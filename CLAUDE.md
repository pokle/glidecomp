# CLAUDE.md

## Project Overview

GlideComp is a web application for analyzing hanggliding/paragliding competition track logs (IGC files). It provides task analysis, scoring explanations, glide and thermal analysis.

## Architecture

Cloudflare monorepo, free-tier focused:

- `web/engine` — pure TypeScript analysis library (IGC/XCTask parsing, event detection, GAP scoring). No DOM dependencies; all track analysis runs client-side in the browser.
- `web/frontend` — Vite multi-page app on Cloudflare Pages.
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
  - **Seed into D1 + R2:** `bun run seed:sample` (idempotent; `--remote` for prod) reads `comp.json` and loads all tasks/classes/pilots/tracks. The 3D replay at `/replay` loads packed tracks from the competition-api Worker (`GET /api/comp/sample-3dvis` → the first task by date, or `/api/comp/:comp_id/task/:task_id/3dvis` for any comp task) — packing is `packTracksFromIgc` in the engine, shared with the offline `bun run build-3dvis` mirror. See `docs/3d-flight-replay-notes.md`.

## Coding Rules

- Decisions MUST be explainable - return explanations for scoring decisions and support unit testing
- **Every mutation that could affect a competition's scores MUST be audit-logged.** Use the `audit()` helper in `web/workers/competition-api/src/audit.ts` from every mutating route handler (comp / task / pilot / track / penalty / xctsk / settings). The description must be a specific human-readable sentence — include the subject name and, where available, the old and new values via `describeChange()`. The audit log is publicly visible (for non-test comps) and is the transparency record for the competition. When you add a new mutating endpoint or field, adding the audit call is part of "done".
- Use [Basecoat](https://basecoatui.com/) components for UI - check https://basecoatui.com/docs/components before creating custom components
- Use Tailwind utility classes for styling - avoid custom CSS when Tailwind provides equivalent functionality
- **Never** implement inline geo math (distance, bearing, etc.) - always use `web/engine/src/geo.ts` which provides WGS84 ellipsoid formulas (Andoyer-Lambert distance, Vincenty direct destination) and Turf.js for bearing/bbox
- **Single source of truth for map visuals/interactions**: [`docs/mapbox-interactions-spec.md`](docs/mapbox-interactions-spec.md) - all map providers must match this spec
