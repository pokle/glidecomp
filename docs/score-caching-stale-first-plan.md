# Plan: stale-first score caching with `latest` pointers

**Date:** 2026-07-07
**Status:** proposed
**Companion to:** [ssr-public-pages-plan.md](./ssr-public-pages-plan.md)

## Principle

Serve the last computed scores **instantly, always**, and recompute in the
background when the inputs have changed. Bounded staleness is an accepted
cost: if a scorer adds a penalty to one pilot, the rest of the field's scores
are already correct, and the one affected row catches up seconds later. In
exchange, no human or crawler ever waits multiple seconds for a score page,
and no burst of traffic can ever stack up N duplicate computations.

The one non-negotiable that makes staleness acceptable: **every scores
surface shows when its scores were computed.**

## Current state (what this replaces)

Both score endpoints (`web/workers/competition-api/src/routes/score.ts`)
compute a deterministic state hash (`computeScoreCacheKey`, engine version +
xctsk + roster + uploads + penalties), look up KV under that exact key, and on
a miss compute synchronously — seconds of R2 fan-out + CPU — before
responding. Consequences:

- Any state change (or an engine-version bump, which rolls *every* key at
  once) makes the next visitor eat the full compute latency.
- Concurrent misses (refresh-happy humans, crawler sweeps) each run their own
  full computation — a thundering herd that wastes Worker CPU, R2 reads, and
  most scarce of all the KV free-tier write quota (1k/day).
- The SSR plan amplifies all of this: every HTML fetch of a comp/task/
  narrative page runs these loaders, and its 5s-timeout fallback would serve
  crawlers an empty shell exactly when the cache is cold.

The design below keeps the state hash (it is what defines "fresh") but stops
using it as the *serving* key.

## Design

### KV keys

| Key | Value | TTL |
|---|---|---|
| `score:latest:<taskId>` | `{ v: 1, state_key, computed_at, response }` | none (finished comps stay warm forever) |
| `compscore:latest:<compId>` | same shape | none |
| `score:revalidating:<taskId>` / `compscore:revalidating:<compId>` | `"1"` — best-effort dedupe lock | 120 s |
| `pa:` / `od:` / `pd:` per-track analysis caches | unchanged | 7 days (unchanged) |

`<taskId>`/`<compId>` are the internal numeric IDs. `state_key` is the
existing `computeScoreCacheKey` output (resp. the comp-level hash); it
identifies *which inputs* the stored response was computed from.
`computed_at` is an ISO timestamp stamped when the computation finished.

The exact-state keys (`score:v5:<taskId>:<hash>`, `compscore:v3:...`) are
retired: no reader ever wants a result for a state other than "the latest one
we have", and dropping them halves the KV write volume. The `v` field inside
the value versions the envelope — bump it if the response shape changes and
treat a mismatch as a cold miss.

### Read path (per request, task endpoint; comp endpoint is identical in shape)

1. Existing comp/task existence + `test`-visibility checks (unchanged —
   these run before any cache so test comps can never leak).
2. Compute the current state hash — cheap, two D1 queries.
3. `kv.get("score:latest:<taskId>")`:
   - **Fresh hit** (`state_key` matches the current hash): serve
     `response` as-is. `X-Cache: HIT`.
   - **Stale hit** (`state_key` differs): serve `response` immediately with
     `stale: true`, and schedule a background revalidation (below) via
     `ctx.waitUntil`. `X-Cache: HIT-STALE`.
   - **Miss** (no pointer, or envelope version mismatch): compute
     synchronously — as today — then write the pointer and serve.
     `X-Cache: MISS`. This is the only slow path left, and it only happens
     on the *first ever* request for a task (Phase 3 makes even that rare).
4. **ETag / `If-None-Match`:** the ETag is the `state_key` **of the response
   being served** (not the current DB hash — under stale-first, an unchanged
   pointer means an unchanged body). On a conditional match, return `304`
   after step 3's freshness check, still scheduling revalidation if stale.
   Refreshing browsers and Googlebot both send conditional requests, so a
   refresh of unchanged scores costs two D1 queries and one KV read, and
   transfers no body.

