# Report card review — making it readable for pilots who don't know GAP

Date: 2026-07-28
Subject: `/comp/:id/task/:id/pilot/:id` — the pilot score details page ("report card")
Reference page reviewed: [Rory Duncan, Task 1 (Open), Corryong Cup 2025](https://glidecomp.com/comp/corryong-cup-2025-wugh/task/task-1-open-mzet/pilot/rory-duncan-wgmy)

Status: **proposal**. Nothing here is implemented yet. Sizes are rough; each item
is independently shippable.

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

## Suggested order

1. **Effective GAP params in the score payload** (blocker; also fixes shipping
   wrong prose on imported comps)
2. **Doc links per section** (small, high value, independent of everything else)
3. **`validity_inputs` + the day-quality detail lines** (the reported issue)
4. **Goal-ratio / weights split** (same payload block, same section)
5. **"Where the points went" comparison** (no API change)
6. Leading/arrival arithmetic
7. Terminology pass + task distance + start-crossing reason + ESS/goal collapse
8. Standings link

Items 1, 3, 4 and 6 share one API/payload change and one `SCORING_ENGINE_VERSION`
bump, so they are cheaper together than apart.

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
