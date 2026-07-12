/**
 * SSR for the four public competition routes. Matches the incoming path, runs
 * the matching route loader over the COMPETITION_API service binding (forwarding
 * the visitor's cookie so admins get their `test` comps), renders the same React
 * pages the SPA uses into the /app shell, and injects per-route <head> tags plus
 * `window.__SSR_DATA__` for the client to hydrate from.
 *
 * Safety net: anything that isn't one of the four routes, or any loader error,
 * falls back to the unmodified SPA shell — SSR can never make a page less
 * available than the pure client-rendered version. Upstream 404s (including
 * anonymous `test` comps) render the shell with a 404 status + noindex.
 *
 * `render` is imported from the Vite-built SSR bundle (web/frontend/dist-ssr),
 * produced by `bun run build:ssr` before the Functions are bundled.
 */
// @ts-expect-error - built artifact, present after `bun run build:ssr`
import { render } from "../../web/frontend/dist-ssr/entry-server.js";
import {
  loadCompetitions,
  loadCompDetail,
  loadTaskDetail,
  loadPilotScoreDetail,
  NotFoundError,
  type FetchFn,
} from "../../web/frontend/src/react/loaders";
import { previewBackends } from "../lib/preview-backends";

interface Env {
  COMPETITION_API: Fetcher;
  ASSETS: Fetcher;
}

interface Rendered {
  /** The SSR loader result, embedded as window.__SSR_DATA__.data. */
  data: unknown;
  head: HeadTags;
}

interface HeadTags {
  title: string;
  description: string;
  /** Extra raw tags (canonical, JSON-LD) already HTML-serialized. */
  extra: string;
}

const ROUTES: Array<{
  pattern: RegExp;
  run: (f: FetchFn, m: RegExpMatchArray, origin: string) => Promise<Rendered>;
}> = [
  {
    pattern: /^\/comp\/?$/,
    async run(f, _m, origin) {
      const data = await loadCompetitions(f);
      return {
        data,
        head: {
          title: "Competitions — GlideComp",
          description:
            "Browse hang gliding and paragliding competitions on GlideComp: tasks, live scores and per-pilot score explanations.",
          extra:
            canonical(`${origin}/comp`) +
            jsonLd({
              "@context": "https://schema.org",
              "@type": "ItemList",
              itemListElement: data.comps.map((c, i) => ({
                "@type": "ListItem",
                position: i + 1,
                name: c.name,
                url: `${origin}/comp/${c.comp_id}`,
              })),
            }),
        },
      };
    },
  },
  {
    pattern: /^\/comp\/([^/]+)\/?$/,
    async run(f, m, origin) {
      const compId = decodeURIComponent(m[1]);
      const data = await loadCompDetail(f, compId);
      const c = data.comp;
      const summary = [
        c.category === "hg" ? "HG" : "PG",
        c.scoring_format === "open_distance" ? "Open distance" : "GAP",
        c.pilot_classes.join(", "),
      ].join(" · ");
      return {
        data,
        head: {
          title: `${c.name} — GlideComp`,
          description: `${c.name}: ${summary}. Tasks, standings and per-pilot score explanations on GlideComp.`,
          extra:
            canonical(`${origin}/comp/${compId}`) +
            jsonLd({
              "@context": "https://schema.org",
              "@type": "SportsEvent",
              name: c.name,
              sport: c.category === "hg" ? "Hang gliding" : "Paragliding",
              url: `${origin}/comp/${compId}`,
            }) +
            jsonLd(breadcrumb(origin, [["Competitions", "/comp"], [c.name, `/comp/${compId}`]])),
        },
      };
    },
  },
  {
    pattern: /^\/comp\/([^/]+)\/task\/([^/]+)\/?$/,
    async run(f, m, origin) {
      const compId = decodeURIComponent(m[1]);
      const taskId = decodeURIComponent(m[2]);
      const data = await loadTaskDetail(f, compId, taskId);
      const compName = data.comp?.name ?? "GlideComp";
      return {
        data,
        head: {
          title: `${data.task.name} — ${compName}`,
          description: `${data.task.name} (${compName}): route, turnpoints and per-class scores on GlideComp.`,
          extra:
            canonical(`${origin}/comp/${compId}/task/${taskId}`) +
            jsonLd(
              breadcrumb(origin, [
                ["Competitions", "/comp"],
                [compName, `/comp/${compId}`],
                [data.task.name, `/comp/${compId}/task/${taskId}`],
              ])
            ),
        },
      };
    },
  },
  {
    pattern: /^\/comp\/([^/]+)\/task\/([^/]+)\/pilot\/([^/]+)\/?$/,
    async run(f, m, origin) {
      const compId = decodeURIComponent(m[1]);
      const taskId = decodeURIComponent(m[2]);
      const pilotId = decodeURIComponent(m[3]);
      const data = await loadPilotScoreDetail(f, compId, taskId, pilotId);
      const pilotName = pilotNameFrom(data.score, pilotId);
      return {
        data,
        head: {
          title: `${pilotName} — ${data.task.name}, ${data.comp.name}: score explanation`,
          description: `How ${pilotName}'s score for ${data.task.name} (${data.comp.name}) was calculated — a step-by-step GlideComp scoring breakdown.`,
          extra:
            canonical(`${origin}/comp/${compId}/task/${taskId}/pilot/${pilotId}`) +
            jsonLd(
              breadcrumb(origin, [
                ["Competitions", "/comp"],
                [data.comp.name, `/comp/${compId}`],
                [data.task.name, `/comp/${compId}/task/${taskId}`],
              ])
            ),
        },
      };
    },
  },
];

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const cookie = request.headers.get("Cookie");

  const match = ROUTES.map((r) => ({ r, m: path.match(r.pattern) })).find((x) => x.m);
  // Not one of the four SSR routes → serve the SPA shell unchanged (today's behavior).
  if (!match || !match.m) return fetchShell(env, url);

  // Forward the cookie so the API answers exactly as it would for this visitor
  // (admins see their test comps; everyone else gets the public view / 404).
  // Branch previews go to the branch's own worker by URL instead of the
  // service binding — see functions/lib/preview-backends.ts.
  const fetcher: FetchFn = (p, init) =>
    previewBackends
      ? fetch(new Request(`${previewBackends.compApiUrl}${p}`, mergeCookie(init, cookie)))
      : env.COMPETITION_API.fetch(new Request(`https://comp.internal${p}`, mergeCookie(init, cookie)));

  let rendered: Rendered;
  try {
    rendered = await match.r.run(fetcher, match.m, url.origin);
  } catch (err) {
    if (err instanceof NotFoundError) return notFoundShell(env, url);
    // Any other failure (upstream 5xx, timeout, render error) → plain SPA shell.
    console.error("SSR loader/render error for", path, err);
    return fetchShell(env, url);
  }

  let bodyHtml: string;
  try {
    const stream = await render(path, { path, data: rendered.data });
    bodyHtml = await new Response(stream as ReadableStream).text();
  } catch (err) {
    console.error("SSR render error for", path, err);
    return fetchShell(env, url);
  }

  const template = await (await fetchShell(env, url)).text();
  const html = injectSsr(template, path, bodyHtml, rendered.head, rendered.data);

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // Cookie-forwarded renders are visitor-specific; never shared-cache them.
      "Cache-Control": cookie
        ? "private, no-store"
        : "public, max-age=0, must-revalidate",
    },
  });
};

