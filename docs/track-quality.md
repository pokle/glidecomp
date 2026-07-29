# Track data quality

FAI S7A §4.4.2 — the verification software must check that "all points used to
verify the flight occurred at reasonable times". Current-state reference.

`web/engine/src/track-quality.ts` assesses every tracklog against its task.
`assessTrackQuality()` is pure, and returns a report of findings each already
rendered as a sentence.

## The checks

**HARD** — withholds the track from scoring *and* from field analysis:

- fixes outside the task's LOCAL day by more than a day
- no fix within 100 km of any turnpoint

**SOFT** — annotates only:

- never left the take-off cylinder
- no sign of flight
- implausible sustained speed

Soft checks only annotate because a short honest flight still earns the S7F
§5.3/§8.6.1 minimum distance.

## A withheld pilot is never deleted from the standings

`buildClassScore` seats them last at 0 with the reasons
(`PilotScoreEntry.track_excluded`).

Before that fix, removing a track made the pilot vanish entirely — uploading
auto-sets them "Landed", which counts in neither `numFlying` nor `numDNF`.

They stay out of both S7F §9.1 buckets deliberately, so a false positive can only
ever change **that one pilot's** score.

## The organiser overrides

§4.4.6 makes rejection the organiser's call, so every verdict is overridable per
track (`task_track.quality_override`, migration 0024).

The verdict is computed on the read path and cached as the `"quality"`
`track_analysis` variant — **never** stored on `task_track`, because it depends
on the task's route, date and zone, all of which an admin can edit.

## Re-tuning the thresholds

Thresholds are calibrated against the whole archive. Re-tune them only with both
of:

```
bun web/scripts/audit-track-quality.ts
GLIDECOMP_COMPS_DIR=<archive>/comps bun web/scripts/audit-track-quality.ts
```

which must report **exactly one HARD finding across 5,112 real tracks**.

`track-quality.ts` is in `SCORING_ROOTS`, so a threshold change cannot ship
without a `SCORING_ENGINE_VERSION` bump.
