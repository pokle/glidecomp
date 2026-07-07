# CLAUDE.md

## Project Overview

GlideComp is a web application for analyzing hanggliding/paragliding competition track logs (IGC files). It provides task analysis, scoring explanations, glide and thermal analysis.

## Architecture

Cloudflare monorepo, free-tier focused:

- `web/engine` — pure TypeScript analysis library (IGC/XCTask parsing, event detection, GAP scoring). No DOM dependencies; all track analysis runs client-side in the browser.
- `web/frontend` — Vite app on Cloudflare Pages. The main UI (competitions, comp/task detail, scores, dashboard, profile, settings, onboarding) is a React SPA under `src/react/` served from `src/app.html`, built with shadcn/ui components (Base UI foundation) in `src/react/ui/` and Tailwind (tokens in `src/react/globals.css`). The content pages (home `/`, `/about`, `/legal`, `/scoring`, `/scoring/gap`, `/scoring/open-distance`) are prerendered static HTML built by a small Astro app in `web/frontend/static/` — zero client JS (KaTeX on the GAP page is prerendered at build via `katex.renderToString`), reusing the SPA's `globals.css` tokens/fonts. The analysis page and 3D replay remain separate vanilla-TS Vite entries. `bun run build` runs the Vite build then the Astro build and merges both into `dist/`; `bun run dev` runs Vite + `astro dev` together and proxies the static routes (and Astro's `/_static` dev namespace) so everything is seamless on `:3000`. SPA routes reach `/app.html` via `public/_redirects`; the static pages are served directly.
- `web/workers/*` — Workers (auth-api, competition-api, airscore-api) backed by D1 + R2, handling accounts, user file storage, and competition management. Reached via Pages Functions proxies in `functions/api/`.

## Build & Development

If `node_modules/` is missing or a dependency can't be resolved, run `bun install` before proceeding. Build commands are in `package.json` scripts. Key ones: `bun run dev`, `bun run test`, `bun run typecheck:all`.

**E2E tests (`bun run test:e2e`) on a fresh clone:**
- Playwright browsers must be installed first: `bunx playwright install chromium` (CI uses `--with-deps`).
- The auth worker needs `web/workers/auth-api/.dev.vars` (gitignored). Without it `BETTER_AUTH_URL` defaults to production, `isLocalDev()` is false, and `/api/auth/dev-login` 404s — every test fails at sign-in. The `test:e2e` script copies `.dev.vars.example` into place if the file is missing.
- If dev servers are already running from a previous session, `bun run kill-dev` clears them.

**Production:** https://glidecomp.com

**Updating bundled data:**
- **Sample competition:** the bundled Corryong Cup 2026 comp lives under `web/samples/comps/`, one folder per task (`corryong-cup-2026-<class>-t<N>`) plus a `corryong-cup-2026/` meta folder (`comp.json` manifest + region `waypoints.wpt`/`.json`). AirScore scores the event as two comps — **open** and **floater** — flying different tasks per day; here they become one comp with two pilot classes (a pilot who flew both, e.g. CIVL 46402, gets one `comp_pilot` row per class).
  - **Re-download from source:** `bun web/scripts/download-airscore-comp.ts corryong-cup-2026` — idempotent, politely rate-limited (`REQUEST_DELAY_MS`, default 3500ms). Rebuilds every task folder + waypoints from xc.highcloud.net; a folder with a `.curated` marker (e.g. `corryong-cup-2026-open-t1`, the AirScore-parity fixture) is left untouched. Add new comps to the `COMPS` registry in that script.
  - **Seed into D1 + R2:** `bun run seed:sample` (idempotent; `--remote` for prod) reads `comp.json` and loads all tasks/classes/pilots/tracks. Pass a slug to seed a different bundled comp (e.g. `bun run seed:sample big-chip`). The manifest may set `comp_name` (the D1 comp name; defaults to the fixed Corryong `SAMPLE_COMP_NAME`), `category`, and `scoring_format` (`gap` | `open_distance`; default `gap`). The 3D replay at `/replay` loads packed tracks from the competition-api Worker (`GET /api/comp/sample-3dvis` → the first task by date, or `/api/comp/:comp_id/task/:task_id/3dvis` for any comp task) — packing is `packTracksFromIgc` in the engine, shared with the offline `bun run build-3dvis` mirror. See `docs/3d-flight-replay-notes.md`.
