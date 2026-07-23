/**
 * SSR for the public competition routes. Matches the incoming path, runs
 * the matching route loader over the COMPETITION_API service binding (forwarding
 * the visitor's cookie so admins get their `test` comps), renders the same React
 * pages the SPA uses into the /app shell, and injects per-route <head> tags plus
 * `window.__SSR_DATA__` for the client to hydrate from.
 *
 * Safety net: anything that isn't one of the SSR routes, or any loader error,
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
  loadCompScores,
  loadCompWaypoints,
  loadTaskDetail,
  loadPilotScoreDetail,
  NotFoundError,
  type FetchFn,
} from "../../web/frontend/src/react/loaders";

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
  /** Extra raw tags (JSON-LD) already HTML-serialized. */
  extra: string;
}

/**
 * SPA routes under /comp that are deliberately NOT server-rendered and must
 * not be indexed: admin-gated, private, and empty without a signed-in
 * admin's API session. Checked before ROUTES.
 *
 * Field analysis (behavioural metrics) lives here while it is admin-only.
 * When it goes public it wants the opposite treatment — a ROUTES entry with
 * a loader — and should move out of this list.
 */
const NOINDEX_SHELL_ROUTES: RegExp[] = [
  /^\/comp\/[^/]+\/analysis\/?$/,
  /^\/comp\/[^/]+\/analysis\/task\/[^/]+\/?$/,
  // Pilot roster editor — admin-only management surface, nothing for crawlers.
  /^\/comp\/[^/]+\/pilots\/?$/,
  // Where the per-task report lived before it was re-nested under the comp
  // report; the SPA redirects it, so it must reach the shell rather than 404.
  /^\/comp\/[^/]+\/task\/[^/]+\/analysis\/?$/,
];

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
          extra: jsonLd({
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
    pattern: /^\/comp\/([^/]+)\/scores\/?$/,
    async run(f, m, origin) {
      const compId = decodeURIComponent(m[1]);
      const data = await loadCompScores(f, compId);
      const c = data.comp;
      return {
        data,
        head: {
          title: `Scores — ${c.name} — GlideComp`,
          description: `Standings for ${c.name}: overall scores per class, top 3 per task, and per-pilot score explanations on GlideComp.`,
          extra: jsonLd(
              breadcrumb(origin, [
                ["Competitions", "/comp"],
                [c.name, `/comp/${compId}`],
                ["Scores", `/comp/${compId}/scores`],
              ])
            ),
        },
      };
    },
  },
  {
    pattern: /^\/comp\/([^/]+)\/waypoints\/?$/,
    async run(f, m, origin) {
      const compId = decodeURIComponent(m[1]);
      const data = await loadCompWaypoints(f, compId);
      const n = data.waypoints.length;
      return {
        data,
        head: {
          title: `Waypoints — ${data.comp.name} — GlideComp`,
          description: `The ${n} shared waypoint${n === 1 ? "" : "s"} for ${data.comp.name}: codes, names and coordinates, with downloads for flight instruments.`,
          extra: jsonLd(
              breadcrumb(origin, [
                ["Competitions", "/comp"],
                [data.comp.name, `/comp/${compId}`],
                ["Waypoints", `/comp/${compId}/waypoints`],
              ])
            ),
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
          extra: jsonLd(
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
          extra: jsonLd(
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

  // Private SPA-only routes under /comp: served as the plain shell (they
  // fetch their own data client-side), but marked noindex — there is nothing
  // here for a crawler, and the pages are admin-gated by the API anyway.
  if (NOINDEX_SHELL_ROUTES.some((p) => p.test(path))) {
    return shellWithNoindex(env, url, 200);
  }

  const match = ROUTES.map((r) => ({ r, m: path.match(r.pattern) })).find((x) => x.m);
  // Not one of the SSR routes → serve the SPA shell unchanged (today's behavior).
  if (!match || !match.m) return fetchShell(env, url);

  // Forward the cookie so the API answers exactly as it would for this visitor
  // (admins see their test comps; everyone else gets the public view / 404).
  const fetcher: FetchFn = (p, init) =>
    env.COMPETITION_API.fetch(new Request(`https://comp.internal${p}`, mergeCookie(init, cookie)));

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
  return shellWithNoindex(env, url, 404);
}

async function shellWithNoindex(
  env: Env,
  url: URL,
  status: number
): Promise<Response> {
  const template = await (await fetchShell(env, url)).text();
  const html = template.replace(
    "</head>",
    `<meta name="robots" content="noindex">\n</head>`
  );
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...(status === 200 ? { "Cache-Control": "private, no-store" } : {}),
    },
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

// Deliberately no <link rel="canonical">: iOS Safari's share sheet copies the
// canonical URL instead of the address bar, and a canonical injected at SSR
// time goes stale after client-side navigation (pushState doesn't touch the
// <head>), so visitors shared the entry page's URL rather than the page they
// were on. Host dedup (glidecomp.pages.dev) is a 301 in functions/_middleware.ts.
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
