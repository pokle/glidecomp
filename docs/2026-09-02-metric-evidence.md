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
in [`2026-09-02-metric-distributions.txt`](./2026-09-02-metric-distributions.txt).

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

  Two refinements from the follow-up conditions sweep (below), which counts the
  small fields honestly. `climb.circle_smoothness` does clear its floor slightly
  more often than chance allows (1.57× the exact expected rate, p = 0.019), so
  something is there — but no condition explains its sign.
  `climb.time_to_core` shows **no significant excess at all** (1.21×, p = 0.25):
  of the three it is the one with the best claim to being pure noise.

  Their declared `direction` is consequently unsupported: `climb.time_to_core`
  says `lower`, `climb.circle_smoothness` says `lower` and `glide.stf_proxy`
  says `higher`, and none of those signs holds. That is not a sign inversion to
  correct — there is no sign to correct to.

## What was decided (TASK_ANALYSIS_VERSION 26 and 27)

On this evidence, `glide.stf_proxy` is **removed**, and `climb.time_to_core` and
`climb.circle_smoothness` become **descriptive** — `direction: 'neutral'`, the
same treatment v9 gave `day.airtime_quality` and v19 gave
`decision.altitude_floor`.

**Why a direction is worth removing.** A `direction` is a *prior*: a claim, made
before anyone looks at the data, that lower (or higher) is better on every task.
It is read very differently from the ρ the page prints beside it, which is a fact
about one day. A metric that declares a direction says *this is a skill, practise
it*, and licenses coaching that transfers to the next comp. Where the declared
sign is wrong, the page instead tells a pilot to practise something that did not
pay — and can contradict the ρ printed next to it. Neutral says *the sign is the
finding*: the `winning` phrasings still name what won on this task, chosen by the
observed sign, but nothing claims it generalises.