### Background revalidation (the only writer of `latest`)

Triggered from a stale hit or a mutation (Phase 3), always inside
`ctx.waitUntil` so it never blocks a response:

1. `kv.get("score:revalidating:<taskId>")` — if present, someone else is
   already on it; skip. Otherwise `kv.put` the lock (120 s TTL) and proceed.
2. Run `computeTaskScore` (reusing the per-track `pa:`/`od:` caches — a
   single-pilot penalty edit re-fetches zero tracks; a single new upload
   re-fetches one).
3. Recompute the state hash *after* the compute, stamp `computed_at`, write
   `score:latest:<taskId>`.
4. Delete the lock (or let it expire).

The lock is best-effort — KV has no compare-and-swap, so two PoPs can
occasionally both revalidate. That is acceptable: the computation is
deterministic, both writers produce equivalent envelopes, and the herd is cut
from "every request during the compute window" to "at most a couple".
A per-task Durable Object would make this exactly-once; it is deliberately
out of scope until KV-write-quota pressure proves it necessary.

**Out-of-order finish race:** revalidator A (state S₁) and B (state S₂,
newer) can finish in either order; if A writes last, `latest` briefly holds
S₁'s result. The next read sees `state_key ≠ current hash` → serves it as
stale → revalidates → converges. Self-healing, same property the current
design has.

**Cross-PoP lag:** KV propagation means another PoP may serve a slightly
older `latest` for up to ~60 s after a revalidation. Under stale-first
philosophy this is just a little more staleness, correctly labelled by its
`computed_at`.

### API shape changes

Both `TaskScoreResponse` and the comp scores response gain:

- `computed_at: string` — ISO timestamp of when the scores were computed.
- `stale: boolean` — true when the server knows newer inputs exist and a
  revalidation is in flight.

Headers: `ETag` (see above), `X-Cache: HIT | HIT-STALE | MISS`, and
`Cache-Control: private, no-store` when a session cookie is present,
otherwise `public, max-age=0, must-revalidate` (matching the SSR plan; the
ETag makes must-revalidate cheap).

### UI: make freshness visible

