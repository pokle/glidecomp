# Open-distance results stop fabricating GAP scaffolding

NO scoring change — every pilot's points are identical. This is a shape
change to the open-distance result, and it rolls every scoring cache once
because the generation is derived from the code it touches.

An open-distance result used to fill the GAP-only fields of the shared
result shape with placeholder values: a task validity of 1.0 on every
component (beside an available-points pool of 0), the default GAP parameter
set published as if it were the task's own, and a GAP-style weight split.
Nothing in the UI surfaced them — but that invariant was enforced only by
comments, and any explainer or chart pointed at such a result would have
printed a coherent-looking falsehood.

What changed, without moving any number:

- `TaskScoreResult` is now a discriminated union on a new `format` field
  (`'gap'` | `'open-distance'`), so a consumer must branch on what the
  result is before reading any GAP field.
- The open-distance arm types the GAP-only concepts — `parameters`,
  `taskValidity`, `weights`, `availablePoints` — as null. There is nothing
  plausible left to misread.
- The published class score for an open-distance task now carries the
  neutral zero validity and zero point pool (the same values an empty class
  publishes) instead of the fabricated 1.0 validity. The scores UI never
  rendered validity for open distance, so nothing visible changes.
- Consumers reading stored bodies degrade per the caching rule: a payload
  persisted before the discriminant existed has no `format` and is treated
  as a GAP result — which every such persisted whole-result payload is.

A pilot's open-distance score remains the rounded metres of open distance
flown, computed exactly as before; GAP scoring is untouched apart from the
result declaring `format: 'gap'`. Every cached score therefore recomputes
on deploy and lands on the same numbers it had before.
