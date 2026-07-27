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
  loadCompFieldAnalysis,
  loadTaskFieldAnalysis,
  publicMaxAgeSeconds,
  NotFoundError,
  type FetchFn,
} from "../../web/frontend/src/react/loaders";
import {
  idFromSegment,
  compPath,
  compScoresPath,
  compWaypointsPath,
  compAnalysisPath,
  taskPath,
  taskAnalysisPath,
  pilotPath,
} from "../../web/frontend/src/react/lib/slug";

interface Env {
  COMPETITION_API: Fetcher;
  ASSETS: Fetcher;
}

/** When present, the page's stale-first freshness — drives an age-based
 * Cache-Control on the SSR HTML (see the response builder). */
interface CacheHint {
  computedAt: string | null;
  stale: boolean;
}

interface Rendered {
  /** The SSR loader result, embedded as window.__SSR_DATA__.data. */
  data: unknown;
  head: HeadTags;
  /** Freshness of the materialized content, if any (scores / field analysis). */
  cache?: CacheHint;
  /** The canonical `${slug}-${id}` pathname for this page, once the names are
   * known. When it differs from the request path, onRequest 301s to it. Absent
   * for routes with no id (the comp list) or when a name was unavailable. */
  canonicalPath?: string;
}

interface HeadTags {
  title: string;
  description: string;
  /** Emit <meta robots noindex> — for pages with no substantive content yet
   * (a pending or empty field analysis). */
  noindex?: boolean;
  /** Extra raw tags (JSON-LD) already HTML-serialized. */
  extra: string;
}

/**
 * SPA routes under /comp that are deliberately NOT server-rendered and must
 * not be indexed: admin-gated, private, and empty without a signed-in
 * admin's API session. Checked before ROUTES.
 *
 * Field analysis (behavioural metrics) is now public and SSR'd — it has ROUTES
 * entries with loaders below (a pending/empty report is rendered but noindexed
 * per-request, not shell-noindexed here).
 */