// ── shell helpers ────────────────────────────────────────────────────────────

function fetchShell(env: Env, url: URL): Promise<Response> {
  return env.ASSETS.fetch(new URL("/app.html", url.origin));
}

async function notFoundShell(env: Env, url: URL): Promise<Response> {
  const template = await (await fetchShell(env, url)).text();
  const html = template.replace(
    "</head>",
    `<meta name="robots" content="noindex">\n</head>`
  );
  return new Response(html, {
    status: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function mergeCookie(init: RequestInit | undefined, cookie: string | null): RequestInit {
  if (!cookie) return init ?? {};
  const headers = new Headers(init?.headers);
  headers.set("Cookie", cookie);
  return { ...init, headers };
}

/**
 * Splice the rendered page into the shell: per-route <head> tags, the markup
 * into #root, and window.__SSR_DATA__ before the client module script.
 */
function injectSsr(
  template: string,
  path: string,
  bodyHtml: string,
  head: HeadTags,
  data: unknown
): string {
  const headTags =
    `<title>${escapeHtml(head.title)}</title>\n` +
    `<meta name="description" content="${escapeAttr(head.description)}">\n` +
    `<meta property="og:title" content="${escapeAttr(head.title)}">\n` +
    `<meta property="og:description" content="${escapeAttr(head.description)}">\n` +
    head.extra;

  // Replace the shell's placeholder <title> and add the rest before </head>.
  let out = template
    .replace(/<title>[\s\S]*?<\/title>/, "")
    .replace("</head>", `${headTags}</head>`);

  // __SSR_DATA__ must run before the client entry module (which sits after the
  // root div in app.html), so the client hydrates from the same loader data.
  const ssrScript = `<script>window.__SSR_DATA__=${serialize({ path, data })}</script>`;
  out = out.replace(
    '<div id="root"></div>',
    `<div id="root">${bodyHtml}</div>${ssrScript}`
  );
  return out;
}

// ── head builders ────────────────────────────────────────────────────────────

function canonical(href: string): string {
  return `<link rel="canonical" href="${escapeAttr(href)}">\n`;
}

function jsonLd(obj: unknown): string {
  return `<script type="application/ld+json">${serialize(obj)}</script>\n`;
}

function breadcrumb(origin: string, items: Array<[string, string]>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, href], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: `${origin}${href}`,
    })),
  };
}

function pilotNameFrom(score: { classes: Array<{ pilots: Array<{ comp_pilot_id: string; pilot_name: string }> }> }, pilotId: string): string {
  for (const cls of score.classes) {
    const p = cls.pilots.find((x) => x.comp_pilot_id === pilotId);
    if (p) return p.pilot_name;
  }
  return "Pilot";
}

/** JSON for embedding in <script>: block `</script>` and `<!--` breakouts. */
function serialize(obj: unknown): string {
  return JSON.stringify(obj)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
