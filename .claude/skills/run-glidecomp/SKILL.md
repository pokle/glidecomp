---
name: run-glidecomp
description: Build, launch, and drive the GlideComp web app (Vite frontend + Cloudflare Workers on D1/R2). Use to run, start, serve, smoke-test, or screenshot GlideComp — seed a sample competition and verify the comp/scores pages render in a headless browser.
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

2. **Seed a sample competition** (idempotent; open-distance comp with 50
   pilots × 2 tasks):
   ```bash
   bun run seed:sample big-chip
   ```
   (Omit the slug for the default Corryong Cup GAP comp.)

3. **Drive it** — loads the comp, loads its scores, screenshots both, asserts
   the scores table rendered and there were no console errors:
   ```bash
   bun .claude/skills/run-glidecomp/driver.mjs
   ```
   Expected output ends with `✓ drove Big Chip (Sample) end-to-end`. Screenshots
   land in `.claude/skills/run-glidecomp/shots/` (`comp.png`, `scores.png`) —
   **open `scores.png` and look at it**; it should show a 50-row scores table,
   distances descending from ~89 km / ~143 km down to `0` for pilots who
   landed inside the launch cylinder.

   Override target with env vars: `BASE_URL`, `COMP_MATCH` (e.g.
   `COMP_MATCH=Corryong bun .claude/skills/run-glidecomp/driver.mjs`).

## Run (human path)

`bun run dev`, then open `http://localhost:3000/comp` in a browser, pick a
comp, click **View scores →**. Useful interactively; useless headless (no way
to observe the client-rendered scores) — that's what the driver is for.

## Test

```bash
bun run test          # engine + worker unit tests + typecheck:all
bun run test:e2e      # Playwright e2e (auto-copies .dev.vars, runs db:migrate)
```

## Gotchas

- **Driving admin-only UI (settings / route-editor dialogs) headless:** sign
  in with dev-login *from inside the page* so the browser stores the session
  cookie — `page.goto('/comp')`, then `page.evaluate(() =>
  fetch('/api/auth/dev-login', { method: 'POST', headers: { 'Content-Type':
  'application/json' }, body: JSON.stringify({ name, email }), credentials:
  'include' }))`. Playwright's `ctx.request.post()` breaks under bun on the
  relative-URL set-cookie, and fetching from the static home page `/` fails —
  use an SPA page. Wait for `networkidle` before logging in: a login racing
  the page's own API calls can trip local D1's transient-500 contention flake.
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
- `no comp matching "Big Chip"` → not seeded. `bun run seed:sample big-chip`.
- Auth/sign-in 404s or every e2e test fails at sign-in → missing
  `web/workers/auth-api/.dev.vars` (see Prerequisites).
