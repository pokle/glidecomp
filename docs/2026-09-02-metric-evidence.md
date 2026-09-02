# What the archive says about the 26 behavioural metrics

**Swept 2026-09-02** over every non-synthetic competition available: the two
bundled comps plus the 25 in `pokle/glidecomp-archive`. The two sets are
disjoint — the archive holds every year the main repo does not bundle — so they
are swept as one corpus.

| | |
|---|---|
| Comps | 27 |
| Tasks analysed | 194 (2 skipped: `dalby-big-air-2022-{open,sports}-t6`, no parseable tracks) |
| Pilot-task rows | 4,959 |
| Excluded | `big-chip`, `kosci-loop` (synthetic) |

Reproduce with `web/scripts/audit-metric-distributions.ts`; the raw output is
kept in the archive at `reports/2026-09-02-metric-distributions.txt`.

This supersedes the bundled-only run (2 comps, 10 tasks, 197 rows) that the
script shipped with, which was ~25× smaller and could not settle whether a
metric has explanatory power.

## How to read it

`ρ` is Spearman's rank correlation between the metric's per-pilot value and GAP
rank, computed per task. A task counts as **informative** for a metric when its
`|ρ|` clears that task's own noise floor — the same rule `aggregate.ts` uses, so
the sweep and the shipped comp analysis agree about the word. **Share** is the
fraction of that metric's tasks which were informative, and **sign** the share of
those informative tasks agreeing on the direction. Rank 1 is best, so a positive
ρ means a higher value went with a worse result.

## The verdict

Sorting the 26 metrics by what the archive can actually show about each:

| | Metrics | Criterion |
|---|---|---|
| **Separate the field** | **18** (16 behavioural + 2 outcome-derived) | informative on ≥28% of tasks, sign-consistent on ≥89% |
| Separate, direction unreliable | 2 | `day.airtime_quality` (82% sign), `glide.extra_distance` (75%) |
| Weak but real | 1 | `climb.exit_decay` |
| No stable signal | 3 | `climb.circle_smoothness`, `glide.stf_proxy`, `climb.time_to_core` |
| Non-correlating by design | 2 | `day.wind`, `day.climb_by_hour` |

The eighteen that separate the field are informative on 28–99% of tasks and,
where informative, agree on the sign 89–100% of the time — there is no middle
ground between them and the three that carry nothing.
`decision.search_fraction` (median |ρ| 0.68, informative on 66% of tasks,
sign-consistent on 99%) and `glide.speed` (0.64 / 61% / 96%) are the strongest
behavioural metrics in the registry, and nothing about that changed from the
small sample — it got firmer.

**The two day-family metrics that never correlate are correct.** `day.wind` and
`day.climb_by_hour` return `allNullPerPilot` by construction: they describe the
day, not the pilots in it, and publish their finding through series and tables.
Reporting `0/0` correlations for them is the right answer, not a gap.

### The five the small sample could not settle

All five showed **zero** informative tasks over the bundled 10. The archive
splits them three ways.

| Metric | bundled | archive: med \|ρ\| | informative | sign |
|---|---|---|---|---|
| `gaggle.departure_winrate` | 0/7 | **0.40** | 50/108 (46%) | **96%** |
| `climb.exit_decay` | 0/10 | 0.22 | 30/180 (17%) | 80% |
| `climb.circle_smoothness` | 0/10 | 0.20 | 24/177 (14%) | 54% |
| `glide.stf_proxy` | 0/10 | 0.22 | 19/159 (12%) | 58% |
| `climb.time_to_core` | 0/10 | 0.20 | 16/181 (9%) | 56% |

- **`gaggle.departure_winrate` is vindicated.** At scale it ranks mid-registry
  and is one of the most sign-consistent metrics there is. Ten tasks were simply
  too few — it needs a field big enough to have gaggles, and it returns a value
  for only 34% of pilots, the lowest coverage of any non-outcome metric.
