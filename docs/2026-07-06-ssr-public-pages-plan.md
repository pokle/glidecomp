# Plan: SEO-friendly SSR for the public competition pages

**Date:** 2026-07-06
**Status:** ✅ **Implemented** (2026-07-09, PR #289). All four public routes are
server-rendered by `functions/comp/[[path]].ts`; see the SSR note in
[CLAUDE.md](../CLAUDE.md) (Architecture) for the shipped shape and the rules for
touching these pages. The plan below is the original design record; a few
details evolved in implementation (react-router `StaticRouter` instead of a
`react-router-dom/server` subpath; the SSR bundle targets workerd's react-dom
edge build; `/scores` stays a client redirect to `/comp/:id#scores`; the score
tables already moved onto the comp page in IA v2 before SSR landed).

> **Update (2026-07-23):** SSR now covers **six** public routes — the four
> above plus the task page and a new `/comp/:id/scores` page, which became the
> canonical scores surface (the comp page keeps only a top-3 standings
> summary, so "curl the comp page for full standings" no longer holds — curl
> `/comp/:id/scores` instead). `/scores?comp_id=X` now redirects to
> `/comp/X/scores`. The admin-only `/comp/:id/pilots` roster editor joined the
> noindex-shell routes alongside field analysis.

## Goal

Make the public competition surfaces crawlable and indexable: the text content
(comp metadata, score tables, per-pilot score explanations) must be present in
the HTML the server returns, not injected client-side after hydration. Maps
stay client-rendered. The public flow also changes slightly:

1. **Homepage** (`/`, Astro static) → links to the competitions list *(exists)*.
2. **Competitions list** (`/comp`) → links to every competition *(exists; becomes SSR)*.
3. **Competition page** (`/comp/:compId`) → **SSRs the scores for the whole
   competition**, with every score linking to that pilot's narrative page
   *(new: scores move onto the comp page; links already exist in the score
   tables — `ScoresSection.tsx:170`, `Scores.tsx:41`)*.
4. **Narrative page** (`/comp/:compId/task/:taskId/pilot/:pilotId`) → **SSRs the
   score explanation**; the map hydrates in the browser *(becomes SSR)*.

Non-goals: SSR for auth-gated pages (`/u/*`, `/settings`, `/onboarding`,
`/admin/*`), the analysis page, and the 3D replay. Those keep the current
`_redirects → /app` SPA flow unchanged.

## Why this is tractable — current state

The exploration that informed this plan (see file references throughout):

- **All the data is already server-side and public.** Task scores are
  materialized stale-first rows in D1 (`task_scores` — see
  [score-caching-stale-first-plan.md](./score-caching-stale-first-plan.md)):
  reads are a single row read and never compute
  (`web/workers/competition-api/src/routes/score.ts`, `score-store.ts`).
  Public GETs, `optionalAuth`, JSON-serializable:
  - `GET /api/comp` — comp list (`routes/comp.ts:260`)
  - `GET /api/comp/:comp_id` — comp detail (`routes/comp.ts:324`)
  - `GET /api/comp/:comp_id/scores` — comp standings, aggregated from `task_scores` (`routes/score.ts:144`)
  - `GET /api/comp/:comp_id/task/:task_id` — task detail (`routes/task.ts:191`)
  - `GET /api/comp/:comp_id/task/:task_id/score` — task scores, served from `task_scores` (`routes/score.ts:60`)
  - `GET .../pilot/:comp_pilot_id/analysis` — narrative input, cached in `track_analysis` (`routes/score.ts:337`)
- **The narrative text needs no tracklog.** `PilotScoreDetail.tsx` builds the
  prose from the `analysis` + `score` responses via the isomorphic engine
  (`explainGapScore` / `explainOpenDistanceScore` in
  `web/engine/src/score-explanation.ts` — pure formatting, no DOM, no track
  scan). The IGC is downloaded *only* to draw the flight line on the map
  (`PilotScoreDetail.tsx:319-339`) and that stays client-side.
- **Pages Functions already have the plumbing.** `functions/api/*/[[path]].ts`
  proxy to the competition-api worker over a `COMPETITION_API` service binding
  (root `wrangler.toml`). An SSR function reaches the data the same way —
  in-colo `fetch`, no extra hop.
- **SEO today is effectively zero** for these pages: `app.html` has a bare
  `<title>`, no description/OG/canonical; no `robots.txt`, no sitemap; all
  content renders into `#root` client-side; `_routes.json` restricts Functions
  to `/api/*`.
- The service worker (`public/sw.js`) only intercepts `/share-target` POSTs —
  no offline caching to fight with SSR.

## Recommended architecture: targeted React SSR in Pages Functions

Server-render **only the four public routes** with the *same React components*
the SPA already uses, inside new Pages Functions that fetch JSON over the
existing `COMPETITION_API` service binding, then hydrate in the browser.

Why this over the alternatives:

| Option | Verdict |
|---|---|
| **Targeted SSR in Pages Functions (chosen)** | Contained to 4 routes; zero deployment-model change (Pages + `functions/` + `_redirects` + service bindings all stay); reuses the existing React pages so there is one source of markup; auth pages untouched. |
| Astro SSR adapter (`@astrojs/cloudflare`) on the existing static app | The adapter emits `_worker.js` (advanced mode), which makes Cloudflare Pages **ignore the `functions/` directory entirely** — the five `/api/*` proxies would have to be re-implemented inside Astro, and the score tables / explanation components would be rebuilt as Astro templates or wrapped as React islands, duplicating the SPA markup. Bigger blast radius for the same result. |
| React Router v7 framework mode (Remix-style loaders, full-app SSR) | The cleanest long-term shape (we already use RR7 as a library), but its official Cloudflare target is **Workers + static assets, not Pages** — adopting it means migrating the whole deployment (wrangler config, `_redirects`, `_headers`, preview envs) and making every auth-gated page SSR-safe at once. Too much unrelated risk for this goal. The loader contract introduced below maps 1:1 onto RR7 loaders, so nothing here is wasted if we migrate later. |
| Prerender at build time | Scores change while a comp runs; the comp list changes over time. Build-time prerender would serve stale scores. SSR-with-KV-backed-APIs is fresh and still fast. |

### Request flow after the change

```
GET /comp/abc123
  → _routes.json now includes /comp/* → Pages Function functions/comp/[[path]].ts
    → loader: env.COMPETITION_API.fetch(/api/comp/abc123, /api/comp/abc123/scores)   (KV-cached JSON)
    → renderToReadableStream(<CompDetail data={…} />)  (Vite-built SSR bundle)
    → template = await env.ASSETS.fetch("/app")        (the built app.html, hashed assets included)
    → inject: rendered HTML into #root, <script>window.__SSR_DATA__…</script>,
              per-route <title>/<meta>/canonical/JSON-LD into <head>
  ← full HTML with scores in the body
Browser: main.tsx sees __SSR_DATA__ → hydrateRoot; map/interactive bits attach.
Client-side nav (e.g. list → comp): the same loader runs against window.fetch.
```

Key trick: using `env.ASSETS.fetch("/app")` as the HTML template means the SSR
function never needs to know Vite's hashed asset filenames — the built
`app.html` already references them. No manifest plumbing.

## Implementation phases

### Phase 0 — SEO groundwork (independent, ship first)

Cheap wins that matter regardless of SSR:

- `public/robots.txt`: allow all, disallow `/u/`, `/settings`, `/onboarding`,
  `/admin/`, `/api/`; point at the sitemap.
- `functions/sitemap.xml.ts`: a Pages Function that fetches `/api/comp` over
  the service binding and emits `<urlset>` entries for `/comp`, each
  `/comp/:compId`, each task and each pilot narrative page (the comp detail +
  scores responses contain everything needed). Short edge cache (e.g.
  `s-maxage=3600`).
- `src/app.html` head: default `<meta name="description">`, OG/Twitter tags,
  `og:site_name`. The Astro pages in `static/src/layouts/Base.astro` get the
  same treatment (they're already crawlable but have no descriptions).
- Decide the canonical URL story now: the narrative page URL
  `/comp/:compId/task/:taskId/pilot/:pilotId` is already clean; `/scores` uses
  `?comp_id=` which crawls poorly — see Phase 2 flow change.

### Phase 1 — SSR infrastructure

1. **Route-loader contract.** New `web/frontend/src/react/loaders.ts` defining
   one loader per public route, parameterized by a `fetch`-like function:
   - `loadCompetitions(f)` → `GET /api/comp`
   - `loadCompDetail(f, compId)` → `GET /api/comp/:id` + `GET /api/comp/:id/scores` (parallel)
   - `loadTaskDetail(f, compId, taskId)` → task + comp + task score (parallel)
   - `loadPilotScoreDetail(f, ids)` → comp + task + score + analysis (parallel,
     exactly the four calls `PilotScoreDetail.tsx:131-142` makes today)

   Server passes a wrapper around `env.COMPETITION_API.fetch` (forwarding the
   incoming `Cookie` header so comp admins get their `test` comps SSR'd too);
   client passes `window.fetch`. Refactor the four page components from
   fetch-in-`useEffect` to consume loader data (initial data via context/prop,
   client-side navigations run the loader with `window.fetch`).

2. **SSR entry + build.** `src/react/entry-server.tsx` exporting
   `render(url, data) → ReadableStream` using `react-dom/server`'s
   `renderToReadableStream` and react-router's static matching for just the
   four routes (no `<Shell>` auth chrome server-side — see Risks). Build it
   with a second Vite pass: `vite build --ssr src/react/entry-server.tsx
   --outDir dist-ssr` appended to the frontend `build` script. Vite handles
   TSX/CSS-import stripping so the Pages Functions esbuild step only has to
   bundle plain JS.

3. **Pages Function.** `functions/comp/[[path]].ts`:
   - match the URL against the four public routes; anything else (unknown
     depth, trailing junk) → serve the SPA shell (`env.ASSETS.fetch("/app")`)
     unmodified, preserving today's behavior;
   - run the loader over the service binding; on API 404 → render a real 404
     status with the shell; on API error/timeout → fall back to the plain SPA
     shell (client fetch takes over) so SSR can never make the site *less*
     available than today;
   - stream the rendered HTML into the `#root` div of the fetched `/app`
     template; inject `<title>`, meta, canonical, JSON-LD, and
     `window.__SSR_DATA__` (serialize with `JSON.stringify(...).replace(/</g,
     "\\u003c")` — pilot names are user-ish data, don't let `</script>` break
     out);
   - `Cache-Control: private, no-store` when a Cookie was forwarded; otherwise
     a conservative `public, max-age=0, must-revalidate` to start (the KV-backed
     APIs make renders fast; edge-caching SSR HTML is a later optimization).

4. **Routing plumbing.**
   - `public/_routes.json`: `include` gains `"/comp"`, `"/comp/*"` (and
     `"/scores"` if kept — see Phase 2). Note `/api/*` stays; the prefixes
     don't collide.
   - `public/_redirects`: delete the `/comp` and `/comp/*` → `/app 200` lines.
   - `main.tsx`: `window.__SSR_DATA__` present → `hydrateRoot`, else
     `createRoot` (non-SSR routes still boot the classic way).
   - Dev story: the Vite middleware in `vite.config.ts` currently rewrites
     `/comp*` to `/app.html`. Either keep that for dev (SSR only in
     preview/prod, verified via `wrangler pages dev`) or add a small Vite dev
     SSR hook. Recommend the former initially — `bun run build && wrangler
     pages dev` exercises the real thing.

### Phase 2 — flow change + route-by-route rollout

Roll out one route at a time; each step is deployable alone because unmatched
routes fall back to the SPA shell.

1. **`/comp` (competitions list).** Simplest page, proves the pipeline:
   loader, hydration, title/meta ("Hanggliding & paragliding competitions —
   GlideComp"), `ItemList` JSON-LD.
2. **`/comp/:compId` (competition page) — the flow change.** Today
   `CompDetail.tsx` shows tasks/pilots/admins; comp-level standings live on
   `/scores?comp_id=`. Change: embed the standings from
   `GET /api/comp/:comp_id/scores` directly on the comp page — per class:
   rank, pilot, total, and per-task points where **each task cell links to
   that pilot's narrative page** (same `detailHref` pattern as
   `ScoresSection.tsx:170`). Tasks list keeps linking to task pages. `/scores`
   then becomes a redirect (`/scores?comp_id=X` → 301 `/comp/X`) or stays as
   an SPA-only power view — decide during implementation; the comp page is the
   canonical scores surface either way. JSON-LD: `SportsEvent` +
   `BreadcrumbList`.
3. **`/comp/:compId/task/:taskId/pilot/:pilotId` (narrative page).** The SEO
   centerpiece. Server renders headline + all explanation sections/items
   (`ExplanationSection`/`ExplanationItem` from `PilotScoreDetail.tsx` operate
   on plain data — reuse as-is). The map (`ScoreDetailMap`, already
   `lazy()`-loaded) and the IGC download effect stay client-only; anchored
   items render server-side as text and gain their pan-the-map behavior on
   hydration. Title like "«Pilot» — «Task», «Comp»: score explanation".
4. **`/comp/:compId/task/:taskId` (task page).** Turnpoints table + per-class
   score tables (`ScoresSection`) SSR'd; track-management chrome stays
   client/auth-gated.

### Phase 3 — head/meta polish + sitemap completion

- Per-route `<title>`/description/canonical emitted by the SSR layer; keep the
  existing `document.title` effects for client-side navigations.
- Expand `sitemap.xml` to include task and narrative URLs with `<lastmod>`
  from task dates.
- Optional later: OG images, edge-caching SSR HTML keyed to the score rows'
  `state_key` (already served as the score endpoints' ETag).

### Phase 4 — verification

- **E2E (Playwright, `bun run test:e2e` harness):** fetch each SSR route with
  JS disabled / raw `request.get()` and assert pilot names, points, and
  explanation text appear in the response body; assert narrative-page links
  are present in the comp page HTML; assert `/u/me` etc. still work (SPA path
  untouched); assert no hydration errors in the console on the SSR pages.
- The seeded sample comp (`bun run seed`, Corryong Cup 2026) gives
  deterministic fixtures for all four routes; the `run-glidecomp` flow already
  covers boot + seed.
- Lighthouse SEO pass on the four routes; `curl -s | grep` smoke checks in the
  deploy smoke test (which already exists — see commit 8cb1715).

## Risks & mitigations

- **Hydration mismatches.** Dates/number formatting must be deterministic:
  render with an explicit locale + the comp/task timezone, never the
  server's/browser's default. Any `window`/`document` access in the four pages
  and their children must be effect-guarded (audit during the refactor; the
  map is already lazy).
- **Auth-dependent chrome on public pages** (admin buttons, the signed-in
  `<Shell>` nav). Render the signed-out state on the server and let auth
  status hydrate in an effect (render-then-upgrade), or mark those subtrees
  client-only. Never SSR anything derived from the session except via the
  forwarded-cookie loader.
- **Cold-score latency.** Addressed by the stale-first score store
  ([score-caching-stale-first-plan.md](./score-caching-stale-first-plan.md),
  implemented): mutations compute scores on write into the D1 `task_scores`
  rows, so score reads are a single row read and never compute. A task only
  goes cold if it predates that feature or slipped the mutation hooks, in
  which case the worker still scores it synchronously (R2 fan-out, seconds).
  The loader timeout (~5s) → SPA-shell fallback stays as a belt-and-braces
  guard but is no longer the mitigation of record.
- **SSR bundle size.** `react-dom/server` + the four pages + the engine
  explanation module must stay under the Pages Functions bundle limit. The
  Vite SSR build tree-shakes mapbox/three/leaflet out (they're behind dynamic
  imports); verify with a size check in CI.
- **`_routes.json` / `_redirects` interplay.** Removing the `/comp*` rewrites
  while adding the Function include must land in the same deploy; the
  function's fall-back-to-shell behavior covers any URL-shape gaps. Extend the
  deploy smoke test to cover both an SSR route and a classic SPA route.
- **`test` comps must not leak.** The API already 404s them without an admin
  cookie; the SSR loader forwards cookies, so behavior matches the SPA. Add an
  e2e assertion that a test comp's SSR URL returns 404 + noindex when signed
  out.

## Acceptance criteria

1. `curl https://glidecomp.com/comp` returns HTML containing every public
   competition name and link — no JS required.
2. `curl https://glidecomp.com/comp/:id` returns HTML containing the comp's
   standings (pilot names, totals) with anchor tags to narrative pages.
3. `curl` on a narrative page returns the full explanation text (headline,
   sections, point values); the map loads only in a browser.
4. Every SSR page has a unique `<title>`, meta description, and canonical URL;
   `robots.txt` and `sitemap.xml` exist and the sitemap lists all public comp,
   task, and narrative URLs.
5. Signed-in flows (`/u/me`, settings, admin) behave exactly as before.
6. No hydration warnings on the SSR routes; e2e suite green.

## Rough sequencing

Phase 0 is a small standalone PR. Phase 1 + step 1 of Phase 2 (the `/comp`
list) land together as the pipeline-proving PR. The comp-page flow change,
narrative page, and task page are one PR each. Phases 3–4 ride along with the
route PRs, with a final polish pass.