- **Synthetic Big Chip open-distance comp:** `web/samples/comps/big-chip/` (meta: `comp.json` + paste-ready `pilots.tsv`) plus `big-chip-t1/` and `big-chip-t2/` (each: a single-`TAKEOFF` open-distance `task.xctsk` + 50 IGC tracks). Two tasks tow-launch from Jil Jil Farm near Birchip, VIC, inside a 5 km take-off ("launch") cylinder; pilots fly downwind (Task 1 NE, Task 2 SE). Each track is an emergent soaring model — hunt for a thermal, circle up, glide downwind, hunt again, land when the altitude runs out — so distance falls out of how many thermals a pilot connects with (a bell curve over thermal count: bulk make ~half the field's best, thin tails). Open-distance scoring measures from the cylinder exit, so short flights that never leave it score 0. Fully fabricated by `bun web/scripts/generate-big-chip.ts` (deterministic seeded PRNG → byte-stable output; re-run and commit). Seed with `bun run seed:sample big-chip`; score with `bun run score-task -- --open-distance web/samples/comps/big-chip-t1/task.xctsk web/samples/comps/big-chip-t1/`.

## Coding Rules

- Decisions MUST be explainable - return explanations for scoring decisions and support unit testing
- **Every mutation that could affect a competition's scores MUST be audit-logged.** Use the `audit()` helper in `web/workers/competition-api/src/audit.ts` from every mutating route handler (comp / task / pilot / track / penalty / xctsk / settings). The description must be a specific human-readable sentence — include the subject name and, where available, the old and new values via `describeChange()`. The audit log is publicly visible (for non-test comps) and is the transparency record for the competition. When you add a new mutating endpoint or field, adding the audit call is part of "done".
- **Every mutation that changes a scoring input MUST also mark the materialized scores stale.** Scores are stale-first rows in D1 (`task_scores`, [docs/score-caching-stale-first-plan.md](docs/score-caching-stale-first-plan.md)): reads never compute, so a mutation that skips the bump serves silently stale scores forever. Call `bumpAndRevalidateScores()` from `web/workers/competition-api/src/score-store.ts` right AFTER the mutation's DB write (never before), beside `audit()`, under the same "part of done" rule. Scoring inputs are tracks/uploads, penalties, task xctsk/date/classes, comp `scoring_format`/`gap_params`, and pilot name/class; roster metadata like team names is read live and needs no bump.
- Main UI (React, `src/react/`): use [shadcn/ui](https://ui.shadcn.com/) components (generated on the Base UI foundation) from `src/react/ui/` - add missing ones with `bunx shadcn@latest add <name>` (config in `web/frontend/components.json`) before creating custom components. The analysis page is vanilla TS (imperative map app): it shares the shadcn tokens via `src/analysis.css`, which also defines its small set of vanilla component classes (`.btn*`, `.input`, `.command`, …) — extend those there rather than adding a UI library. The 3D replay styles itself (own `replay.css` + inline theme)
- Use Tailwind utility classes for styling - avoid custom CSS when Tailwind provides equivalent functionality
- **Never** implement inline geo math (distance, bearing, etc.) - always use `web/engine/src/geo.ts` which provides WGS84 ellipsoid formulas (Andoyer-Lambert distance, Vincenty direct destination) and Turf.js for bearing/bbox
- **Single source of truth for map visuals/interactions**: [`docs/mapbox-interactions-spec.md`](docs/mapbox-interactions-spec.md) - all map providers must match this spec
