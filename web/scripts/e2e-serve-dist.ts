#!/usr/bin/env bun
/**
 * The e2e suite's frontend: the PRODUCTION build in web/frontend/dist, served
 * on the dev server's port with the dev server's routing. Started by
 * web/scripts/e2e-frontend.sh, which builds dist/ first (`--mode e2e`).
 *
 * ── Why not the Vite dev server ──────────────────────────────────────────────
 *
 * Every e2e test opens a fresh browser context, so every page load starts with
 * an empty HTTP cache. On the dev server that meant fetching about 330
 * unbundled modules per load. Measured on /comp/:id/waypoints, signed in
 * (2026-11-02, the same machine, warm servers):
 *
 *   dev server    goto 986 ms, ready 1529 ms, 341 requests (330 scripts)
 *   this server   goto 466 ms, ready  647 ms,  56 requests ( 50 scripts)
 *
 * The organiser shard alone made 180 page loads (median 885 ms in CI), so page
 * loads were about 40% of its run. It also means the suite runs the bundles
 * that ship rather than the dev transform of them.
 *
 * ── Why not `wrangler pages dev` ─────────────────────────────────────────────
 *
 * That runs the SSR Function too, which is e2e/ssr.spec.ts's job
 * (playwright.ssr.config.ts). This suite was written against the client-side
 * app, and many specs stub an API response with page.route() before the page
 * asks for it — a server-rendered page would already have the real data. So
 * this server keeps the dev server's semantics: the SPA shell for every app
 * route, the API proxied, nothing rendered on the server.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 *
 * The routing table is src/dev-routing.ts, shared with vite.config.ts so the
 * two cannot drift. In order:
 *   1. The Workers' prefixes → the dev-router (:8790), as the dev proxy does.
 *   2. /comp/:id/scores.csv, .pdf and .zip → the same handlers as the Pages
 *      Function (the dev server's stand-ins, imported directly: Bun runs the
 *      engine's TypeScript, which Vite's config bundle cannot).
 *   3. Old *.html URLs → 301.
 *   4. The prerendered content pages, the SPA routes (→ app.html) and /replay.
 *   5. Any file in dist/, then `<path>.html` and `<path>/index.html`.
 *   6. A SOURCE module by its path under web/frontend/src — `/analysis/
 *      elevation.ts` — bundled on request. The dev server lets a page import
 *      any source module that way, and a spec that drives a module directly
 *      (analysis-map's terrain-DEM test) relies on it. Each such import is
 *      its own bundle, sharing no module instances with the app's.
 *   7. Otherwise dist/404.html with a 404, as Cloudflare Pages does.
 *
 * ── Shielding wrangler from a cancelled request ──────────────────────────────
 *
 * `wrangler dev` exits when a client connection is severed mid-request (see
 * web/scripts/dev-workers.sh, which restarts it). A browser cancels requests
 * all the time — every navigation drops the fetches the last page left in
 * flight — and the dev proxy passed each cancellation straight through. This
 * proxy reads the request body and the whole answer before replying, so a
 * request the browser gives up on still completes cleanly at wrangler's end.
 * Only an event stream is passed through as a stream, because it is meant to
 * stay open.
 */
import { statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import {
  API_PROXY_PREFIXES,
  CIVL_RANKINGS_CSV_API_PATH,
  CIVL_RANKINGS_CSV_PATH,
  MOVED_PAGES,
  SCORES_CSV_PATTERN,
  STATIC_PAGE_ROUTES,
  isSpaRoute,
  scoresCsvResponse,
} from "../frontend/src/dev-routing";
import {
  RESULTS_RECORD_FONT_PATHS,
  RESULTS_RECORD_PATTERN,
  serveResultsRecord,
  type ResultsRecordFormat,
} from "../frontend/src/results-record/serve";

const DIST = resolve(import.meta.dir, "..", "frontend", "dist");
/** Vite's `root` (vite.config.ts), where the dev server resolves a module path. */
const SRC = resolve(import.meta.dir, "..", "frontend", "src");
const PORT = Number(process.env.DEV_FRONTEND_PORT) || 3000;
const API_ORIGIN =
  process.env.DEV_API_ORIGIN || `http://localhost:${process.env.DEV_API_PORT || 8790}`;

/** Request headers that describe this hop, not the request. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "host",
  // Bun's fetch decodes compressed bodies itself; asking for identity keeps
  // the bytes and the headers in agreement.
  "accept-encoding",
]);

/** Response headers that no longer describe the body once it is re-sent. */
const STALE_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-encoding",
  "content-length",
  "set-cookie", // re-added one by one below; joined, they would not parse
]);

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** A file under dist/, or null. Never anything outside it. */
function distFile(relative: string, init?: ResponseInit): Response | null {
  const path = normalize(join(DIST, relative));
  if (!path.startsWith(DIST + "/") || !isFile(path)) return null;
  const headers = new Headers(init?.headers);
  // Content-hashed build output, as public/_headers says in production.
  if (/^\/(assets|_astro)\//.test(relative)) {
    headers.set("Cache-Control", "public, max-age=31536000, immutable");
  }
  return new Response(Bun.file(path), { ...init, headers });
}

