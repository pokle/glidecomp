# web/engine deep-dive code review — 2026-07-12

A full review of `web/engine/` (~11k lines of src, plus `cli/` and `tests/`): five parallel
review passes (parsing, scoring, geometry/task, event analysis, infra/packaging), with every
High/Medium finding re-verified against the code by hand. Baseline at review time: 632 tests
pass, `typecheck:engine` clean, branch `a5cc174`.

Legend: **[C]** = confirmed by direct code read / runtime repro during the review;
**[P]** = plausible from code read, needs a repro test to pin down exact conditions.

---

## 1. High-severity bugs (silent wrong results on the scoring path)

### 1.1 [C] Turnpoint nested inside a larger following cylinder → finisher scored landed-out

Status: Fixed in #321

`src/turnpoint-sequence.ts:503-528` (`buildForwardPath`), rooted in the crossing-only design of
`detectCylinderCrossings`.

Credit for each turnpoint requires a **boundary crossing** with `time >= prevReachingTime`;
otherwise the loop `break`s ("Pilot didn't reach this TP"). GAP/FS semantics are
presence-based: any fix inside the cylinder after reaching the previous TP counts. Failure
scenario: the previous turnpoint lies inside a larger next cylinder (e.g. a big ESS cylinder
overlapping the last TP). The pilot enters the big cylinder at `t1`, tags the previous TP
inside it at `t2 > t1`, and reaches goal without ever exiting the big cylinder — its only
crossing is at `t1 < t2`, so ESS/goal is denied and the pilot is scored landed-out despite
finishing. If they happen to exit and re-enter, a later crossing rescues them, making the bug
intermittent. The `>=` comment at L509-518 covers only the identical co-located-cylinder case.
No test covers a TP nested inside the following cylinder.

### 1.2 [C] v2 XCTSK polyline decoder swaps latitude and longitude

Status: Fixed in #322

`src/xctsk-parser.ts:100-111` (decoder) vs `src/waypoint-export.ts:395-406` (encoder).

`decodePolyline` assigns the first decoded value to **lat**, second to **lon** — but the real
XCTrack/Flyskyhy format packs **longitude first**, as proven by this repo's own encoder, which
is byte-verified against sampled competition QRs. Round-trip repro:
`encodeTurnpointZ({lat: 47, lon: 11})` → `parseXCTask` → `{lat: 11, lon: 47}`. For Alps-like
coordinates both swapped values pass `isValidTask` range checks, so the task is silently placed
at the wrong location; for Australia the swap fails validation and the task is rejected. The
test at `tests/xctsk-parser.test.ts:373-393` only asserts the decoded values "are numbers".
(While fixing: the "Google Polyline Algorithm" delta-accumulation comment is wrong — each
turnpoint `z` is a standalone 4-value tuple, no cross-tuple deltas.)

