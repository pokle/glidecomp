# CLAUDE.md

## Project Overview

GlideComp is a web application for analyzing hanggliding/paragliding competition track logs (IGC files). It provides task analysis, scoring explanations, glide and thermal analysis.

## Architecture

Cloudflare monorepo, free-tier focused:

- `web/engine` — pure TypeScript analysis library (IGC/XCTask parsing, event detection, GAP scoring). No DOM dependencies; all track analysis runs client-side in the browser.
- `web/frontend` — Vite app on Cloudflare Pages. The main UI (home, competitions, comp/task detail, scores, dashboard, profile, settings, onboarding) is a React + Base UI SPA under `src/react/` served from `src/index.html`; the analysis, 3D replay, scoring-explainer, theme-editor, kitchensink and admin pages remain separate vanilla-TS Vite entries.
- `web/workers/*` — Workers (auth-api, competition-api, airscore-api) backed by D1 + R2, handling accounts, user file storage, and competition management. Reached via Pages Functions proxies in `functions/api/`.

## Build & Development

If `node_modules/` is missing or a dependency can't be resolved, run `bun install` before proceeding. Build commands are in `package.json` scripts. Key ones: `bun run dev`, `bun run test`, `bun run typecheck:all`.

**E2E tests (`bun run test:e2e`) on a fresh clone:**
- Playwright browsers must be installed first: `bunx playwright install chromium` (CI uses `--with-deps`).
- The auth worker needs `web/workers/auth-api/.dev.vars` (gitignored). Without it `BETTER_AUTH_URL` defaults to production, `isLocalDev()` is false, and `/api/auth/dev-login` 404s — every test fails at sign-in. The `test:e2e` script copies `.dev.vars.example` into place if the file is missing.
- If dev servers are already running from a previous session, `bun run kill-dev` clears them.

**Production:** https://glidecomp.com

**Updating bundled data:**
- **Google Fonts list:** `web/frontend/src/google-fonts.ts` contains a bundled list of all ~1900 Google Fonts for the theme editor. To refresh it: `bash web/scripts/update-google-fonts.sh`
- **Sample competition:** the bundled Corryong Cup 2026 comp lives under `web/samples/comps/`, one folder per task (`corryong-cup-2026-<class>-t<N>`) plus a `corryong-cup-2026/` meta folder (`comp.json` manifest + region `waypoints.wpt`/`.json`). AirScore scores the event as two comps — **open** and **floater** — flying different tasks per day; here they become one comp with two pilot classes (a pilot who flew both, e.g. CIVL 46402, gets one `comp_pilot` row per class).
  - **Re-download from source:** `bun web/scripts/download-airscore-comp.ts corryong-cup-2026` — idempotent, politely rate-limited (`REQUEST_DELAY_MS`, default 3500ms). Rebuilds every task folder + waypoints from xc.highcloud.net; a folder with a `.curated` marker (e.g. `corryong-cup-2026-open-t1`, the AirScore-parity fixture) is left untouched. Add new comps to the `COMPS` registry in that script.
  - **Seed into D1 + R2:** `bun run seed:sample` (idempotent; `--remote` for prod) reads `comp.json` and loads all tasks/classes/pilots/tracks. Pass a slug to seed a different bundled comp (e.g. `bun run seed:sample big-chip`). The manifest may set `comp_name` (the D1 comp name; defaults to the fixed Corryong `SAMPLE_COMP_NAME`), `category`, and `scoring_format` (`gap` | `open_distance`; default `gap`). The 3D replay at `/replay` loads packed tracks from the competition-api Worker (`GET /api/comp/sample-3dvis` → the first task by date, or `/api/comp/:comp_id/task/:task_id/3dvis` for any comp task) — packing is `packTracksFromIgc` in the engine, shared with the offline `bun run build-3dvis` mirror. See `docs/3d-flight-replay-notes.md`.
- **Synthetic Big Chip open-distance comp:** `web/samples/comps/big-chip/` (meta: `comp.json` + paste-ready `pilots.tsv`) plus `big-chip-t1/` and `big-chip-t2/` (each: a single-`TAKEOFF` open-distance `task.xctsk` + 50 IGC tracks). Two tasks tow-launch from Jil Jil Farm near Birchip, VIC, inside a 5 km take-off ("launch") cylinder; pilots fly downwind (Task 1 NE, Task 2 SE). Each track is an emergent soaring model — hunt for a thermal, circle up, glide downwind, hunt again, land when the altitude runs out — so distance falls out of how many thermals a pilot connects with (a bell curve over thermal count: bulk make ~half the field's best, thin tails). Open-distance scoring measures from the cylinder exit, so short flights that never leave it score 0. Fully fabricated by `bun web/scripts/generate-big-chip.ts` (deterministic seeded PRNG → byte-stable output; re-run and commit). Seed with `bun run seed:sample big-chip`; score with `bun run score-task -- --open-distance web/samples/comps/big-chip-t1/task.xctsk web/samples/comps/big-chip-t1/`.

## Coding Rules

- Decisions MUST be explainable - return explanations for scoring decisions and support unit testing
- **Every mutation that could affect a competition's scores MUST be audit-logged.** Use the `audit()` helper in `web/workers/competition-api/src/audit.ts` from every mutating route handler (comp / task / pilot / track / penalty / xctsk / settings). The description must be a specific human-readable sentence — include the subject name and, where available, the old and new values via `describeChange()`. The audit log is publicly visible (for non-test comps) and is the transparency record for the competition. When you add a new mutating endpoint or field, adding the audit call is part of "done".
- Main UI (React, `src/react/`): use [Base UI](https://base-ui.com/) components - check https://base-ui.com/react/components before creating custom components. Remaining vanilla pages (analysis, replay, admin, theme-editor): use [Basecoat](https://basecoatui.com/) components
- Use Tailwind utility classes for styling - avoid custom CSS when Tailwind provides equivalent functionality
- **Never** implement inline geo math (distance, bearing, etc.) - always use `web/engine/src/geo.ts` which provides WGS84 ellipsoid formulas (Andoyer-Lambert distance, Vincenty direct destination) and Turf.js for bearing/bbox
- **Single source of truth for map visuals/interactions**: [`docs/mapbox-interactions-spec.md`](docs/mapbox-interactions-spec.md) - all map providers must match this spec
