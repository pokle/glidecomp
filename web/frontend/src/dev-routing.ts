/**
 * Where a request goes when no Cloudflare is in front of the app: the one
 * routing table shared by the Vite dev server (vite.config.ts) and the e2e
 * suite's server for the built output (web/scripts/e2e-serve-dist.ts).
 *
 * Production routes with `_redirects`, `_routes.json` and the Pages Functions.
 * Locally there are two stand-ins for all of that, and they used to be one: the
 * dev server. When the e2e suite moved onto a production build (bundled
 * scripts load in a fraction of the time 330 dev modules took), the routing had
 * to work in both places — and two copies of this table would drift the way
 * the dev proxy's per-prefix table once did (`/api/u/` went missing from it).
 * So both servers read it from here, and neither has a list of its own.
 *
 * Nothing in here may import the engine or anything else that is raw
 * workspace TypeScript: vite.config.ts imports this module, and Vite's config
 * bundle cannot load those (see resultsRecordDev in vite.config.ts).
 */
import { buildScoresCsv, scoresCsvFilename, type ScoresCsvInput } from "./scores-csv";
import { compUrlId, idFromSegment } from "./react/lib/slug";

/**
 * The prerendered content pages (home, about, legal, scoring/*), built by the
 * Astro app in web/frontend/static. Keep in sync with static/src/pages/ — a
 * page missing here 404s locally (production still serves it, because
 * _routes.json hands /scoring/* to the built files).
 */
export const STATIC_PAGE_ROUTES: ReadonlySet<string> = new Set([
  "/",
  "/about",
  "/assistant",
  "/legal",
  "/scoring",
  "/scoring/gap",
  "/scoring/open-distance",
  "/scoring/data-cleaning",
  "/scoring/track-validity",
]);

/** Old static-page URLs, 301'd to their clean routes (as `_redirects` does). */
export const MOVED_PAGES: Readonly<Record<string, string>> = {
  "/about.html": "/about",
  "/legal.html": "/legal",
  "/scoring.html": "/scoring",
  "/scoring-gap.html": "/scoring/gap",
  "/scoring-open-distance.html": "/scoring/open-distance",
  "/theme-editor": "/",
  "/kitchensink.html": "/",
};

/**
 * True for a path the React app shell (app.html) answers. Module and asset
 * requests contain a dot and never match.
 */
export function isSpaRoute(path: string): boolean {
  if (path.includes(".")) return false;
  return (
    path.startsWith("/u/") ||
    // All /comp* routes serve the shell, mirroring production where
    // _routes.json hands /comp* to the Pages Function (SSR with an SPA-shell
    // fallback). Covers every comp sub-route registered in
    // src/react/routes.tsx (waypoints, task, pilot, ...).
    path === "/comp" ||
    path.startsWith("/comp/") ||
    path === "/scores" ||
    // The kit form's test bench (e2e/forms.spec.ts). It exists only in a
    // development build and the e2e build (src/react/routes.tsx), and
    // production's _redirects does not name it.
    path === "/__kit/form" ||
    /^\/(submit|profile|settings|onboarding|signin|oauth\/consent)\/?$/.test(path) ||
    /^\/admin\/(users|cache)\/?$/.test(path)
  );
}

/**
 * Path prefixes that belong to the Workers, all sent to the dev-router on
 * :8790, which dispatches them over service bindings exactly as the Pages
 * Functions in functions/ do in production. A routing change belongs in three
 * places at once: functions/, dev-router/src/index.ts, and this list.
 */
export const API_PROXY_PREFIXES: readonly string[] = [
  // The whole API surface. There is no /api/* path either local server
  // answers itself.
  "/api",
  // The OAuth discovery documents MCP clients fetch from the origin root.
  // Pages Functions in production (functions/.well-known/); the dev-router
  // sends them to auth-api here.
  "/.well-known/oauth-",
  // The MCP endpoint and its server card (functions/mcp/[[path]].ts in
  // production).
  "/mcp",
  "/.well-known/openid-configuration",
];

/**
 * /civl-rankings.csv is a Pages Function in production
 * (functions/civl-rankings.csv.ts). Locally it is the worker path that
 * Function forwards to, so the one public URL works without a
 * `wrangler pages dev` build.
 */
export const CIVL_RANKINGS_CSV_PATH = "/civl-rankings.csv";
export const CIVL_RANKINGS_CSV_API_PATH = "/api/civl-rankings.csv";

/** The scores CSV's public URL, `/comp/:segment/scores.csv`. */
export const SCORES_CSV_PATTERN = /^\/comp\/([^/]+)\/scores\.csv$/;

/**
 * Local stand-in for the /comp/:id/scores.csv Pages Function
 * (functions/comp/[[path]].ts). Without it the scores page's Download → CSV
 * link 404s locally — and a link that only works in production is a link
 * nobody tests. Same builder, same bytes; the visitor's cookie is forwarded so
 * a hidden comp behaves as it does in production.
 */
export async function scoresCsvResponse(opts: {
  apiOrigin: string;
  segment: string;
  cookie: string | undefined;
  /** This server's origin, which the rows link back to. */
  origin: string;
}): Promise<Response> {
  const compId = idFromSegment(opts.segment);
  const headers = opts.cookie ? { cookie: opts.cookie } : undefined;
  try {
    const [compRes, scoresRes] = await Promise.all([
      fetch(`${opts.apiOrigin}/api/comp/${compId}`, { headers }),
      fetch(`${opts.apiOrigin}/api/comp/${compId}/scores`, { headers }),
    ]);
    if (!compRes.ok) {
      const status = compRes.status === 404 || compRes.status === 400 ? 404 : 502;
      return new Response("Competition not found\n", { status });
    }
    const comp = (await compRes.json()) as {
      comp_id: string;
      name: string;
      test: boolean;
      share_key?: string | null;
    };
    // No scores yet is an empty sheet, as in the Function. (While this lived
    // in vite.config.ts, which nothing type-checks, the fallback said
    // `scores: []` and the builder, reading `class_scores`, threw on it.)
    const scores: ScoresCsvInput = scoresRes.ok
      ? ((await scoresRes.json()) as ScoresCsvInput)
      : { comp_id: compId, tasks: [], class_scores: [] };
    // Same as the Function: on a hidden comp the rows link back with the share
    // key, or a shared sheet's links would all 404.
    scores.comp_id = compUrlId(comp, compId);
    return new Response(
      // Same rule as the Function: link back to where this came from.
      buildScoresCsv(scores, { compName: comp.name, origin: opts.origin }),
      {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${scoresCsvFilename(comp.name)}"`,
        },
      }
    );
  } catch {
    return new Response(`API Workers not reachable at ${opts.apiOrigin}\n`, { status: 502 });
  }
}
