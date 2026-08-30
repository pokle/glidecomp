# "Field analysis" becomes comp analysis and task analysis

NO behaviour change. Not one expression, threshold or constant moved: this
is a rename, and every scored number is identical before and after.

One name, "field analysis", covered two different things — the report for a
whole competition read across its tasks, and the report for a single task's
field read against itself. A reader could not tell from a heading, a
breadcrumb, a tab title or a type name which of the two they had in front of
them. They are now named apart everywhere: **comp analysis** under a
competition, **task analysis** under a task.

Four files inside the hashed scoring closure are touched, and in all four the
only edit is to a COMMENT that named the old concept:

- `gap-types.ts` — a note on why the competition API refuses the analysis on
  an oversized field.
- `takeoff-landing-detector.ts` — a note listing the consumers of the raw
  event stream.
- `track-quality.ts` — the notes on what a HARD verdict withholds a track
  from, and on a day-profile axis bug.
- `zone-offset.ts` — a cross-reference to the report's time formatter.

Because the generation is a content hash over that closure, a comment is
enough to roll it, so every competition recomputes. The recompute is
harmless: the scoring sources are otherwise byte-identical, and the engine's
own suites (1,612 assertions) and the competition API's 769 pass unchanged.

The behavioural metrics themselves did not move either, so
`TASK_ANALYSIS_VERSION` (the second stamp on a stored analysis row) is
deliberately NOT bumped — the stored reports stay valid and are not
recomputed by this change.

Storage follows the naming: migration 0033 renames `task_field_analysis` to
`task_analysis`, a pure `ALTER TABLE … RENAME TO` that rewrites no row and
discards no cached report. The API routes lose the redundant word too —
`/api/comp/:id/analysis` and `/api/comp/:id/task/:id/analysis`, matching the
page URLs they serve.
