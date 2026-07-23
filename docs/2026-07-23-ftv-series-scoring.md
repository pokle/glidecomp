# FTV (Fixed Total Validity) series scoring — 2026-07-23

Implements the FTV part of issue #266 (FAI S7F §13–15, S7A §5.2.5). Point-in-time
record of the design as shipped; see `docs/competition-spec.md` for the current
schema/API and the `/scoring/gap` explainer for the pilot-facing version.

## What FTV is

A competition's standings combine each pilot's task scores. Two methods, chosen
per comp (`comp.series_scoring`):

- **`total`** — sum of all task scores. The default; used by HG comps and short
  series. Ties share a place (S7A §5.2.5.4), via `rankByTotalScore`.
- **`ftv`** — Fixed Total Validity (S7F §15). Scores each pilot on their best
  tasks: a fixed fraction of the total validity is discarded, so one bad day
  hurts less. The paragliding norm.

## The algorithm (S7F §15, matched against AirScore)

Per pilot class:

1. Each task's FTV **validity** = the class day-winner's score ÷ 1000 (AirScore's
   `validity_ref = max_score`; the winning score is the operative measure of the
   day's worth).
2. **Discard factor** (S7A §5.2.5.1): `0.2` for ≤6 planned tasks, `0.25` for ≥7.
   We derive "planned" from the scoreable-task count; `comp.ftv_factor` overrides.
3. **CalculatedFTV** = `(1 − factor) × Σ validity` over the class's tasks (the
   kept validity — the same cap for every pilot in the class).
4. Per pilot: order their flights by performance (`score ÷ winnerScore`)
   descending; add each raw task score and consume its validity until the kept
   validity reaches CalculatedFTV. A task that fits counts in **full**; the task
   that tips over counts a **fraction** (scaled so the kept validity lands exactly
   on the cap); the rest are **discarded**. A pilot who flew too few tasks to
   reach the cap keeps all of them.

Engine: `web/engine/src/ftv.ts` — `ftvDiscardFactor`, `calculatedFtv`,
`computeFtvForPilot`, and `explainFtv` (which-tasks-counted/discarded sections).
Pure and unit-tested (`web/engine/tests/ftv.test.ts`); full precision internally,
rounded only for display and for tie comparison.

## Where it runs

FTV is a **pure re-aggregation over the per-task scores already stored** — no
task is re-scored and nothing new is materialized. `GET /api/comp/:id/scores`
(`web/workers/competition-api/src/routes/score.ts`) computes the day-winner per
class/task while aggregating, then (for GAP comps set to FTV with >1 task) runs
`computeFtvForPilot` per pilot, setting `total_score` to the FTV total and
annotating each per-task entry with `ftv_status` / `ftv_counted_score` /
`validity`. Non-FTV, non-GAP, or single-task comps fall back to the sum.

## Settings, audit, and caching

`comp.series_scoring` + `comp.ftv_factor` (migration 0022). Set on create
(new PG GAP comps default to `ftv`; DB default stays `total` so existing comps
never change silently) and via `PATCH /api/comp/:id` (SettingsDialog).

Deliberate departure from `scoring_format`: these two fields change the
**standings** but not any per-task score. So they are **audit-logged** (they
change published results) but do **not** call `bumpAndRevalidateScores` — bumping
every task's materialized score would be wasted work. Cache correctness comes
from folding `series_scoring` + `ftv_factor` into the `/scores` comp ETag, so a
toggle invalidates the cached response.

## UI

- `CompScoresSection` standings: FTV total in the Total column; discarded
  per-task scores struck through, part-counted marked "(part)", both with
  tooltips; a caption naming the discard %; and a per-pilot **breakdown** dialog
  (`FtvBreakdown`) listing counted/discarded tasks and the arithmetic.
- `SettingsDialog`: "Series scoring" control (GAP comps only) — Sum of task
  scores / FTV, with an automatic-or-explicit discard-fraction selector.

## Decisions

- **PG default = new comps only.** New PG GAP comps default to FTV; existing
  comps keep sum-of-tasks until an admin opts in. Avoids silently rewriting
  already-published standings. A backfill (`UPDATE comp SET series_scoring='ftv'
  WHERE category='pg' AND scoring_format='gap'`) can flip them all if wanted.
- **FTV core in the engine**, not the worker — pure, unit-testable, reusable by
  the CLI, and the home of the sibling `score-explanation` module.

## Out of scope (still open on #266)

Female/nation sub-rankings (need a pilot gender/nation schema migration first).
