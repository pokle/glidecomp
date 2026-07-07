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
│  React SPA (app.html)      /comp, /u/:username, /scores,         │
│                            /settings, /onboarding, /admin/*      │
│  Vanilla-TS entries        /analysis (map app), /replay (3D)     │
│                                                                  │
│  Pages Functions           functions/api/* → service-binding     │
│                            proxies to the Workers below          │
└─────────┬───────────────────────┬──────────────────────┬─────────┘
          │ /api/auth/*           │ /api/comp|user|u|    │ /api/airscore/*
          │                       │ admin/*              │
          ▼                       ▼                      ▼
┌──────────────────┐   ┌────────────────────┐   ┌──────────────────┐
│     auth-api     │◀──│  competition-api   │──▶│   airscore-api   │
│   Better Auth    │   │  comps · tasks ·   │   │  caching proxy   │
│  Google OAuth,   │   │  pilots · tracks · │   │  for AirScore    │
│  API keys        │   │  scores · user     │   │  (KV cache) →    │
└────────┬─────────┘   │  files · audit     │   │ xc.highcloud.net │
         │             └───┬────────┬───┬───┘   └──────────────────┘
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
- **React SPA** — the main UI (`src/react/`, served from `app.html`): competitions, comp/task detail, pilot score detail, scores, dashboard, settings, onboarding, super-admin pages. Built with shadcn/ui components on the Base UI foundation and Tailwind. SPA routes reach the shell via `public/_redirects` rewrites (`/comp/*`, `/u/*`, `/scores`, … → `/app` 200).
- **Vanilla-TS Vite entries** — the analysis page (`src/analysis/`, an imperative map app) and the 3D replay (`src/replay/`, three.js + Mapbox) are separate entries from the SPA.

Local dev (`bun run dev`) runs the three Workers under wrangler plus Vite and `astro dev` together; the Vite dev server proxies `/api/*` to the local Workers and the static routes to Astro, so everything is seamless on `:3000`.

### Analysis Engine (`web/engine`)

Pure TypeScript library with no DOM dependencies, consumed by the browser, the Workers, and CLI scripts (`web/engine/cli/`). Major modules: IGC parsing (`igc-parser.ts`), XCTask parsing (`xctsk-parser.ts`), event detection (`event-detector.ts`, `circle-detector.ts`, `cluster-detector.ts`), GAP scoring (`gap-scoring.ts`), open-distance scoring (`open-distance-scoring.ts`), task-line optimization (`task-optimizer.ts`), geo math (`geo.ts` — the single home for distance/bearing formulas), score explanations (`score-explanation.ts`), and 3D track packing (`track-packer.ts`).

### Workers

Three Workers under `web/workers/`, all deployed on routes of the `glidecomp.com` zone.

**auth-api** — authentication, built on [Better Auth](https://better-auth.com) (Hono + Kysely over D1).

- Route `glidecomp.com/api/auth/*`; bindings: the shared D1 database, the `glidecomp` R2 bucket.
- Google OAuth is the only production sign-in method (with the `oAuthProxy` plugin so preview deployments can complete the flow). Email+password / `dev-login` exist only in local dev.
- API keys via the Better Auth `apiKey` plugin (prefix `glc_`, rate-limited, usable wherever a session cookie is).
- Custom endpoints beyond the Better Auth handler: `GET /api/auth/me`, `POST /api/auth/set-username`, user preferences routes, and `POST /api/auth/delete-account` — which purges every R2 object under `u/{userId}/` and then deletes the `user` row, cascading to sessions, accounts, preferences, user tracks/tasks/annotations (see [docs/database.md](database.md)).

**competition-api** — the main application/data worker (Hono, Smart Placement enabled so it runs near D1).

- Routes `glidecomp.com/api/comp*`, `/api/user*`, `/api/u/*`; bindings: the shared D1 database, the `glidecomp` R2 bucket, a KV namespace for score/3dvis caching, and service bindings to `auth-api` and `airscore-api`.
- Identity is resolved by forwarding the inbound cookie / `x-api-key` to auth-api over the service binding (`/api/auth/me`) — client-supplied identity headers are never trusted. Middleware layers: `requireAuth` (401), `optionalAuth`, `requireCompAdmin` (403), and a super-admin allowlist for the admin/cache endpoints. Public IDs are Sqids-encoded, decoded by middleware.
- Route groups: comp CRUD, tasks, pilots (incl. bulk paste + pre-registration), per-task pilot status, IGC track upload/download, scores + per-pilot analysis, 3D visualization data (`/3dvis`, KV-cached), user-owned files (`/api/user/*` private, `/api/u/:username/*` public-by-link), the public audit log, and super-admin user/cache pages.
- Every score-affecting mutation must call `audit()` and `bumpAndRevalidateScores()` — see Coding Rules in [CLAUDE.md](../CLAUDE.md).

**airscore-api** — a read-only caching proxy for the external AirScore server (`xc.highcloud.net`), used to import tasks and tracks.

- Route `glidecomp.com/api/airscore/*`; KV-cached responses (task TTL 1 h, track TTL 24 h); transforms AirScore data into GlideComp format. Internal cache stats/clear endpoints are reachable only via competition-api's service binding (super-admin cache page). See [docs/airscore-api-worker-spec.md](airscore-api-worker-spec.md).

### API Routing

`/api/*` reaches the Workers by two paths:

1. **Worker routes** on the `glidecomp.com` zone (declared in each worker's `wrangler.toml`) serve production traffic directly.
2. **Pages Functions proxies** (`functions/api/{auth,comp,user,u,admin}/[[path]].ts`) forward requests over service bindings (`AUTH_API`, `COMPETITION_API` in the root `wrangler.toml`). This makes the API work on every Pages deployment — including `*.glidecomp.pages.dev` previews that the zone routes don't cover.

In local dev the Vite server proxies `/api/*` to the wrangler dev ports instead.

### Data Layer

#### D1 (single shared database)

One database, `taskscore-auth`, bound by both auth-api and competition-api; migrations live in `web/db/migrations/` and are shared by both workers. Table groups:

- **Auth (Better Auth):** `user`, `session`, `account`, `verification`, `apikey`
- **Competition:** `pilot` (per-user pilot profile), `comp`, `comp_admin`, `comp_pilot` (`pilot_id` nullable for pre-registration; linked later by CIVL ID), `task`, `task_class`, `task_track` (one IGC per task+pilot, with penalty fields), `task_pilot_status`, `audit_log`
- **Score cache:** `task_scores` (materialized stale-first score rows), `track_analysis` (per-track cached analyses)
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

#### Audit log

Every mutation that could affect a competition's scores is recorded in `audit_log` via the `audit()` helper — free-text, human-readable descriptions with old/new values. The log is publicly readable (`GET /api/comp/:comp_id/audit`) and is the transparency record for the competition.

### Sample data

`bun run seed:sample` loads bundled sample competitions from `web/samples/comps/` (Corryong Cup 2026 by default; `big-chip` for the synthetic open-distance comp) into D1 + R2, idempotently. The 3D replay's default dataset is served from the seeded sample via `GET /api/comp/sample-3dvis`.

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
- **SSR public pages** — server-render the public competition/score pages for SEO: [docs/ssr-public-pages-plan.md](ssr-public-pages-plan.md).
- **Live tracking** — integration with live tracking services during competition.
- **Multi-tenant** — richer support for multiple competition organizers (today any user can create a comp and add co-admins; super-admin is a hardcoded allowlist).
- **XContest integration** — import tasks directly from XContest.
