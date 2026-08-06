# Engine code quality review — 2026-08-06

A structural audit of `web/engine` against the *thermo-nuclear code quality
review* framework: seven mandates covering structural ambition, the 1,000-line
file boundary, spaghetti resistance, design over acceptance, boring directness,
canonical placement, and atomic orchestration.

This is a point-in-time snapshot. Nothing here was changed — the document is
the finding list, not the fix.

## Method

- 80 non-test source files, 27,575 lines.
- Baseline established first: `bun test ./web/engine` → **1215 pass, 0 fail**
  across 65 files. Every finding below is a structural observation against
  working, tested code, not a bug report.
- Every claim carries a `file:line` citation and was read in place.

## Verdict

**Blocked**, on two of the framework's presumptive blockers:

- one file at 2,128 lines, more than twice the boundary (finding 1);
- a canonical-placement failure that the repository's own standing rule already
  forbids (finding 2).

The rest of the library is in good shape and the report says so — see
*Checked and clean* at the end. 79 of 80 files sit under the boundary, module
seams are honest, and the explainers already call the scorer's own functions
rather than re-implementing them. The findings are concentrated, not diffuse.

---

## 1. `score-explanation-sections.ts` is 2,128 lines — BLOCKING

`web/engine/src/score-explanation-sections.ts` is 2.1× the 1,000-line boundary
and the largest file in the engine by a factor of two. The next largest,
`track-quality.ts`, sits at exactly 1,000.

It carries **one** internal divider comment, at line 77. Two thousand lines with
a single signpost is not navigable.

The file is not a tangle, though — it is a clean sequence of independent builders
that were never given their own homes. Each takes a scored result and returns
`ScoreExplanationItem[]` or a `ScoreExplanationSection`; none reaches into
another's internals. The seams are already drawn:

| Lines | Content | Suggested module |
|---|---|---|
| 49–113 | `turnpointLabel`, `turnpointName`, `reachingAnchor`, `FlightNarrativeCtx` | `sections/shared.ts` |
| 115–582 | the five flight-narrative phase builders + `buildFlightSection` | `sections/flight.ts` |
| 584–765 | validity details + `buildValiditySection` | `sections/validity.ts` |
| 766–1370 | distance, time, leading, arrival sections | `sections/components.ts` |
| 1371–1412 | `rankAmong`, `rankLabel`, `ordinal` | `sections/rank.ts` |
| 1413–1937 | total, comparison, points-left | `sections/totals.ts` |
| 1938–2128 | winner headline, penalties, manual flight | `sections/misc.ts` |

This is a move, not a rewrite: the builders are already pure functions over
`ScoreEntryInput` / `ClassContextInput`, so the split is mechanical and the test
suite (`tests/score-explanation.test.ts`) covers the result.

Worth noting that `score-explanation*.ts` is *already* five files —
`-sections`, `-charts`, `-format`, `-types`, and the `score-explanation.ts`
entry point. The decomposition instinct was right; it just stopped one level too
early on the largest piece.

## 2. Five different answers to "how many metres in a degree?" — BLOCKING

`CLAUDE.md` states the rule plainly:

> **Never implement inline geo math** (distance, bearing, etc.) — always use
> `web/engine/src/geo.ts`.

The WGS84 metres-per-degree series expansion is copy-pasted **verbatim, three
times**:

- `src/geo.ts:269-273` — inside `localEastNorth`, the canonical home
- `src/track-packer.ts:173-179` — as an exported `metresPerDegree()`, which the
  barrel re-exports (`src/index.ts:42`), so the engine's public API offers a
  second front door to geo maths from a 3D-packing module
- `src/field-analysis/thermal-shape.ts:858-863` — inside `offsetToLatLon`, whose
  own doc comment says *"Invert localEastNorth for small offsets (same series
  expansion)"*, which is the code admitting the duplication in writing

Two cruder constants answer the same question elsewhere, with different values:

- `src/circle-detector.ts:31` — `METERS_PER_DEGREE_LAT = 111320`, a flat
  approximation used for the wind-drift projection at lines 316 and 638
- `src/turnpoint-sequence-crossings.ts:127,295` — `110540` with a hand-tuned
  `* 1.01` safety factor for the bounding-box pre-filter

The two constants are defensible in isolation — a bbox pre-filter genuinely does
not need sub-metre accuracy, and a hand-tuned margin is cheaper than a call. But
five spellings of one formula in one library, three of them byte-identical, is
the canonical-placement mandate failing exactly as written.

**The judo move.** Export `metresPerDegree(lat)` from `geo.ts`, define
`localEastNorth` in terms of it, and have the other four sites call it. That
deletes two duplicate bodies outright, removes a geo function from the
track-packer's public surface, and turns the two approximations into a
deliberate, documented choice (`// bbox pre-filter — flat approximation is
sufficient`) rather than an accident. `metresPerDegree` should then be re-exported
from `geo.ts` in the barrel, leaving `track-packer.ts` exporting only packing.

