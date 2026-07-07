# Plan: stale-first score storage in D1 (compute-on-write)

**Date:** 2026-07-07
**Status:** implemented (see "Implementation notes" at the end; supersedes
the KV `latest`-pointer draft of this doc)
**Companion to:** [2026-07-06-ssr-public-pages-plan.md](./2026-07-06-ssr-public-pages-plan.md)

## Principle

**Reads never compute; writes do.** Computed scores are rows in D1 — the same
database the scoring inputs live in — written when the inputs change and
served instantly, always. Bounded staleness is an accepted cost: if a scorer
adds a penalty to one pilot, the rest of the field's scores are already
correct, and the affected row catches up seconds later. In exchange, no human
or crawler ever waits multiple seconds for a score page, and no burst of
traffic can stack up duplicate computations.

The one non-negotiable that makes staleness acceptable: **every scores
surface shows when its scores were computed**, and says so plainly while a
re-score is in flight.

## Current state (what this replaces)

Both score endpoints (`web/workers/competition-api/src/routes/score.ts`)
compute a deterministic state hash (`computeScoreCacheKey`: engine version +
xctsk + roster + uploads + penalties — re-reading every track row of every
task on every request), look up KV under that exact key, and on a miss
compute synchronously — seconds of R2 fan-out + CPU — before responding.
Consequences:

- Any state change (or an engine-version bump, which rolls *every* key at
  once) makes the next visitor eat the full compute latency.
- Concurrent misses (refresh-happy humans, crawler sweeps) each run their own
  full computation — a thundering herd that wastes Worker CPU, R2 reads, and,
  most scarce of all, the KV free-tier write quota (1k/day).
- KV is eventually consistent and has no compare-and-swap, so any
  dedupe lock is best-effort and a scorer isn't guaranteed to read their own
  re-score for up to ~60 s.
- The SSR plan amplifies all of this: every HTML fetch of a comp/task/
  narrative page runs these loaders, and its 5s-timeout fallback would serve
  crawlers an empty shell exactly when the cache is cold.

Why D1 instead of KV, in one line each:

- **Transactional staleness** — the mutation that changes an input can mark
  the scores stale *in the same transaction*, so the read path needs no hash
  computation at all.
- **Real locks / CAS** — conditional `UPDATE`s make revalidation exactly-once
  and kill the out-of-order-writer races the KV design could only document.
- **Read-your-writes** — the scorer reliably sees their re-score once it
  lands; no cross-PoP propagation caveats.
- **Quota headroom** — D1 free tier: 100k rows written/day, 5M read/day, vs
  KV's 1k writes/day that every scenario had to tiptoe around.
- **Fewer round trips** — the old read path was 2 D1 queries (hash) + 1 KV
  read; the new one is a single D1 query.

## Design

### Schema

```sql
-- Materialized scores, one row per task. The blob is the exact
-- TaskScoreResponse the endpoint serves.
CREATE TABLE task_scores (
  task_id            INTEGER PRIMARY KEY
                     REFERENCES task(task_id) ON DELETE CASCADE,
  response_json      TEXT    NOT NULL,
  state_key          TEXT    NOT NULL,  -- computeScoreCacheKey at write time; the ETag
  computed_at        TEXT    NOT NULL,  -- ISO, stamped when the compute finished
  inputs_rev         INTEGER NOT NULL DEFAULT 0,  -- bumped by every score-affecting mutation
  computed_rev       INTEGER NOT NULL DEFAULT -1, -- inputs_rev the blob was computed from
  revalidating_until TEXT    NOT NULL DEFAULT ''  -- lock lease (ISO); '' = unlocked
);

-- Per-track, field-independent analyses (today's pa:/od:/pd: KV entries).
-- Overwritten in place when the geometry or the upload changes.
CREATE TABLE track_analysis (
  task_track_id INTEGER NOT NULL
                REFERENCES task_track(task_track_id) ON DELETE CASCADE,
  variant       TEXT    NOT NULL,  -- 'gap' | 'od' | 'pilot-detail'
  geom_hash     TEXT    NOT NULL,  -- task geometry + engine version, as today
  uploaded_at   TEXT    NOT NULL,  -- of the track the payload was computed from
  payload_json  TEXT    NOT NULL,
  PRIMARY KEY (task_track_id, variant)
);
```

