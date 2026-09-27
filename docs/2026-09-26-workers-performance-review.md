# Workers performance review (26 September 2026)

A review of `web/workers/*` and the Pages Functions in front of them, focused on
performance. It asks four questions:

1. Which API calls happen too often during normal browsing?
2. Would a backend-for-frontend (BFF) help? Or, on Cloudflare, are parallel
   calls from the browser the better shape?
3. Are any workers or endpoints no longer called?
4. Where has the code rotted, and which patterns do only some workers follow?

This is a point-in-time snapshot. It builds on
[performance-investigation-2026-07.md](performance-investigation-2026-07.md),
which fixed the cold 3dvis path, turned on Smart Placement and led to
stale-first scores. Nothing here repeats that work.

## Method

- Read every route in `auth-api`, `competition-api` and `airscore-api`, the
  `functions/` proxies, the SSR Function and the frontend call sites.
- **Measured the calls per page load** against the production build
  (`bun run preview`: real Pages runtime, SSR Functions and service bindings,
  seeded Corryong Cup 2026). A temporary, uncommitted log line in each worker
  counted server-side invocations, so the counts include service-binding hops
  that a browser never sees. Canonical (slugged) URLs were used, because a bare
  id costs one extra full SSR render before the 301.
- **Counted the D1 queries in `/api/auth/me`** by running auth-api against a
  `bun:sqlite` shim of D1 with every migration applied.
- **Checked the query plans.** Ran `EXPLAIN QUERY PLAN` on the hot queries
  against that same migrated schema.
- **Measured bundle sizes** with `wrangler deploy --dry-run`, with and without
  `--minify`.

## Summary: what to do, in order

