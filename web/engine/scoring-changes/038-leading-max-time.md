# Leading coefficient's land-out tail runs to maxTime

The leading coefficient's land-out tail runs to the spec's field-level
`maxTime` (issue #585, S7F §11.3.1):

```
maxTime = min(max(lastOutlandingTime, lastESStime), taskDeadline)
```

Both variants inherited AirScore's tail instead. The classic (HG) one
ran to max(lastESStime, the pilot's OWN last fix) — per-pilot, so a
pilot who landed early was never carried out to the field's last
land-out; the weighted (PG) one ran to lastESStime alone and never
extended at all for the pilots the prose is about ("for pilots who land
out after the last pilot reached ESS, the calculation keeps going until
they land"). Neither capped anything at the task deadline.
`maxTime` is now resolved once per class from the whole field — the
last land-out is the latest tracklog end among started pilots who never
reached ESS — and capped at the goal deadline (§8.3.c) and, on a
stopped task, at the stop time (§12.3.1), since nothing after either is
scored and a recorder left running would otherwise stretch every
pilot's tail. A deadline at or before the first start is ignored, the
same task-setting mistake resolveTimingWindow already ignores. Both
tails are floored at zero: the cap can land maxTime before a very late
starter's own crossing, and a negative tail would hand that pilot the
field's best coefficient.
Measured over the 58 leading-scored tasks of the 211-comp archive
(1,521 scored pilots), against a master that already carries v37:
12.6% of pilots' leading points move, mean |Δ| 0.6 points, p95 3.3,
largest 17.8, and 2.0% change rank. Distance, time and arrival points
are untouched, and 34 of the 58 tasks are unchanged — every one whose
last land-out came before the last ESS.
The movement concentrates on the 9 archive tasks where NOBODY reached
ESS, and there it is a correction, not a perturbation. With no last-ESS
time the old tail fell back to each pilot's OWN last fix, so a pilot
was charged for the whole time they stayed up and credited for landing
early — the leading order came out close to the landing order. On
Forbes 2022 task 7 the pilot with the old best coefficient (1.63, all
17.5 leading points on offer) is the first to land; under one shared
maxTime they hold the WORST of the field (7.93) at 0 points, and the
pilot who got nearest ESS takes the 17.5. Those tasks also moved CLOSER
to AirScore's published totals (Forbes 2022 task 7: mean |Δtotal|
33.7 → 25.8; Forbes 2025 task 4: 27.6 → 25.5), despite the change being
a deliberate departure from AirScore.
v37 is why the numbers are small: it cut a no-goal HG day's leading
offer from up to 100 points to the spec's 17.5, and those are exactly
the days this changes most. Against the pre-v37 master the same run
moved a pilot by as much as 93 points.
The scored payload also carries the resolved clock per class
(`leading_times`: first start, last ESS, last land-out, deadline, stop,
and the maxTime they produce), because `maxTime` is the one input to a
landed-out pilot's coefficient that lives entirely outside their own
flight — the report card now names it and says which field time set it.
