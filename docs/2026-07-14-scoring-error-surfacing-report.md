# Report: the silent scoring exception, and why it stayed silent

**Date:** 2026-07-14
**Context:** A real exception in the competition-api worker corrupted a task's
scores but surfaced *nowhere* the user could see — only in the local
`wrangler dev` console. This report documents that specific failure and, more
importantly, the **systemic gap**: scoring failures in the API are neither
surfaced to the frontend, nor monitored, nor alarmed. It's the brief for a
follow-up session on error surfacing + observability.

---

## 1. The exception that prompted this

```
Error: scoreFlights: useLeading requires a leadingAggregate, or fixes + sequence, in FlightScoringData
    at gap-scoring.ts:1303  (Array.map)
    at scoreFlights          (gap-scoring.ts:1291)
    at computeTaskScore      (competition-api/src/scoring.ts:891)
    at computeAndStoreTaskScore (competition-api/src/score-store.ts:319)
    at revalidateTaskScores  (competition-api/src/score-store.ts:282)
    at async Promise.allSettled (index 0) { taskId: 7 }
```

**Root cause (already fixed, engine v14):** turning on leading points by
default for HG comps made `scoreFlights` demand leading inputs for *every*
flight, but a manual flight (a track-less pilot, issue #306) has no tracklog,
so it carried no leading aggregate/fixes/sequence and the scorer threw. Fixed
by marking such flights `trackless` and awarding them zero leading points.

**That fix is not the point of this report.** The point is everything the
exception did *not* do on its way out.

---

## 2. Why it was invisible

The scores are a **stale-first store** (`score-store.ts`,
[docs/score-caching-stale-first-plan.md](score-caching-stale-first-plan.md)):
reads never compute; a scoring-input change bumps the row stale and schedules a
**background** recompute. The exception happened on that background path, which
is built to swallow errors:

1. **`scheduleTaskRevalidation()`** runs the recompute under
   `c.executionCtx.waitUntil(Promise.allSettled(...))`. `allSettled` never
   rejects — a throwing task becomes a discarded rejected result.
2. **`revalidateTaskScores()`** wraps its body in `try/catch` and, on error,
   does only `console.error("score revalidation failed", err, { taskId })` then
   releases the lock. By design — a failed revalidation must not crash the
   request that scheduled it — but the failure goes **only to the console**.
3. The row stays stale forever (`computed_rev < inputs_rev`): every future read
   re-serves the old blob and re-schedules a revalidation that throws again.

So the exception never reached a request, never hit the app's `onError`
handler (`index.ts:81` — that only catches **request-path** errors, never
`waitUntil` work), and produced no 500, no metric, no alert. The user only saw
it because they happened to be tailing the local worker console.

### The asymmetry worth knowing
The **same** `computeAndStoreTaskScore` is also called **synchronously** in the
GET handler for a *cold* task — one that has no materialized row yet
(`routes/score.ts:129`, and the comp-level loop at `:219`). There it is **not**
wrapped, so the throw *does* propagate → `onError` → **HTTP 500** to the client.

Net effect, same underlying bug, two completely different behaviours:
- **Never-scored task** → loud 500 on read.
- **Previously-scored task, later bumped stale** (the common case; this was
  task 7) → silent forever; frontend shows stale scores + a perpetual
  "re-scoring…" banner.

---

## 3. What the frontend showed (nothing useful)

`CompScoresSection.tsx` fetches `/scores`, gets a **200** with `stale: true`
(the pre-failure blob), and renders `ScoreFreshness.tsx`, which:
- shows *"Hold tight, scores are being re-scored…"*, and
- polls the endpoint with `If-None-Match` until the ETag changes.

Because revalidation keeps throwing, the ETag never changes. The poll gives up
after ~2 minutes (`POLL_GIVE_UP_MS`) and just… stops, leaving the banner up. The
only "error" state `CompScoresSection` has is `unavailable`, reached solely when
the fetch returns non-OK — a stale 200 is OK, so it never triggers. **A pilot
looking at the page sees plausible-but-stale scores and an optimistic banner,
indefinitely, with no indication anything is wrong.**

---

## 4. The monitoring / alarm gap

- **No Workers observability.** `competition-api/wrangler.toml` has no
  `[observability]` block, no `tail_consumers`, no logpush. In production the
  `console.error`s are effectively write-only — visible only via a live
  `wrangler tail`, retained nowhere.
- **No error tracking.** No Sentry / equivalent; no structured error events.
- **`onError` leaks + under-reports.** `index.ts:81` returns the raw
  `err.message` in the 500 body (internal detail leak) and, being request-scoped,
  never sees background-path failures at all.
- **No alarms.** Nothing watches for "task N has been stale and failing to
  revalidate for X minutes," which is the exact shape of this incident.

---

## 5. Brief for the follow-up session

Goal (user's words): failures like this should be **caught, surfaced in the
frontend as errors, monitored, and alarmed with enough context to fix them.**
A sketch of the surface area:

**Catch & record (backend).** Give `revalidateTaskScores` a durable failure
record instead of a bare `console.error` — e.g. persist the last error
(message + `taskId` + `inputs_rev` + engine version + timestamp) on the
`task_scores` row (a `last_error` / `last_error_at` column), and increment a
consecutive-failure counter. This turns an ephemeral log line into queryable
state and is the single source both the frontend and alarms read from.

**Surface (frontend).** `ScoreFreshness` / `CompScoresSection` should
distinguish "re-scoring in progress" from "re-score is **failing**." When a row
has been stale-and-failing past a threshold (or `last_error` is set), show a
real error state ("Scores couldn't be updated — the organiser has been
notified") instead of the perpetual optimistic banner. Admins could see the
underlying reason; visitors a generic message. Decide whether a hard failure
should down-rank confidence in the stale numbers shown.

**Monitor.** Enable `[observability]` on the worker (Workers Logs) at minimum;
consider a `tail_consumer` worker or Sentry for structured error events. Emit a
structured event on every revalidation failure with full context: `taskId`,
`comp_id`, `scoring_format`, resolved `gap_params`, engine version, error.

**Alarm.** Something that fires when a task is stale + failing for > N minutes,
or when the revalidation error rate crosses a threshold — carrying enough
context (which comp/task, which formula, the error) to act without spelunking.
A Cron-triggered sweep over `task_scores WHERE computed_rev < inputs_rev AND
last_error_at < now - N` is a cheap first version.

**Also worth fixing in passing:** the `onError` handler returning raw
`err.message` to clients (leak), and the cold-vs-stale asymmetry (a cold task
still 500s synchronously — decide whether reads should ever compute, or always
serve-then-revalidate).

### Key files
- `web/workers/competition-api/src/score-store.ts` — `scheduleTaskRevalidation`,
  `revalidateTaskScores` (the swallow), `computeAndStoreTaskScore`.
- `web/workers/competition-api/src/routes/score.ts` — cold synchronous compute
  (`:129`, `:219`); the stale-serving read paths.
- `web/workers/competition-api/src/index.ts:81` — `onError` (request-path only).
- `web/workers/competition-api/wrangler.toml` — no observability configured.
- `web/frontend/src/react/comp/ScoreFreshness.tsx`,
  `web/frontend/src/react/comp/CompScoresSection.tsx` — the optimistic banner /
  missing error state.
- `web/db/migrations/0012_task_scores.sql` — the row shape to extend with error
  columns.
