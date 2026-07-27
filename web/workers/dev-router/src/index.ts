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

interface Env {
  AUTH_API: Fetcher;
  COMPETITION_API: Fetcher;
  AIRSCORE_API: Fetcher;
}

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

const ROUTES: Array<[string, keyof Env]> = [
  ["/api/auth", "AUTH_API"],
  ["/api/airscore", "AIRSCORE_API"],
  ["/api/comp", "COMPETITION_API"],
  ["/api/user", "COMPETITION_API"],
  ["/api/u", "COMPETITION_API"],
  ["/api/admin", "COMPETITION_API"],
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
 */
async function readiness(env: Env): Promise<Response> {
  const probes: Array<[keyof Env, string]> = [
    ["AUTH_API", "/api/auth/me"],
    ["COMPETITION_API", "/api/comp"],
    ["AIRSCORE_API", "/api/airscore"],
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
    const { pathname } = new URL(request.url);

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