- **`climb.exit_decay` is weak but real.** Informative on 17% of tasks with 80%
  sign agreement: a genuine signal on the minority of days where it fires.
- **`climb.circle_smoothness`, `glide.stf_proxy` and `climb.time_to_core` carry
  no stable signal.** Informative on 9–14% of tasks — near what the noise floor
  admits by construction — and, on the tasks where they do fire, the sign is a
  coin flip (54%, 58%, 56%). Their median signed ρ is +0.03, +0.00 and −0.03.
  This is the shape of noise, not of a weak effect.

  Their declared `direction` is consequently unsupported: `climb.time_to_core`
  says `lower` and `glide.stf_proxy` says `higher`, and neither sign holds. That
  is not a sign inversion to correct — there is no sign to correct to. Whether
  three metrics that cannot be shown to separate the field should stay in the
  registry, or lose their direction and become descriptive, is an open question
  for the owner; this document only records the measurement.

## The `race.leg_time_lost` defect, confirmed at scale

The metric sums `max(0, legTime − reference)` over the legs the pilot
**completed**. A pilot who lands after one leg accumulates one loss term; one who
flies the whole speed section slightly slowly accumulates six. Under
`direction: 'lower'`, landing early therefore scores better. It carries
`outcome: true` on the grounds that it "follows the result by construction".

Over 144 speed-section tasks (`web/scripts/audit-leg-time-lost.ts`, raw output at
`reports/2026-09-02-leg-time-lost.txt` in the archive), that construction holds
only where the field finished:

| Share of field that landed out | Tasks | Median ρ vs rank |
|---|---|---|
| none (0%) | 9 | **+0.97** |
| few (<25%) | 25 | +0.68 |
| some (25–50%) | 44 | +0.41 |
| many (50–90%) | 47 | +0.11 |
| mostly (≥90%) | 19 | **−0.12** |

The counterfactual is the clincher. Over the 104 tasks holding both partial and
full finishers, median ρ against rank is **+0.41 over the whole field but +0.93
over the full finishers alone**, and dropping the partial finishers raises ρ on
**98 of 104 tasks (94%)**. The pilots who landed out are the entire reason the
metric stops tracking the result.

This is not an edge case. **66 of 144 tasks (46%) had more than half the field
land out**, and on only 9 tasks (6%) did everyone complete every leg. On five
tasks the metric inverted outright — a significantly *negative* ρ, meaning the
smaller loss sum went with the *worse* placing:

```
forbes-flatlands-2022-sports-t7   n= 3  partial=3/3    ρ=-1.00  floor=1.00
corryong-cup-2025-floater-t1      n=10  partial=7/10   ρ=-0.73  floor=0.63
corryong-cup-2021-open-t5         n=22  partial=15/22  ρ=-0.55  floor=0.42
dalby-big-air-2022-open-t5        n=21  partial=19/21  ρ=-0.55  floor=0.43
bright-open-2023-open-t1          n=88  partial=39/88  ρ=-0.24  floor=0.21
```

The report card and the task analysis both label this metric outcome-derived and
tell the reader not to read its correlation as a finding, so the published ρ is
already disclaimed. What is *not* disclaimed is the per-pilot value itself: a
pilot who landed out early reads a small "time lost" beside a pilot who flew the
whole speed section, and the smaller number is the worse flight. Fixing it is a
scoring-analysis behaviour change and is left to the owner — the obvious
candidates are charging unflown legs against the reference, or restricting the
metric to pilots who completed the speed section.

## Full registry at archive scale

Ranked by median |ρ|. `*` marks an outcome-derived metric, where ρ is a sanity
check rather than a finding.

