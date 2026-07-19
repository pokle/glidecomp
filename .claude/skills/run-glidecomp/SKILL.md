---
name: run-glidecomp
description: Build, launch, and drive the GlideComp web app (Vite frontend + Cloudflare Workers on D1/R2). Use to run, start, serve, smoke-test, or screenshot GlideComp — seed the sample competitions and verify the comp/scores pages render in a headless browser.
---

# Run GlideComp

GlideComp is a Cloudflare monorepo: a Vite multi-page frontend (Cloudflare
Pages, port **3000**) that proxies `/api/*` to three local Workers — auth
(**8788**), competition-api (**8789**), airscore (**8787**) — backed by
local D1 + R2. Track analysis and **open-distance scoring run client-side in
the browser**, so a real check means loading a page and reading the rendered
scores, not just curling an API.

The agent path is a Playwright driver, [`driver.mjs`](driver.mjs), that
resolves a seeded comp from `/api/comp`, loads its comp + scores pages, and
screenshots them. Paths below are relative to the repo root.

## Prerequisites

- **bun** (repo uses bun; `node_modules/` via `bun install`).
- **Playwright chromium** — installed once; the pinned build may differ from
  what's cached, so install explicitly:
  ```bash
  bunx playwright install chromium
  ```
- **auth Worker dev vars** — without this, sign-in/auth 404s. The file is
  gitignored; copy the example:
  ```bash
  [ -f web/workers/auth-api/.dev.vars ] || cp web/workers/auth-api/.dev.vars.example web/workers/auth-api/.dev.vars
  ```

## Build & launch (agent path)

1. **Start the full stack** (runs `db:migrate`, then workers + frontend). Give
   it ~15s; it stays running:
   ```bash
   bun run dev
   ```
   Ready when `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/`
   returns `200` and the log shows all three Workers `Ready on http://localhost:878x`.
   Stale servers from a prior run? `bun run kill-dev`.

2. **Seed the sample competitions** (idempotent; seeds all bundled comps,
   ~1,500 tracks in ~11s):
   ```bash
   bun run seed
   ```
   (Pass slugs to seed a subset, e.g. `bun run seed corryong-cup-2026`.)
   The fabricated fixtures (`big-chip`, `kosci-loop`) seed **hidden** — they're
   invisible to anonymous visitors and need an admin sign-in to view.

3. **Drive it** — loads the comp, loads its scores, screenshots both, asserts
   the scores table rendered and there were no console errors:
   ```bash
   bun .claude/skills/run-glidecomp/driver.mjs
   ```
   Expected output ends with `✓ drove Corryong Cup 2026 end-to-end`. Screenshots
   land in `.claude/skills/run-glidecomp/shots/` (`comp.png`, `scores.png`) —
   **open `scores.png` and look at it**; it should show a ~99-row GAP standings
   table with per-task points and a descending total (Jon Durand tops it at
   ~2,433). Known quirk: `comp.png` and `scores.png` currently come out
   byte-identical — `/comp/:id` carries the standings inline now, so the
   driver's second stop (`/scores?comp_id=…`) renders the same view.

   To drive the open-distance path instead, use the hidden Big Chip comp — it
   needs an admin session, since hidden comps 404 anonymously:
   `COMP_MATCH="Big Chip" bun .claude/skills/run-glidecomp/driver.mjs` will fail
   at comp discovery until the driver is given a signed-in admin cookie.

   Override target with env vars: `BASE_URL`, `COMP_MATCH` (e.g.
   `COMP_MATCH=Corryong bun .claude/skills/run-glidecomp/driver.mjs`).

4. **Drive the admin-only Field Analysis pages** — signs in as the super-admin,
   follows the task page's "Field analysis" link, waits out the background
   compute, expands a metric family, then checks the comp-level aggregate and
   that an anonymous visitor is gated:
   ```bash
   bun .claude/skills/run-glidecomp/drive-field-analysis.mjs
   ```
   Ends with `✓ drove field analysis end-to-end`; shots land in `shots/`
   (`fa-task.png`, `fa-task-family.png`, `fa-comp.png`, `fa-anon.png`).
   **Breadcrumbs / navigation hierarchy** have their own driver — it asserts
   the trail text on every `/comp` page and walks the field-analysis journey
   (comp detail → Field analysis → a task chapter → up one level), including
   the legacy-URL redirect and the "View task" sibling link:
   ```bash
   bun .claude/skills/run-glidecomp/drive-breadcrumbs.mjs
   ```
   Ends with `✓ breadcrumb hierarchy verified end-to-end`; shots in
   `shots/bc-*.png`. **Gotcha:** read a trail only after the page's *own*
   chrome appears — `waitForURL` resolves while React still has the previous
   route mounted, and the comp/task names arrive from a later fetch, so a
   single read races both and reports the old page's trail. The driver's
   `trail()` polls toward an expected string for this reason.

   Cross-check the rendered separation ranking against the engine directly:
   `bun run score-task -- --wing HG --field-analysis web/samples/comps/corryong-cup-2026-open-t1/task.xctsk web/samples/comps/corryong-cup-2026-open-t1/`
   — the ρ values must match exactly.

## Run (human path)

`bun run dev`, then open `http://localhost:3000/comp` in a browser, pick a
comp, click **View scores →**. Useful interactively; useless headless (no way
to observe the client-rendered scores) — that's what the driver is for.

## Test

