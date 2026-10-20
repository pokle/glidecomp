# The logger's fix interval, and other archive checks (2026-10-20)

**Swept 2026-10-20** over the bundled comps and `pokle/glidecomp-archive`
together: 187 tasks with three or more analysable tracks, 4,948 pilot-task
rows. Synthetic comps (`big-chip`, `kosci-loop`) are excluded.

The sweep started from an outside article, Jörg Korner's
["The invisible railway"](https://joerxc.org/invisible-railway/), which
compares one record flight with a cohort of 100 flights over about 25
parameters. Its methods suggested five checks on our own task analysis. One of
them found a defect that changed published metrics. The other four gave
smaller changes, or no change. This document records all five, because a
negative result is also evidence.

It is a point-in-time snapshot. The shipped behaviour is in
`web/engine/src/analysis/version.ts` (v30).

## Summary

| Check | Finding | Change |
|---|---|---|
| Logger fix interval | A pilot's logger moved them by 24–48 percentile points on seven metrics | Seconds-based thermal detector; four metrics leave out coarse loggers |
| Wind estimators | The ground-speed estimate read 1.5× too high and filled 12% of `day.wind` | `day.wind` uses centre drift only |
| Final glide | The wind changes the committed ratio by 10% or more for 41% of ESS pilots | "Final glide through the air" table |
| Wind by height | The wind barely changes across the working band | None |
| Distance carried while circling | A real 13–17% of a leg, but no new metric in it | None |

## 1. The logger's fix interval

### The loggers in the archive

The modal gap between B records, per pilot-task row:

| Interval | Rows | Share |
|---|---|---|
| 1 s | 4,337 | 87.7% |
| 2 s | 144 | 2.9% |
| 3–4 s | 138 | 2.8% |
| 5 s | 207 | 4.2% |
| 10 s or more | 121 | 2.4% |

126 of 187 tasks have at least one pilot at 5 s or slower. The share is
highest in the oldest comp (2017: 56%) and is about 4% since 2024.

### Method

Every metric is ranked across one field. So anything that changes a value for
a reason other than flying also changes the pilot's place in the field. To
separate the logger from the pilot, the sweep thins a fixed 25% of the 1 Hz
pilots in each task to a coarser logger. It drops B records before parsing, so
altitude cleaning runs on the coarse log, as it would for a real one. Everyone
else stays as logged. Then it measures how far the thinned pilots' percentiles
in the field move. A metric that reads behaviour should not move.

As a check, the archive's real coarse loggers (5 s or slower) are compared with
1 Hz pilots of the same GAP rank.

### What the old detector did

Mean percentile shift of the thinned pilots (0–100 scale), and the residual of
the real coarse loggers:

| Metric | 2 s | 5 s | 10 s | Real ≥ 5 s |
|---|---|---|---|---|
| `climb.exit_decay` | −33 | −48 | −52 | −54 |
| `glide.dolphin_fraction` | −30 | −40 | −30 | −44 |
| `climb.shared_percentile` | −18 | −27 | −36 | −41 |
| `decision.search_fraction` | −15 | −24 | −28 | −32 |
| `climb.time_to_core` | +16 | +34 | +44 | +45 |
| `decision.km_between_climbs` | +9 | +39 | +47 | +51 |
| `climb.circle_smoothness` | +6 | +33 | +44 | +45 |
| `climb.departure_band` | 0 | +11 | +18 | +18 |
| `glide.extra_distance` | −3 | −11 | −17 | −18 |
| `glide.speed` | +2 | −2 | −10 | −12 |

The real loggers show the same shifts as the simulation, so the bias was in
the published task analyses.

These metrics did not move by more than 4 points at 10 s: all `race.*`
metrics, `gaggle.affinity`, `gaggle.departure_winrate`, `race.start_delay`,
`day.airtime_quality` and `decision.altitude_floor`.

Coarse loggers are spread evenly through the results (mean rank percentile
54). So the bias added noise to the correlations, not a false direction. The
noise was not small. With only 1 Hz pilots, `glide.dolphin_fraction`'s median
|ρ| was 0.48 instead of 0.37, and `climb.time_to_core` was informative on
twice as many tasks (16 against 8 of 104).

### The cause

`detectThermals` averaged the climb rate over the last 10 **fixes** and ended a
thermal after 3 weak **fixes**. At 1 Hz that is 10 s and 3 s. On a 10 s logger
it is 100 s and 30 s, so the thermals started early and ran on into the glide.
One real 1 Hz track, thinned to 10 s, went from 18 thermals and 31 minutes of
climbing to 6 thermals and 43 minutes.

Circle fitting needs 8 fixes per circle (`minFixesPerCircle`), which a 20 s
circle on a 5 s logger cannot give. That limit is real and stays.

### The fix: seconds, not fixes

The window is now 10 s and the exit is "weak for 2 s". On an evenly spaced
1 Hz track these rules are exactly the old ones, and
`tests/flight-phase-detectors-interval.test.ts` proves it against a copy of
the old rules. On the same thinned track, the new detector gives 12 thermals
and 36 minutes.

The thermal detector is not in the scoring closure, so no score moves.

Shifts with the seconds-based detector:

| Metric | 2 s | 5 s | 10 s | Real ≥ 5 s |
|---|---|---|---|---|
| `climb.exit_decay` | +3 | −2 | −13 | −13 |
| `glide.dolphin_fraction` | −2 | −30 | −39 | −41 |
| `climb.shared_percentile` | +3 | +8 | 0 | +7 |
| `decision.search_fraction` | −2 | −10 | −15 | −16 |
| `climb.time_to_core` | +4 | +9 | +17 | +17 |
| `decision.km_between_climbs` | +4 | +15 | +28 | +26 |
| `climb.circle_smoothness` | +6 | +33 | +44 | +45 |
| `climb.departure_band` | +1 | +3 | +7 | +5 |
| `glide.extra_distance` | 0 | −1 | −5 | −3 |
| `glide.speed` | −1 | −4 | −10 | −12 |

At 2 s every metric now moves by 6 points or less. At 5–10 s the shifts are a
half to a third of what they were. Over the real archive the metrics separate
the field on more tasks: `climb.exit_decay` 30 → 37, `decision.km_between_climbs`
56 → 64, `decision.search_fraction` 120 → 126, `glide.dolphin_fraction` 73 → 78.
None became materially worse.

### What a coarse log still cannot show: the logger gate

Two metrics read the circles themselves, and a coarse log does not contain
them. Two others read the thermal edges, which degrade more slowly. These four
now leave out a pilot whose logger is too coarse
(`coarseLoggerGate` in `analysis/metrics/util.ts`):

| Metric | Leaves out a logger slower than |
|---|---|
| `glide.dolphin_fraction`, `climb.circle_smoothness` | 2 s |
| `climb.time_to_core`, `decision.km_between_climbs` | 4 s |

The value is null with a note, and the metric's field summary says how many
pilots were left out and why. The logger interval is the median gap between
fixes over the airborne track.

With the gate in place, the audit of the shipped code
([`2026-10-20-fix-interval-audit.txt`](./2026-10-20-fix-interval-audit.txt))
reads "all left out" for the four gated metrics at 5 s and 10 s. Its 2 s column
agrees with the seconds-based detector table to within 2 points: no metric
moves by more than 4.

**Known residuals, not gated.** At 10 s, `decision.search_fraction` (−13),
`climb.exit_decay` (−13) and `glide.speed` (−10) still move a thinned pilot.
They are the next candidates for a gate if 10 s loggers become common again.
They are 2.4% of the archive.

### The archive sweep after the change

Re-run with `audit-metric-distributions.ts` and `audit-metric-conditions.ts`;
the raw outputs are `2026-10-20-metric-distributions.txt` and
`2026-10-20-metric-conditions.txt`. The verdicts in
[2026-09-02-metric-evidence.md](2026-09-02-metric-evidence.md) mostly stand,
with these changes:

| Metric | med \|ρ\| | Informative | Sign | Coverage |
|---|---|---|---|---|
| `decision.search_fraction` | 0.68 → **0.72** | 120 → **126**/181 | 99% → 98% | 90% |
| `glide.dolphin_fraction` | 0.44 → **0.50** | 43% → **54%** of tasks | 100% → 98% | 79% → 69% |
| `decision.km_between_climbs` | 0.42 → **0.47** | 38% → **46%** of tasks | 95% | 65% → 60% |
| `climb.exit_decay` | 0.22 → 0.23 | 30 → 37/180 | 80% → 73% | 93% |
| `climb.time_to_core` | 0.20 → 0.22 | 9% → 13% of tasks | 56% → 52% | 94% → 85% |
| `climb.circle_smoothness` | 0.20 → 0.24 | 14% → 16% of tasks | 54% → 52% | 89% → 80% |

`climb.time_to_core` and `climb.circle_smoothness` still carry **no stable
signal**: they are informative a little more often, but their sign is still a
coin flip. The logger was not why.

The conditions sweep also changed. `decision.km_between_climbs` now depends
on the day (ρ −0.44 against goal rate), which the logger noise had hidden.

## 2. How stable is a metric for one pilot?

This asks which metrics describe a PILOT and which describe a DAY, for a
future pilot-analysis page (issue #558). For pilots who appear more than once
(identified by federation id), it is the Pearson r between the same pilot's
z-scores on two tasks. Only 1 Hz pilots, measured with the old detector:

| Metric | Same comp | Another comp or year |
|---|---|---|
| *(GAP rank percentile, for scale)* | 0.48 | 0.31 |
| `glide.speed` | **0.68** | **0.43** |
| `glide.dolphin_fraction` | 0.45 | 0.22 |
| `decision.search_fraction` | 0.42 | 0.26 |
| `decision.km_between_climbs` | 0.38 | 0.17 |
| `glide.ld_vs_field` | 0.38 | 0.19 |
| `climb.exit_decay` | 0.32 | 0.14 |
| `gaggle.affinity` | 0.30 | 0.21 |
| `race.leg_time_lost` | 0.29 | 0.22 |
| `climb.time_to_core` | 0.17 | 0.09 |
| `race.start_delay` | 0.13 | 0.08 |
| `climb.departure_band` | 0.12 | 0.10 |
| `decision.low_saves` | 0.11 | 0.05 |
| `decision.altitude_floor` | 0.10 | 0.12 |
| `climb.circle_smoothness` | 0.10 | 0.06 |
| `race.final_glide_init` | 0.07 | 0.05 |

A pilot's glide speed is steadier from task to task than their result. The
final glide, the altitude floor and the start delay describe the day.

**The logger made some metrics look like traits.** A pilot uses the same
logger on every task. With coarse loggers included, `climb.time_to_core` read
0.39, `climb.exit_decay` 0.48 and `climb.shared_percentile` 0.32 — part of
that was the instrument, not the pilot.

A "what set this pilot apart" table of outliers would mostly show chance. A
typical pilot sits 2 SD or more from the field on 0.80 of 21 metrics; shuffled
data gives 0.66. Task winners stand out on fewer (0.34), and 78% of winners on
none: they are a little better almost everywhere, not extreme anywhere.

## 3. The two wind estimators

`detectCircles` estimates the wind two ways per circle: from the drift of the
circle's centre, and from half the spread of ground speed around the circle.
Against each 3-minute-plus climb's own net drift (20,215 climbs):

| Estimator | Median ratio to net drift |
|---|---|
| Centre drift | 1.09 |
| Ground speed (half of max − min) | 1.72 |

On the same circle, ground speed reads 1.55× centre drift (629,207 circles).
Half the spread of noisy per-fix speeds reads their extremes, so it reads high.

`day.wind` used the ground-speed estimate where a circle had no centre-drift
estimate: 12% of estimates (51% for loggers at 5 s or slower). That lifted the
day's reported wind by a median 6%, up to 21%; 19 of 183 tasks by 10% or more.
`day.wind` now uses centre drift only.

**Follow-up, not changed here:** the analysis page's map display shows the
ground-speed estimate first (`event-detector.ts`), so it reads high in the same
way. The thermal shapes pool both estimates.

## 4. Final glide through the air

For 408 final glides (last climb before ESS → ESS) in 99 tasks, with the wind
the pilot's own last climb measured: median glide 7.8 km for 874 m. Removing
the wind changes the ground L/D by 10% or more for 41% of glides, and by 25%
or more for 9%. Within a task, the wind is about a quarter of the variation in
final-glide L/D between pilots.

`race.final_glide_init` now publishes a "Final glide through the air" table:
the committed ratio over the ground, the tailwind along the line to goal, and
the ratio through the air. The metric's own value, and its correlation, are
unchanged. A glide slower than 25 km/h over the ground is left out of the
table: it was a descent, not a glide. A pilot far above glide who spirals off
height near goal takes minutes over a few kilometres, and dividing the wind by
that speed would correct a glide that never needed it. 407 of the 408 measured
glides were faster. Only 5 tasks had enough ESS pilots to test whether the air ratio
separates the field better, so that is not known.

## 5. Checked, and no change

**Wind by height.** The article's central finding was a wind that grew with
height. In 153 tasks, the top third of the working band (median 1.25 km
thick) differs from the bottom third, in the same hour, by a median +0.3 km/h
(p10 −2.0, p90 +3.1). Only 2 tasks differ by 5 km/h or more; the hour-to-hour
change is larger (median 1.3 km/h). A wind-by-height chart would show a flat
line.

**Distance carried while circling.** A median 13% of each leg is made good
while circling, and 17% on the 207 legs with a tailwind over 10 km/h. But
circling takes about 37% of a leg in any wind, and its link with leg time does
not change with the wind (ρ −0.00 over 353 legs). A per-pilot "drift speed
while circling" looked informative on 61 of 113 tasks. That was the straight
flight at each thermal's entry and exit: measured from the first circle centre
to the last, its median ρ is +0.08.

**Not done.** Comparing the field's wind with the weather model's
pressure-level winds: Open-Meteo refused the requests on the day (daily limit).

## Reproducing

```sh
# all comps in one directory, as in 2026-09-02-metric-evidence.md
export GLIDECOMP_COMPS_DIR=/path/to/all-comps
# about three CPU-hours, so in four shards:
for i in 0 1 2 3; do
  bun web/scripts/audit-fix-interval.ts --shard $i/4 --partial /tmp/fix.$i.json &
done; wait
bun web/scripts/audit-fix-interval.ts --merge /tmp/fix.*.json
bun web/scripts/audit-metric-distributions.ts
bun web/scripts/audit-metric-conditions.ts
```

`audit-fix-interval.ts` is the thinning experiment; its output for the
shipped code is `2026-10-20-fix-interval-audit.txt`. The "old detector" table
above came from the same experiment before the change, and the real-logger
column from comparing real coarse loggers with 1 Hz pilots of the same rank.
Sections 2–5 were one-off analyses over the same corpus; the method of each is
given in the section.
