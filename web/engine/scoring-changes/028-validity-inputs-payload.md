# Transparency fields in the scored payload

NO behaviour change — a payload roll. The scored body now carries the
transparency fields the score-details page needs to show its working:
per-class `validity_inputs` (the field counts, best distance/time, goal
ratio, weights and the mean distance over minimum that the validity and
weight formulas were evaluated from), the fully-resolved `gap_params`
the class was actually scored with (comp settings AND the task's own
migration-0021 overrides, "auto" nominal distance already resolved),
and each pilot's `leading_coefficient`. Every point on the page is
unchanged; only what the page can explain about them changes.
Bumped deliberately even though scoring is identical: the fields are
optional and every consumer degrades without them, but the stale-first
store would otherwise serve pre-change bodies for settled comps
indefinitely — and a settled comp is exactly the one a pilot reads.