```bash
bun run test          # engine + airscore worker unit tests (bun test) + typecheck:all
bun run test:e2e      # Playwright e2e (auto-copies .dev.vars, runs db:migrate)
```

The **frontend** unit suite is separate — `bun run test` scopes `bun test` to
`./web/engine ./web/workers/airscore-api`, so it does NOT run `web/frontend`.
Run those with vitest:

```bash
cd web/frontend && bunx vitest run     # or: bun run --filter '@glidecomp/frontend' test
```

- The frontend suite is **vitest**: test files import `{ describe, it, expect, vi }`
  from `'vitest'` and mock with `vi.mock(...)`. Don't write frontend tests
  against `'bun:test'`/`mock.module(...)` — vitest picks them up (they match
  `src/**/*.test.ts`) and fails them at transform time trying to resolve the
  real `mapbox-gl`. (This was the long-standing "3 replay suites always fail
  under `vitest run`" annoyance — the `src/replay/*.test.ts` files were
  bun-native; they're vitest now.)
- To stub `mapbox-gl` (can't run headless) in a vitest unit test, `vi.mock('mapbox-gl', () => ({}))`
  at top level, then `await import('./the-module-under-test')`. The CSS
  side-effect import (`mapbox-gl/dist/mapbox-gl.css`) needs no mock — vitest
  resolves CSS to an empty module by default.

## Gotchas

- **Driving admin-only UI (settings / route-editor / waypoint editor) headless:**
  sign in with dev-login *from inside the page* so the browser stores the
  session cookie — `page.goto('/comp')`, then `page.evaluate(() =>
  fetch('/api/auth/dev-login', { method: 'POST', headers: { 'Content-Type':
  'application/json' }, body: JSON.stringify({ name, email }), credentials:
  'include' }))`. Playwright's `ctx.request.post()` breaks under bun on the
  relative-URL set-cookie, and fetching from the static home page `/` fails —
  use an SPA page. Wait for `networkidle` before logging in: a login racing
  the page's own API calls can trip local D1's transient-500 contention flake.
  **Two follow-on traps that look like map/render failures but are auth:**
  (1) log in as the **super-admin** `tushar.pokle@gmail.com` (hardcoded in
  `web/workers/competition-api/src/super-admin.ts`) — a throwaway email is
  `is_admin: false` on every comp, so the admin controls (Add-from-map, the
  editable table) never render. (2) A brand-new account is **redirected to
  `/onboarding`** before any comp page loads; complete it (fill Full name +
  Username, click Continue) then re-navigate, or you'll wait forever for a
  map selector that the onboarding page doesn't have.
- **"There's no Mapbox token" is almost always WRONG.** The token IS
  configured — it just lives in **`.env` at the repo root**, not
  `web/frontend/` — `vite.config.ts` sets `envDir: '../..'`, so
  `ls web/frontend/.env*` finds nothing and you conclude "no token." Check the
  repo root (`grep VITE_MAPBOX_TOKEN ./.env`). Mapbox is the only map provider,
  so the real **Mapbox** canvas renders (`.mapboxgl-canvas`) and its features
  (snap-to-peak, place-name pre-fill, terrain DEM) work — verify against it. If
  a drive times out waiting for `.mapboxgl-canvas`, it's the auth/onboarding trap
  above, not the token. The Mapbox `Map` instance is **not** exposed on
  `window`; to drive a specific location, use the waypoint table's per-row
  locate button (pans via `panTo`) rather than hunting for a label's canvas
  pixel.
- **`bun run dev` dies if you pipe it** (`bun run dev | tail`) — the pipe closes
  and takes the stack with it. Redirect to a file instead:
  `bun run dev > /tmp/glidecomp-dev.log 2>&1`.
- **`waitUntil: "networkidle"` never settles on pages with a freshness poller**
  (field analysis; any scores view showing a stale banner). `ScoreFreshness`
  keeps a conditional request in flight by design. Use `"domcontentloaded"` plus
  a role locator, or the drive times out on a page that rendered perfectly.
- **The comp's public id (sqid) changes every seed.** Never hardcode it; the
  driver resolves it by matching the comp **name** via `GET /api/comp`. If you
  navigate by hand, grab the id from that endpoint first.
- **Open-distance scores are distances in metres**, computed in the browser
  from the takeoff-cylinder exit. A `0` is correct — that pilot never left the
  5 km launch cylinder. Don't read `0`/`573` as a bug.
- **Playwright browser mismatch** surfaces as `Executable doesn't exist at
  .../chromium_headless_shell-<N>`. The cache had older builds than the pinned
  version — `bunx playwright install chromium` fixes it. This is the same
  install CI does with `--with-deps`.
- **Frontend proxies `/api`** to the Workers; hitting comp-api directly on
  `:8789` works too, but the driver uses `:3000` so it exercises the proxy.
- **`playwright` isn't directly resolvable**, but `@playwright/test` is — the
  driver imports `{ chromium }` from `@playwright/test`.

## Troubleshooting

- `GET /api/comp failed` from the driver → dev stack isn't up. Run `bun run
  dev`, wait for `200` on `http://localhost:3000/`.
- `no comp matching "Corryong Cup 2026"` → not seeded. Run `bun run seed`.
  Note the driver browses anonymously, so it can only find **public** comps —
  pointing `COMP_MATCH` at Big Chip or Kosciuszko Loop will always fail.
- Auth/sign-in 404s or every e2e test fails at sign-in → missing
  `web/workers/auth-api/.dev.vars` (see Prerequisites).