### 2b. Radians → compass bearing, hand-rolled four ways

The same conversion appears with four spellings:

- `src/field-analysis/thermal-shape.ts:594, 730, 771` and
  `src/field-analysis/stats.ts:144` and `src/weather/derive.ts:154` —
  `((Math.atan2(e, n) * 180) / Math.PI + 360) % 360`
- `src/circle-detector.ts:646-649` — `Math.atan2(dLon, dLat) * 180 / Math.PI`,
  then `normalizeBearingDelta(dirTo + 180)`, then a manual `if (direction < 0)
  direction += 360`

The circle-detector path is not wrong, and this is not a bug report — but three
lines to reach a value four other sites reach in one is the cost of not having
`bearingFromComponents(east, north)` in `geo.ts`. `geo.ts` exports
`calculateBearing` for the lat/lon case; the components case is the missing
sibling.

## 3. Scoring predicates re-derived in three modules

`CLAUDE.md` is emphatic that the report card must reflect what the scorer
actually did — rule (b) forbids re-deriving GAP parameters on an explanation
page, and the charts are required to be sampled from *"the scorer's own
functions … so it is the formula and never a fit"*.

That contract holds for the *point* functions: `score-explanation-charts.ts`
imports `calculateSpeedFraction`, `calculateArrivalPoints`,
`calculateDistanceDifficulty` and `resolveTimePointsExponent` from the scorer.
Good.

It does **not** hold for the *derived predicates*, which are not exported and so
get re-typed by hand:

| Predicate | Scorer | Sections | Charts |
|---|---|---|---|
| `scoring === 'HG' && useDistanceDifficulty` | `gap-scoring.ts:496` | `:779` | `:383` |
| `scoring === 'PG' ? 0 : essNotGoalFactor` | `gap-scoring.ts:513` | `:946` | `:164` |
| best-time source: `factor > 0 ? reachedESS : madeGoal` | `gap-scoring.ts:520-524` | `:960-964` | `:165-169` |

The comments beside the copies are the tell. `score-explanation-sections.ts:941`
reads *"Mirrors calculateTimePoints / scoreFlights"*;
`score-explanation-charts.ts:163` reads *"The same best-time source scoreFlights
used"*. A comment asserting that two pieces of code agree is a maintenance
contract with no enforcement — and this is precisely the pairing the report-card
rules exist to protect.

There are 23 `scoring === 'PG' | 'HG'` branch sites across the engine. Most are
legitimately local to a formula. These three are not: they are field-level
derived facts that the scorer computes and the explainers guess at.

**The judo move.** Export three functions from `gap-scoring.ts` —
`usesDistanceDifficulty(params)`, `effectiveEssNotGoalFactor(params)`, and
`bestTimeFrom(pilots, factor)` — and call them from all three modules. Six
hand-maintained copies collapse to three definitions, and the drift becomes
impossible rather than merely commented against.

This is the highest value-per-line change in the review: small, mechanical,
behaviour-preserving, and it closes a correctness gap the project has already
written a rule about.

## 4. `FlightScoringData` encodes a three-way choice as four optional fields

`src/gap-scoring.ts:343-361`. When `useLeading` is on, a flight must supply
exactly one of:

- `leadingAggregate` — the backend's cached per-track scan, or
- `fixes` + `sequence` — the raw tracklog, or
- `trackless: true` — a manual flight with no tracklog at all.

Nothing in the type says so. The rule is enforced at
`gap-scoring.ts:661-666` by a runtime `throw` whose message is a prose
description of the invariant:

```
'scoreFlights: useLeading requires a leadingAggregate, or fixes + sequence, in FlightScoringData'
```

This is the *boring directness* mandate: prefer explicit typed models over
loosely-shaped objects. A discriminated union —

```ts
leading:
  | { kind: 'aggregate'; aggregate: LeadingAggregate }
  | { kind: 'track'; fixes: IGCFix[]; sequence: TurnpointReaching[] }
  | { kind: 'none' }
```

— makes the three cases exhaustive, deletes the throw, and lets the compiler
catch at the call site what currently surfaces as a runtime error during scoring.

**Caveat, and it is a real one.** This shape is serialised into the backend's
per-track cache, so the change needs a revive step that reads the old flat shape
and a `SCORING_SOURCE_FINGERPRINT` bump. That cost is why this is finding 4 and
not finding 1 — but the fingerprint machinery in `scoring-version.ts` exists
precisely to make such changes safe, and four correlated optionals in the
library's most important interface will keep costing reading time until it moves.

