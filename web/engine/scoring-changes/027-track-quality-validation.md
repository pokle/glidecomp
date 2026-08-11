# Track data-quality validation

Track data-quality validation (FAI S7A §4.4.2, §4.4.6). A new module,
track-quality.ts, assesses every submitted tracklog against its task
before it is scored; the backend withholds a HARD-failed track from
scoring AND from field analysis, seating the pilot last at zero with the
reasons attached rather than letting them vanish from the results.
§4.4.2 puts this obligation on the verification software — "all points
used to verify the flight occurred at reasonable times (e.g. on the day
in question)" — and nothing checked it, because time-gates.ts resolves
the task's gates near an instant taken from the FLIGHT, so a tracklog
from another day silently relocated the task onto its own calendar day
and scored normally.
Two HARD checks: the fixes fall wholly outside the task's LOCAL day by
more than a day (the local day, resolved in the comp's zone, is what
lets an Australian task flown 00:09–04:13 UTC pass; the one-day grace is
because a recorder set a day out is a real recurring fault — three
Bright Open 2020 pilots, one of whom placed 4th in goal), or no fix
comes within 100 km of ANY turnpoint. Three SOFT checks only annotate —
never left the take-off cylinder, no sign of flight, implausible
sustained speed — because a short honest flight still earns the §5.3 /
§8.6.1 minimum distance and that behaviour is correct.
§4.4.6 makes rejecting a track log the organiser's judgement, so the
verdict is overridable per track (task_track.quality_override).
Withholding a track changes numPresent, hence launch validity and every
distance ratio on an affected task; tasks with no hard-failed track
recompute identically.