| Metric | Family | med \|ρ\| | med ρ | Informative | Share | Sign | Coverage |
|---|---|---|---|---|---|---|---|
| `race.time_behind` * | racecraft | 1.00 | +1.00 | 112/113 | 99% | 100% | 36% |
| `decision.search_fraction` | decision | 0.68 | +0.68 | 120/181 | 66% | 99% | 90% |
| `glide.speed` | gliding | 0.64 | −0.63 | 104/171 | 61% | 96% | 83% |
| `climb.selectivity` | climbing | 0.50 | −0.43 | 86/169 | 51% | 97% | 80% |
| `gaggle.affinity` | gaggle | 0.50 | −0.48 | 89/151 | 59% | 98% | 90% |
| `race.final_glide_init` | racecraft | 0.50 | +0.50 | 69/148 | 47% | 93% | 62% |
| `climb.departure_band` | climbing | 0.49 | −0.47 | 82/170 | 48% | 96% | 83% |
| `glide.dolphin_fraction` | gliding | 0.44 | +0.38 | 73/168 | 43% | 100% | 79% |
| `decision.altitude_floor` | decision | 0.44 | −0.40 | 72/159 | 45% | 94% | 72% |
| `race.start_delay` | racecraft | 0.44 | +0.42 | 67/118 | 57% | 99% | 90% |
| `decision.km_between_climbs` | decision | 0.42 | −0.32 | 56/147 | 38% | 95% | 65% |
| `glide.extra_distance` | gliding | 0.42 | +0.19 | 64/144 | 44% | 75% | 66% |
| `glide.ld_vs_field` | gliding | 0.41 | −0.39 | 71/143 | 50% | 97% | 65% |
| `race.leg_time_lost` * | racecraft | 0.41 | +0.37 | 68/144 | 47% | 93% | 66% |
| `gaggle.departure_winrate` | gaggle | 0.40 | −0.38 | 50/108 | 46% | 96% | 34% |
| `race.ess_margin` | racecraft | 0.34 | +0.26 | 32/113 | 28% | 91% | 36% |
| `gaggle.marker_usage` | gaggle | 0.34 | −0.21 | 47/150 | 31% | 89% | 78% |
| `day.airtime_quality` | day | 0.31 | +0.13 | 55/184 | 30% | 82% | 100% |
| `decision.low_saves` | decision | 0.30 | −0.26 | 42/149 | 28% | 100% | 90% |
| `climb.shared_percentile` | climbing | 0.27 | −0.16 | 48/171 | 28% | 90% | 86% |
| `climb.exit_decay` | climbing | 0.22 | −0.07 | 30/180 | 17% | 80% | 93% |
| `glide.stf_proxy` | gliding | 0.22 | +0.00 | 19/159 | 12% | 58% | 71% |
| `climb.circle_smoothness` | climbing | 0.20 | +0.03 | 24/177 | 14% | 54% | 89% |
| `climb.time_to_core` | climbing | 0.20 | −0.03 | 16/181 | 9% | 56% | 94% |
| `day.wind` | day | — | — | 0/0 | — | — | 0% |
| `day.climb_by_hour` | day | — | — | 0/0 | — | — | 0% |

`glide.extra_distance` is worth one note: 75% sign agreement is the lowest of the
sixteen that separate the field, low enough that the direction it declares
(`lower`) is real but not dependable day to day.

## Reproducing

The two comp sets live in separate repositories, and both scripts take a single
`GLIDECOMP_COMPS_DIR`. Sweep them together by pointing that at a directory of
symlinks to both:

```sh
mkdir -p /tmp/all-comps && cd /tmp/all-comps
ln -sfn <glidecomp>/web/samples/comps/*/ .
ln -sfn <glidecomp-archive>/comps/*/ .   # corryong-cup-2021-open-t1 is in both,
                                          # byte-identical; either copy will do

GLIDECOMP_COMPS_DIR=/tmp/all-comps bun web/scripts/audit-metric-distributions.ts
GLIDECOMP_COMPS_DIR=/tmp/all-comps bun web/scripts/audit-leg-time-lost.ts
```

The full sweep takes about eight minutes; the leg-time probe, which needs only
`scoreTask` and never `buildFieldContext`, about two.