## 5. Two 400-line functions

- `scoreFlights` — `gap-scoring.ts:431-863`, 433 lines
- `resolveSequenceOnce` — `turnpoint-sequence.ts:213-624`, 412 lines

Neither is spaghetti; both are exceptionally well commented and each step cites
its FAI clause. But `scoreFlights` has already labelled its own seams —
`// Step 1: Early starts` (441), `// Step 2: Gather aggregate statistics` (487),
`// Step 3: Calculate task validity` (598), `// Step 4: Calculate weights and
available points` (604), `// Step 5: Calculate leading coefficients` (624),
`// Step 6: Determine ESS arrival order` (683), `// Step 7: Score each pilot`
(741).

Seven numbered comments in one body are seven functions asking to exist. Steps 1,
2, 5 and 6 in particular have clean inputs and a single output
(`applyEarlyStarts`, `gatherFieldStats`, `computeLeadingCoefficients`,
`essArrivalOrder`), which would leave the outer function readable as the
seven-line pipeline the comments already describe.

## 6. Duplicate helpers where a canonical one exists

Individually small; listed together because the pattern is one habit.

- **`quantileSorted` vs `percentile`.**
  `field-analysis/thermal-shape.ts:819` defines a private linear-interpolated
  quantile. `field-analysis/stats.ts:16` exports `percentile`, which is the same
  function on a 0–100 scale, two files away in the same directory. Only the
  empty-array result differs (`0` vs `NaN`) — worth preserving explicitly at the
  call site rather than by forking the helper.

- **`roundToTenth` defined, then bypassed eight times in its own file.**
  `gap-scoring.ts:69` defines it; `gap-scoring.ts:723, 813, 814, 815, 816, 817,
  818, 831` all write `Math.round(x * 10) / 10` inline instead. FAI S7F §11
  one-decimal rounding is a scoring rule, and it should have exactly one
  spelling in the scorer.

- **`formatKm` vs `km`/`kmEq`.** `track-quality.ts:685` formats kilometres; so do
  `score-explanation-format.ts:15` (`km`) and `:130` (`kmEq`). The behaviours
  differ deliberately (`formatKm` switches to thousands-separated integers above
  100 km), so this is the weakest item here — but the divergence should live as
  an option on the shared formatter, not as a private third copy.

## 7. The barrel is unreadable

`src/index.ts` is 54 lines, well within bounds — but individual lines run to
1,986, 1,228 and 759 characters. Line 42 alone exports twelve names. A diff
touching one export shows as a change to a 2,000-character line, which makes
review of the engine's public surface effectively impossible.

Multi-line export blocks (the file already uses one, at lines 14–29 for
`forge-igc`) would fix this with no behaviour change at all.

---

## Checked and clean

Stated explicitly, because a review that only lists problems misrepresents the
codebase.

- **File sizes.** 79 of 80 files are under 1,000 lines. The median is well under
  300. There is no general sprawl problem — finding 1 is a single outlier.
- **Atomic orchestration.** The weather registry's sequential provider loop
  (`weather/registry.ts:99`) looks like a parallelisation candidate and is not:
  it is a preference-ordered fallback chain, and firing the providers
  concurrently would issue redundant calls to a paid external API to discard
  most of the answers. Correct as written.
- **Thin wrappers.** A scan for single-expression delegating exports found no
  identity wrappers. `parseWaypointsCUP` (`waypoint-files.ts:221`) delegates
  straight to `parseWaypointTable`, but it is a named format in a family of
  parsers, so the name carries meaning.
- **Feature logic in shared paths.** None found. The scorer does not know about
  the report card; the report card does not know about D1; `field-analysis/`
  does not reach into `gap-scoring` beyond its published types.
- **Explainers versus the scorer.** The architecture is right — the charts and
  sections import and call the scorer's own point functions rather than
  reimplementing the formulas. Finding 3 is a gap in an otherwise sound design,
  not the absence of one.
- **Spaghetti.** No ad-hoc conditionals bolted onto unrelated flows were found.
  The PG/HG branching is dense (23 sites) but almost all of it is local to the
  formula that needs it, which is where the FAI spec puts it too.

## Suggested order

1. **Finding 3** — highest value per line: mechanical, behaviour-preserving, and
   it closes a correctness gap the project already has a rule about.
2. **Finding 2** — deletes two duplicate formula bodies and brings the engine
   back into line with its own standing geo rule.
3. **Finding 6 and 7** — small, safe, independent.
4. **Finding 1** — the largest diff, but a pure move; do it when it will not
   collide with in-flight work on the report card.
5. **Finding 5** — worthwhile once 1 and 3 have settled.
6. **Finding 4** — last, and only with the cache-revive and fingerprint bump
   planned as part of it.
