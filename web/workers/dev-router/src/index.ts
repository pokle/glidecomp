/**
 * dev-router — local development only. Never deployed.
 *
 * In production every `/api/*` path is served by a Pages Function that forwards
 * to a Worker over a service binding (see `functions/api/*`). Locally we used to
 * emulate that by running each Worker as its own `wrangler dev` process on its
 * own port, with Vite proxying `/api/auth` → :8788 and the rest → :8789.
 *
 * That is what made the e2e suite flaky (issue #477): auth-api and
 * competition-api are two Miniflare *processes* opening the SAME D1 SQLite file
 * (shared `--persist-to`), and concurrent cross-process access intermittently
 * surfaced as `D1_ERROR: internal error` — sometimes killing the whole
 * `wrangler dev` process and cascading a CI run.
 *
 * The fix is to run all the Workers inside ONE Miniflare instance, which
 * `wrangler dev -c … -c … -c …` does. But multi-config dev only exposes the
 * *primary* config's port; the others are reachable solely through service
 * bindings. So this Worker is the primary: it owns the port and dispatches to
 * its siblings over exactly the bindings the Pages Functions use in production.
 *
 * Keep the prefix list in sync with `functions/api/` — the two are the same
 * routing decision expressed for two runtimes. (Vite needs no third copy: it
 * proxies all of `/api` straight here.) `test/routes.test.ts` pins every path.
 */

/** The siblings this Worker dispatches to, over service bindings. */
interface Bindings {
  AUTH_API: Fetcher;
  COMPETITION_API: Fetcher;
  AIRSCORE_API: Fetcher;
  MCP_API: Fetcher;
}

interface Env extends Bindings {
  /**
   * Set (to anything) by web/scripts/dev-workers.sh when it is keeping its
   * session log — see ARRIVAL_MARK.
   */
  DEV_ROUTER_LOG_ARRIVALS?: string;
}

/**
 * How a line that says a request has ARRIVED begins. wrangler puts the
 * Worker's name in front of everything a Worker logs in a multi-config
 * session, so in its output the line reads `[dev-router] → POST /api/…`.
 *
 * wrangler writes its own line for a request (`[wrangler:info] POST … 201
 * Created (431ms)`) only once the request has answered. When `wrangler dev`
 * dies mid-request — `Error: Network connection lost.`, which it treats as
 * fatal (see web/scripts/dev-workers.sh) — the request it was serving is
 * therefore the one request the log never names. Every request passes through
 * here first, so a line on arrival closes that gap: in the session log, a
 * request that arrived and has no wrangler line before the crash banner was in
 * flight when wrangler died.
 *
 * Only while dev-workers.sh is keeping that log, which copies these lines into
 * the file and keeps them off the terminal. Kept in sync with the `case` in its
 * log_lines().
 */
const ARRIVAL_MARK = "→";

/**
 * Path prefix → the binding that serves it. A prefix matches the path exactly
 * or as a whole path segment, so `/api/u` claims `/api/u/<name>/track/<sha>`
 * without also swallowing `/api/user/tracks`. Written without trailing slashes
 * for that reason — `/api/u/` as a prefix would only ever match `/api/u//…`.
 */
/**
 * Where to ask "is the whole stack up?". Not under `/api`, so it can never
 * shadow a real route. Deliberately NOT exported: workerd rejects a module
 * whose named exports aren't handlers ("Incorrect type for map entry"). The
 * callers keep their own copy — `API_READY_URL` in e2e/fixtures/stack.ts and a
 * literal in the two serve scripts — and test/routes.test.ts pins the path.
 */
const READINESS_PATH = "/__ready";

const ROUTES: Array<[string, keyof Bindings]> = [
  ["/api/auth", "AUTH_API"],
  ["/api/airscore", "AIRSCORE_API"],
  ["/api/comp", "COMPETITION_API"],
  // Backs the root-level /civl-rankings.csv download. In production a Pages
  // Function forwards to this path over the service binding; in dev the Vite
  // proxy rewrites the root URL to it (see vite.config.ts).
  ["/api/civl-rankings.csv", "COMPETITION_API"],
  ["/api/user", "COMPETITION_API"],
  ["/api/u", "COMPETITION_API"],
  ["/api/admin", "COMPETITION_API"],
  // The OAuth discovery documents MCP clients fetch from the origin root
  // (docs/2026-10-24-mcp-oauth-plan.md). Pages Functions in production:
  // functions/.well-known/.
  ["/.well-known/oauth-authorization-server", "AUTH_API"],
  ["/.well-known/oauth-protected-resource", "AUTH_API"],
  ["/.well-known/openid-configuration", "AUTH_API"],
  // The MCP endpoint and its server card; functions/mcp/[[path]].ts in production.
  ["/mcp", "MCP_API"],
];

/**
 * Readiness probe for every Worker in the session, not just one.
 *
 * This matters because of what the single port took away. With a Worker per
 * port, Playwright waited on `:8788/api/auth/me` AND `:8789/api/comp` and so
 * proved both were loaded. Behind one port, a probe of `/api/comp` proves only
 * that competition-api is up — auth-api can still be loading, and a request
 * that lands on a Worker mid-load makes wrangler's ProxyWorker report
 * `Error: Network connection lost.`, which its ProxyController treats as fatal
 * and exits `wrangler dev` on. That is the same "the dev server died 35 s in"
 * failure as issue #477's, reached by a different route.
 *
 * So: 200 only when every binding answers. Anything less is 503, which
 * Playwright reads as "not ready yet" and keeps polling (it accepts 200–403).
 *
 * Startup is only half of it: wrangler exits the same way when a client
 * connection is severed mid-request, at any point in a run. So this path is now
 * asked the same question twice — once by Playwright's `webServer` at startup,
 * and again by every test (`e2e/fixtures/test.ts`) so none of them runs while
 * the supervisor in `web/scripts/dev-workers.sh` is bringing wrangler back.
 */
async function readiness(env: Env): Promise<Response> {
  const probes: Array<[keyof Bindings, string]> = [
    ["AUTH_API", "/api/auth/me"],
    ["COMPETITION_API", "/api/comp"],
    ["AIRSCORE_API", "/api/airscore"],
    // 401s an unauthenticated probe, which is a sign of life.
    ["MCP_API", "/mcp"],
  ];

  const workers = Object.fromEntries(
    await Promise.all(
      probes.map(async ([binding, path]) => {
        try {
          const res = await env[binding].fetch(
            new Request(`http://dev-router${path}`)
          );
          // Any HTTP answer means the Worker is loaded and serving; airscore
          // 404s its own root, which is a perfectly good sign of life.
          return [binding, res.status < 500 ? "ok" : `status ${res.status}`];
        } catch (err) {
          return [binding, (err as Error).message];
        }
      })
    )
  );

  const ready = Object.values(workers).every((v) => v === "ok");
  return Response.json({ ready, workers }, { status: ready ? 200 : 503 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname, search } = new URL(request.url);
    if (env.DEV_ROUTER_LOG_ARRIVALS) {
      console.log(`${ARRIVAL_MARK} ${request.method} ${pathname}${search}`);
    }

    if (pathname === READINESS_PATH) return readiness(env);

    for (const [prefix, binding] of ROUTES) {
      if (pathname === prefix || pathname.startsWith(prefix + "/")) {
        return env[binding].fetch(request);
      }
    }

    return new Response(
      `dev-router: no worker bound for ${pathname}. Known prefixes: ` +
        ROUTES.map(([p]) => p).join(", "),
      { status: 404 }
    );
  },
};