**Fixed 2026-07-12** ([#322](https://github.com/pokle/glidecomp/pull/322)) — verified against the XCTrack spec
(https://xctrack.org/Competition_Interfaces.html: "The turnpoint coordinates are 4 numbers
(longitude, latitude, altitude, radius) compressed using Google's polyline algorithm") and
twpayne/go-xctrack. `decodePolyline` now reads (lon, lat, alt, radius) as standalone values;
scoring engine bumped to v6; tests assert exact coordinates (Alps + southern-hemisphere) and
encoder round-trips.

### 1.3 [C] Modern `HFDTEDATE:` header unrecognized → flight date becomes "today"

Status: Fixed in #323

`src/igc-parser.ts:273, 307`.

Both date regexes (`/(?:HFDTE|HDTE)[:\s]*(\d{6})/`) require digits immediately after the tag;
the post-2015 long form `HFDTEDATE:150124,01` doesn't match, so `header.date` is `undefined`
and `baseDate = new Date()` (L302) stamps every fix with **the current date**. Start gates,
task-date checks and timezone display are all wrong — and non-deterministically so (the same
file parses differently each day). Fix: `(?:FDTE|DTE)(?:DATE)?[:\s]*(\d{6})`. Tests only cover
the short form.

### 1.4 [C] 3D-replay legend scored with hardcoded 70 km nominal distance (dead fallback)

Status: Fixed in #324

`src/track-pack-pipeline.ts:83-86`.

```ts
const params: Partial<GAPParameters> = { ...DEFAULT_GAP_PARAMETERS, ...(input.gapParams ?? {}) };
if (params.nominalDistance === undefined) { ... }   // never true
```
`DEFAULT_GAP_PARAMETERS` is spread first (it sets `nominalDistance: 70000`), so the
`calculateOptimizedTaskDistance(task) * 0.7` fallback can never fire. The Worker passes
`gapParams` from `JSON.parse(...)` or `{}` — JSON never yields `undefined` — so any comp
without an explicit stored `nominalDistance` is scored here with 70 km, while the official
scoring path (`web/workers/competition-api/src/scoring.ts:462-467`) derives it from the task.
The replay legend's ranks/scores can contradict the published standings beside them. Mirror
the `!gapParams.nominalDistance` check *before* merging defaults. (`cli/bench-task.ts` inherits
the same divergence.)

---

## 2. Medium-severity bugs

### Scoring & explanations
- **[C] Distance explanation omits the 0.5 linear factor for HG pilots whose difficulty half
  is 0** — `src/score-explanation.ts:561-564, 622-627`. `useDifficulty` is gated on
  `entry.distance_difficulty_points > 0`, but an HG pilot's difficulty half can legitimately
  be 0; they fall into the pure-linear branch whose detail string renders
  `(d ÷ best) × available = pts` while the engine computed `0.5 × (d/best) × available`
  (`gap-scoring.ts:559`). The published equation is arithmetically false by 2×. Gate on
  `params.useDistanceDifficulty && scoring === 'HG'` instead of the point value.
  **Fixed 2026-07-12** ([#326](https://github.com/pokle/glidecomp/pull/326)) — the gate now
  mirrors `scoreFlights`' predicate exactly; regression test pins the 0.5 equation for a
  0-difficulty HG pilot.
- **[C] One HG jump-the-gun starter can zero the whole field's leading points** —
  `src/gap-scoring.ts:861-863, 927, 1226-1229`. `hg_penalty` pilots keep their leading
  aggregate; `shiftSec = pilotSSS − taskFirstSSS` is negative for a pre-gate starter, so
  pre-gate progress contributes negative time and their LC can undercut every legitimate
  leader, in the extreme going ≤ 0 — at which point `calculateLeadingPoints`'s
  `minLC <= 0 → return 0` guard deletes leading points for **every** pilot. Clamp per-fix
  contributions at the first gate, and separate "no valid LC in field" from "minLC ≤ 0".
  **Fixed 2026-07-12** ([#326](https://github.com/pokle/glidecomp/pull/326), engine v9) —
  `computeLeadingAggregate` clamps each fix's time at the first gate (§11.3.1; gates resolve
  from the task alone, so the aggregate stays cacheable), and "no valid LC in field" is now a
  non-finite minLC (degenerate minLC ≤ 0 awards the minimum-holder full points instead of
  zeroing everyone). AirScore parity unchanged; whole-field regression test added.
- **[P] Total-score equations don't always reconcile** — `src/score-explanation.ts:721-748`
  vs `gap-scoring.ts:1326-1343`. Components are rounded to 0.1 independently but the total is
  rounded from the unrounded sum, so the printed `round(a + b + c + d, 1dp) = total` can be
  off by up to 0.2; and when the §12.2 jump-the-gun floor engages, the printed equation is not
  the operation performed. Same class of issue in `buildValiditySection` (2-dp factors vs
  rounded product, L531).
  **Fixed 2026-07-12** ([#329](https://github.com/pokle/glidecomp/pull/329)) — the equations
  are checked against the published figures before printing: exact `=` only when they equate,
  `≈` plus a display-rounding note when they drift, and a narrative of the actual floor
  operation (§12.2 minimum-distance / §12.4 zero) when a floor engaged. Scores unchanged.
- **[C] Scored start crossing can be hidden behind the 12-crossing listing cap** —
  `src/score-explanation.ts:294, 349-374`. Only `slice(0, 12)` crossings can carry the "this
  is the scored start" tag, but the scored start is usually one of the *last* crossings for a
  pilot who milled around the start cylinder — exactly the case the narrative exists for.
  Always include the scored crossing in the listing.
  **Fixed 2026-07-12** ([#326](https://github.com/pokle/glidecomp/pull/326)) — the scored
  crossing is always listed; the middle crossings are elided (`…N more crossings…`) instead.
- **[C] Open distance: mid-flight re-entry of the launch cylinder erases all prior distance** —
  `src/open-distance-scoring.ts:44-49, 70-84, 144-152`. Origin = *last* exit of the take-off
  cylinder over the whole flight, and the furthest-fix search starts at that exit. A pilot who
  flies 80 km, drifts back through the (up to 5 km) launch cylinder, then lands nearby scores
  a few km. If last-exit is intentional policy it should be bounded (e.g. exits within N
  minutes of the first) — and the docstring, which frames it as launch-jitter robustness,
  corrected either way.
  **Fixed 2026-07-12** ([#326](https://github.com/pokle/glidecomp/pull/326), engine v9) —
  policy decided (Tushar): re-entries do not matter; the cylinder only gates that the pilot
  left, and distance is measured from the cylinder *edge* to the furthest point
  (`dist(centre, furthest fix) − radius`, clamped at 0). Matches the manual-flight
  measurement, needs no crossing detection, and makes the geometry origin a derived edge
  point (no fix index/time). Re-entry regression test added.

### Geometry
- **[C] `goal.type: 'LINE'` is parsed but never consumed — goal lines score as cylinders** —
  `src/xctsk-parser.ts:36, 283`; no consumer in `task-optimizer.ts` or
  `turnpoint-sequence.ts`. Optimized distance is under-measured by up to the radius, and
  `madeGoal`/arrival time anchor to cylinder-edge crossing rather than line crossing. Either
  implement line geometry or explicitly reject/flag LINE-goal tasks; today it degrades
  silently.
  Status: Fixed in #339 — `src/goal-line.ts` implements the line + control semicircle, consumed
  by `turnpoint-sequence.ts` and `task-optimizer.ts`. Line control zones at *intermediate*
  turnpoints (S7F §8.4) remain unimplemented; tracked in #259.
- **[P] `toleranceCredited` mislabels two-step band penetrations** —
  `src/turnpoint-sequence.ts:429-440`. Detection straddles the outer band edge, interpolation
  targets nominal radius; a pilot entering in two steps (410 m → 402 m → 398 m) is flagged
  "credited by tolerance, never physically crossed" even though they did penetrate the nominal
  cylinder one fix later, and their reaching time/position anchor differs from single-step
  crossings.

### Parsing
- **[C] `parseBRecord` accepts garbage: NaN coords / Invalid Date enter the fixes array** —
  `src/igc-parser.ts:155-173`. Only `line.length < 35` is checked; a single corrupted B record
  poisons downstream distance/climb math with NaN. `parseCRecord` (L220) already validates
  with `/^\d{7}[NS]$/` — B records deserve the same.
  **Fixed 2026-07-12** (engine v10) — every B-record field is now regex-validated (time,
  lat/lon with hemisphere, `[AV]` validity, altitudes incl. negative `-0012` form) before
  parsing; corrupted records are dropped. Regression tests cover six corruption shapes and
  below-sea-level altitudes.
- **[C] v1 turnpoint `radius: 0` coerced to 400** — `src/xctsk-parser.ts:146` uses
  `(tpObj.radius as number) || 400` while the v2 path (L231) and the encoder
  (`waypoint-export.ts:397`, "real waypoint QRs use radius 0") preserve 0. Radius is a scoring
  input. Use a `typeof` check and the existing `DEFAULT_TURNPOINT_RADIUS` constant.
  **Fixed 2026-07-12** (engine v10) — `typeof` check preserves 0; `DEFAULT_TURNPOINT_RADIUS`
  hoisted to the top of the module and used by both the v1 and v2 paths.
- **[C] `HP`/`HO` H-records dropped (pilot name lost)** — `src/igc-parser.ts:268-290` matches
  only `HF<code>`/bare `<code>`; the IGC spec allows source char `F|O|P`. Match `[FOP]?`.
  **Fixed 2026-07-12** (engine v10) — header fields and both date regexes (incl. the
  first-pass scan, now anchored) accept `[FOP]?`; tests cover `HPPLT`/`HOGTY`/`HPCID` and
  `HPDTE`.
- **[C] Fuzzy waypoint-name containment false-positives on short/empty names** —
  `src/waypoints.ts:109-113`. `"anything".includes('')` is true, so an empty-named DB row
  matches every query, and 1-2 char names match almost anything; a false match silently
  substitutes the wrong radius/altitude into the task. Require a minimum name length or
  word-boundary containment.
  **Fixed 2026-07-12** (engine v10) — the containment fallback requires a 3+ char DB name;
  exact and normalized matches on short names still work. Regression tests added.

### Event detection
- **[C] `Infinity` glide ratio reaches user-facing text and JSON** —
  `src/event-detector.ts:305, 875`. A glide with net altitude gain gets
  `glideRatio: Infinity` → description `"Glide start (L/D Infinity)"`, and `JSON.stringify`
  turns `Infinity` into `null` across worker/cache boundaries. `glide-speed.ts:176-180`
  correctly uses `undefined` for the same case — align the conventions.
  **Fixed 2026-07-12** ([#328](https://github.com/pokle/glidecomp/pull/328)) — `glideRatio`
  is `undefined` on altitude gain; description reads "Glide start (altitude gained)";
  `extractSinks` skips ratio-less glides.
- **[C] `detectLanding` uses a seconds threshold as a fix-index bound** —
  `src/event-detector.ts:588`: `for (i = fixes.length - 2; i >= config.landingTimeWindow; i--)`
  treats 30 (seconds) as an index, silently assuming 1 Hz logging. At a 5-10 s interval, a
  landing inside the first 30 fixes (150-300 s of flight) returns no landing at all. The bound
  is redundant — the `windowStartIndex === i` guard already handles track start; loop to
  `i >= 1`.
  **Fixed 2026-07-12** ([#328](https://github.com/pokle/glidecomp/pull/328)) — loops to
  `i >= 1`; regression test at 10 s logging.
- **[P] Takeoff can fire from two isolated GPS speed spikes while grounded** —
  `src/event-detector.ts:499-502, 546-549, 567-578`. Criterion is 1-of-3 where one criterion
  is a single fix-pair speed >5 m/s, and `verifyFlightSustained` also passes on any single
  fix-pair spike. Since every downstream detector slices at `takeoffIndex`, a false-early
  takeoff feeds ground noise into everything. (Also: the verify loop `j < endIdx - 1` never
  speed-checks the window's final interval.)
  **Fixed 2026-07-12** ([#328](https://github.com/pokle/glidecomp/pull/328)) — verification
  now requires two consecutive fast intervals whose combined displacement is also fast (an
  out-and-back spike has near-zero net displacement); the loop covers the final interval.
- **[C] Thermal entry/exit events carry the thermal centroid as coordinates** —
  `src/event-detector.ts:827-829, 843-845`; consumed at `src/segment-extractors.ts:143-147`.
  Entry markers are drawn mid-thermal (a drifting thermal displaces them hundreds of metres);
  in `extractClimbs`, `startLat/startLon === endLat/endLon` for every climb. If intentional,
  document; otherwise use the real start/end fixes like glide events do.
  **Fixed 2026-07-12** ([#328](https://github.com/pokle/glidecomp/pull/328)) — decided
  (Tushar): entry/exit events sit on the track's boundary fixes like glide events; the
  centroid stays available as `ThermalSegment.location`. Regression test added.

### Packaging / infra
- **[C] Replay legend scores mapped back to pilots by display name** —
  `src/track-pack-pipeline.ts:88-95`. Duplicate pilot names (the sample comp has a pilot in
  two classes) collide last-wins. The unique key already flows through as
  `trackFile`/`p.id` — key the map on that.
- **[C] `web/engine/cli/*` is typechecked by nothing** — engine tsconfig includes only
  `src/**/*`; root tsconfig includes engine `src` + `tests` but not `cli`. Add
  `web/engine/cli/**/*` to the root include (it already has `@types/node` + `bun` types).
- **[C] Track-packer Z-axis JSDoc contradicts the implementation** — `src/track-packer.ts:94-95,
  126-131` document `z` as "North metres" while `projZ` (L241) computes `(lat0 - lat)·m/deg`,
  i.e. **south-positive**. Data is internally consistent (viewer consumes it raw), so this is
  a doc bug — but exactly the kind that produces a sign error in the next geometry feature.

---

## 3. Low-severity / edge cases

- `src/utm.ts:94-99` — `latitudeBand` returns invalid band `'Z'` for lat 80-84° (index 20 into
  a 20-char table); such an export can't be re-imported (`waypoint-files.ts:422` regex excludes
  Z). Arctic-only.
- `src/utm.ts:24` + `waypoint-files.ts:422` — UTM zone never validated 1-60; `"0C"` yields a
  plausible-looking wrong coordinate instead of a skip.
- `src/igc-parser.ts:337-341` — midnight rollover fires only on `prev ≥ 18h && cur ≤ 6h`; an
  8h+ mid-log gap crossing midnight goes backwards in time. A monotonicity check
  (`newTime < prevTime → dayOffset++`) is strictly more robust. Garbage time also sets
  `prevHours = NaN`, silently disabling rollover detection.
- `src/waypoint-files.ts:99-117` — any trailing hemisphere letter forces the packed-DDMM
  interpretation: `'147.8914E'` → 1.798° (wrong), `'36.185S'` → row silently skipped. A
  digit-count heuristic (≥4 digits before the dot for packed form) resolves real cases.
- `src/xctsk-parser.ts:236-238` — v2 numeric type `t: 1` (TAKEOFF) unmapped → typed as
  intermediate turnpoint by `getIntermediateTurnpoints`.
- `src/thresholds.ts:120` — `resolveThresholds` returns the shared mutable
  `DEFAULT_THRESHOLDS` object when called with no arg; a mutating caller corrupts defaults
  process-wide (long-lived workerd). Also `{ ...defaults, ...partial.thermal }` lets an
  explicit `undefined` override a default. Same pattern:
  `src/open-distance-scoring.ts:281` returns `DEFAULT_GAP_PARAMETERS` by reference (the GAP
  path spreads a copy at `gap-scoring.ts:1090`).
- `src/gap-scoring.ts:326-335` — degenerate params (`nominalDistance: 0`, zero pilots) produce
  NaN validity that propagates silently into published scores; `Partial<GAPParameters>` is
  never range-validated.
- `src/gap-scoring.ts:1221` — magic 1-hour `taskLastESSTime` fallback when nobody reaches ESS
  changes the leading-point distribution on ESS-less days; unnamed, no spec reference, and
  inconsistent with the classic branch (which uses `max(lastESS, lastFix)`).
- `src/time-gates.ts:99-107` — exported `gateIndexForCrossing` returns out-of-range index 0
  for an empty gates array; document the non-empty precondition or guard.
- `src/open-distance-scoring.ts:236, 258-265` — ranks tie on raw metres while the displayed
  score is `Math.round(distance)`: identical displayed scores, different ranks (GAP path ties
  on the rounded score). Tie on what the scoreboard displays.
- `src/score-explanation.ts:894, 976-979` — open-distance headline and items branches key on
  different predicates (`flown_distance > 0` vs `!geometry || flown_distance <= 0`), producing
  a self-contradicting explanation on inconsistent inputs.
- `src/turnpoint-sequence.ts:827-829, 884-886` — `flownDistance` unclamped, can go negative in
  the documented wire format (the scorer clamps later).
- `src/turnpoint-sequence.ts:399-407, 438-439` — the bbox fast-path breaks silently at the
  antimeridian (`dLon ≈ 359.8` → fix classified outside without a distance call → crossings
  vanish). Honestly documented, but the failure is silent zero scores; detect ±180° proximity
  and fall back to pure distance checks. Related: this block is inline geo math
  (`110540`/`111000` m-per-degree constants) in violation of the "all geo math in geo.ts"
  rule — extract as `makeCylinderPrefilter` in geo.ts.
- `src/task-optimizer.ts:57-86` — golden-section search on a fixed `[0, 2π]` cut of a periodic
  function isn't guaranteed unimodal (minimum near bearing-north sits at both ends); centering
  the window on the prev/next midpoint bearing is a cheap robust fix. Also L194-202: the
  convergence check runs before `path = newPath`, discarding a final improving pass; `1.0` m /
  `1e-5` rad / `n*10` iterations are unnamed magic constants.
- `src/geo.ts:55` — `C === 0` guard in `andoyerDistance` returns 0 for the *antipodal* case
  (correct answer ≈ 20 015 km); practically unreachable in doubles, but the guard should
  only cover `S === 0`.
- `src/circle-detector.ts:456-459` vs `:558-561` — `strongestLiftBearing` is [-180, 180] while
  wind `direction` is [0, 360); both documented only as "degrees".
- `src/circle-detector.ts:226-237` — circling segments include up to 15 s of straight cruise
  at the tail (`endIndex` = where the hysteresis timeout expired, not where turning stopped).
- `cli/score-task.ts` — docblock says `--scoring` defaults to PG; code/usage say HG. Missing
  arg values become silent `NaN` (`Number(args[++i])`); `as 'PG' | 'HG'` casts accept any
  string; nonexistent path throws a raw ENOENT stack.
- `src/units.ts:28-34, 143` — truncated conversion factors (2.237 vs 2.23694 etc.);
  `formatRadius` omits the NBSP separator that `formatUnit` uses ("5km" vs "5 km").
- Dead code: `buildPalette` (`src/track-packer.ts:158-168`, exported, zero callers); the
  `weighted` branch of `lcContribution` (`src/gap-scoring.ts:653-670`, re-implemented inline
  at 798-807 — drift risk); `glide-speed.ts:73` (`prevCumulativeDistance` never read);
  unreachable `i < 1` guards (`circle-detector.ts:129, 365`); unreachable
  `unitStr === undefined` (`threshold-parser.ts:119`).

---

## 4. Performance (client-side hot paths)

1. **`computeBestProgress` is O(sssCrossings × fixes)** — `src/turnpoint-sequence.ts:590-637`,
   called per SSS-crossing candidate (L824) and again for the winner (L881). A pilot
   thermalling around an EXIT start can produce 10-30 crossings × ~15-20k fixes of
   `andoyerDistance` calls. Fixes: binary-search the start index (fixes are time-sorted),
   memoize per `(lastReaching.taskIndex, lastReaching.time)` (candidates converge to the same
   forward path), and cache the winner's result instead of recomputing at L881.
2. **`computeLeadingAggregate` re-runs the full iterative task optimizer once per pilot** —
   `src/gap-scoring.ts:745, 1239` → `task-optimizer.ts:188-204` (no memoization). N pilots =
   N identical task optimizations on the `scoreTask` path. Hoist the segment distances out of
   the per-pilot call. Related: `calculateOptimizedTaskDistance` and
   `getOptimizedSegmentDistances` each rerun the full optimization for callers wanting both.
3. **Per-fix bearings computed three times over with Turf feature allocation each call** —
   `src/circle-detector.ts:135-144, 368-380`. Bearing at fix k is a pure per-fix value;
   `computeBearingRates` recomputes both ends per iteration and `extractCircles` recomputes
   them again. Each `calculateBearing` allocates two GeoJSON features (geo.ts:80-85) → ~160k+
   allocations per 40k-fix track. Precompute one `bearings[i]` array. Also the lookback scan
   at L124 degrades to O(run²) across duplicate-timestamp logger stalls — a logger behavior
   the repo already regression-tests elsewhere.
4. **`detectThermals` inner window sum telescopes** — `src/event-detector.ts:226-231` sums
   consecutive deltas that collapse to `alt[i] − alt[i−w]` / `t[i] − t[i−w]`; the O(n·w) loop
   is pure overhead. Also `windowSize` is in *fixes* (unwired, default 10), so effective
   averaging is 10 s at 1 Hz but 50 s at 5 s intervals — thermal sensitivity silently varies
   by logger rate.
5. **`calculateDistanceDifficulty` windowed sum is O(slots × lookAhead)** —
   `src/gap-scoring.ts:489-498`; with few land-outs, `lookAhead` can reach thousands over a
   course of thousands of 100 m slots. A prefix-sum makes it O(slots).
6. `src/segment-extractors.ts:66-77` — `findEndEvent` does a linear `events.find` per start
   event (O(n²)); a Map keyed by `type:startIndex:endIndex` is trivial.

---

## 5. Test-coverage gaps

Modules with **no test file at all**: `track-packer.ts`, `track-pack-pipeline.ts`,
`segment-extractors.ts`, `units.ts`, `thresholds.ts`, `threshold-parser.ts`,
`event-styles.ts`. The packing path feeds both the Worker 3dvis endpoint and `build-3dvis`;
a projection/ordering regression ships silently. A small pack-roundtrip test would pin
findings 1.4, the name-collision bug, and the Z-sign convention at once.

Specific missing cases that would have caught the bugs above:
- turnpoint nested inside the following cylinder (§1.1); `goal.type: 'LINE'` (§2);
  two-step tolerance-band penetration; antimeridian crossing detection.
- `HFDTEDATE:` long-form header (§1.3); corrupted B record; `HP`/`HO` headers; multi-second
  fix intervals for landing detection; net-altitude-gain glide (Infinity L/D).
- polyline `z` decode asserting actual coordinates, not "is a number" (§1.2).
- early starter + `useLeading` (field-wide zeroing); nobody-reaches-ESS leading fallback;
  >12 start crossings in explanations; explanation equations asserted to actually evaluate
  to the printed total.
- classic-formula AirScore parity (parity fixtures pin gap2020+ only).

---

## 6. Maintainability / assistant-DX

- **The offline 3dvis mirror is dead weight; the packer itself is live.** Usage map, verified
  by grep: the replay page always fetches the Worker endpoints
  (`/api/comp/.../3dvis` / `/api/comp/sample-3dvis`, built in
  `web/frontend/src/replay/main.ts:44-45`), and the Worker packs on demand via
  `packTracksFromIgc` (`web/workers/competition-api/src/visualization.ts:170`) — so
  `track-packer.ts`/`track-pack-pipeline.ts` are production code, not a demo leftover. What
  *is* left over from the homepage-demo era is the static mirror:
  `web/frontend/public/replay-offline/` (manifest.json + ~3 MB `tracks.bin.gz`, last
  regenerated at `8cae48d`) is referenced by nothing — not the replay entry, the service
  worker, Astro, or `_redirects` — yet ships in `dist/` on every Pages deploy. It exists only
  to be written by `web/engine/cli/build-3dvis.ts` (`bun run build-3dvis`).
  Cleanup: delete `public/replay-offline/`, drop the `build-3dvis` CLI + package script (or
  keep the CLI as a pipeline-exercising tool with a gitignored default output), and update
  `docs/3d-flight-replay-notes.md` + the CLAUDE.md sample-data section, which still describe
  the mirror as live architecture. This also removes the dead `buildPalette` question for the
  CLI path — but note the packer's zero-test-coverage gap (§5) stays fully relevant, since the
  packer is load-bearing via the Worker.

- **`web/engine` has no README.** One paragraph covering: module map, the pure-TS/no-DOM/no-
  Node constraint (and that `tsconfig "types": []` + `"lib": ["ES2022"]` enforces it — a
  deliberate structural guard worth documenting), how tests run (bun-native from the repo
  root; `bun run test` inside the package does nothing), and which exports are curated public
  API vs explainability surface.
- **Public API is ~2× wider than external usage** — of 255 names exported from
  `src/index.ts`, 141 have no consumer outside the engine. Much is deliberate
  "explainable scoring" surface, but nothing records which is which. Also
  `package.json` lacks `"sideEffects": false` for tree-shaking the wide barrel.
- **`noUncheckedIndexedAccess` is off** in both engine and root tsconfigs; the engine is
  index-heavy loop code that benefits most (e.g. `open-distance-scoring.ts:260`,
  `track-packer.ts:226`).
- **Threshold/default duplication**: circle-detection defaults live in three places
  (`thresholds.ts:104-113`, `circle-detector.ts:25-34 + 618-625`,
  `event-detector.ts:923-932` hand-copies each field); turnpoint radius 400 is a magic
  literal in four modules (~10 sites) while `DEFAULT_TURNPOINT_RADIUS` exists but is unused
  even within its own file; `roundToTenth` exists but `Math.round(x*10)/10` is re-inlined
  five times in `gap-scoring.ts:1338-1352`; tie-sharing rank loops and the "started
  inside vs first-fix origin" fallback are duplicated between GAP/open-distance/
  turnpoint-sequence.
- **Convention drift to align**: fixes-count vs seconds parameters (`windowSize`,
  `landingTimeWindow` misuse); bearing ranges ([-180,180] vs [0,360)); `Infinity` vs
  `undefined` for "no glide ratio"; `Math.max(...arr)` spread beside the stack-safe
  `array-utils.ts` helpers created to replace it (`gap-scoring.ts:488`,
  `score-explanation.ts:560, 656`).
- **Long functions with natural seams**: `resolveTurnpointSequence` (~275 lines,
  `turnpoint-sequence.ts:660-934`) and the `scoreFlights` tail; the candidate-iteration and
  gate-plumbing blocks are clean extraction points.

## 7. Verified sound (checked, no finding)

No Node API leakage in `src/` (and the tsconfig makes it a type error); no deep imports
bypassing the index (the `/timezone` subpath correctly isolates `tz-lookup`); dependency list
exactly matches imports; `scoreFlights` never mutates its inputs; the leading-aggregate
cache-split and its equivalence tests; near-midnight gate resolution; jump-the-gun paths
pinned by AirScore parity; heading-wraparound (`normalizeBearingDelta`) and the Kasa circle
fit; duplicate-timestamp takeoff slicing (regression-tested); float32 precision budget in the
track packer (~8 mm at 100 km; epoch times correctly kept out of the binary); `packDDM`/DMS
carry guards and `encodeTurnpointZ` byte-parity with real QRs; `parseIGC`'s never-throws
contract fuzz-pinned by `parser-robustness.test.ts`.

---

## Suggested fix order

1. §1.1 nested-cylinder credit (wrong ranking for finishers) + regression test.
2. §1.2 polyline lat/lon swap + §1.3 `HFDTEDATE` + §2 parsing items — small, isolated, high
   silent-corruption risk; one PR.
3. §1.4 + name-keyed legend map + Z-doc fix + a `track-packer` roundtrip test; add
   `web/engine/cli` to root tsconfig include.
4. §2 scoring/explanation items (0.5 factor, early-starter leading, scored-start listing,
   open-distance re-anchor policy decision). **Done in #326** (the §2 [P] total-rounding
   item remains open).
5. Perf items §4.1-4.3 (measurable client-side wins), then the low/quality backlog
   opportunistically.
