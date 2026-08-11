# System Architecture Specification

## Overview

GlideComp is a client-heavy web application for analyzing hang gliding and paragliding competition track logs (IGC files) against defined tasks, with competition management, GAP / open-distance scoring, and a public transparency record. The architecture prioritizes simplicity, minimal operational overhead, and generous free-tier usage — everything runs on Cloudflare (Pages, Workers, D1, R2, KV).

Production: https://glidecomp.com

## Current Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        Cloudflare Pages                          │
│                                                                  │
│  Prerendered Astro pages   /, /about, /legal, /scoring/*         │
│  React SPA (app.html)      /comp, /u/:username, /submit,         │
│                            /scores, /settings, /signin,          │
│                            /onboarding, /admin/*                 │
│  Vanilla-TS entries        /analysis (map app), /replay (3D)     │
│                                                                  │
│  Pages Functions           functions/api/* → service-binding     │
│                            proxies to auth-api & competition-api │
└─────────┬───────────────────────┬────────────────────────────────┘
          │ /api/auth/*           │ /api/comp|user|u|admin/*
          │                       │                    zone route:
          ▼                       ▼                  /api/airscore/*
┌──────────────────┐   ┌────────────────────┐   ┌──────────────────┐
│     auth-api     │◀──│  competition-api   │──▶│   airscore-api   │
│   Better Auth    │   │  comps · tasks ·   │   │  caching proxy   │
│  Google OAuth,   │   │  pilots · tracks · │   │  for AirScore    │
│  email OTP,      │   │  scores · user     │   │  (KV cache) →    │
│  API keys        │   │  files · audit     │   │ xc.highcloud.net │
└────────┬─────────┘   └───┬────────┬───┬───┘   └──────────────────┘
         │                 │        │   │
         ▼                 ▼        ▼   ▼
   ┌─────────────────────────┐   ┌────┐ ┌──────────────────────┐
   │  D1: taskscore-auth     │   │ R2 │ │ KV: scores/3dvis     │
   │  (one shared database)  │   └────┘ │     cache            │
   └─────────────────────────┘          └──────────────────────┘
```

All flight analysis (IGC parsing, event detection, scoring math) runs **client-side in the browser** via the pure-TypeScript engine (`web/engine`). The Workers store data, enforce auth, and serve materialized scores — they reuse the same engine for server-side score computation, but reads never compute (see [Score storage](#score-storage-stale-first)).

### Frontend (Cloudflare Pages)

One Pages project (`glidecomp`, output `web/frontend/dist`) with three kinds of surface:

- **Prerendered static pages** — a small Astro app in `web/frontend/static/` builds the content pages (`/`, `/about`, `/legal`, `/scoring`, `/scoring/gap`, `/scoring/open-distance`) as zero-client-JS HTML (KaTeX on the GAP page is rendered at build time). `bun run build` runs the Vite build, then the Astro build, and merges both into `dist/`.
- **React SPA** — the main UI (`src/react/`, served from `app.html`): competitions, comp/task detail, pilot score detail, the field-analysis reports, scores, `/submit` (the public track-submission page), sign-in, dashboard, the admin-only comp roster, settings, onboarding, super-admin pages. The authoritative list is the route tree in `src/react/routes.tsx`. Built with **react-aria-components** (the one kit, `src/react/rac/`) and Tailwind — the shadcn/Base UI kit was removed in July 2026, and `src/react/one-kit.test.ts` fails the build if it comes back; see [docs/2026-07-18-rac-adoption-guide.md](2026-07-18-rac-adoption-guide.md). Most SPA routes reach the shell via `public/_redirects` rewrites (`/u/*`, `/scores`, … → `/app` 200); `/comp*` is handed to the SSR Pages Function below via `public/_routes.json`.
- **SSR public comp pages** — the eight public competition pages (`/comp`, `/comp/:id`, scores, waypoints, task, pilot report card, comp field analysis, task field analysis) are server-rendered by the Pages Function `functions/comp/[[path]].ts`, which renders the same React tree the SPA hydrates (this is the SEO strategy). The `ROUTES` array in that file is the authoritative list. Shipped 2026-07-09; full design in [docs/2026-07-06-ssr-public-pages-plan.md](2026-07-06-ssr-public-pages-plan.md).
- **Vanilla-TS Vite entries** — the analysis page (`src/analysis/`, an imperative map app) and the 3D replay (`src/replay/`, three.js + Mapbox) are separate entries from the SPA.

Local dev (`bun run dev`) runs all the Workers in one wrangler session plus Vite and `astro dev` together; the Vite dev server proxies `/api/*` to the dev-router on `:8790` and the static routes to Astro, so everything is seamless on `:3000`.

### Analysis Engine (`web/engine`)

Pure TypeScript library with no DOM dependencies, consumed by the browser, the Workers, and CLI scripts (`web/engine/cli/`). Major modules: IGC parsing (`igc-parser.ts`), XCTask parsing (`xctsk-parser.ts`), event detection (`event-detector.ts`, `circle-detector.ts`, `cluster-detector.ts`), GAP scoring (`gap-scoring.ts`), open-distance scoring (`open-distance-scoring.ts`), task-line optimization (`task-optimizer.ts`), geo math (`geo.ts` — the single home for distance/bearing formulas), score explanations (`score-explanation.ts`), 3D track packing (`track-packer.ts`), and field analysis (`field-analysis/` — per-pilot behavioural metrics across a whole task's tracks with a Spearman-vs-GAP-rank eval; surfaced on the public `/comp/:id/analysis` pages (admin-only only for hidden `test` comps), stored stale-first by the competition-api Worker, and printed by the CLI `score-task --field-analysis` / `--comp`, see `docs/2026-07-18-field-analysis-plan.md`).

### Workers

Four Workers under `web/workers/`. Three are deployed on routes of the `glidecomp.com` zone; the fourth (`dev-router`) is local-dev-only and never deployed.

**auth-api** — authentication, built on [Better Auth](https://better-auth.com) (Hono + Kysely over D1).

- Route `glidecomp.com/api/auth/*`; bindings: the shared D1 database, the `glidecomp` R2 bucket, and the Cloudflare Email Sending binding (`EMAIL`) that delivers sign-in codes.
- Two production sign-in methods: **Google OAuth** (with the `oAuthProxy` plugin so preview deployments can complete the flow) and **passwordless email OTP** (Better Auth's `emailOTP` plugin — 6-digit codes, 10-minute expiry, hashed at rest, rate-limited per code / per IP / per address). Only email+password and the `dev-login` endpoint are dev-gated. Sessions are 60-day rolling, refreshed at most daily.
- API keys via the Better Auth `apiKey` plugin (prefix `glc_`, rate-limited, usable wherever a session cookie is).
- Custom endpoints beyond the Better Auth handler: `GET /api/auth/me`, `POST /api/auth/set-username`, user preferences routes, and `POST /api/auth/delete-account` — which purges every R2 object under `u/{userId}/` and then deletes the `user` row, cascading to sessions, accounts, preferences, user tracks/tasks/annotations (see [docs/database.md](database.md)).

**competition-api** — the main application/data worker (Hono, Smart Placement enabled so it runs near D1).

- Routes `glidecomp.com/api/comp*`, `/api/user*`, `/api/u/*`; bindings: the shared D1 database, the `glidecomp` R2 bucket, a KV namespace for score/3dvis caching, and service bindings to `auth-api` and `airscore-api`.
- Identity is resolved by forwarding the inbound cookie / `x-api-key` to auth-api over the service binding (`/api/auth/me`) — client-supplied identity headers are never trusted. Middleware layers: `requireAuth` (401), `optionalAuth`, `requireCompAdmin` (403), and a super-admin allowlist for the admin/cache endpoints. Public IDs are Sqids-encoded, decoded by middleware.
- Route groups: comp CRUD, tasks, pilots (incl. bulk paste + pre-registration), per-task pilot status, IGC track upload/download, scores + per-pilot analysis, 3D visualization data (`/3dvis`, KV-cached), user-owned files (`/api/user/*` private, `/api/u/:username/*` public-by-link), the public audit log, and super-admin user/cache pages.
- Every score-affecting mutation must call `audit()` and `bumpAndRevalidateScores()` — see Coding Rules in [CLAUDE.md](../CLAUDE.md).

**airscore-api** — a read-only caching proxy for the external AirScore server (`xc.highcloud.net`), used to import tasks and tracks.

- Route `glidecomp.com/api/airscore/*`; KV-cached responses (task TTL 1 h, track TTL 24 h); transforms AirScore data into GlideComp format. Unlike the other two it has **no** Pages Function proxy and no binding in the root `wrangler.toml` — competition-api reaches it over a service binding (for the super-admin cache page's `/internal/cache/*` endpoints), and browser traffic depends entirely on the zone route. See [docs/airscore-api-worker-spec.md](airscore-api-worker-spec.md).

**dev-router** — a dev-only fourth Worker (`web/workers/dev-router/`), never deployed.

- Owns the single exposed local port (**8790**) and dispatches `/api/*` to its three siblings over the same service bindings the Pages Functions use.
- It exists because all four Workers run in ONE `wrangler dev` session (`bun run dev:workers` → `web/scripts/dev-workers.sh`, where dev-router is the *primary* `-c` config): auth-api and competition-api share one D1 SQLite file, and two Miniflare processes writing it raced into `D1_ERROR: internal error` (issue #477). Multi-config `wrangler dev` exposes only the primary's port, hence the router.
- A routing change therefore lands in three places at once: `functions/api/`, `dev-router/src/index.ts` (pinned by its unit test), and the Vite proxy.

### API Routing

`/api/*` reaches the Workers by two paths:

1. **Worker routes** on the `glidecomp.com` zone (declared in each worker's `wrangler.toml`) serve production traffic directly.
2. **Pages Functions proxies** (`functions/api/{auth,comp,user,u,admin}/[[path]].ts`) forward requests over service bindings (`AUTH_API`, `COMPETITION_API` in the root `wrangler.toml`). This makes the API work on every Pages deployment — including `*.glidecomp.pages.dev` previews that the zone routes don't cover.

There is **no** `functions/api/airscore/` proxy and no `AIRSCORE_API` binding on Pages, so `/api/airscore/*` is only served where the zone route applies — it is unavailable from `*.glidecomp.pages.dev` branch previews and from `bun run preview:container`. Known gap; one proxy file fixes both.

Beyond the API proxies, `functions/` also holds `comp/[[path]].ts` (the SSR renderer for the public comp pages), `civl-rankings.csv.ts` and `sitemap.xml.ts` (both non-HTML public URLs), and `_middleware.ts` (the 301 that dedupes the `glidecomp.pages.dev` production alias onto `glidecomp.com`).

In local dev there are no Pages Functions: the Vite server proxies `/api/*` to the dev-router on :8790 instead, and mirrors the handful of Function-only URLs (e.g. `scores.csv`) with its own middleware.

### Data Layer

#### D1 (single shared database)

One database, `taskscore-auth`, bound by both auth-api and competition-api; migrations live in `web/db/migrations/` and are shared by both workers (latest: `0025_pilot_ranking.sql`). Table groups:

- **Auth (Better Auth):** `user`, `session`, `account`, `verification`, `apikey`, `rateLimit` (0017 — the D1-backed request limiter, because in-memory counters reset with every workerd isolate)
- **Competition:** `pilot` (per-user pilot profile), `comp`, `comp_admin`, `comp_pilot` (`pilot_id` nullable for pre-registration; linked later by CIVL ID), `comp_waypoints` (0015 — the comp's region waypoint file), `task`, `task_class`, `task_track` (one IGC per task+pilot, with penalty fields and `quality_override` from 0024, the organiser's per-track override of a track-quality verdict), `task_manual_flight` (0014 — supersede-not-delete manual flight reports for track-less pilots), `task_pilot_status`, `audit_log`
- **Derived, stale-first:** `task_scores` (materialized score rows), `task_field_analysis` (0019 — the behavioural-metric reports; lazily revalidated, never computed on the cold path), `track_analysis` (per-track cached analyses), `task_weather` (0023 — cached provider answers)
- **Rankings:** `pilot_ranking` (0025 — the FAI/CIVL monthly world ranking, deliberately standalone: no FK to `pilot`/`comp_pilot`, no reader, no UI yet. See [docs/civl-rankings.md](civl-rankings.md))
- **User files:** `user_preferences`, `user_track`, `user_task` (XCTSK JSON stored inline in D1 — tiny, and row-level transactions make account deletion trivial), `user_annotation`

#### R2 (bucket `glidecomp`)

```
c/{compId}/t/{taskId}/{compPilotId}.igc   # Competition tracks (gzipped)
u/{userId}/track/{sha256}.igc.gz          # User-owned tracks (gzipped)
```

Per-user tracks are namespaced under `u/{userId}/` so the auth-api delete-account flow can purge a user's entire R2 footprint with a prefixed list+delete. Cross-user dedup was rejected to keep cascade-delete trivial (storage is cheap). Within a user's namespace tracks are still content-addressed by SHA-256, so re-uploading the same file from another device is idempotent.

#### KV

Two namespaces: the airscore-api response cache, and competition-api's cache for packed 3D-visualization tracks. Scores are **not** in KV — they moved to D1 (below).

#### Score storage (stale-first)

Task scores are materialized rows in D1 (`task_scores`): **reads never compute, writes do**. A score-affecting mutation bumps `inputs_rev` (instantly marking the row stale) and schedules background revalidation; freshness is derived (`computed_rev === inputs_rev` and matching engine version), so deploying a new scoring-engine version rolls every row stale without a migration. A lease lock makes revalidation exactly-once under concurrency. Full design: [docs/score-caching-stale-first-plan.md](score-caching-stale-first-plan.md).

Two more stores follow the same stale-first shape with deliberate departures:

- **`task_field_analysis`** — one `bumpScoreInputs()` marks it stale alongside `task_scores`, but revalidation is **lazy** (triggered by a read, not the mutation — it's expensive and few people read it) and the cold path never computes synchronously: it returns `pending`, schedules, and the UI polls.
- **`task_weather`** — invalidated **by query key, not `inputs_rev`**. Weather is a function of a place and a past interval, and a past interval's weather never changes, so there is deliberately no bump at the mutation sites; move the route or the date and the engine's `weatherQueryKey` stops matching the stored row. Provisional answers re-fetch on a TTL, failures back off, and — as with field analysis — a page render never waits on the third-party fetch.

#### Audit log

Every mutation that could affect a competition's scores is recorded in `audit_log` via the `audit()` helper — free-text, human-readable descriptions with old/new values. The log is publicly readable (`GET /api/comp/:comp_id/audit`) and is the transparency record for the competition.

### Sample data

`bun run seed` loads the bundled sample competitions from `web/samples/comps/` into D1 + R2, idempotently — every comp with a `comp.json` manifest by default, or just the slugs you name (e.g. `bun run seed big-chip` for the synthetic open-distance comp). Comps whose manifest sets `"hidden": true` (the fabricated Big Chip and Kosciuszko Loop fixtures) seed with the D1 `test` flag, so they're admin-only. The 3D replay's default dataset is served from the seeded sample via `GET /api/comp/sample-3dvis`.

## Design Principles

1. **Client-Heavy Processing** — IGC parsing and analysis run in the browser; the same engine is reused server-side only to materialize scores on write.

2. **Explainable Decisions** — scoring returns explanations, is unit-tested, and every score-affecting mutation is publicly audit-logged.

3. **Reads Never Compute** — score reads serve materialized rows; mutations mark them stale and revalidate in the background.

4. **Single Vendor** — all infrastructure on Cloudflare for operational simplicity.

5. **Generous Free Tier** — designed to operate within free-tier limits for typical competition usage.

6. **Trivial Account Deletion** — user data is namespaced (R2 prefix, D1 cascades) so deleting an account is a prefix purge plus one row delete.

## Infrastructure Costs

All components operate within Cloudflare's free tier for typical competition usage.

| Component | Free Tier Allowance | Current Usage |
|-----------|---------------------|---------------|
| Pages | Unlimited bandwidth | Static pages + SPA + Functions proxies |
| Workers | 100,000 requests/day | auth-api, competition-api, airscore-api |
| D1 | 5 GB storage, 5M reads/day | Shared app database |
| R2 | 10 GB storage, 10M reads/month | Gzipped IGC tracks (~100 KB each) |
| KV | 100,000 reads/day | AirScore + 3dvis caches |

---

## Future Roadmap

Planned but **not yet implemented**:

- **Email submission** — pilots email IGC files to `submit@{domain}`; an Email Worker archives, validates, and links submissions to pilots. Full design (workflow, dedup, submission states): [docs/email-submission-spec.md](email-submission-spec.md).
- **Live tracking** — integration with live tracking services during competition.
- **Multi-tenant** — richer support for multiple competition organizers (today any user can create a comp and add co-admins; super-admin is a hardcoded allowlist).
- **XContest integration** — import tasks directly from XContest.
