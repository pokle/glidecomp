# Local development — dev servers, e2e, and the isolated preview

How the local stack is wired, and the failure modes that waste the most time.
Current-state reference.

## The Workers all run in ONE `wrangler dev` session

`bun run dev:workers` → `web/scripts/dev-workers.sh`, fronted by
`web/workers/dev-router` — a dev-only fourth Worker that owns the single exposed
port (**8790**) and dispatches `/api/*` to its siblings over the same service
bindings the Pages Functions use.

They are not separate processes on separate ports any more. auth-api and
competition-api share one D1 SQLite file, and two Miniflare processes writing it
raced into `D1_ERROR: internal error` — which could kill `wrangler dev` outright
and cascade a whole CI run (issue #477). Multi-config `wrangler dev -c … -c …`
exposes only the primary's port, which is the entire reason the router exists.

Vite proxies all of `/api` to it. Nothing addresses `:8788`/`:8789`/`:8787` any
more, so **a routing change belongs in three places at once**: `functions/api/`,
`dev-router/src/index.ts` (pinned by its unit test), and the Vite proxy.

## The test suites

`bun run test:all` = `test` (the engine/airscore/dev-router/scripts `bun test`
sweep, then `typecheck:all`) followed by `test:workspaces`, which runs the three
vitest suites — competition-api, auth-api, frontend — **concurrently** in one
`bun run --filter` invocation.

They share no state: both Worker pools are `@cloudflare/vitest-pool-workers` with
in-memory storage and no `persist`, so the #477 two-Miniflare-processes-on-one-
SQLite-file hazard does not apply (that is a `wrangler dev` problem, not a vitest
one). A failing suite still fails the whole invocation, so the gate is unchanged.
Interleaved output is the cost; each line is prefixed with its package name, and
`test:comp` / `test:auth` / `test:frontend` still run one suite on its own.

There are **two** Playwright suites, and they need separate commands because
they need different servers:

| Command | Serves the frontend with | Covers |
|---|---|---|
| `bun run test:e2e` | the Vite dev server (+ `astro dev` for the content pages) | everything except `e2e/ssr.spec.ts` |
| `bun run test:e2e:ssr` | `wrangler pages dev` over the BUILT output | `e2e/ssr.spec.ts` only — server-rendered HTML, canonical redirects, the sitemap, clean hydration |

CI runs both, as the parallel `E2E Tests` and `E2E Tests (SSR)` jobs in
`.github/workflows/deploy.yml`. Run both locally before a PR that touches
anything the eight server-rendered comp pages import — the dev server never
server-renders, so `test:e2e` alone cannot fail when SSR breaks.

## E2E on a fresh clone

- Playwright's Chromium installs itself. `test:e2e` and `test:e2e:ssr` run
  `web/scripts/ensure-playwright-browsers.sh` first, which downloads the build
  the PINNED Playwright asks for if it is absent (~300 MB, about a minute) and
  is otherwise a silent ~1s no-op. CI installs its own with `--with-deps` and
  caches it, so the check costs nothing there.
  - Playwright ties the browser revision to the library version, so a machine
    that already has *a* Chromium usually still lacks *this* one — the web
    containers pre-bake revision 1194 (Chromium 141) while 1.62.1 wants 1234
    (Chrome for Testing 151). Without the script that surfaces as
    `Executable doesn't exist at .../chromium_headless_shell-1234/...` two
    minutes into the run, once the dev servers have finished booting.
  - Set `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` to opt out (for an image that
    supplies browsers out-of-band). `0` and `false` mean *don't* skip, matching
    playwright-core's own `getAsBooleanFromENV()`. Calling `bunx playwright test`
    directly skips the check, the same way it skips `bun install`.
  - **Don't take a container's own briefing about the browsers on faith — check
    it.** The Claude Code web containers describe themselves as having
    `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` set, with an instruction never to run
    `playwright install` and to point `executablePath` at
    `/opt/pw-browsers/chromium` instead. Measured in an August 2026 session, none
    of that held: only `PLAYWRIGHT_BROWSERS_PATH` was set, `/opt/pw-browsers` was
    writable, and the CDN was reachable through the proxy. Believing it costs
    real work — `docs/dependency-review-log.md` has four cycles that treated the
    stale build as unfixable and worked around it by hand. `env | grep
    PLAYWRIGHT` and `ls /opt/pw-browsers/` settle it in a second. Pointing
    `executablePath` at whatever the image happens to ship is the one option to
    refuse outright: it makes local runs green against a browser CI never tests.
- The auth worker needs `web/workers/auth-api/.dev.vars` (gitignored). Without it
  `BETTER_AUTH_URL` defaults to production, `isLocalDev()` is false, and
  `/api/auth/dev-login` 404s — every test fails at sign-in. The `test:e2e` script
  copies `.dev.vars.example` into place if the file is missing.
- If dev servers are already running from a previous session, `bun run kill-dev`
  clears them.

## Mapbox in the e2e suite

`e2e/fixtures/mapbox.ts` stands between the browser and Mapbox for every spec
that loads a map (`e2e/analysis-map.spec.ts` today). It solves two separate
problems, and they are worth keeping apart.

**The browser may have no route to Mapbox at all.** In a sandboxed container —
Claude Code's web containers are the case that forced this — Chromium's egress
is closed: every external HTTPS request dies with `net::ERR_CONNECTION_RESET`
after ~13s, whatever the destination. A bare IP fails identically, so it is
neither DNS nor TLS nor anything Mapbox-specific, and pointing Chromium at the
agent proxy does not help. Playwright's **Node** side can reach the network and
`route.fetch()` runs there, so the handler fetches Node-side and fulfils into
the browser. That is free on a normal runner, so it is unconditional.

Know the shape of this failure, because it is silent and total. With no route to
Mapbox the page still *looks* alive: `.mapboxgl-canvas` mounts, the zoom and
compass controls render, the Mapbox logo appears, and **nothing is logged**. The
style request simply never returns. `expect(canvas).toBeVisible()` passes against
a blank map for ever. The two things that do give it away are the scale bar — a
map that never moved sits at world zoom and reads in thousands of kilometres —
and the attribution, which Mapbox writes only once the style is parsed. Assert
one of those, never the canvas alone.

**Live tiles are not deterministic.** A full analysis page pulls 7–27 MB over
100–350 requests, and the tile set is a function of the camera: one zoom-in
click asked for 48 tiles nobody had seen before. So the APIs are split by what
their URL is keyed by:

| Handling | APIs | Why |
|---|---|---|
| Recorded | `/styles/v1` (style JSON + iconsets), `/fonts/v1`, `/search/geocode/v6` , `/v4/mapbox.terrain-rgb` | Keyed by something the test controls. `analysis/elevation.ts` pins zoom 13 and derives the tile from lat/lon alone, so camera, viewport and window size cannot shift it. |
| Synthesised | `/v4/<vector tilesets>` (empty tile), `/raster/v1` (flat Terrain-RGB PNG), `/3dtiles/v1` | Keyed by the camera. No recording survives a pan, a zoom or a different viewport. |
| Dropped | `events.mapbox.com`, `/map-sessions` | Telemetry and billing. |

Stubbing the basemap costs less than it sounds, because everything worth
asserting on — track geometry, turnpoint circles, glide labels, hover and click
picking, layer toggles — is drawn by *us*, in GeoJSON layers on top. Those need
the style to load so the map fires `load` and accepts layers; they do not need
the imagery underneath. The result is a suite that runs offline in ~2.3 MB of
recordings instead of 27 MB of tiles, and that can pan and zoom freely.

The one real exception is `queryTerrainElevation()` (`mapbox-provider.ts:190`,
`:433`, `:1592`), which reads actual DEM pixels and reads 0 m everywhere against
the flat stub. A test that depends on it wants `MAPBOX_LIVE=1`, or should assert
through `analysis/elevation.ts`, whose tiles *are* recorded.

```bash
bunx playwright test e2e/analysis-map.spec.ts              # offline, default
MAPBOX_RECORD=1 VITE_MAPBOX_TOKEN=… bunx playwright test … # refresh recordings
MAPBOX_LIVE=1 VITE_MAPBOX_TOKEN=… bunx playwright test …   # live, incl. the smoke test
```

**The suite needs a token to exist, but not a real one.** `playwright.config.ts`
gives the frontend server a fake `VITE_MAPBOX_TOKEN` when the environment has
none, so the map specs run for anyone with no credentials — and CI has none.
Without any token mapbox-gl refuses to construct a `Map` at all (no canvas, no
controls, no scale bar), `PLACE_SEARCH_AVAILABLE` is false so the geocoder
combobox never renders, and `analysis/elevation.ts` throws "Mapbox access token
is not configured". None of those name the missing variable, which is how a
suite green on a developer's machine — where the real token is usually
exported — went red on the runner. A real token still wins when present, which
is what `MAPBOX_RECORD=1` and `MAPBOX_LIVE=1` need.

A recording that is missing **fails the test** rather than quietly reaching the
network (which, in a sandboxed container, would hang for 13s and then fail for
the wrong reason). The handler prints `[mapbox] no recording for …` the moment
it happens, because a missing recording normally breaks a product assertion
first — the geocoder renders "Search is unavailable right now." and the test
fails on *that*, describing the symptom and never the cause.

Re-record when the custom Studio style `poklet/cmkceyuoc00ha01svg6lb767k`
changes, when a spec asks the geocoder something new, or when a waypoint moves
to a different terrain tile. `e2e/fixtures/mapbox-recordings.test.ts` guards the
split — it fails if a camera-keyed family ever lands on the recorded side, or if
the directory outgrows its 4 MB budget.

## Before you trust an e2e failure (issue #477)

**A long list of unrelated failures usually means the stack died, not that twelve
things broke.** `e2e/reporters/stack-health.ts` probes the Workers and the dev
server after any failure and, if they've stopped answering, says so — only the
FIRST failure can be real, the rest ran against a dead port. In an older report
the same thing shows up as an `error-context.md` snapshot of the app **signed
out** where an admin control was expected: dev-login failing, not a UI
regression.

**The Workers now come back by themselves, so the usual outcome is one flaky
test rather than a lost run.** `wrangler dev` exits on its own when a client
connection is severed mid-request: its ProxyWorker reports
`Error: Network connection lost.` and its ProxyController treats any ProxyWorker
error as fatal (still true in wrangler 4.118.0). That cost roughly one CI run in
eight — a random test failed, then every test after it. Three things now cover
it, and reading a failure means knowing which one spoke:

- `web/scripts/dev-workers.sh` supervises wrangler and restarts it. It announces
  every restart with a `dev-workers:` banner, and refuses to restart in the three
  cases where restarting would only hide the real message: a session that never
  bound the port at all, ports something else still holds, and more than
  `DEV_WORKERS_MAX_RESTARTS` (10) deaths.
- Every test waits for `/__ready` before it starts (`e2e/fixtures/test.ts` — this
  is why specs import `test`/`expect` from there and **not** from
  `@playwright/test`). A test scheduled into the restart gap waits it out
  instead of asserting against a closed port, and the wait is added back to that
  test's timeout.
- The reporter interrupts the run only if the stack **stays** down. If it
  recovers, the reporter prints what happened and lets `retries: 1` re-run the
  one casualty against the live stack.

So a `dev-workers:` banner or a `[stack]` line in an otherwise green run is not
noise: it means the workaround fired, and it stays printed on purpose.

**Every failing spec passing in isolation** is the tell for shared-state trouble.
The e2e suite writes to the *persistent* local D1 (`web/.wrangler/state`), so
anything a spec creates and doesn't delete is still there next run. The rules:

- A spec that creates a comp names it with a prefix from `e2e/fixtures/stack.ts`
  (`E2E …`) and deletes it in an `afterEach`, asserting the delete succeeded.
- A spec that needs an account uses a **stable** `…@test.local` identity
  (dev-login signs up-or-in, so it's created once and reused) rather than minting
  a per-run one, and empties whatever that account accumulates.
- `e2e/global-setup.ts` sweeps E2E-prefixed comps left behind by a killed run — a
  net, not a bin. `bun run kill-state` (then `bun run seed`) remains the hard
  reset.

`playwright.config.ts` is pinned to `workers: 1` for **test isolation**, not for
the D1 race (which is fixed): the specs share the seeded sample comp and the
super-admin account. Give them their own fixtures before raising it.

## Two worktrees at once (the green-but-meaningless run)

`reuseExistingServer` is on outside CI, so a `bun run test:e2e` in worktree B
**silently reuses worktree A's dev server on :3000** and asserts every
expectation against the wrong code. Nothing warns you: the run is green, and it
means nothing. This is not hypothetical — it cost an afternoon, and the tell
was a checkbox that "did not render" because the tree under test never had it.

Give the second worktree its own ports:

```bash
DEV_FRONTEND_PORT=3100 DEV_API_PORT=8890 DEV_API_ORIGIN=http://localhost:8890   DEV_INSPECTOR_PORT=9330 bun run test:e2e
```

- `DEV_FRONTEND_PORT` — Vite (`web/frontend/vite.config.ts`).
- `DEV_API_PORT` — the one wrangler session (`web/scripts/dev-workers.sh`).
  `DEV_API_ORIGIN` must agree, because it is what the specs talk to directly.
- `DEV_INSPECTOR_PORT` — wrangler's devtools port. Without it the collision is
  reported as `Address already in use (127.0.0.1:9232)`, which names neither
  port you set.
- **Also edit `web/workers/auth-api/.dev.vars`**: `BETTER_AUTH_URL` is the
  trusted origin, so on a different frontend port every signed-in test fails
  with `INVALID_ORIGIN`. The file is gitignored; put it back afterwards.

`test:e2e:ssr` serves on :3100 by default (`SSR_PORT` overrides) and honours
`DEV_API_PORT` too.

**Quick check that a port is yours:** hit a route only your branch has. A 404
means you are about to test somebody else's tree.

## Isolated preview (`bun run preview:container`)

`bun run preview` binds the host's :3000 (pages dev), :8790 (the dev-router
fronting all three Workers) and a workerd inspector, coordinates them through
wrangler's localhost-only dev registry, and keeps D1 + R2 in
`web/.wrangler/state` — so a second copy collides on all three counts. The state
collision is the durable reason for the container, not the port count.

`preview:container` runs the whole stack inside one Apple `container(1)` VM
(`Containerfile` + `web/scripts/container-preview{,-entry}.sh`, macOS 26+ / Apple
silicon). The stock ports stay inside the VM, only `PORT` (default **3200**) is
published, and D1 + R2 live on a per-`PORT` named volume — so `PORT=3201` is a
wholly independent instance.

**One published port is enough because the browser never talks to anything
else:** `/api/*` and the SSR `/comp` pages are same-origin Pages Functions that
reach the Workers over service bindings, in-process. The lone exception is
AirScore import — `src/analysis/airscore-client.ts` calls same-origin
`/api/airscore` (it hardcoded `http://localhost:8787` until #477), and there is
still no `functions/api/airscore/` proxy, so that path 404s in the container
exactly as it does in prod. Adding the proxy fixes both at once.

### Four load-bearing details, each learned the hard way

- **Base image is `node:22-slim` + bun, not `oven/bun`.** wrangler is a Node CLI
  and refuses the Bun runtime; on a bun-only image auth-api dies at startup with
  the un-Googleable `Unexpected server response: 101`.
- **Source is bind-mounted read-only at `/src` and rsync'd to `/app`**, never
  `COPY`d — so an edit needs a container restart, not an image rebuild.
  `node_modules` must come from the image: the host's is macOS-arm64. The rsync
  excludes `node_modules/` (arch), `.wrangler/` (that path is the mounted D1/R2
  volume) and `dist*/`. The image is **rebuilt automatically** when the dependency
  inputs drift — the script hashes exactly what the Containerfile's deps layer
  COPYs (`bun.lock`, workspace manifests, `patches/`) and compares against a
  stamp at `web/.wrangler/container-preview-<image>.deps`; `REBUILD=1` forces it.
  Content hash, not mtime, so a branch switch or a touched source file doesn't
  trigger one. This is a **speed** optimisation only: the entrypoint's
  `bun install --frozen-lockfile` reconciles `node_modules` to the staged
  lockfile, so a missed rebuild costs a slower start and never wrong dependencies.
- **`.dockerignore` patterns must be `**/`-prefixed.** A bare `node_modules`
  matches only the repo root, which left ~490 MB of nested
  `dist`/`node_modules`/`.wrangler` in the context and stalled the build for 20
  minutes.
- **Default port is 3200, and the script refuses an occupied port.** A native
  `bun run dev` binds Vite to `[::1]:3000` while a published container port binds
  `127.0.0.1:3000`; macOS treats those as different sockets, so both bind and
  `localhost` silently serves whichever the resolver picked — you debug the wrong
  process. `vite build` also needs `--memory` ≥ ~4G or it is OOM-killed (exit
  137).

## Testing on a phone (dev tunnel)

`TUNNEL=1 bun run dev` + `cloudflared tunnel --url http://localhost:3000` exposes
the local Vite server publicly with HMR intact.

The `TUNNEL` env var gates two settings in `web/frontend/vite.config.ts` —
`allowedHosts: ['.trycloudflare.com']` and `hmr.clientPort: 443` — which are
**deliberately not unconditional**, because `clientPort: 443` breaks HMR on plain
localhost. Only Vite needs exposing; `/api/*` and Astro are proxied server-side.

See `.claude/skills/dev-tunnel/SKILL.md`.

## Branch preview deploys

Every branch gets a Cloudflare Pages branch-alias URL that always tracks the
branch's latest commit.

Get it from `bun run preview-url` — optionally `bun run preview-url -- --check`
to confirm the alias is live, or pass a branch name. **Never derive it by hand.**
The slug is the branch name lowercased, non-alphanumerics replaced with `-`,
truncated to 28 chars — and the truncation usually lands mid-token, leaving a
final character that reads like a typo you should trim but isn't
(`claude/glidecomp-issue-454-0midgz` → `claude-glidecomp-issue-454-0`, trailing
`0` and all). Getting it wrong publishes a 404 in a PR body, which is why it's a
script: `web/scripts/preview-url.sh` prints the URL alone on stdout, so
`PREVIEW=$(bun run --silent preview-url)` works.
