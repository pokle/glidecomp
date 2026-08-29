# SSR for the public competition pages

The eight public comp pages are server-rendered. This is the SEO strategy:
crawlers and link-preview bots must see the text, not an empty `#root`.

Current-state reference. For the original design reasoning see
[2026-07-06-ssr-public-pages-plan.md](2026-07-06-ssr-public-pages-plan.md) and
[2026-07-08-information-architecture-v2.md](2026-07-08-information-architecture-v2.md)
§6 — both dated, so treat them as snapshots.

## The routes

All owned by the Pages Function `functions/comp/[[path]].ts` (`ROUTES`):

| Route | Notes |
|---|---|
| `/comp` | |
| `/comp/:id` | hub: merged task list + top-3 scores summary |
| `/comp/:id/scores` | the canonical full-scores page; `?task=` deep-links the scores-by-task view |
| `/comp/:id/waypoints` | |
| `/comp/:id/task/:id` | route + public top-3 results; the admin manage grid is client-only |
| `/comp/:id/task/:id/pilot/:id` | the report card |
| `/comp/:id/analysis` | field analysis, comp report |
| `/comp/:id/task/:id/analysis` | field analysis, this task's chapter (a summary of the five below) |
| `/comp/:id/task/:id/analysis/:section` | one section of that chapter — `separation`, `day`, `pilots`, `styles`, `method` |

A cold field-analysis report server-renders its pending notice and is noindexed
**per request**, not shell-noindexed. The section route's pattern is built from
`field-analysis/sections.ts`, so a section added there cannot be a 404 here; an
unknown slug falls through to the 404 shell like any other junk `/comp` URL.

`NOINDEX_SHELL_ROUTES` (checked *before* `ROUTES`) covers the `/comp` paths that
are real SPA routes but have nothing to server-render — they must reach the
shell rather than 404, and there is nothing here for a crawler:

| Path | What it is |
|---|---|
| `/comp/:id/pilots` | the roster editor (admin-only) |
| `/comp/:id/settings[/:group]` | competition settings, index + group sub-pages |
| `/comp/:id/task/:id/settings` | task settings |
| `/comp/:id/task/:id/route` | the route editor |
| `/comp/:id/task/:id/weather` | the weather notes |
| `/comp/:id/task/:id/pilot/:id/manual-flight` | recording a manual flight |
| `/comp/:id/task/:id/analysis/similar` | the pilot-similarity sheet, derived client-side |

All but the last are admin-only editors, and every one of them was a dialog over
a public page until #636/#637 — which is why the list grew: converting a dialog
to a routed page creates a URL the SSR Function has to have an answer for, and
without an entry here that answer is a genuine 404. The route editor has a
second reason never to be server-rendered: it pulls Mapbox.

Superseded public URLs are the other case the Function answers itself, ahead
of both tables: `/comp/:id/analysis/task/:id` (and `/similar` below it) is where
the per-task report lived from July to August 2026, and it **301s** to the URL
under the task, query preserved. A redirect and not a shell entry, because that
URL was server-rendered and indexable while it stood — a crawler handed a
noindex shell would learn the page was gone rather than where it went. The SPA
carries the same redirect for in-app and back/forward navigation.

**Adding a routed admin editor means adding it here.** The Function's fallback
for an unmatched `/comp` path is a real 404 with `noindex` — deliberately, so
junk URLs stop looking valid — so a new page that skips this list works in dev
(where the SPA shell is served for everything) and 404s in production.

One query string is checked alongside them: `/comp?q=…` — a search on the
competitions page ([site search](2026-08-01-site-search.md)) — also gets the
noindex shell. The results come from `/api/comp/search` client-side, so there is
nothing to server-render, a search-results URL is not one a crawler should keep,
and a shell with no `__SSR_DATA__` means the client creates a fresh root instead
of hydrating markup the search is about to replace. The bare `/comp` is
unaffected.

`public/_routes.json` hands `/comp*` and `/sitemap.xml` to Functions. The old
`/comp* → /app` `_redirects` lines are gone.

**Non-goals** — auth-gated pages, the analysis page and the 3D replay stay pure
SPA.

## How a request is served

1. Run the route's loader (`src/react/loaders.ts`, one per route, parameterized
   by a `FetchFn`) over the `COMPETITION_API` service binding, **forwarding the
   visitor's cookie** so admins still get their `test` comps.
2. Render the *same* React components the SPA uses — shared tree in
   `src/react/routes.tsx`, rendered server-side by `entry-server.tsx`.
3. Splice the markup into the `/app` shell with per-route `<title>`, description
   and JSON-LD.
4. Embed `window.__SSR_DATA__` for the client to hydrate from
   (`entry-client.tsx` → `hydrateRoot`; `src/react/lib/initial-data.tsx` seeds
   each page's state so the first render matches).

**Deliberately no `<link rel="canonical">`** — iOS Safari's share sheet copies it
instead of the address bar, and it goes stale after client-side navigation. The
`glidecomp.pages.dev` prod alias is deduped by a 301 in
`functions/_middleware.ts` instead, with the static content pages routed through
it via `_routes.json` because `_redirects` can't match hosts.

### Failure behaviour

- Upstream 404/400 → a real 404 plus `noindex`. Hidden `test` comps 404
  anonymously.
- Any loader or render error → the plain SPA shell. **SSR can never make a page
  less available than the pure-client version.**

## `/comp/:id/scores.csv`

The one non-HTML URL under `/comp`, served by the same Function: the scores
page's downloadable twin, built from the same loader so the file can't disagree
with the page. Built by the pure `src/scores-csv.ts`.

- **Long form** — one row per pilot per task, ONE `score` column and a `task`
  column, so it pivots. Never a column per task.
- **Ids ship as fully-qualified URLs** — `comp_url`/`task_url`/`score_url`, built
  from `lib/slug.ts` and absolute against the SERVING request's origin, so a
  preview deploy's export links back into the preview. A bare sqid in a cell
  takes a reader nowhere. `comp_pilot_id` is the one exception, kept as the
  group-by-pilot key because a pilot has no page of their own.
- `noindex` (the page is the indexable form), and cookie-forwarded like
  everything else here.

It is a real URL rather than a client-built blob because that is what makes
Google Sheets' `IMPORTDATA` work — the "Open in Google Sheets" flow in
`src/react/comp/ScoresDownload.tsx` hands the visitor that formula, and the sheet
re-reads it after a re-score.

Dev has no Functions, so a `scoresCsvDev` middleware in `vite.config.ts` mirrors
it on :3000 using the same builder, rather than leaving the link 404ing where
nobody would notice.

## Verifying

Dev serves the SPA shell, with no SSR. To actually exercise it:

```
bun run build && wrangler pages dev web/frontend/dist
bun run test:e2e:ssr          # asserts clean hydration
```