`scores_stale` is derived, not stored: a row is stale iff
`computed_rev < inputs_rev`. Storing two integers instead of a flag gives
revalidation a real CAS token (below). Foreign-key cascades mean deleted
tasks/tracks clean up their materialized rows — no TTLs, no orphan garbage.

**No `comp_scores` table.** Comp standings are pure aggregation over the
per-task blobs plus team assignments: the comp endpoint reads all
`task_scores` rows for the comp in one query, aggregates in the worker
(cheap JS over already-computed numbers), reads teams fresh from
`comp_pilot`, and reports `computed_at` = oldest task `computed_at`,
`stale` = any task stale. This deletes the whole comp-level
staleness-propagation problem (team edits need no cache handling at all) —
the KV draft needed a second envelope and a second hash for this.

### Read path (task endpoint; comp endpoint is the same over N rows)

1. Existing comp/task existence + `test`-visibility checks (unchanged —
   they run before any lookup, so test comps can never leak).
2. `SELECT * FROM task_scores WHERE task_id = ?` — one query:
   - **Fresh** (`computed_rev = inputs_rev`): serve `response_json`.
     `X-Cache: HIT`.
   - **Stale** (`computed_rev < inputs_rev`): serve `response_json`
     immediately with `stale: true`, and schedule revalidation (below) via
     `ctx.waitUntil`. `X-Cache: HIT-STALE`.
   - **No row**: cold — compute synchronously (as today), insert the row,
     serve. `X-Cache: MISS`. Only ever happens for a task whose creation
     predates this feature or slipped past the mutation hooks; the
     mutation-path compute (below) means normal tasks have a row before the
     public ever visits.
3. **ETag / `If-None-Match`:** the ETag is the stored `state_key` — the
   identity of the body being served. Conditional match → `304` (still
   scheduling revalidation if stale). Refreshing browsers and Googlebot both
   send conditional requests, so a refresh of unchanged scores costs one D1
   query and transfers nothing.

### Mutation path (compute-on-write)

Every score-affecting mutation already calls `audit()` (project rule in
CLAUDE.md — track upload/delete in `igc.ts`, penalties in
`pilot.ts`/`pilot-status.ts`, xctsk & task edits in `task.ts`, roster/class
edits in `comp.ts`). A shared helper, called right next to `audit()` and
part of the same "adding this call is part of done" rule, does two things:

