# Report card review — making it readable for pilots who don't know GAP

Date: 2026-07-28
Subject: `/comp/:id/task/:id/pilot/:id` — the pilot score details page ("report card")
Reference page reviewed: [Rory Duncan, Task 1 (Open), Corryong Cup 2025](https://glidecomp.com/comp/corryong-cup-2025-wugh/task/task-1-open-mzet/pilot/rory-duncan-wgmy)

Status: **largely implemented**, across three PRs off this review. What remains
is marked ⬜ in "Suggested order" at the foot: the validity sparklines, the
distance-validity distribution, the terminology/glossary pass, and the standings
link.

---

## What the page already does well

Worth stating, because the proposals below are all "keep doing that, in the
places it isn't":

- **Every point component prints its substituted arithmetic.** Distance shows
  `(50.4 km ÷ 50.4 km) × 398.5`; time shows the whole speed-fraction expression
  with the exponent named and its provenance (`5⁄6, the current FAI S7F`); the
  total shows `round(398.5 + 307.8, 1 dp) = 706.3`. The reconciliation helpers
  in `score-explanation-format.ts` go to real trouble (`reconcileWithAvailable`)
  to make sure the printed figures visibly multiply out, and print `≈` with an
  apology when they can't. That is the standard the rest of the page should meet.
- **The flight narrative explains choices, not just events** — which of five
  start crossings scored and why, that the clock ran from gate 2 of 4 rather
  than the crossing, which crossings the tolerance band credited.
- **Every caveat carries its spec reference**, so a pilot who wants to argue has
  somewhere to go.

## The core defect

**The day-quality section is the one place on the page that states a rule and
then just asserts a number.** Compare:

| Section | What the reader gets |
|---|---|
| Distance points | rule + inputs + formula + substituted arithmetic |
| Time points | rule + inputs + formula + substituted arithmetic |
| Total | rule + substituted arithmetic |
| **Day quality** | **rule + a percentage** |

Today it reads:

> Time validity — was the winning time long enough relative to the nominal time? · **90.17%**

The pilot is told the rule refers to a "nominal time", is not told what that
value is, is not told the winning time it was compared against (it *is* on the
page — 1:03:47, in the time section, 200 px lower), and is not shown the
comparison. The same is true of launch validity (nominal launch, pilots present,
pilots flying) and distance validity (nominal distance, nominal goal, minimum
distance, the field's distance spread).

This is the user-reported issue and it generalises: **the section that decides
how many points the whole day is worth is the least explained section on the
page.**

### What it should say

Sketched below. The **time validity** block uses the reference page's real
numbers and is verified: `nominalTime = 5400 s` against the page's published best
time of 1:03:47 reproduces the published 90.17% exactly through the S7F
time-validity cubic. The launch and distance blocks are shape-only — those inputs
aren't on the page today, which is the whole point.

> **Launch validity** — the day is worth less if much of the field never got off
> the hill. · **100%**
> _47 of 48 pilots present launched. Nominal launch is 96%, so the target was
> 46.1 — the field cleared it, giving the full 1.00._
>
> **Distance validity** — the day is worth less if the field as a whole didn't
> get far. · **100%**
> _Measured against a 35.0 km nominal distance, a 20% nominal goal and a 5.0 km
> minimum distance. The field averaged 44.1 km over the minimum against a
> nominal area of 39.0 km, so this caps at 1.00._
>
> **Time validity** — the day is worth less if the fastest pilot got round much
> quicker than the task was meant to take. · **90.17%**
> _Fastest speed-section time 1:03:47 against a nominal time of 1:30:00 →
> 0.7087 of nominal → 90.17% on the S7F time-validity curve._
>
> **Points on offer for the day** · **901.7 pts**
> _1000 × 1.00 × 1.00 × 0.9017 = 901.7_

Note the re-worded time-validity question. The current phrasing ("was the
winning time long enough relative to the nominal time?") reads backwards to
pilots — it sounds like a *long* winning time is the problem. The rule is that a
day nobody could stretch out is worth less.

### What it costs

The engine already computes every input. `TaskStats` in
`web/engine/src/gap-scoring.ts:209` carries `numPresent`, `numFlying`,
`numInGoal`, `numReachedESS`, `bestDistance`, `bestTime`, `goalRatio`,
`taskDistance` — and `TaskScoreResult` carries `weights` alongside
`taskValidity` and `availablePoints`.

**The competition API throws all of it away.** `buildClassScore`
(`web/workers/competition-api/src/scoring.ts:570`) copies only
`result.taskValidity` and `result.availablePoints` onto `ClassScore`.

So the work is:

1. Add a `validity_inputs` (stats + effective nominal params + weights) block to
   `ClassScore`, populated from `result.stats` / `result.weights` /
   the resolved `GAPParameters`.
2. Widen `ClassContextInput` in `score-explanation-types.ts` to carry it.
3. Extend `buildValiditySection` in `score-explanation-sections.ts` to print the
   detail lines, reusing the existing `reconcileDecimals` discipline so the
   printed inputs visibly produce the printed validity.
4. Bump `SCORING_ENGINE_VERSION` — the cached score payload's shape changes, and
   the fingerprint test will demand it anyway.

The section builder must degrade gracefully when `validity_inputs` is absent, so
score rows cached before the change render exactly as they do today rather than
crashing. (The version bump rolls the keys, but the stale-first store serves the
old body until revalidation completes.)

---

## Blocker: the page resolves GAP parameters from the wrong place

Before any of the above can be *correct*, this has to be fixed, because the
proposal above needs `nominalTime` / `nominalDistance` / `nominalGoal` /
`nominalLaunch` / `minimumDistance` and today the page cannot get the right ones.

`PilotScoreDetail.tsx:365-377` resolves the parameter set from
**`comp.gap_params` only**:

```ts
const { nominalDistance: _nd, ...stored } = comp.gap_params ?? {};
return resolveCompGapParams(comp.category === "pg" ? "pg" : "hg", ...);
```

The scorer does not. `scoreTask` merges **task-level** overrides over the comp's
(`scoring.ts:770`, `mergeStoredGapParamsJson`) — `task.gap_params`, migration
0021, which exists precisely because imported AirScore comps publish a different
formula per task. This is not hypothetical: `web/samples/comps/corryong-cup-2026/comp.json`
sets no comp-level `nominalDistance` and overrides `nominalDistance: 35000` on
**all six tasks**, and `web/scripts/lib/airscore-formula-map.ts` documents the
per-task `departure` (leading) and `arrival` flags too.

Consequences today, on any imported comp with per-task overrides:

- The leading section's variant sentence (`leadingVariantSentence`) and weight
  provenance (`leadingWeightDetail`) can name a formula generation the task
  wasn't scored with.
- Whether the leading/arrival sections appear at all is decided by
  `available_points`, which is right — but their *prose* comes from comp params,
  which may not be.
- `essNotGoalFactor`, `jumpTheGunFactor`, `minimumDistance` and the time-points
  exponent can all be per-task in an import, and all appear in printed prose.

The page's `nominalDistance` is stripped deliberately (the comment explains: the
explainer never used it, and the stored value is nullable "auto"). That comment
stops being true the moment distance validity is explained.

**Fix:** return the *effective, merged, resolved* parameters with the score
payload — `ClassScore.gap_params` (or alongside `validity_inputs`) — and delete
the frontend's `resolveCompGapParams` call. This removes a duplicated resolution
of comp category defaults, comp creation date, and the "auto" nominal-distance
hole from the client, and makes the report card's prose provably the parameters
that scored the task. Same version bump covers it.

---

## Other improvements, roughly by value

### 1. The report card never links to the GAP explainer — S, high value

`/scoring/gap` is a 1300-line, KaTeX-typeset, spec-referenced explainer with
stable anchors for every section (`#task-validity`, `#distance-points`,
`#time-points`, `#leading-points`, `#arrival-points`, `#stopped-tasks`,
`#leading-coefficient`, `#distance-difficulty`, `#minimum-distance`, `#ftv`).

The report card links to `/scoring/track-validity` and `/scoring/data-cleaning`
(both only when something went wrong) and **never to `/scoring/gap`**. The
audience this page is for — a pilot who doesn't understand GAP — has no route
from the page they landed on to the document written for them.

Add a small "How this works" link on each section header, pointed at the
matching anchor. `ExplanationSection` already has a header row with a
right-aligned points value; a `docHref?: string` on `ScoreExplanationSection`
renders it there. This is the highest value-per-line change on the list.

### 2. The goal-ratio split is asserted, never shown — S

> Split between the components by the goal ratio · _distance 398.5 · time 503.2_

"Goal ratio" appears here and nowhere else on the page, with no value, no
definition, and no link. The weights that produced the split are not shown
either — and they *are* the reason a pilot with a good distance and a mediocre
time scores the way they do.

Should read (shape, not the page's real figures): `12 of 41 pilots made goal →
goal ratio 0.29 → distance weight 44.2%, time weight 55.8%`, with the PG
weight-generation note (`leadingWeightDetail`,
today buried in the leading section) moved here, where the weights are actually
decided. Needs `goalRatio` + `weights`, i.e. the same `validity_inputs` block.

### 3. Leading and arrival points get no arithmetic at all — M

Every other component prints its formula with values substituted. These two
print a sentence and a number:

> Leading points reward flying out front during the speed section — the pilot
> with the best leading coefficient takes all available leading points, others
> fall off with the gap. · **73.2 pts**

Where did 73.2 come from? The page doesn't say. This is the least intuitive
component in GAP and the one pilots most often dispute, and on PG comps it is
frequently the difference between 2nd and 5th.

The engine has the missing number: `PilotScore.leadingCoefficient`
(`gap-scoring.ts:134`) is computed for every pilot and dropped by the API.
Surface it per pilot and print, in the style of the time section (figures
illustrative):

> _Your leading coefficient 1.284, best in class 0.981 →
> leading factor = 1 − ((1.284 − 0.981) ÷ …)^(2⁄3) = 0.62; × 118.1 available = 73.2_

Arrival is cheaper — position at ESS is derivable from the class entries already
on the page — and the S7F §11.4 cubic can be printed the same way:
`arrived 7th of 22 at ESS → 0.2 + 0.037x + 0.13x² + 0.633x³`.

(Neither section appears on the reference page — Corryong 2025 Open scores
distance + time only — so this is invisible there and important elsewhere.)

### 4. Nothing on the page says how this pilot compares — M

The header says "ranked #9" and then never mentions it again. The reader's
actual question — *why am I 9th and not 3rd?* — is answerable from data already
in the payload but is never assembled.

Proposed: a "Where the points went" section, per component — the reference
page's own numbers, none of which it currently puts side by side:

| | You | Best in class | Gap |
|---|---|---|---|
| Distance | 398.5 | 398.5 | — |
| Time | 307.8 | 503.2 | −195.4 |
| **Total** | **706.3** | **901.7** | **−195.4** |

plus one factual sentence: *"All of your gap to the leader is time: you were
19:53 slower through the speed section."* Factual, not coaching.

**This needs no API change.** `explainGapScore` is already handed the full
`ClassScore` at runtime (`PilotScoreDetail.tsx:440` passes `cls`); only the
`ClassContextInput.pilots` type narrows it to four fields
(`score-explanation-types.ts:158`). Widening the type unlocks it.

### 5. Jargon is unglossed — M

The page uses, without definition: SSS, ESS, speed section, nominal
launch/distance/goal/time, validity, goal ratio, leading coefficient, optimized
task line, made good, minimum distance, jump the gun, distance difficulty. A
pilot who doesn't know GAP does not know most of these, and "ESS" is used as a
bare column label in the flight narrative.

Cheapest good fix: expand on first use in prose ("ESS — the end of the speed
section, where the clock stops"), which several strings already do well and
others don't, plus a "Terms on this page" disclosure at the foot linking each
term to its `/scoring/gap` anchor. Avoid `title`-only tooltips — they fail the
accessibility standard on touch and keyboard.

### 6. The task distance is never stated — S

A goal pilot sees "Scored distance 50.4 km / Best distance in class 50.4 km" and
must infer the task was 50.4 km. A landed-out pilot is told they were "12.3 km
short of goal" with no total to put it against. `TaskStats.taskDistance` exists;
one line in the flight or distance section fixes it.

### 7. The start-crossing narrative states the rule, not the reason — S

After listing five crossings it says: *"The scored start is the latest crossing
from which the flight still makes its best run along the course — re-starting
supersedes an earlier start, while simply flying back through the cylinder later
in the task changes nothing."*

True and well written, but it is the general rule. The reader wants the specific
consequence: *"Your 13:51:51 exit is the scored start. The 15:11:36 exit came
after you had already tagged TP5, so starting from it would have scored less."*
The selection data to say this is in `TurnpointSequenceResult` already.

### 8. ESS and goal render as duplicate lines when they share a cylinder — XS

On the reference page:

```
ESS (CORRY)   15:13:40   first of 11 crossings
Goal (CORRY)  15:13:40   first of 11 crossings
```

Two lines, identical time, identical detail, one event. Collapse to
`ESS + Goal — CORRY` when `essIdx === goalIdx`. Cosmetic, but it is the moment
the pilot finished the task and it currently reads like a rendering bug.

### 9. The task's contribution to the standings is never shown — M

The report card ends at the task total. Nothing says what this task contributed
to the comp standings, whether FTV kept or discarded it, or where the pilot sits
overall. A closing "This task in the competition" line with a link to
`/comp/:id/scores` would close the loop — and on an FTV comp, "this task was
discarded" is information a pilot very much wants on the page that explains it.

---

## Charts

Several of the items above are curves or field comparisons, and prose is the
wrong medium for both. The strongest single idea: **for every point component,
draw the formula as a curve and put each pilot on it as a dot.** For the point
components this is not an approximation — every pilot sits *exactly* on the
curve by construction, because the curve **is** the function that produced their
points.

### The governing principle: these are emphasis charts, not field charts

The field-analysis charts treat every pilot as equally the subject: `RankScatter`
paints all dots one colour and permanently labels the top and bottom three. **The
report card is about one pilot**, so the same marks need a different colour job —
one accent dot for you, de-emphasis grey for the field. Anyone reusing
`RankScatter` unchanged here would bury the reader in the crowd they came to
locate themselves in.

State this up front in whatever component gets built, because the temptation to
"just reuse the scatter" is strong and the result would be subtly wrong.

### Where dots-on-a-curve genuinely works

**Time points** — the best candidate on the page, and the one that answers the
reference pilot's actual question ("why did 20 minutes cost 195 points?").

- x = speed-section time, y = time points
- the curve is the S7F §11.2 speed fraction × available points, drawn from the
  fastest time out to where the fraction reaches 0
- one dot per pilot who reached ESS, all sitting exactly on the curve; yours in
  the accent, ringed
- it shows at a glance how steep the falloff is, how bunched the field was, and
  how much of the curve lies between you and the leader

Pilots who never reached ESS must **not** be plotted at y = 0 — they have no x,
and a row of dots on the floor would read as "on the curve, scoring zero", which
is a different and false statement. Count them in the caption instead.

**Distance points** — same construction, and it gets something valuable for free.
On a PG comp the curve is a straight line from (0, 0) to (best distance,
available) and the dots show the field's spread. On an HG comp with distance
difficulty the total is linear-half + difficulty-half, so the plotted curve has
visible kinks where the field landed out in clusters — which makes the
distance-difficulty concept, close to unexplainable in a sentence, legible for
nothing: *the steep sections are where lots of pilots landed, and getting past
them was worth more.*

**Leading points** — x = leading coefficient, y = leading points, curve is the
§11.3 falloff, dots are the field. Worth doing precisely because leading is the
component pilots understand least; seeing that the LC scale is compressed at the
good end and where you sat on it is more use than any sentence. Needs
`leadingCoefficient` surfaced (§3 above).

**Arrival points** — the §11.4 cubic, but its domain is *integer arrival position
at ESS*, so the honest form is a small column chart with your column emphasized,
not a curve with dots. Now unblocked: `arrival_position` and `ess_time_ms` ship
per pilot, so the whole order is plottable. Its value went UP once the data
landed — the seeded Corryong task has the class winner (fastest through the
speed section by ten minutes) sitting **3rd** on arrival, behind two pilots who
took an earlier gate. A chart makes that inversion visible in a way the table
cannot.

### Where it does *not* work — worth writing down

The three **validity** curves are day facts, not pilot facts. Time validity is a
cubic in `bestTime ÷ nominalTime` and has exactly **one** point on it — the day's.
Scattering the field's times along that curve would be a category error: those
pilots' times are not inputs to it, and the chart would invite everyone to read
their own validity off it.

They are still worth drawing, small: a sparkline-scale curve with the day's
single point marked and a dropline to each axis, sitting beside the validity row
it explains. That makes "the winner got round in 71% of nominal, so the day is
worth 90.2%" visible, and shows what would have had to change — without implying
anything per-pilot.

**Distance validity is the exception, and it wants a different form entirely.**
It is driven by the spread of the whole field's distances over the minimum, so
the informative picture is not the formula but the **distribution**: a strip or
histogram of the field's flown distances with nominal distance, minimum distance
and your own distance marked. `charts/DistributionStrip.tsx` already does exactly
this shape and already takes an `emphasizeTrackFile` prop.

### The field comparison (item 4) as a chart

Keep the table — it is the exact, accessible reading — and put the gaps beside it
as a small diverging bar per component (distance 0, time −195.4). "Δ to target"
is the diverging bar's job. A dumbbell (you ↔ best, per component) is the
alternative; the diverging bar wins because the reader's question is *what did I
give away*, and it puts every component's answer on one shared zero.

Separately, a one-line strip of every class score in the task with your dot
ringed answers "where am I in this field" faster than the rank number in the
header does.

### What was actually built

One component, `charts/ScoreCurve.tsx`, drawn for four sections (distance, time,
leading, arrival) from data the engine emits as `ScoreExplanationSection.chart`.
Two decisions are worth recording because neither was in the original proposal:

**The curve is sampled from the scorer's own functions.** `buildTimeChart` calls
`calculateSpeedFraction`, `buildArrivalChart` calls `calculateArrivalPoints`, and
so on — so "the curve is the formula" is not a claim in a caption, it is how the
data was produced, and it is unit-testable.

**A dot is plotted only if the curve provably explains it.** Each pilot's
published points are checked against the function at their x; anyone who fails
(an ESS-but-not-goal pilot carrying the §12.1 reduction, a goal pilot docked by a
stopped task under §12.3.5) is counted and left off, and the caption says how
many. Without this the "every dot sits exactly on it" claim would be false
precisely for the pilots with the most surprising scores. Checking rather than
special-casing also means a reduction nobody has thought of yet degrades to an
honest omission instead of a wrong picture — and if the *viewing* pilot is the
omitted one, the chart is suppressed entirely, because a chart whose whole job is
to locate you is worse than nothing when it cannot.

**The HG difficulty case turned out to be reachable.** `calculateDistanceDifficulty`
already returns a `fractionFor(distance)` closure, so the total is a genuine
function of distance after all: `0.5·(d ÷ best)·available + fractionFor(d)·available`.
The chart builder reconstructs it from the class context — the same scored
distances, goal flags and minimum distance the scorer used — and it is the most
informative of the four, because its steep sections are literally the stretches
few pilots got past.

That reconstruction is not taken on trust. Every pilot is checked against it, so
getting it wrong cannot draw a plausible-looking wrong picture — the dots stop
matching and the chart suppresses itself. `web/scripts/audit-score-charts.ts`
reads that signal across a whole comp library: **184 archive tasks, 4,762
pilot-views, 4,727 distance charts drawn and zero unexplained pilots.** No spec
reduction applies to distance points, so any omission there at all would mean the
reconstruction is wrong; that is the assertion the script fails on.

**Naming.** The subject is named rather than labelled "You" — the report card is
public and read by everyone, not only by its pilot — alongside the three best at
that component, the last, and the median (only when the field is big enough for
"the middle one" to mean anything). Names are ranked by the component's own
points, not the class standings, which is what makes the arrival chart's story
legible: the pilot who won the day is not necessarily among the three named at
the top of it.

### Conventions to inherit, and one to change

`RankScatter` and `chart-utils.ts` have already settled the hard parts, and these
charts should follow them rather than reinvent:

- hand-rolled inline SVG, no chart library (so it **server-renders** — which
  matters here more than on the field-analysis pages, since the report card is
  the SEO centrepiece)
- `fill-chart-*` tokens for data, `stroke-foreground` for the curve — the curve
  is an annotation over one series, not a second series, and the existing comment
  in `RankScatter` documents why the chart hues fail the 3:1 non-text contrast bar
  for that role
- a 24px invisible halo over each dot (accessibility standard §4.5, WCAG 2.5.8),
  focusable dots, arrow-key walk in rank order, a readout line mirroring
  hover/focus, tick labels `aria-hidden` because the caption carries the reading
- `MetricChartOverlay`'s full-screen pattern for phones, where a pinned chart is
  a smudge

**The one thing that must change is the caption vocabulary.** `RankScatter` says
*"the curve is a trend fitted through the dots"* and withholds it below a noise
floor, because a fitted curve is a claim about data. These curves are the
opposite: they are the formula itself, exact, and every dot is on one by
definition. The caption must say so — *"the curve is the scoring formula; every
pilot sits exactly on it"* — because that distinction is the entire reason the
chart is trustworthy, and reusing the trend-line wording would quietly downgrade
a fact into a fit.

Tables stay. The field-analysis rule (tables are the accessible exact reading,
charts sit alongside) applies here too — and on this page the existing
item/value/detail lines already *are* the table, so charts are additive and never
replace a line.

### Practical note

`chart-utils.ts` (`linearScale`, `niceTicks`, `extent`, `spreadLabels`,
`quantileSorted`) is exactly what these charts need and its own header says it is
"scoped to field-analysis and not a chart framework". Using it from the report
card means promoting it to something like `src/react/charts/` — a deliberate
scope decision to make explicitly rather than by quietly importing across.

Keep them small inline (~160px) inside the section each explains, with the
full-screen overlay for a proper look. The page is already long; four full-size
charts would bury the prose that currently carries it.

---

## Suggested order

1. ✅ **Effective GAP params in the score payload** (blocker; also fixes shipping
   wrong prose on imported comps)
2. ✅ **Doc links per section** (small, high value, independent of everything else)
3. ✅ **`validity_inputs` + the day-quality detail lines** (the reported issue)
4. ✅ **Goal-ratio / weights split** (same payload block, same section)
5. ✅ **"Where the points went" comparison** — the gap bars are the chart half,
   still to come
6. ✅ **The time-points curve** — the single highest-value chart, and it needed no
   payload change: every pilot's speed-section time and time points were
   already in the class entries on the page
7. ✅ Leading arithmetic; ✅ arrival arithmetic (the deferral in §3 is resolved —
   the scorer's `essPositionMap` was being discarded, so `arrivalPosition` and
   `essTimeMs` are now published and the §11.4 formula substitutes like every
   other component); ✅ the leading curve; ✅ the arrival curve
8. ✅ The distance-points curve, both cases (linear, and the HG difficulty
   step function reconstructed from the field); ⬜ the validity sparklines, the
   distance distribution
9. ✅ Task distance + start-crossing reason + ESS/goal collapse; ⬜ the full
   terminology/glossary pass
10. ⬜ Standings link

Items 1, 3, 4 and 7 shared one API/payload change and one `SCORING_ENGINE_VERSION`
bump (v28 — a payload roll, no behaviour change), so they shipped together.

## Testing notes

- `web/engine/tests/score-explanation.test.ts` is the natural home for the new
  section assertions; it already fixes `task_validity` values per test and
  asserts printed equations reconcile.
- Both new payload fields must be optional, and the section builders must render
  without them — score rows cached before the change are served by the
  stale-first store until revalidation lands.
- These pages are SSR'd. `bun run test:e2e:ssr` (clean hydration) is part of
  "done" for any change here, and all new copy must render deterministically —
  no runtime locale, no runtime "today".
- Charts are inline SVG with no browser API, so they server-render and are
  covered by the same SSR check. Anything measured from the DOM (the full-screen
  overlay's aspect) must stay behind the open state, as `MetricChartOverlay`
  already does.
- Chart accessibility is measured against `docs/accessibility-standard.md` like
  the rest of the UI: caption states the reading in words, dots are focusable
  with a 24px target, and the section's existing item/value lines remain the full
  data equivalent.
