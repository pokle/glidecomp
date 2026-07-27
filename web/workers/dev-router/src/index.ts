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
const ROUTES: Array<[string, keyof Env]> = [
  ["/api/auth", "AUTH_API"],
  ["/api/airscore", "AIRSCORE_API"],
  ["/api/comp", "COMPETITION_API"],
  ["/api/user", "COMPETITION_API"],
  ["/api/u", "COMPETITION_API"],
  ["/api/admin", "COMPETITION_API"],
];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

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