**Why the two climbing metrics stay.** The null result is itself what a learning
pilot wants to know. Coring speed and circle roundness barely move the result,
while where you choose to go (`decision.search_fraction`, median |ρ| 0.68) and
how fast you glide between climbs (`glide.speed`, 0.64) dominate it. That tells a
pilot where *not* to spend attention — a lesson a deleted metric cannot carry.
In the style clusters they keep their nicknames ("Quick corers", "Smooth
circlers") but lose their strength/cost hint, since `hintFor()` returns undefined
for a neutral direction: a cluster can still be *called* quick-coring without the
page asserting that is a strength.

**Why `glide.stf_proxy` goes instead.** Unlike those two it names no behaviour a
pilot can observe or act on. Its own explanation concedes it is "a PROXY, and not
true speed to fly, because there is no glider polar data". A descriptive metric
still has to describe something; a proxy that never correlates is a failed
instrument rather than a fact about the field. Its `STYLE_NICKNAMES` entry goes
with it, taking the style clusters from 23 signature dimensions to 22.

The registry is now **25 metrics**. The tables below are the sweep as run, before
these changes — removing a metric and relabelling two directions moves no ρ, so
every number in them still stands.

**v27 then made `glide.extra_distance` neutral too**, on the conditions evidence
in the next section: it is the one metric measured to reverse outright with the
day. Three explanations changed with it — `extra_distance` gained the
conditional reading, `climb.time_to_core` and `climb.circle_smoothness` lost the
closing claims that faster coring and rounder circles are better (v26 had made
them neutral while their prose still asserted a direction), and
`climb.exit_decay` gained what the archive found about which days it shows up
on. No metric value moves in either version.

## Does the DAY decide what a behaviour is worth?

**Swept 2026-09-03**, same corpus, by `web/scripts/audit-metric-conditions.ts`;
raw output in [`2026-09-03-metric-conditions.txt`](./2026-09-03-metric-conditions.txt).

The sweep above pools every task together, and that cannot tell a metric that
never matters apart from one that matters enormously on some days and not on
others: both give a median ρ near zero and a ~50/50 sign split. So this asks a
different question — is a metric's per-task ρ itself predicted by the day's own
conditions? Eighteen conditions are derived from the tracks (wind, climb
strength and spread, working band, thermal counts, airtime split, task
distance, goal and ESS rate, duration, field size, month).

Two statistical traps had to be handled first, and both produced a confident
wrong answer before they were:

1. **The noise floor is not 5% at small n.** `spearmanNoiseFloor` is the
   α = 0.05 critical value, but Spearman is *discrete* at tiny n: with 3 pilots
   ρ can only be 0, ±0.5 or ±1, so P(|ρ| ≥ floor) is **1/3**, not 1/20. Counting
   a 3-pilot task as a 5% event overstates the evidence by nearly 7×. Expected
   counts are now summed from the exact per-n rate, and every condition test
   drops fields under 10 pilots.
2. **Multiple comparisons.** 414 (metric, condition) pairs were tested, so at
   α = 0.05 about 20 "findings" are guaranteed by chance. Every p carries a
   Benjamini–Hochberg q over the whole family; only q < 0.10 counts.

### The answer is yes, emphatically — for some metrics

**How many pilots made goal is the single most powerful conditioner**, which is
why it should be on the page: see
[#683](https://github.com/pokle/glidecomp/issues/683).

| Metric | Condition | ρ | What happens |
|---|---|---|---|
| `race.leg_time_lost` | goal rate | **+0.61** | ρ +0.06 on the hardest quarter of days → +0.68 on the easiest |
| `climb.exit_decay` | ESS rate | **−0.54** | +0.03 (1/30 informative) on hard days → −0.31 (13/33, 100% negative) on easy |
| `decision.low_saves` | goal rate | **+0.53** | −0.37 (14/30 informative) on hard days → −0.05 (2/30) on easy |
| `glide.extra_distance` | goal rate | **+0.49** | −0.22 on hard days → **+0.48** on easy — a true reversal |
| `climb.shared_percentile` | wind | +0.43 | −0.30 (17/30) in calm air → −0.03 (1/31) in wind |
| `climb.departure_band` | wind | −0.35 | −0.26 in calm air → −0.53 (19/30) in wind |

Read as flying:

- **Leaving lift that still works pays on a day the field completes, and makes
  no measurable difference on a day it lands out** (`climb.exit_decay`). On a
  weak day everyone must milk every climb.
- **Getting low and saving it matters enormously on a hard day and not at all
  on an easy one** (`decision.low_saves`) — the mirror image, and the two
  together are the clearest statement in the data that weak days reward
  survival and strong days reward speed.
- **Out-climbing the pilots you share a thermal with decides the day in calm
  air, and stops mattering in wind** (`climb.shared_percentile`), while **where
  in the band you leave a thermal matters MORE in wind**
  (`climb.departure_band`). Different skills for different air.

### The one outright reversal

`glide.extra_distance` is the only metric whose sign flips rather than merely
fading, on both goal rate and ESS rate:

| Goal rate | Median ρ | Informative | Sign |
|---|---|---|---|
| 0–29% (hardest) | **−0.22** | 12/29 | 83% negative |
| 32–48% | +0.34 | 14/29 | 86% positive |
| 49–64% | +0.31 | 16/29 | 81% positive |
| 65–90% (easiest) | **+0.48** | 18/29 | 100% positive |

On a day the field gets round, flying wide of the line costs you. On a day most
of it lands out, the pilots who leave the line to hunt for lift are the ones
still in the air, so deviation marks the survivors. Its `direction: 'lower'`
was therefore wrong on roughly half of all tasks — and this is exactly why it
had the weakest sign consistency (75%) of the eighteen metrics that separate
the field. Not unreliability: conditionality. It is `neutral` from
TASK_ANALYSIS_VERSION 27, and its explanation now tells the reader to read the
sign against how many pilots made goal.

### It also re-finds the `leg_time_lost` defect from the other side

`race.leg_time_lost` has the strongest conditioning of any metric (+0.61 on
goal rate) — reached with no knowledge of legs, partial finishers or the metric's
internals, purely from ρ against the day. Goal rate is close to the inverse of
the partial-finisher share, so this is the same defect documented below,
confirmed independently. That is a useful check that the method finds real
structure rather than manufacturing it.

### What it does NOT rescue

Neither `climb.circle_smoothness` nor `climb.time_to_core` has a condition
surviving FDR (`time_to_core`'s best is wind at q = 0.062, and its quartiles
are flat and sign-inconsistent). `glide.stf_proxy`, re-measured from the
pre-removal commit, has two conditions at q = 0.052 — but with 0/28 and 1/31
tasks informative in the extreme quartiles, that is a drift in the median of a
distribution that is almost entirely noise, and its direction is *contrary* to
speed-to-fly theory. Removing it stands.

### Caveats

- These are hypotheses, not conclusions. The conditions are the ones derivable
  from tracks; the variable that most plausibly decides whether coring technique
  matters — airmass stability, how broken the lift is — is not among them. "No
  condition found" is not "no condition exists".
- Goal rate and ESS rate are ~collinear and are partly a function of task
  setting rather than the weather. Where a finding matters, the pure-weather
  conditions agree: `climb.exit_decay` conditions on peak climb rate (−0.49) and
  climb spread (−0.47) as well as on goal rate.
- `durationH` reaches 242.9 h on one task — a tracklog whose timestamps survived
  the quality checks. It only affects the two `durationH` rows, but those should
  be read with that in mind.

## The `race.leg_time_lost` defect, confirmed at scale

The metric sums `max(0, legTime − reference)` over the legs the pilot
**completed**. A pilot who lands after one leg accumulates one loss term; one who
flies the whole speed section slightly slowly accumulates six. Under
`direction: 'lower'`, landing early therefore scores better. It carries
`outcome: true` on the grounds that it "follows the result by construction".

Over 144 speed-section tasks (`web/scripts/audit-leg-time-lost.ts`, raw output in
[`2026-09-02-leg-time-lost.txt`](./2026-09-02-leg-time-lost.txt)), that
construction holds only where the field finished:

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

`glide.extra_distance`'s 75% sign agreement — the lowest of the eighteen that
separate the field — is explained by the conditions sweep above: the metric
reverses with the day rather than being unreliable, and it no longer declares a
direction.

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
GLIDECOMP_COMPS_DIR=/tmp/all-comps bun web/scripts/audit-metric-conditions.ts
GLIDECOMP_COMPS_DIR=/tmp/all-comps bun web/scripts/audit-leg-time-lost.ts
```

The two full sweeps take about eight minutes each; the leg-time probe, which
needs only `scoreTask` and never `buildFieldContext`, about two.

The three answer different questions and none replaces another:
`audit-metric-distributions.ts` asks whether a metric separates the field at
all, `audit-metric-conditions.ts` asks whether the day decides what it is worth,
and `audit-leg-time-lost.ts` dissects one metric's known defect.