/** The file for a path, the way the dev server and Pages both resolve it. */
function staticResponse(pathname: string): Response | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.endsWith("/")) return distFile(decoded + "index.html");
  return (
    distFile(decoded) ?? distFile(decoded + ".html") ?? distFile(decoded + "/index.html")
  );
}

/**
 * What Vite puts in `import.meta.env` for this build: the mode, and every
 * VITE_* variable (VITE_MAPBOX_TOKEN — playwright.config.ts supplies a fake one).
 */
const IMPORT_META_ENV = JSON.stringify({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith("VITE_"))),
  MODE: "e2e",
  DEV: false,
  PROD: true,
  SSR: false,
  BASE_URL: "/",
});

const sourceBundles = new Map<string, Promise<Response>>();

/** A source module under SRC, bundled for the browser (step 6 above), or null. */
function sourceModule(pathname: string): Promise<Response> | null {
  if (!/\.tsx?$/.test(pathname)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const path = normalize(join(SRC, decoded));
  if (!path.startsWith(SRC + "/") || !isFile(path)) return null;
  let bundle = sourceBundles.get(path);
  if (!bundle) {
    bundle = Bun.build({
      entrypoints: [path],
      target: "browser",
      format: "esm",
      define: { "import.meta.env": IMPORT_META_ENV },
    }).then(async (result) => {
      if (!result.success) {
        return new Response(result.logs.map(String).join("\n"), { status: 500 });
      }
      return new Response(await result.outputs[0].text(), {
        headers: { "Content-Type": "text/javascript; charset=utf-8" },
      });
    });
    sourceBundles.set(path, bundle);
  }
  return bundle.then((response) => response.clone());
}

async function proxy(req: Request, upstreamPath: string): Promise<Response> {
  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(API_ORIGIN + upstreamPath, {
      method: req.method,
      headers,
      // Read in full first: a client that goes away mid-upload must not sever
      // the request at wrangler's end.
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: "manual",
    });
  } catch (err) {
    return new Response(`API Workers not reachable at ${API_ORIGIN}: ${String(err)}\n`, {
      status: 502,
    });
  }
  const out = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!STALE_RESPONSE_HEADERS.has(key.toLowerCase())) out.set(key, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) out.append("Set-Cookie", cookie);
  const init = { status: upstream.status, statusText: upstream.statusText, headers: out };
  if (upstream.headers.get("content-type")?.startsWith("text/event-stream")) {
    return new Response(upstream.body, init);
  }
  // Read in full before replying (see the header on wrangler).
  return new Response(await upstream.arrayBuffer(), init);
}

function resultsRecord(req: Request, segment: string, format: ResultsRecordFormat, origin: string) {
  const cookie = req.headers.get("cookie");
  return serveResultsRecord({
    fetch: (path, init) =>
      fetch(API_ORIGIN + path, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(cookie ? { cookie } : {}),
        },
      }),
    segment,
    format,
    origin,
    loadFonts: async () => ({
      regular: new Uint8Array(await Bun.file(join(DIST, RESULTS_RECORD_FONT_PATHS.regular)).arrayBuffer()),
      bold: new Uint8Array(await Bun.file(join(DIST, RESULTS_RECORD_FONT_PATHS.bold)).arrayBuffer()),
    }),
  });
}

async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  if (API_PROXY_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return proxy(req, path + url.search);
  }
  if (path === CIVL_RANKINGS_CSV_PATH) {
    return proxy(req, CIVL_RANKINGS_CSV_API_PATH + url.search);
  }

  const csv = path.match(SCORES_CSV_PATTERN);
  if (csv) {
    return scoresCsvResponse({
      apiOrigin: API_ORIGIN,
      segment: csv[1],
      cookie: req.headers.get("cookie") ?? undefined,
      origin: url.origin,
    });
  }
  const record = path.match(RESULTS_RECORD_PATTERN);
  if (record) return resultsRecord(req, record[1], record[2] as ResultsRecordFormat, url.origin);

  const movedTo = MOVED_PAGES[path];
  if (movedTo) return new Response(null, { status: 301, headers: { Location: movedTo } });

  if (STATIC_PAGE_ROUTES.has(path)) {
    const page = distFile(path === "/" ? "/index.html" : `${path}/index.html`);
    if (page) return page;
  }
  if (isSpaRoute(path)) return distFile("/app.html")!;
  if (path === "/replay" || path === "/replay/") return distFile("/replay.html")!;

  return (
    staticResponse(path) ??
    (await sourceModule(path)) ??
    distFile("/404.html", { status: 404 }) ??
    new Response("Not found\n", { status: 404 })
  );
}

if (!isFile(join(DIST, "app.html"))) {
  console.error(`e2e-serve-dist: no build at ${DIST} — run web/scripts/e2e-frontend.sh`);
  process.exit(1);
}

Bun.serve({
  port: PORT,
  // Off: a slow API answer (a cold task analysis, a big results record) must
  // not be cut off by Bun's default 10 s idle limit.
  idleTimeout: 0,
  fetch: handle,
  error(err) {
    console.error("e2e-serve-dist:", err);
    return new Response(`e2e-serve-dist: ${String(err)}\n`, { status: 500 });
  },
});
console.log(`e2e-serve-dist: ${DIST} on http://localhost:${PORT} (API → ${API_ORIGIN})`);