- Every scores surface (`Scores.tsx`, `ScoresSection.tsx`, task detail, and
  the SSR'd comp page once the SSR plan lands) renders the timestamp next to
  the tables — e.g. "Scores computed 7 Jul 2026, 14:32 UTC" (absolute, in the
  comp timezone, so SSR output is deterministic — no relative "2 min ago" on
  the server-rendered path, per the SSR plan's hydration-mismatch rule).
- When `stale: true`: show a subtle "updating…" affordance and schedule **one**
  refetch ~8 s later; if the refetch comes back fresh, swap the data in. No
  polling loops — one shot, then the timestamp speaks for itself.
- The comp scores page passes `computed_at` down so per-task and comp-level
  standings can't silently disagree about what the user is looking at.

### Warm on mutation (keep staleness to seconds)

Every score-affecting mutation already calls `audit()` (project rule in
CLAUDE.md) — that same set of handlers (track upload/delete in `igc.ts`,
penalties in `pilot.ts`/`pilot-status.ts`, xctsk & task edits in `task.ts`,
roster/class/team & settings in `comp.ts`) gets a `ctx.waitUntil(revalidate)`
call after the write, going through the same dedupe lock (which doubles as a
debounce during bulk track uploads: the first upload starts a revalidation,
the rest skip; the last state gets picked up by the next stale-hit
revalidation, or by re-checking the hash once more when the lock is
released — implement the recheck, it's one extra `get`).

Effects:
- The scorer who adds a penalty sees it land within seconds (their own next
  fetch either gets the fresh result or a stale-flagged one whose one-shot
  refetch picks it up).
- The public never triggers the slow path at all during a live comp: by the
  time anyone visits, `latest` exists and revalidations were started by the
  mutations themselves.
- The truly-cold first compute only happens for a task nobody has mutated or
  visited — essentially only freshly seeded data. A post-deploy cron warmer
  remains optional polish, no longer a prerequisite.

### What this buys, by scenario

- **Refresh-happy human on a cold-ish page:** first request serves stale
  instantly (or 304s); at most one background recompute runs regardless of
  how many times they hammer F5.
- **Penalty edit mid-comp (the motivating example):** everyone keeps getting
  instant, 99%-correct scores labelled with their timestamp; the affected
  pilot's row and ranking correct themselves within seconds.
- **Engine-version bump on deploy:** every pointer goes stale, *nothing goes
  slow*. Crawlers and humans get instant old-engine scores; each task
  revalidates once (lock-deduped) as it's next visited. The KV write burst is
  spread over organic traffic instead of stampeding.
- **Daily crawler sweep (with the SSR plan's sitemap):** unchanged comps are
  all fresh hits / 304s — two D1 queries each. Changed comps cost one
  background recompute each. The SSR loader always returns quickly, so the
  SSR plan's 5s-timeout shell fallback becomes near-dead code and its
  thin-content-indexing risk disappears.
- **KV write quota:** writes now happen only when state actually changed
  (one `latest` write + changed-track `pa:` writes per revalidation, plus the
  lock), instead of per cold request.

### Interaction with the SSR plan

- The SSR loaders call these endpoints over the service binding and inherit
  stale-first for free; the comp page's `ETag` can be derived from the
  `state_key` values the loaders served (plus the build hash), making
  crawler recrawls of unchanged comps almost free at the HTML layer too.
- The SSR plan's "Cold-score latency" risk section should be updated to point
  here once this lands; the timeout fallback can stay as a belt-and-braces
  guard but is no longer the mitigation of record.

## Out of scope (revisit if pressure appears)

- Durable Object single-flight (exactly-once revalidation).
- Edge Cache API layer in front of KV.
- Rate limiting on `/api/comp/*` (still worth one free WAF rule eventually).
- Stale-first for the per-pilot analysis endpoint (`pd:`) — it already
  per-track caches and recomputes one track at most; apply this pattern later
  only if narrative-page SSR shows it mattering.

## Phases

1. **Worker read path** — `latest` envelopes, stale serving, revalidation +
   lock, ETag/304, `computed_at`/`stale` fields, retire exact-state keys,
   update `routes/cache.ts` prefix stats (`score:latest:`, locks). Unit tests
   alongside the existing `test/cache.test.ts` / `scoring.test.ts` patterns:
   fresh hit, stale hit serves old body + schedules revalidation, lock
   dedupes, 304 on matching ETag, envelope-version mismatch → cold.
2. **UI freshness** — timestamps on all scores surfaces, stale indicator +
   one-shot refetch.
3. **Warm on mutation** — `waitUntil` revalidation from every audit-logged
   score-affecting handler, with the lock-release state recheck.
4. **Verification** — e2e: scores pages show the timestamp; penalty-edit
   flow shows updated scores within the one-shot refetch; `X-Cache`
   assertions in the deploy smoke test.

## Acceptance criteria

1. Once a task has been computed once, `GET .../score` and `GET .../scores`
   respond in KV+D1 time (tens of ms) regardless of subsequent data changes —
   verified by asserting no `X-Cache: MISS` after first touch in e2e.
2. After a penalty edit, the next response is either fresh or `stale: true`
   with the pre-edit scores and their `computed_at`; the fresh result is
   servable within seconds without any user-facing slow request.
3. N concurrent requests during a revalidation trigger at most ~1 recompute
   (lock-deduped) and all get instant responses.
4. Every scores surface (SPA and, later, SSR HTML) displays the
   computed-at timestamp.
5. KV writes occur only on state change, never per read.