1. **In the mutation's own D1 batch:** `UPDATE task_scores SET inputs_rev =
   inputs_rev + 1 WHERE task_id = ?` (upserting the row if absent). The
   instant the mutation commits, every reader sees `stale: true` — no race,
   no propagation delay.
2. **After responding:** `ctx.waitUntil(revalidate(taskId))`.

So the scorer's penalty is followed within seconds by fresh scores, and
anyone already on the page sees the banner (below) the moment they next
touch the endpoint.

### Revalidation (the only writer of `response_json`)

Runs inside `ctx.waitUntil`, from a stale read or a mutation:

1. **Take the lock:** `UPDATE task_scores SET revalidating_until = <now+120s>
   WHERE task_id = ? AND revalidating_until < <now>`. Zero rows changed →
   someone else is on it → stop. This is a real lock, not KV best-effort.
2. Capture `rev = inputs_rev`, run `computeTaskScore` — reusing
   `track_analysis` rows, so a one-pilot penalty edit re-fetches zero tracks
   from R2 and a single new upload re-fetches one.
3. **CAS write:** `UPDATE task_scores SET response_json = ?, state_key = ?,
   computed_at = ?, computed_rev = ?rev, revalidating_until = '' WHERE
   task_id = ? AND inputs_rev = ?rev`. If a further mutation bumped
   `inputs_rev` mid-compute, the row still gets the (already newer than
   before) result via a fallback write that keeps `computed_rev = ?rev` —
   i.e. the row stays marked stale and the mutation's own `waitUntil` (or
   the next stale read) converges it. No result computed from older inputs
   can ever be recorded as fresh: that class of race is gone, not just
   self-healing.

### Engine version bumps

The one input change with no mutation handler. A deploy-time migration step
runs `UPDATE task_scores SET inputs_rev = inputs_rev + 1` (one statement,
every row stale, nothing slow), and an optional cron backfills recomputes in
the background. Until each task's turn comes, everyone gets instant,
timestamped, old-engine scores — the crawler sweep after a deploy spreads
the recompute load instead of stampeding it.

### API shape changes

`TaskScoreResponse` and the comp scores response gain:

- `computed_at: string` — ISO timestamp of when the scores were computed
  (comp level: the oldest constituent task).
- `stale: boolean` — true when newer inputs exist and a re-score is in
  flight or pending.

Headers: `ETag` (stored `state_key`; comp level: hash of the task
`state_key`s + team assignments), `X-Cache: HIT | HIT-STALE | MISS`, and
`Cache-Control: private, no-store` when a session cookie is present,
otherwise `public, max-age=0, must-revalidate` (matching the SSR plan; the
ETag makes must-revalidate cheap).

### UI: make freshness visible

- Every scores surface (`Scores.tsx`, `ScoresSection.tsx`, task detail, and
  the SSR'd comp page once the SSR plan lands) renders the timestamp next to
  the tables — e.g. "Scores computed 7 Jul 2026, 14:32 UTC" (absolute, in the
  comp timezone, so SSR output is deterministic — no relative "2 min ago" on
  the server-rendered path, per the SSR plan's hydration-mismatch rule).
- **Re-score banner (JS frontend only).** When the response has
  `stale: true`, the score list shows a clearly visible notice:
  *"Hold tight, scores are being re-scored…"*. The client then polls the same
  endpoint for freshness and, once the re-score has landed, switches the
  notice to *"Re-score finished [Reload]"* — a button that reloads the page
  on tap/click. No silent data swap: rankings reordering under the reader is
  more disorienting than an explicit reload, and the reload path also works
  identically once the pages are SSR'd (the fresh HTML simply renders the new
  scores, no banner).
  - **Polling is conditional and cheap.** Each poll is a `fetch` with
    `If-None-Match: <ETag of the stale body>`. While the re-score is still
    running the row is unchanged → `304`, no body. When it lands, the
    `state_key` changes → `200` → show the Reload button. Polls never
    trigger extra computation: a stale read only *schedules* revalidation,
    and the lock dedupes. Each poll costs one D1 row read.
  - Cadence: every ~4 s, backing off to ~15 s, giving up after ~2 minutes
    (leave the "being re-scored" notice with the timestamp — the next manual
    reload picks up whatever is newest). Stop polling when the tab is hidden
    (`visibilitychange`) and resume on return.

### KV namespace wind-down

`track_analysis` replaces the `pa:`/`od:`/`pd:` KV entries and the D1 rows
replace `score:`/`compscore:`. The only remaining user of
`glidecomp_scores_cache` is the 3D-replay bundle cache (`3dvis:` keys,
`visualization.ts`) — out of scope here; the namespace stays for that alone.
The admin cache routes (`routes/cache.ts`) swap `kv.list()` pagination for
SQL counts (`task_scores` rows, stale counts, `track_analysis` rows) and
"clear" becomes "mark all stale" (`inputs_rev + 1`) plus an optional hard
delete — a better admin story than blind key deletion.

### What this buys, by scenario

- **Refresh-happy human:** every request is one D1 read serving instantly
  (or a 304); at most one revalidation runs regardless of how hard they
  hammer F5 — and it's *exactly* one now, not "usually one".
- **Penalty edit mid-comp (the motivating example):** everyone keeps getting
  instant, 99%-correct scores labelled with their timestamp; `stale: true`
  is visible transactionally with the edit; the affected pilot's row and
  ranking correct themselves within seconds; the scorer reliably reads their
  own re-score.
- **Engine-version bump on deploy:** every row goes stale, *nothing goes
  slow*; recomputes spread over organic traffic or the backfill cron.
- **Daily crawler sweep (with the SSR plan's sitemap):** unchanged comps are
  one-row reads / 304s. Changed comps cost one background recompute each.
  The SSR loader always returns quickly, so the SSR plan's 5s-timeout shell
  fallback becomes near-dead code and its thin-content-indexing risk
  disappears.
- **Quotas:** scoring stops consuming KV entirely; D1's 100k writes/day
  dwarfs the handful of rows a busy comp day writes; reads per request go
  *down* versus today (no more per-request roster/track re-reads for the
  hash).

### Interaction with the SSR plan

- The SSR loaders call these endpoints over the service binding and inherit
  stale-first for free; the comp page's HTML `ETag` can be derived from the
  served `state_key`s plus the build hash, making crawler recrawls of
  unchanged comps almost free at the HTML layer too.
- The SSR plan's "Cold-score latency" risk section should point here once
  this lands; its timeout fallback can stay as a belt-and-braces guard but is
  no longer the mitigation of record.

## Trade-offs accepted

- **Blob over normalized rows.** One JSON blob per task is quota-cheap and
  simple; per-pilot score rows would be queryable (pilot history, cross-comp
  stats) but cost ~a row per pilot per recompute and need reassembly. Start
  with the blob; normalized rows can be added later when a feature wants
  them. Verify the D1 value-size limit (~2 MB) against the largest realistic
  comp — score JSONs run tens to low hundreds of KB, so there is headroom.
- **D1 primary-region reads** instead of edge-cached KV reads. Already the
  status quo — today's path hits D1 twice before KV — and the new path does
  strictly fewer round trips. D1 read replication (sessions API) exists if
  far-region latency ever matters.
- **`inputs_rev` bumping is handler discipline**, like `audit()` — a
  forgotten bump means silently stale scores. Mitigations: the helper is
  called at the same call sites as `audit()` under the same "part of done"
  rule; `state_key` (still computed at write time) doubles as a drift
  detector — an optional weekly cron recomputes the hash for recently-active
  tasks and re-marks stale on mismatch, turning "forgot the bump" from a
  silent bug into a bounded delay.
- **A schema migration, not a cache tweak.** The payoff includes a
  transparency bonus that fits this project's ethos: score rows with
  `computed_at` + `state_key` sit next to the audit log, and an append-only
  history table ("scores as anyone saw them at time T") becomes a cheap
  future option KV could never offer.

## Phases

1. **Schema + task read/write path** — migration for both tables; endpoint
   reads the row; revalidation with lock + CAS; ETag/304;
   `computed_at`/`stale` fields; synchronous cold path for rowless tasks.
   Unit tests alongside `test/cache.test.ts` / `scoring.test.ts` patterns:
   fresh read, stale read serves old body + schedules revalidation, lock
   admits one winner, CAS refuses to mark a mid-mutation result fresh, 304
   on matching ETag.
2. **Comp endpoint** — aggregate standings from `task_scores` rows + live
   team reads; comp-level ETag; drop the comp-level hash/envelope entirely.
3. **UI freshness** — timestamps on all scores surfaces; the re-score
   banner: "Hold tight, scores are being re-scored…" on `stale: true`,
   conditional-GET polling, then "Re-score finished [Reload]".
4. **Mutation hooks** — the `bumpScoreInputs()` helper called beside
   `audit()` in every score-affecting handler + `waitUntil` revalidation;
   engine-bump migration statement; optional backfill cron.
5. **Per-track analyses to D1** — port `pa:`/`od:`/`pd:` reads/writes to
   `track_analysis`; admin cache routes to SQL; leave KV to `3dvis:` only.
6. **Verification** — e2e: scores pages show the timestamp; penalty-edit
   flow shows the re-score banner, then the Reload button, and reloading
   shows the updated scores; polls are `304`s while stale (assert no
   recompute is triggered by polling); `X-Cache` assertions in the deploy
   smoke test.

## Acceptance criteria

1. Once a task has a `task_scores` row, `GET .../score` and
   `GET .../scores` respond from a single D1 read (tens of ms) regardless of
   subsequent data changes — no `X-Cache: MISS` after first touch in e2e.
2. A penalty edit makes the very next read return `stale: true` with the
   pre-edit scores and their `computed_at` (transactional, not eventual);
   fresh scores are servable within seconds with no user-facing slow
   request. A viewer already on the page sees "Hold tight, scores are being
   re-scored…", then "Re-score finished [Reload]", and reloading shows the
   updated scores.
3. N concurrent stale reads trigger exactly one recompute (lock), and a
   result computed from superseded inputs is never recorded as fresh (CAS).
4. Every scores surface (SPA and, later, SSR HTML) displays the
   computed-at timestamp.
5. Scoring performs zero KV operations; D1 writes occur only on state
   change, never per read.

## Implementation notes (as built)

Implemented per this plan (migration `0012_task_scores.sql`,
`competition-api/src/score-store.ts`, `routes/score.ts`, hooks in
`igc.ts`/`task.ts`/`comp.ts`/`pilot.ts`, `ScoreFreshness.tsx`), with these
deliberate deltas:

- **Engine bumps need no deploy step.** Instead of a deploy-time
  `inputs_rev + 1` statement, `task_scores` stores the `engine_version` the
  blob was computed with, and staleness is
  `computed_rev < inputs_rev OR engine_version != SCORING_ENGINE_VERSION`.
  A deploy that bumps the engine version makes every row read as stale on
  its next visit — same spread-the-recompute behaviour, no pipeline step to
  forget. The store-write guard treats a changed engine version like a newer
  revision, so mixed-version workers during a rolling deploy converge.
- **The bump follows the write.** `bumpScoreInputs()` runs immediately
  after the mutation's DB write rather than inside one batch with it (the
  handlers are multi-statement already, like `audit()`). The invariant that
  matters is ordering: bump strictly AFTER the write, so a concurrent
  revalidation can never capture a rev that predates data it then reads.
- **pilot-status.ts has no hook.** Pilot statuses are roll-call metadata —
  `computeTaskScore` never reads `task_pilot_status` — so status edits
  don't (and mustn't) re-score. Penalties live in `igc.ts`'s PATCH route,
  which is hooked. If statuses ever become scoring inputs (DNF/DSQ
  handling), add the helper beside their `audit()` calls then.
- **Revalidation also releases the lock on no-op runs** (row already fresh,
  or the guarded write was filtered because a newer result landed first) —
  otherwise a redundant trigger would sit on the lease for its full 120 s
  and delay the next legitimate re-score.
- **The ETag folds the staleness label in** (`"<state_key>:stale"` while
  stale). The served body includes `stale`, so a stale-labelled body must
  not share a validator with the fresh one — otherwise a browser that
  cached the stale-labelled body keeps re-serving its banner via 304s after
  the re-score concludes, and a re-score that reproduces identical scores
  (a no-op bump, e.g. the admin mark-stale) never flips the client's poll
  to 200. The plan's polling contract is unchanged: 304 while the re-score
  runs, 200 the moment it lands.
- **Team edits confirm the no-comp-blob design:** they change the comp
  ETag (it hashes task state_keys + team assignments) and the served teams
  with zero recomputes and zero cache handling.
- The comp endpoint reports `computed_at: null` for a comp with no
  scoreable tasks; the UI renders no timestamp in that state.