const NOINDEX_SHELL_ROUTES: RegExp[] = [
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
            "Browse hang gliding and paragliding competitions on GlideComp: tasks, live scores, per-pilot score explanations, and the field analysis of how each day was flown.",
          extra: jsonLd({
              "@context": "https://schema.org",
              "@type": "ItemList",
              itemListElement: data.comps.map((c, i) => ({
                "@type": "ListItem",
                position: i + 1,
                name: c.name,
                url: `${origin}${compPath(c.comp_id, c.name)}`,
              })),
            }),
        },
      };
    },
  },
  {
    pattern: /^\/comp\/([^/]+)\/?$/,
    async run(f, m, origin) {
      const compId = idFromSegment(m[1]);
      const data = await loadCompDetail(f, compId);
      const c = data.comp;
      const canonical = compPath(compId, c.name);
      const summary = [
        c.category === "hg" ? "HG" : "PG",
        c.scoring_format === "open_distance" ? "Open distance" : "GAP",
        c.pilot_classes.join(", "),
      ].join(" · ");
      return {
        data,
        canonicalPath: canonical,
        cache: data.scores
          ? { computedAt: data.scores.computed_at, stale: data.scores.stale }
          : undefined,
        head: {
          title: `${c.name} — GlideComp`,
          description: `${c.name}: ${summary}. Tasks, standings and per-pilot score explanations on GlideComp.`,
          extra:
            jsonLd({
              "@context": "https://schema.org",
              "@type": "SportsEvent",
              name: c.name,
              sport: c.category === "hg" ? "Hang gliding" : "Paragliding",
              url: `${origin}${canonical}`,
            }) +
            jsonLd(breadcrumb(origin, [["Competitions", "/comp"], [c.name, canonical]])),
        },
      };
    },
  },
  {
    pattern: /^\/comp\/([^/]+)\/scores\/?$/,
    async run(f, m, origin) {
      const compId = idFromSegment(m[1]);
      const data = await loadCompScores(f, compId);
      const c = data.comp;
      const canonical = compScoresPath(compId, c.name);
      return {
        data,
        canonicalPath: canonical,
        cache: data.scores
          ? { computedAt: data.scores.computed_at, stale: data.scores.stale }
          : undefined,
        head: {
          title: `Scores — ${c.name} — GlideComp`,
          description: `Standings for ${c.name}: overall scores per class, top 3 per task, and per-pilot score explanations on GlideComp.`,
          extra: jsonLd(
              breadcrumb(origin, [
                ["Competitions", "/comp"],
                [c.name, compPath(compId, c.name)],
                ["Scores", canonical],
              ])
            ),
        },
      };
    },
  },
  {
    pattern: /^\/comp\/([^/]+)\/waypoints\/?$/,
    async run(f, m, origin) {
      const compId = idFromSegment(m[1]);
      const data = await loadCompWaypoints(f, compId);
      const n = data.waypoints.length;
      const canonical = compWaypointsPath(compId, data.comp.name);
      return {
        data,
        canonicalPath: canonical,
        head: {
          title: `Waypoints — ${data.comp.name} — GlideComp`,
          description: `The ${n} shared waypoint${n === 1 ? "" : "s"} for ${data.comp.name}: codes, names and coordinates, with downloads for flight instruments.`,
          extra: jsonLd(
              breadcrumb(origin, [
                ["Competitions", "/comp"],
                [data.comp.name, compPath(compId, data.comp.name)],
                ["Waypoints", canonical],
              ])
            ),
        },
      };
    },
  },
  {
    pattern: /^\/comp\/([^/]+)\/task\/([^/]+)\/?$/,
    async run(f, m, origin) {
      const compId = idFromSegment(m[1]);
      const taskId = idFromSegment(m[2]);
      const data = await loadTaskDetail(f, compId, taskId);
      const compName = data.comp?.name ?? "GlideComp";
      // Only canonicalise when the comp name resolved — otherwise we'd 301 to a
      // URL that strips a good comp slug down to the bare id.
      const canonical = data.comp
        ? taskPath(compId, data.comp.name, taskId, data.task.name)
        : undefined;
      return {
        data,
        canonicalPath: canonical,
        cache: data.score
          ? { computedAt: data.score.computed_at, stale: data.score.stale }
          : undefined,
        head: {
          title: `${data.task.name} — ${compName}`,
          description: `${data.task.name} (${compName}): route, turnpoints and per-class scores on GlideComp.`,
          extra: jsonLd(
              breadcrumb(origin, [
                ["Competitions", "/comp"],
                [compName, compPath(compId, data.comp?.name)],
                [data.task.name, taskPath(compId, data.comp?.name, taskId, data.task.name)],
              ])
            ),
        },
      };
    },
  },
  {
    pattern: /^\/comp\/([^/]+)\/task\/([^/]+)\/pilot\/([^/]+)\/?$/,
    async run(f, m, origin) {
      const compId = idFromSegment(m[1]);
      const taskId = idFromSegment(m[2]);
      const pilotId = idFromSegment(m[3]);
      const data = await loadPilotScoreDetail(f, compId, taskId, pilotId);
      const pilotName = pilotNameFrom(data.score, pilotId);
      const canonical = pilotPath(
        compId,
        data.comp.name,
        taskId,
        data.task.name,
        pilotId,
        pilotName
      );
      return {
        data,
        canonicalPath: canonical,
        cache: { computedAt: data.score.computed_at, stale: data.score.stale },
        head: {
          title: `${pilotName} — ${data.task.name}, ${data.comp.name}: score explanation`,
          description: `How ${pilotName}'s score for ${data.task.name} (${data.comp.name}) was calculated — a step-by-step GlideComp scoring breakdown.`,
          extra: jsonLd(
              breadcrumb(origin, [
                ["Competitions", "/comp"],
                [data.comp.name, compPath(compId, data.comp.name)],
                [data.task.name, taskPath(compId, data.comp.name, taskId, data.task.name)],
              ])
            ),
        },
      };
    },
  },
  {
    // Comp field analysis (behavioural metrics across the comp's tasks).
    pattern: /^\/comp\/([^/]+)\/analysis\/?$/,
    async run(f, m, origin) {
      const compId = idFromSegment(m[1]);
      const data = await loadCompFieldAnalysis(f, compId);
      const a = data.analysis;
      const name = data.comp?.name ?? a.comp_name;
      const canonical = compAnalysisPath(compId, name);
      // Nothing aggregated yet (all tasks pending, or none analysable) → render
      // the page but keep it out of the index until it has real content.
      const hasContent = a.classes.length > 0;
      return {
        data,
        canonicalPath: canonical,
        cache: {
          computedAt: a.computed_at,
          stale: a.stale || a.pending_task_count > 0,
        },
        head: {
          title: `Field analysis — ${name} — GlideComp`,
          description: `Which flying behaviours separated the field at ${name} — climbing, gliding, decision-making and race craft, ranked by how strongly each tracks finishing position.`,
          noindex: !hasContent,
          extra: jsonLd(
            breadcrumb(origin, [
              ["Competitions", "/comp"],
              [name, compPath(compId, name)],
              ["Field analysis", canonical],
            ])
          ),
        },
      };
    },
  },
  {
    // Per-task field analysis (a chapter of the comp report above).
    pattern: /^\/comp\/([^/]+)\/analysis\/task\/([^/]+)\/?$/,
    async run(f, m, origin) {
      const compId = idFromSegment(m[1]);
      const taskId = idFromSegment(m[2]);
      const data = await loadTaskFieldAnalysis(f, compId, taskId);
      const a = data.analysis;
      const compName = data.comp?.name ?? "GlideComp";
      const taskName = data.task?.name ?? "Task";
      // Only canonicalise when both names resolved (the analysis body carries
      // neither) — otherwise we'd 301 to a URL that strips good slugs.
      const canonical =
        data.comp && data.task
          ? taskAnalysisPath(compId, data.comp.name, taskId, data.task.name)
          : undefined;
      // Pending (still computing), an error (no route), or no classes → no
      // substantive content to index yet.
      const hasContent = a.classes.length > 0 && !a.pending;
      return {
        data,
        canonicalPath: canonical,
        cache: { computedAt: a.computed_at, stale: a.stale || a.pending },
        head: {
          title: `Field analysis — ${taskName}, ${compName}`,
          description: `How the field flew ${taskName} at ${compName}, and which behaviours separated the leaderboard — a per-pilot behavioural breakdown on GlideComp.`,
          noindex: !hasContent,
          extra: jsonLd(
            breadcrumb(origin, [
              ["Competitions", "/comp"],
              [compName, compPath(compId, data.comp?.name)],
              ["Field analysis", compAnalysisPath(compId, data.comp?.name)],
              [taskName, taskAnalysisPath(compId, data.comp?.name, taskId, data.task?.name)],
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
  // Not one of the SSR routes. Valid SPA-only /comp routes (the pilots roster,
  // the old task-analysis redirect) were already handled above via
  // NOINDEX_SHELL_ROUTES, so reaching here means the path matches no known
  // /comp route at all (e.g. /comp/<id>/asdf) — it is a genuine 404. Render the
  // SPA shell (react-router shows its NotFound page) but with a real 404 status
  // + noindex, rather than the old soft-200 that made junk URLs look valid.
  if (!match || !match.m) return notFoundShell(env, url);

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

  // Canonicalise the URL: 301 to `${slug}-${id}` whenever the request path is
  // not already it (a bare `${id}`, a stale/mis-cased slug, a trailing slash).
  // The name comes from the loader above, so the target reflects the current
  // title. Query is preserved; the fragment never reaches the server.
  if (rendered.canonicalPath && rendered.canonicalPath !== path) {
    return canonicalRedirect(url.origin + rendered.canonicalPath + url.search, cookie);
  }

  let bodyHtml: string;
  try {
    // Render with the query string: it is part of the location the client
    // hydrates from, and pages read view state out of it (`?class=`, `?task=`).
    // `initialData.path` stays the PATHNAME — useInitialData matches it against
    // location.pathname, which a query-bearing string would never equal.
    const stream = await render(path + url.search, { path, data: rendered.data });
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
      "Cache-Control": pageCacheControl(cookie, rendered.cache),
    },
  });
};

/**
 * Cache-Control for a rendered SSR page. Cookie-forwarded renders are
 * visitor-specific and never shared-cached. For anonymous renders of
 * stale-first content (scores / field analysis) the max-age grows with how
 * long the content has already been stable (publicMaxAgeSeconds) — a finished
 * comp's pages stop being re-fetched, a live one stays near-realtime — while
 * pages with no freshness signal keep the always-revalidate default.
 */
function pageCacheControl(cookie: string | null, cache?: CacheHint): string {
  if (cookie) return "private, no-store";
  if (!cache) return "public, max-age=0, must-revalidate";
  const maxAge = publicMaxAgeSeconds(cache.computedAt, cache.stale, Date.now());
  return `public, max-age=${maxAge}, must-revalidate`;
}

/**
 * 301 to the canonical slugged URL. A permanent redirect so search engines
 * consolidate on the canonical form. Cached modestly (the target changes only
 * if the comp/task is renamed); a cookie-forwarded redirect can name a comp
 * visible only to that admin, so it is never shared-cached.
 */
function canonicalRedirect(location: string, cookie: string | null): Response {
  return new Response(null, {
    status: 301,
    headers: {
      Location: location,
      "Cache-Control": cookie ? "private, no-store" : "public, max-age=3600",
    },
  });
}

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
    (head.noindex ? `<meta name="robots" content="noindex">\n` : "") +
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