| # | Change | Effort | Impact |
|---|---|---|---|
| 1 | Add indexes on `task(comp_id)`, `comp_pilot(comp_id)` and `comp_admin(user_id)` ([§3.2](#32-missing-indexes)) | S (one migration) | Every comp, task and score read stops scanning whole tables |
| 2 | Make the auth hop cheap: turn on Better Auth `cookieCache`, reuse the `betterAuth` instance per isolate, and forward only the session cookie ([§2](#2-the-auth-hop-is-half-of-all-signed-in-traffic)) | S–M | Removes about half of the signed-in worker invocations' D1 work |
| 3 | Fold `whoami` into `/api/auth/me`, or into the SSR payload ([§2.3](#23-per-page-extras-whoami-and-preferences)) | S | One fewer request (plus one fewer auth hop) on every signed-in page load |
| 4 | One shared "load the visible comp" helper that uses `db.batch()`, applied everywhere ([§3.1](#31-sequential-reads), [§7.1](#71-the-visibility-check-is-copied-34-times)) | M | 2–7 sequential D1 round trips become 1 on every public read |
| 5 | A light comp header for the SSR loaders, instead of the full `GET /api/comp/:id` ([§1.2](#12-the-ssr-fan-out)) | S–M | The heaviest read stops running for pages that need only a name and a time zone |
| 6 | Edge-cache anonymous reads with `caches.default`, following the civl-rankings pattern ([§4](#4-caching-what-the-edge-actually-holds)) | M | Warm anonymous views skip D1 entirely |
| 7 | Bound the concurrency of background revalidation ([§8](#8-background-work-has-no-concurrency-bound)) | S | Removes a memory and CPU cliff after an engine deploy |
| 8 | `minify = true` and Smart Placement on `auth-api` ([§9](#9-bundle-size-and-placement)) | S | auth-api: 3.2 MB → 1.4 MB; `/me` runs next to D1 |

Numbers 1, 2, 3, 7 and 8 are small, local changes. The BFF question
([§5](#5-bff-or-parallel-calls)) comes out as "no new worker". Make the fixed
cost of each invocation cheap first, then add composite endpoints only where
the SSR loaders fan out.

---

## 1. What a page load costs

### 1.1 Measured

"Browser" means requests the browser made after the HTML arrived. "Server"
means every worker invocation the page load caused. That includes the SSR
Function's loader calls and every auth-api hop made by `competition-api`.

| Page | Anonymous: browser / server | Signed in: browser / server | `/api/auth/me` hops (signed in) |
|---|---|---|---|
| `/comp` | 0 / 1 | 2 / 6 | 3 |
| `/comp/:c` | 1 / 3 | 3 / 10 | 5 |
| `/comp/:c/task/:t` | 1 / 4 | 6 / 18 | 9 |
| Report card `/comp/:c/task/:t/pilot/:p` | 2 / 6 | 4 / 16 | 8 |
| `/comp/:c/task/:t/analysis` | 1 / 3 | 3 / 12 | 6 |

What this shows:

- **SSR has done its job for anonymous visitors.** The browser makes 0–2
  calls, and they are genuinely client-side data (the audit feed, weather, the
  report card's tracklog).
- **Signed in, about half of all worker invocations are `/api/auth/me`.** Each
  `/me` is two *sequential* D1 queries (`session` by token, then `user` by id).
  A signed-in task page therefore spends 18 D1 round trips on identity before
  it reads any competition data. See [§2](#2-the-auth-hop-is-half-of-all-signed-in-traffic).
- **Two requests run on every signed-in page, whatever the page:**
  `GET /api/admin/whoami` and `GET /api/auth/preferences`
  ([§2.3](#23-per-page-extras-whoami-and-preferences)).
- **The signed-in task page asks for the roster twice.** `TaskScoresPublic`
  and `SubmitTrackDialog` each call `GET /api/comp/:c/pilot` separately.
- **The report card loads the whole comp's scores** (`TaskInCompScores` →
  `/api/comp/:c/scores`, every pilot × every task) to show one pilot's comp
  standing.

### 1.2 The SSR fan-out

Every SSR loader in `src/react/loaders.ts` calls `GET /api/comp/:id` in
parallel with its real data. It does this even where it uses only the comp's
name, time zone and `is_admin` (task detail, report card, both analysis
pages). That endpoint is the heaviest read in the API:

- **Seven sequential D1 queries** in `routes/comp.ts`: comp, `isCompAdmin`,
  admins, tasks, `task_class`, pilot count, waypoint count.
- **It returns the full `xctsk`-derived data for every task.** It parses every
  task's `xctsk` JSON to build `taskRouteSummary` and the speed-section
  warnings.

The report card makes four such calls (`comp`, `task`, `score`,
`pilot/analysis`). For a signed-in visitor that is four auth hops, four
visibility checks and four `comp` row reads, for one page.

### 1.3 The whole-task analysis page

`/analysis?compId=…&taskId=…` (without `pilotId`) loads the field by issuing
**one `GET …/igc/:p/download` per pilot**, all in parallel (`analysis/main.ts`).
A 150-pilot task is 150 worker invocations. Each one does a comp check, a track
row lookup and an R2 GET, plus an auth hop if the visitor is signed in. None of
those responses carries a `Cache-Control` or an `ETag`
([§4](#4-caching-what-the-edge-actually-holds)), so a second visit pays the
whole cost again. The 3dvis bundle already shows the batched alternative: one
request, cached by content key.

---

## 2. The auth hop is half of all signed-in traffic

### 2.1 How it works today

`competition-api`'s `optionalAuth`/`requireAuth` call `resolveUser()` →
`AUTH_API.fetch("/api/auth/me")` on **every** request that carries any
cookie, `x-api-key` or `Authorization` header. In auth-api, each `/me`:

1. **Builds a new `betterAuth()` instance.** `createAuth(c.env)` is called per
   request in seven places. Measured under Bun: 0.34 ms to construct, and
   ~1.6 ms per request including the lazy init, against 0.6 ms with a reused
   instance. About 1 ms of CPU per request, for nothing.
2. **Runs two sequential D1 queries:** `session WHERE token = ?`, then
   `user WHERE id = ?`.

`competition-api` has Smart Placement, but `auth-api` does not. A browser's
own `/api/auth/me` therefore runs at the edge and pays two long-haul D1 round
trips. The July investigation measured ~250 ms each from a US edge.

### 2.2 Recommendations

> **Status (2026-09-26):** done, and taken one step further: the cache cookie
> is signed with an asymmetric key, so competition-api and the SSR Function
> verify it themselves with the public key and skip the hop entirely, without
> holding `BETTER_AUTH_SECRET`. See
> [auth.md](auth.md#cross-worker-auth-verification).

- **Turn on `session.cookieCache`** (for example `{ enabled: true, maxAge: 300 }`).
  Better Auth then signs a `session_data` cookie and `getSession` validates it
  without touching D1. `/me` drops from 2 D1 queries to 0 for five minutes at a
  time.
  - *The trade-offs:* a revoked session or a sign-out on another device
    survives for up to `maxAge`. Also, `POST /api/auth/set-name` and
    `set-username` write `"user"` directly, so they must refresh the cached
    cookie (call `getSession` with `disableCookieCache`, or go through Better
    Auth's `updateUser`), or `/me` serves the old name until the cache expires.
    The onboarding gate reads that name, so this matters.
- **Memoise `createAuth()` per isolate**, keyed on the `env` object (stable
  within an isolate) plus whether an execution context is present. The
  `executionCtx`-dependent parts (`waitUntil` in `sendVerificationOTP` and the
  session hook) need the context passed per call, not captured at
  construction. That is the one refactor this requires.
- **Forward only the Better Auth cookie.** `forwardAuthHeaders()` forwards the
  whole `Cookie` header, so *any* cookie (analytics, `__cf_bm`) makes an
  anonymous visitor pay a service-binding hop. The SSR Function has the same
  test (`cookie ? fetchVisitor : null`), and it also marks the page
  `private, no-store`, which disables caching of the HTML for that visitor.
  Check for `better-auth.session_token` (and `__Secure-` variant) instead.
  - Today auth-api answers such a request with 0 D1 queries, so the cost is
    the hop and the lost cacheability, not D1.
- **Optional, and only after `cookieCache`:** a per-isolate map from cookie
  hash to user with a ~30 s TTL in `resolveUser()` would absorb the SSR
  fan-out's 3–4 concurrent hops for the same visitor. It is only worth doing
  if `cookieCache` still leaves `/me` visible in traces.

### 2.3 Per-page extras: `whoami` and preferences

- **`GET /api/admin/whoami`** exists only to compute `isSuperAdmin(user)`,
  which needs no database. It costs a browser request, a competition-api
  invocation and another auth hop, on every signed-in page load.
  - *Also in production:* `/api/admin/*` has **no** worker route in
    `competition-api/wrangler.toml`, so it is the one API prefix that still
    goes through a Pages Function first ([§6](#6-workers-and-endpoints-that-are-no-longer-called)).
  - *Fix:* return `is_super_admin` from `/api/auth/me` and put it in the SSR
    `user` payload. That means `SUPER_ADMIN_EMAILS` has to move to
    `@glidecomp/worker-kit`. It qualifies under that package's own rule: two
    workers disagreeing about who is a super admin would be a bug that nothing
    catches.
- **`GET /api/auth/preferences`** runs on every signed-in page load
  (`preferences-sync.ts` bootstrap). The whole blob is ≤ 64 KiB and changes
  rarely. An `ETag`/`If-None-Match` pair, or a `updated_at` kept in
  `localStorage` and sent as a query, would make most loads a 304. Serving
  the blob inside `/me` is the other option, but it would grow every `/me`
  response.

---

## 3. D1

### 3.1 Sequential reads

`db.batch()` sends several statements in **one** round trip. The workers use
it for writes (about 15 call sites) and almost never for reads. Every public read
starts with the same serial prelude:

```
comp (id, test)  →  [isCompAdmin, only for test comps]  →  task  →  the actual data
```

| Endpoint | Sequential D1 round trips (anonymous, warm) |
|---|---|
| `GET /api/comp/:id` | 6 (7 when signed in) |
| `GET /api/comp/:id/task/:id` | 4 |
| `GET /api/comp/:id/task/:id/score` | 3 |
| `GET /api/comp/:id/scores` | 4 |
| `GET …/3dvis` (warm) | 5, then a KV read |
| `GET …/igc/:p/download` | 2, then an R2 read |

With Smart Placement working, each round trip is short. It is still serial
latency, and it is paid again on every 304 revalidation of a score poll.

- **The comp and admin checks collapse into one query:**
  ```sql
  SELECT c.*, EXISTS(SELECT 1 FROM comp_admin ca
                     WHERE ca.comp_id = c.comp_id AND ca.user_id = ?) AS is_admin
  FROM comp c WHERE c.comp_id = ?
  ```
  (The super-admin case stays in code.)
- **The independent reads that follow can go in one `db.batch()`.** In
  `GET /api/comp/:id` those are admins, tasks, task classes, pilot count and
  waypoint count. In the task GET they are task, classes and track count.

`GET /api/comp/:id` would go from 7 round trips to 2, and the task GET from 4
to 1.

### 3.2 Missing indexes

`EXPLAIN QUERY PLAN` against the fully migrated schema:

| Query (hot path) | Plan today | Index to add |
|---|---|---|
| `task WHERE comp_id = ?` (comp detail, scores, `taskIdsForComp`) | `SCAN task` | `task(comp_id, task_date)` |
| `SELECT comp_id, MIN(task_date), MAX(task_date) FROM task GROUP BY comp_id` (comp list) | `SCAN task` + temp B-tree | covered by the same index |
| `comp_pilot WHERE comp_id = ?` (roster, teams in `/scores`, pilot counts) | `SCAN comp_pilot` | `comp_pilot(comp_id)` |
| `comp_admin WHERE user_id = ?` (comp list signed in, `visibleCompsFilter`, search) | `SCAN comp_admin` | `comp_admin(user_id)` |
| `comp WHERE test = 0 AND creation_date >= ? ORDER BY creation_date` (comp list) | `SCAN comp` | `comp(test, creation_date)` (optional; the table is small) |
| `session WHERE "userId" = ?` / `account WHERE "userId" = ?` (Better Auth list/revoke; delete-account) | `SCAN` | `session("userId")`, `account("userId")` |

- **`comp_pilot` is the surprising one.** `0001` declared `UNIQUE(comp_id, pilot_id)`,
  but the table was later rebuilt, and today the only composite index is the
  *partial* `idx_comp_pilot_unique_linked … WHERE pilot_id IS NOT NULL`. The
  planner cannot use a partial index for a bare `comp_id = ?`.
- **Why it matters beyond latency:** these scans grow with the *whole
  database*, not with the comp being viewed. Every archive import makes every
  other comp's pages slower, and D1 bills per row read.

### 3.3 The comp list is unbounded

`GET /api/comp` returns every non-test comp from the last 24 months, with no
`LIMIT`, and runs the whole-table `GROUP BY` above on each call. It feeds the
`/comp` SSR page, the dashboard and `sitemap.xml`. With the index it is cheap
for now. Once the archive grows, it needs pagination, or a cached response
([§4](#4-caching-what-the-edge-actually-holds)).

### 3.4 Read replication (later)

D1 read replication through the Sessions API (`env.DB.withSession(…)`) is not
used anywhere. Stale-first scores and analysis already accept lag, so anonymous
GETs are good candidates. Mutations, and reads that follow them, need the
bookmark so they can read their own writes. Treat this as the step after
Smart Placement, and measure first.

---

## 4. Caching: what the edge actually holds

**A Worker's or Pages Function's response is not stored in Cloudflare's cache
because of its `Cache-Control` header.** The cache in front of a Worker holds
only what the Worker puts there with `caches.default` (or what it fetches with
`cf` cache options). Today:

- **The SSR pages and `sitemap.xml`** send `public, max-age=…` and
  `s-maxage=3600`. That reaches browsers and any proxy downstream, but the
  edge stores nothing. Every anonymous crawl of a comp page runs the loaders
  against D1.
- **The score, analysis, weather and 3dvis responses** have careful `ETag`s
  and age-based `max-age`s (`publicMaxAgeSeconds`). They save the *browser* a
  download. They save the *worker* nothing: a 304 still runs the full D1
  prelude.
- **`civl-rankings.csv` is the only route that uses `caches.default`.** It is
  the model to copy.

### Recommendations

- **Cache anonymous, visibility-safe reads at the edge.** For requests without
  a session cookie, `caches.default.match()` → on a miss run the handler →
  `cache.put()` in `waitUntil`, keyed by URL. Candidates:
  - comp detail, task detail and scores;
  - the task-analysis GETs, which already have age-based lifetimes;
  - the SSR HTML for anonymous visitors;
  - `GET /api/comp` and `sitemap.xml`.

  A stale row already sends `max-age=0`, so the existing lifetime rules carry
  over as they are.
- **Cache per colo, then purge on mutation.** The Cache API is per data
  centre, so a mutation cannot purge it globally without the zone purge API.
  The age-based lifetimes are what keep this safe. They are already designed
  around the fact that "a late correction is not seen by caches until their
  lifetime expires". Keep them short for a live comp, which is what
  `publicMaxAgeSeconds` already does.
- **Give the tracklog download an `ETag` and `Cache-Control`.** The R2 key is
  stable per pilot (`c/:comp/t/:task/:pilot.igc`), but the object changes on a
  re-upload. `ETag: object.httpEtag` + `Cache-Control: public, max-age=0,
  must-revalidate` (anonymous) and an `If-None-Match` check before the R2
  body read costs nothing and makes repeat views of a report card, or the
  whole-task analysis page, 304s.

---

## 5. BFF, or parallel calls?

**Short answer: do not add a separate BFF worker. The SSR Function already is
one for the eight public pages. Make it make fewer calls, and make each call's
fixed cost smaller.**

### Why parallel calls are fine on Cloudflare, up to a point

- **The browser side is cheap.** Over HTTP/2 to one origin, the browser sends
  requests multiplexed on one connection. Each lands on a separately scheduled
  isolate, and none blocks another.
- **Parallelism earns its keep when resources have different lifetimes.**
  Scores poll with `If-None-Match`, weather polls while pending, and 3dvis is
  a large content-addressed blob. Splitting those lets each cache and
  revalidate on its own terms. Keep them separate.
- **The cost is the fixed prelude of every invocation,** not the parallelism.
  That prelude is the auth hop (2 D1 queries), the comp/test check (1–2) and
  any repeated read of the same comp row. The report card pays it four times,
  concurrently, to render one page.

### Why a separate BFF worker is the wrong fix

A BFF worker in front of `competition-api` adds a hop. It still has to resolve
identity, and SEC-10 forbids it from asserting that identity to the API in a
header. The places where a BFF would help are already covered:

- **For SSR pages,** the SSR Function is the BFF. Give its loaders one
  composite endpoint per page shape (for example,
  `GET /api/comp/:c/task/:t/page`). That endpoint returns the light comp
  header, the task and the score in one invocation, with one auth resolution,
  one visibility check and one `db.batch()`. It is composition *inside*
  `competition-api`, calling the same functions the separate routes call. It
  is not a new service.
- **For the SPA,** after hydration the browser already makes 0–2 data calls
  per page. A BFF there would bundle requests with different lifetimes and
  lose their independent caching.

### Invocations worth splitting, and one to merge

| Invocation | Recommendation |
|---|---|
| `GET /api/comp/:id` | **Split.** Add a light header (name, time zone, category, scoring format, `is_admin`, `test`) for the SSR loaders, and keep the full detail for the comp page and the admin surfaces. |
| Report card's `/api/comp/:c/scores` | **Consider** a per-pilot comp-standing field on the task score instead of the whole comp matrix. |
| Whole-task tracklogs (analysis page) | **Merge** the per-pilot downloads into a batched, cacheable bundle, as 3dvis already is. |
| `whoami` + `/me` | **Merge** ([§2.3](#23-per-page-extras-whoami-and-preferences)). |

---

## 6. Workers and endpoints that are no longer called

**No whole worker is dead.** What there is:

- **The four Pages Function proxies are shadowed in production.**
  `competition-api/wrangler.toml` routes `glidecomp.com/api/comp*`, `/api/user*`
  and `/api/u/*` straight to the worker, and `auth-api` does the same for
  `/api/auth/*`. On glidecomp.com, Worker routes win over Pages Functions, so
  `functions/api/{comp,user,u,auth}` run only on preview deployments and on
  `glidecomp.pages.dev` (which 301s anyway).
  - *Why it matters for performance:* previews add an extra Functions
    invocation to every API call, so a latency number measured on a preview is
    not a production number.
  - *The reverse case:* `/api/admin/*` has **no** worker route, so in
    production it always goes through the Pages Function
    ([§2.3](#23-per-page-extras-whoami-and-preferences)).
  - *Decide one way:* add a `glidecomp.com/api/admin/*` route, or drop the
    worker routes and accept the Functions hop everywhere. Having both shapes
    means two behaviours to reason about.
- **`airscore-api` is unreachable on preview deployments.** There is no
  `functions/api/airscore/…` proxy and no `AIRSCORE_API` binding in the Pages
  `wrangler.toml`. The comment in `analysis/airscore-client.ts` ("in production
  the Pages Function proxies it") is wrong: production works only because of
  the worker route `glidecomp.com/api/airscore/*`. Its only caller is the
  analysis page's AirScore import.
- **Endpoints with no caller in the UI.** They are listed in `docs/api.md`, so
  they are public API surface, not dead code. Keep them only if someone uses
  them:
  - `PATCH …/igc/:comp_pilot_id/quality-override`. This is the organiser's
    FAI S7A §4.4.6 override, and it has no UI anywhere. CLAUDE.md's "every
    verdict is organiser-overridable" is true only through the API.
  - `GET …/manual-flight/:comp_pilot_id/history`.
  - The `/field-analysis` → `/analysis` redirect shims in `routes/analysis.ts`.
    Remove them once the logs show no traffic.
- **The KV namespace `glidecomp_scores_cache` holds only 3dvis bundles** since
  scores moved to D1. The name now misleads ([§7.3](#73-three-caching-mechanisms-for-one-idea)).

---

## 7. Code rot and patterns applied unevenly

### 7.1 The visibility check is copied 34 times

`SELECT comp_id, test FROM comp WHERE comp_id = ?` followed by an inline
`isCompAdmin` appears across 12 route files. `hiddenFromCaller()` in
`comp-visibility.ts` exists to do this, and 4 files use it. The copies all
read the same way today, but each is 2 serial queries, and each is one more
place to forget the rule. A single
`loadVisibleComp(db, compId, user, columns)` helper, using the one-query form
from [§3.1](#31-sequential-reads), fixes both problems.

### 7.2 `audit()` in a loop, beside `auditAll()`

`auditAll()` was written to replace per-field `await audit()` loops with one
batched transaction. Three handlers use it. Two still loop:

- `routes/pilot.ts` (the comp-pilot PATCH, one write per changed field);
- `routes/pilot-profile.ts` (one write per linked registration).

### 7.3 Three caching mechanisms for one idea

| Data | Store |
|---|---|
| Scores, task analysis, weather | D1 stale-first rows with `inputs_rev` |
| 3dvis bundles | KV, keyed by a content hash that costs 3 D1 queries to compute on every request |
| AirScore responses | KV, with `await kv.put()` blocking the response (it could be `waitUntil`) |
| CIVL rankings CSV | `caches.default` |

Consolidating is not urgent. When 3dvis is next touched, though:

- a content-addressed R2 object (no per-write KV cost, no 25 MiB value cap)
  or `caches.default` fits it better than KV;
- its cache key could come from the `task_scores.state_key` the stale-first
  store already keeps, instead of re-reading every track row.

### 7.4 Two `If-None-Match` parsers

`ifNoneMatchMatches()` (`score-store.ts`) and `etagMatches()`
(`routes/visualization.ts`) do the same job with slightly different rules. The
first strips quotes, and the second compares quoted values.

### 7.5 Worker config drift

| | competition-api | auth-api | airscore-api |
|---|---|---|---|
| `compatibility_date` | 2025-03-10 | 2025-03-10 | **2024-12-01** |
| `nodejs_compat` | yes | yes | **no** |
| Smart Placement | yes | **no** | no (it is an outbound proxy, so it matters less) |
| `minify` | no | no | no |
| Explicit `[limits]` | yes | no | no |
| `[observability]` in config | no | no | no |

- **Observability:** without Workers Logs or traces there is no production
  latency data per route. The July investigation had to time endpoints from
  outside. Enabling `[observability]` (at a sampling rate) is the
  prerequisite for checking any of the latency claims in this review against
  production.
- **airscore-api tests:** they run under `bun test` (`handlers/track.test.ts`),
  while the other two workers use `@cloudflare/vitest-pool-workers`.

---

## 8. Background work has no concurrency bound

`scheduleTaskRevalidation(c, taskIds)` runs `Promise.allSettled` over **all**
the tasks at once, in one `waitUntil`, and each task fetches its tracks at
`TRACK_FETCH_CONCURRENCY`. The synchronous cold path in `/scores` deliberately
caps this at `COMP_TASK_CONCURRENCY = 3` "to bound total R2 concurrency". The
background path has no cap.

The per-track memo (`track_analysis`) normally keeps this cheap. However,
`gapGeomHash` includes the engine generation, so **every scoring deploy
invalidates every memo**. After such a deploy, the first `/scores` read of a
comp marks every task stale and revalidates them all at once. A 10-task,
150-pilot comp would parse ~1,500 tracklogs concurrently inside one
invocation's 128 MB and 30 s CPU budget.

- **Use `mapWithConcurrency(taskIds, COMP_TASK_CONCURRENCY, …)` here too.**
- **Consider a Queue for this, or the existing hourly cron,** so that an
  engine deploy re-scores comps in the background instead of on the first
  visitor's request.

---

## 9. Bundle size and placement

`wrangler deploy --dry-run`:

| Worker | Unminified | Minified | Largest contents |
|---|---|---|---|
| auth-api | 3,190 KiB (506 KiB gzip) | 1,433 KiB (350 KiB gzip) | zod 861 KiB, better-auth 685 KiB, kysely 645 KiB, @better-auth/core 318 KiB |
| competition-api | 1,082 KiB (250 KiB gzip) | 574 KiB (182 KiB gzip) | engine (turf, tz-lookup), zod 125 KiB, hono |
| airscore-api | 184 KiB | — | |

- **auth-api's startup cost matters more than its size suggests.** It sits on
  the hot path of every signed-in request through the service binding, and a
  service-binding call is not warmed during the client's TLS handshake the way
  a direct request is.
- **`minify = true` roughly halves the script that has to be parsed.**
  Measure startup time with `wrangler versions upload` before and after.
- **Give `auth-api` `[placement] mode = "smart"`.** Its only backend is D1, so
  the reasoning that put Smart Placement on `competition-api` applies here too.

---

## Reproducing the measurements

- **Calls per page:** `bun run preview`, then add
  `app.use("*", async (c, next) => { console.log("[perf] " + c.req.method + " " + new URL(c.req.url).pathname); await next(); })`
  to both workers' `index.ts` (do not commit it). Load each page with
  Playwright on its canonical URL, once anonymously and once after
  `POST /api/auth/dev-login`, and count the `[perf]` lines. React StrictMode
  doubles every effect under `bun run dev`, so measure the production build.
- **Query plans:** apply `web/db/migrations/*.sql` in order to a `bun:sqlite`
  in-memory database and run `EXPLAIN QUERY PLAN` on the query.
- **Bundle sizes:** `bunx wrangler deploy --dry-run [--minify] --outdir <dir>`
  in each worker's directory.
