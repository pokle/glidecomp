# Field Analysis — per-task / per-comp behavioural metrics in the engine + scoring CLI

## Context

GlideComp has scores and ranks but doesn't yet explain *how* better pilots fly. This feature computes per-pilot behavioural metrics (climbing, gliding, decision-making, gaggle flying, race craft, day profile/wind) across all pilots' tracks in a task, compares each pilot against the field, and ranks the metrics by Spearman correlation against GAP rank — so we learn which behaviours actually separate the leaderboard and which metrics deserve refinement later. Engine + CLI only: the report prints after the existing scores table in `score-task`, per task, and (new whole-comp mode) aggregated for an entire comp. Simple first implementations — "good, not perfect" — the correlation eval is the prioritisation tool.

Execution model: implemented by parallel agents. Stage 0 is a serial foundation that freezes shared types/files; Stage 1 is six parallel metric-family packages with disjoint file ownership; Stage 2 is serial integration.

Key facts from exploration (verified 2026-07-18):
- `scoreTask` (`web/engine/src/gap-scoring.ts`) retains per-pilot `turnpointResult: TurnpointSequenceResult` — every turnpoint crossing time/fixIndex (`sequence: TurnpointReaching[]`, `sssReaching`, `essReaching`), `legs`, `flownDistance`, `speedSectionTime`, `startGate`. Race-craft metrics need no re-derivation. Pair pilots by `trackFile`, never array index (project rule).
- Detectors exist per track: `detectFlightEvents`, `detectThermals`/`detectGlides` (glides = gaps between thermals; the union does NOT cover the flight — unclassified time exists), `detectCircles` (per-circle wind two ways: `windFromGroundSpeed`, `windFromCenterDrift`; no flight-level aggregation exists).
- `detectGaggles(frames, params, opts)` (`web/engine/src/cluster-detector.ts`) does cross-pilot clustering but the CALLER must supply time-gridded ENU `Frame[]` (`{t, states: [{pilot, x=east, y=alt, z=−north}]}`); supports `opts.startCylinder` exclusion. **No resampler exists anywhere in the engine — it's a Stage 0 foundation.**
- Geo via `web/engine/src/geo.ts` only (`andoyerDistance`, `calculateBearing`, `calculateTrackDistance`, `destinationPoint`, `localEastNorth`) — never inline geo math (project rule).
- `stoppedGlideRatio(scoring)` and `resolveGoalAltitude(task)` are in `web/engine/src/gap-stopped.ts` (relative import; not in the index barrel).
- CLI: `web/engine/cli/score-task.ts` (single task; GAP table printing ends ~line 555; manual argv parsing, unknown flags error; `--json` mode). Whole-comp enumeration pattern: `web/scripts/seed-sample-comp.ts` (`CompManifest`, `readTask`, `idFromFilename` at ~lines 283–464 — coupled to D1 seeding, so mirror a lean helper, don't refactor).
- Tests: `bun:test` in `web/engine/tests/`, helpers `tests/test-helpers.ts` (`createFix`, `BASE_TIME`). `kosci-loop` (synthetic, deterministic, PG, 44 pilots, 3 tasks) is the integration fixture; `corryong-cup-2026` (real, HG, 2 classes × 3 tasks) is the manual verification target.
- Project rule: every analysis decision must be explainable — each metric carries a printed explanation string.

## Module architecture

New pure (fs/DOM-free) module `web/engine/src/field-analysis/`; file I/O and manifest reading stay in the CLI layer.

```
web/engine/src/field-analysis/
  types.ts            # ALL shared types + MetricComputer contract  (FROZEN after Stage 0)
  stats.ts            # percentile, median, mean, rankWithTies, spearman, circularMeanWind
  resample.ts         # time-grid resampler → TimeGrid + ResampledTrack (feeds detectGaggles)
  shared-thermals.ts  # cross-pilot thermal clustering (union-find)
  phase-partition.ts  # three-way climb/glide/search partition
  working-band.ts     # day usable altitude band from field-wide thermal data
  context.ts          # buildPilotContext / buildFieldContext (runs every detector ONCE per pilot)
  registry.ts         # imports six family arrays, exports ALL_METRICS   (FROZEN after Stage 0)
  evaluate.ts         # run metrics, Spearman vs GAP rank, build FieldAnalysisReport model
  report.ts           # plain-text renderer (~100 col), generic over the registry
  aggregate.ts        # cross-task comp aggregation + comp-level correlations
  index.ts            # barrel
  metrics/climbing.ts gliding.ts decision.ts gaggle.ts racecraft.ts day-profile.ts   # Stage 1
```

`web/engine/src/index.ts` gets one export line re-exporting the barrel (`buildFieldContext`, `evaluateField`, `renderFieldReport`, `aggregateComp`, `ALL_METRICS`, types).

### MetricComputer contract (`types.ts`) — the parallel-work interface

```ts
export type MetricFamily = 'climbing' | 'gliding' | 'decision' | 'gaggle' | 'racecraft' | 'day';
/** 'higher' = larger value should mean better GAP rank; 'neutral' = no prior, report signed ρ. */
export type MetricDirection = 'higher' | 'lower' | 'neutral';

export interface PilotMetricValue {
  trackFile: string;            // pairing key (project rule)
  value: number | null;         // null = not applicable (no thermals, never started, …)
  note?: string;                // e.g. "3 low saves, deepest at 12% of band"
}
export interface ReportTable {
  title: string;
  columns: { header: string; align: 'left' | 'right' }[];
  rows: string[][];
  footnotes?: string[];
}
export interface MetricOutput {
  perPilot: PilotMetricValue[];      // one per FieldContext.pilots element, same order
  fieldSummary?: string[];           // lines under the family heading
  extraTables?: ReportTable[];       // horserace, waterfall, wind, …
}
export interface MetricComputer {
  id: string;                        // 'climb.shared_percentile', 'race.leg_time_lost', …
  label: string;
  shortLabel?: string;               // ≤10-char column header for the family table
  unit: string;                      // 'pct' | 'm/s' | 's' | 'min' | 'km/h' | 'count' | 'ratio' | 'm'
  family: MetricFamily;
  direction: MetricDirection;
  explanation: string;               // 1–2 sentence method text, printed once (explainability rule)
  compute(field: FieldContext): MetricOutput;   // pure; must not mutate field
}
```

Rules that make parallelism safe: metrics ONLY read `FieldContext` (never re-run detectors); `value: null` is the universal "not applicable"; field-level-only metrics return all-null `perPilot` and the eval skips correlation below the minimum sample; cross-pilot proximity questions go through `grid`/`gaggles`/`sharedThermals`, never nested per-fix loops over pilots.

### Context types (`types.ts`)

```ts
export interface PilotAnalysisContext {
  pilotName: string; trackFile: string;
  pilotIndex: number;               // index into FieldContext.pilots AND grid PilotState.pilot
  fixes: IGCFix[];
  score: PilotScore;                // includes turnpointResult
  thermals: ThermalSegment[]; glides: GlideSegment[];   // fix indices absolute
  circles: CircleDetectionResult;   // segment/circle indices absolute; bearingRates slice-relative
  phases: PhaseInterval[];          // covers takeoff..landing exactly
  takeoffIndex: number; landingIndex: number;
  sssMs: number | null; essMs: number | null;
  track: ResampledTrack;            // this pilot on the shared grid
}
// NOTE (Stage 0 as built): no `events: FlightEvent[]` field — no metric spec reads raw
// FlightEvents and including it would run every detector twice. Detectors are invoked
// individually in context.ts (detectTakeoffLanding → slice → detectThermals/Glides/Circles).
export interface LegInfo { fromTaskIndex: number; toTaskIndex: number; optimizedMeters: number; }
export interface FieldContext {
  task: XCTask;
  category: 'hg' | 'pg';
  scoreResult: TaskScoreResult;
  pilots: PilotAnalysisContext[];   // sorted by score.rank ascending
  grid: TimeGrid;
  gaggles: GaggleResult;            // detectGaggles(grid.frames, DEFAULT_GAGGLE_PARAMS, {startCylinder})
  sharedThermals: SharedThermal[];  // includes singletons
  workingBand: WorkingBand;
  legs: LegInfo[];                  // from getOptimizedSegmentDistances(task)
  origin: { lat: number; lon: number };  // ENU reference = task.turnpoints[0] center
}
export function buildFieldContext(task, flights: PilotFlight[], scoreResult, category,
  opts?: { stepSeconds?: number }): FieldContext;
```

`buildFieldContext` pairs flights↔scores by `trackFile`, runs detectors once per pilot, builds grid/tracks, runs `detectGaggles` with the SSS cylinder (via `getEffectiveSSSIndex(task)`) projected to ENU with `localEastNorth` (mind the frame convention: **z = South = −north**), then shared thermals, working band, phase partitions.

## Foundational primitives (Stage 0)

### (a) Time-grid resampler — `resample.ts`

```ts
export interface ResampledSample { lat; lon; alt; east; north; vario; }   // numbers
export interface ResampledTrack { startStep: number; endStep: number;
  samples: (ResampledSample | null)[]; }   // length grid.count; null = not airborne / logger gap
export interface TimeGrid { t0Ms: number; stepSeconds: number;  // default 10 (= gaggle default)
  count: number; frames: Frame[]; }        // Frame.t = i*stepSeconds (relative s)
export function buildTimeGrid(pilots: {fixes; takeoffIndex; landingIndex}[],
  origin: {lat; lon}, stepSeconds = 10): { grid: TimeGrid; tracks: ResampledTrack[] };
export function sampleAt(grid, track, tMs): ResampledSample | null;   // nearest step
```

Two-pointer sweep per pilot (O(fixes + steps)). Linear interpolation; altitude = `gnssAltitude` falling back to `pressureAltitude` when 0; samples only between takeoff and landing; fix gaps > 60 s → nulls (no interpolation across dropouts). `vario` = (alt(t) − alt(t−step))/step. Frames states: `{pilot: pilotIndex, x: east, y: alt, z: -north}`. Cap grid at 14 h.

### (b) Shared-thermal clusterer — `shared-thermals.ts`

```ts
export interface ThermalUse { pilotIndex; thermalIndex; startMs; endMs; lat; lon;
  avgClimbRate; gainMeters; entryAltitude; exitAltitude; }
export interface SharedThermal { id; uses: ThermalUse[]; lat; lon; startMs; endMs; pilotCount; }
export function clusterSharedThermals(pilots: PilotAnalysisContext[],
  opts?: { maxDistanceMeters?: number /*800*/; maxGapSeconds?: number /*120*/ }): SharedThermal[];
```

Flatten every pilot's `ThermalSegment`s into `ThermalUse[]` (≤ ~1,000 for 80 pilots). Union-find (copy the pattern from `clusterFrame` in `cluster-detector.ts`): link uses when `andoyerDistance ≤ maxDistanceMeters` AND time intervals overlap or gap ≤ `maxGapSeconds`. Sort by `startMs` and break the inner loop once past the time horizon (effectively O(N·k)). Keep singletons (marker-usage denominator needs them). Centroid = mean lat/lon of uses.

### (c) Three-way phase partition — `phase-partition.ts`

```ts
export type FlightPhase = 'climb' | 'glide' | 'search';
export interface PhaseInterval { phase; startIndex; endIndex; startMs; endMs; durationSeconds; }
export function partitionPhases(fixes, thermals, circles, takeoffIndex, landingIndex,
  opts?: { minGlideNetSpeedMps?: number /*8*/; windowSeconds?: number /*60*/ }): PhaseInterval[];
```

1. Every `ThermalSegment` → `climb`. 2. Remaining gaps chopped into ≤ `windowSeconds` windows: `glide` when net displacement speed ≥ threshold AND the window doesn't overlap a `circlingSegment`; else `search`. 3. Merge adjacent same-phase intervals. Must cover `[takeoffIndex, landingIndex]` exactly, no overlaps (asserted in tests).

### (d) Working band — `working-band.ts`

```ts
export interface WorkingBand { floorMeters; ceilingMeters; spanMeters; sampleCount;
  hourly: { hourStartMs; floor; ceiling; samples }[];
  bandFraction(altMeters: number): number; }   // (alt−floor)/span, clamped [−0.5, 1.5]
export function estimateWorkingBand(pilots: PilotAnalysisContext[]): WorkingBand;
```

Floor = p10 of all field thermal ENTRY altitudes; ceiling = p90 of EXIT altitudes; span ≥ 1. Fallback for < 10 thermal samples: p10/p90 of all fix altitudes (metrics note the fallback).

### (e) Stats — `stats.ts`

`percentile(sorted, p)` (linear interp), `median`, `mean`, `rankWithTies(values)` (average ranks — standard Spearman tie treatment), `spearman(a, b)` (Pearson of tied ranks; NaN for n < 3 or zero variance), `circularMeanWind(estimates)` (vector u/v average → `{speed, direction, n}`). No dependencies.

## Per-metric specifications

Conventions: **post-SSS** = at/after `sssMs` (never started → null unless stated). **Speed section** = `[sssMs, essMs ?? landing]`. The scalar `value` feeds the eval; richer breakdowns go in `fieldSummary`/`extraTables`. Every metric's `explanation` states its method.

### P1 climbing — `metrics/climbing.ts`

1. **`climb.shared_percentile`** (pct, higher) — For each `SharedThermal` with `pilotCount ≥ 2`, rank `uses` by `avgClimbRate`; a use's percentile = 100·(#strictly slower)/(n−1). Value = duration-weighted mean percentile across the pilot's shared uses. Null if none. This is centering skill isolated from thermal selection.
2. **`climb.time_to_core`** (s, lower) — Per thermal ≥ 60 s: 30 s rolling climb rate; time-to-core = first time rolling rate ≥ 0.9·its peak, minus segment start. Value = median across qualifying thermals.
3. **`climb.exit_decay`** (m/s, neutral) — Per thermal ≥ 90 s: climb rate over the final 30 s ("give-up rate"). Value = median. Low = abandons weakening lift early; the ρ sign says which behaviour pays — hence neutral.
4. **`climb.selectivity`** (pct, neutral) — Encounters = post-SSS circling segments ≥ 30 s; accepted = those overlapping a `ThermalSegment`. Value = 100·accepted/encounters (null if < 3 encounters). `fieldSummary`: field median acceptance per hour bucket (acceptance threshold vs time of day, coarse).
5. **`climb.departure_band`** (pct, neutral) — Median over post-SSS thermals of `100·bandFraction(exitAltitude)`; `note` adds mean on-course altitude as band %.
6. **`climb.circle_smoothness`** (ratio, lower) — Per circle: `fitErrorRMS / radiusMeters`; value = median (≥ 10 circles else null). `fieldSummary`: per-pilot turn-direction split (% left).

### P2 gliding — `metrics/gliding.ts`

7. **`glide.speed`** (km/h, higher) — Duration-weighted mean of post-SSS glide `distance/duration` × 3.6. `fieldSummary`: field median/p90.
8. **`glide.ld_vs_field`** (ratio, higher) — Per completed speed-section leg (between consecutive `TurnpointReaching`s): pilot leg L/D = Σ fix-path distance in `glide` phases within the leg ÷ net altitude lost in those phases (skip legs losing < 100 m). Value = mean over legs of pilot L/D ÷ field median leg L/D. Captures "found a better line" without a map.
9. **`glide.stf_proxy`** (km/h, higher) — Speed-to-fly proxy (no polars exist; explanation says so). Pair each post-SSS glide with the next thermal ≤ 5 min later: (glide speed, next climb rate). Value = mean glide speed before stronger-than-median climbs − mean before weaker (null if < 4 pairs). Positive = flies faster when the day/next climb justifies it.
10. **`glide.track_efficiency`** (ratio, lower) — Per completed leg: actual path distance (`calculateTrackDistance` on the fix slice between reachings) ÷ optimized leg meters (`FieldContext.legs`). Value = distance-weighted mean.
11. **`glide.dolphin_fraction`** (pct, neutral) — Total gain = Σ positive 10 s-smoothed altitude deltas post-SSS; dolphin gain = same restricted to fixes outside every `ThermalSegment`. Value = 100·dolphin/total (null if total < 200 m). Showcases pilots reading the air without stopping to circle.

### P3 decision-making — `metrics/decision.ts`

12. **`decision.altitude_floor`** (pct, higher) — Post-SSS local minima of 30 s-smoothed altitude with ≥ 100 m prominence; value = median as band % (null if < 2 minima).
13. **`decision.low_saves`** (count, neutral) — Post-SSS thermal with `entryAltitude` < floor + 0.15·span AND gain ≥ 300 m. Value = count (0 is valid for started pilots); `note` = deepest save.
14. **`decision.climbs_per_100km`** (count, lower) — Post-SSS thermal count ÷ (flownDistance/100 km); null if < 20 km. `note`: pilot's mean shared-climb percentile, so the report shows "few stops AND strong climbs".
15. **`decision.search_fraction`** (pct, lower) — 100·search/(climb+glide+search) within the speed section. `fieldSummary`: field median/p25/p75 for all three phase shares.

### P4 gaggle — `metrics/gaggle.ts`

16. **`gaggle.affinity`** (pct, neutral) — Fraction of grid steps **from SSS onwards** (everyone gaggles near launch; gaggles also computed with start-cylinder exclusion) where the pilot appears in some episode's timeline snapshot. Null if never started.
17. **`gaggle.marker_usage`** (pct, neutral) — A post-SSS thermal use is "marked" when another pilot's use in the same `SharedThermal` started ≥ 30 s earlier and covers the pilot's entry. Value = 100·marked/uses (null if < 3 uses). Distinguishes "finds own climbs" from "climbs on others".
18. **`gaggle.departure_winrate`** (pct, neutral) — Departure = pilot present in an episode snapshot at t, absent from all its later snapshots, episode continues ≥ 120 s with ≥ 2 remaining members. For each: pilot's next `TurnpointReaching` after t vs the median reaching time of the members who stayed (same taskIndex). Value = 100·wins/departures; `note` = "W–L (n departures)". **Explanation printed verbatim** (must be self-explanatory): "When a pilot leaves a gaggle that keeps flying, did leaving pay off? We compare the leaver's arrival at the next turnpoint against the median arrival of the pilots who stayed. Win rate > 50% means their departures beat the gaggle."

### P5 race craft — `metrics/racecraft.ts`

19. **`race.start_delay`** (s, lower) — Seconds between taken gate time (`turnpointResult.startGate?.time`, else the race gate) and `sssReaching.time`. `extraTables`: start table — delay, crossing altitude (and band %), distance behind lead at own start step (grid-based: min remaining-to-next-TP among already-started pilots vs own).
20. **`race.leg_time_lost`** (s, lower) — **The waterfall.** Leg time = `sequence[i+1].time − sequence[i].time`. Value = Σ over completed legs of max(0, pilotLeg − top10MeanLeg). `extraTables`: rows = pilots in rank order, one column per leg, cell = signed Δ vs winner ("+m:ss"/"−m:ss"), Total column; "—" for missing legs; footnote explains signs and the top-10 reference.
21. **`race.time_behind`** (min, lower) — **Horserace.** At each speed-section TP: elapsed = reaching − own start; behind = elapsed − min elapsed among reachers. Value = minutes behind at ESS (null if no ESS). `extraTables`: rows = pilots, cols = TP names (SSS…ESS/Goal), cells = minutes behind leader, "—" if unreached. Expected |ρ| ≈ 1 — kept deliberately as an eval sanity check (noted in explanation).
22. **`race.ess_margin`** (m, lower) — `essReaching.altitude − (resolveGoalAltitude(task) + distanceToGoal / stoppedGlideRatio(category))` — both helpers imported from `../gap-stopped` (relative; not in the index barrel). Null for non-ESS pilots. `fieldSummary`: top-10 vs rest margin distribution.
23. **`race.final_glide_init`** (ratio, neutral) — At the last post-SSS thermal exit before ESS/landing: required glide ratio = distance-to-goal ÷ (exitAlt − goalAlt). `note`: "left last climb X km out at Y m". Null if pilot never got within 1.5× final-leg distance.

### P6 day profile & wind — `metrics/day-profile.ts` (mostly field-level; printed regardless)

24. **`day.wind`** (perPilot all null) — Per-circle `windFromCenterDrift ?? windFromGroundSpeed` across all pilots, vector-averaged (`circularMeanWind`) for: whole task, per hour (circle midpoint), per leg (assign each circle to the leg its pilot occupied, via reaching times). `extraTables`: rows for task/hourly/per-leg with speed km/h, direction° (FROM), n. Printed even without a downstream use — the point is to eyeball wind-vs-leg-outcome (e.g. a mid-task wind switch).
25. **`day.climb_by_hour`** (perPilot all null) — Hourly buckets over all `ThermalUse`s: median and p90 climb, sample count. One table — the day's shape.
26. **`day.launch_timing`** (pct, higher) — Per pilot: 100·(airborne samples with 30 s-smoothed vario ≥ −0.5 m/s)/(airborne samples) — proportion of flight in non-sinking air, the lens on flying the day's optimal window. `fieldSummary`: best-conditions hour (argmax of #25) vs takeoff-time quartiles, one line.

## Eval (metric separation ranking) — `evaluate.ts` (Stage 0)

- Spearman = Pearson over `rankWithTies` ranks; NaN for n < 3 / constant series.
- Per metric: pilots with `value !== null` and a GAP rank; correlate value vs rank (rank 1 = best → a 'higher' metric should show **negative** ρ). Report signed ρ, |ρ|, n, direction, verdict ('strong' |ρ| ≥ 0.5, 'moderate' ≥ 0.3, 'weak' < 0.3, 'n too small' n < 8 — still shown, flagged).
- 'neutral' metrics ranked purely by |ρ|; the sign tells the user which way the behaviour pays.
- Cross-task (`aggregate.ts`): per metric, n-weighted mean |ρ| across tasks with per-task signed ρ listed; comp-level ρ on per-pilot metric means (matched by `pilotKeyFor`) vs comp rank (Σ totalScore desc). Classes never mix (open and floater are separate fields).
- Types: `MetricCorrelation {metricId, rho, absRho, n, verdict}`, `FieldAnalysisReport {basis, families, correlations}`, `CompAggregateReport`.

## CLI integration — `web/engine/cli/score-task.ts` + `web/engine/cli/comp-manifest.ts`

Flags:
- `--field-analysis` — single-task mode: after the score table (~line 555), `buildFieldContext` → `evaluateField` → `renderFieldReport`, print. With `--json`, attach the `FieldAnalysisReport` model as a `fieldAnalysis` key instead of text.
- `--comp <slug-or-dir>` — whole-comp mode (implies `--field-analysis`; positionals become optional). `<slug>` → `web/samples/comps/<slug>/comp.json`; a path containing `comp.json` used directly. Wing from manifest `category` (hg→HG, pg→PG), `--wing` overrides. `scoring_format: 'open_distance'` comps (big-chip): score via `scoreOpenDistance`, rank by distance, same metrics (start-relative ones null) — supported but secondary.

New CLI-local helper `web/engine/cli/comp-manifest.ts` (mirror, don't refactor, the seed script's read path — `web/scripts/seed-sample-comp.ts` ~lines 283–464 — which is coupled to D1/Miniflare):

```ts
export function loadCompManifest(slugOrDir: string): { manifest: CompManifest; compsRoot: string };
export function readTaskDir(dir: string): { task: XCTask; pilots: PilotFlight[] };
/** Cross-task pilot key: federation id from filename (digits, per idFromFilename) else normalized name.
    trackFile can't pair across tasks — filenames embed the task date (lamb_18239_050126.igc). */
export function pilotKeyFor(trackFile: string, pilotName: string): string;
```

Comp flow: per class, per task (chronological): score exactly as single-task mode (auto nominal-distance 70% as today) → score table → per-task field-analysis report; retain per-task reports; then per class print the comp aggregate (`aggregateComp`). `--json` emits `{ tasks: [...], comp: {...} }`.

Report layout (`report.ts`, ~100 col, reuses the CLI's `padLeft`/`padRight` style):

```
=== Field Analysis ===========================================================
Basis: 42 scored pilots · grid 10 s · 118 shared thermals (73 multi-pilot) ·
working band 850–2350 m · phases cover 100.0% of flight time
--- Day profile & wind ---   (wind table, climb-by-hour table, launch-timing line)
--- Climbing ---             (explanations once, then ONE per-pilot table in rank
--- Gliding ---               order with one column per family metric, then
--- Decision-making ---       fieldSummary lines and extraTables)
--- Gaggle ---
--- Race craft ---           (start table · leg waterfall vs winner · horserace)
--- Metric separation ranking (Spearman ρ vs GAP rank) ---
  Metric               ρ     |ρ|   n   direction  verdict     (sorted |ρ| desc,
  race.time_behind  -0.97   0.97  38   lower      sanity≈rank  sign footnote)
```

`report.ts` is generic over the registry — a Stage 1 agent adding a metric to their family array appears in the report with zero report-code changes.

## Testing

Stage 0: `web/engine/tests/field-resample.test.ts` (interpolation, >60 s gaps → nulls, ENU z = −north matches cluster-detector), `field-shared-thermals.test.ts` (concurrent 300 m apart clusters; 2 km / 10 min apart don't; singletons kept), `field-phase-partition.test.ts` (exact coverage, no overlaps, fast-straight → glide, slow-meander → search), `field-stats.test.ts` (Spearman hand-computed incl. ties/constant/n=2), `field-analysis.test.ts` (integration skeleton over `web/samples/comps/kosci-loop-t1/`: parse → `scoreTask` (PG) → `buildFieldContext` → `evaluateField` → `renderFieldReport`; passes with stub families), plus `web/engine/tests/field-test-helpers.ts` (`makeTestField(...)` factory — FROZEN after Stage 0).

Stage 1: one test file per package (below), synthetic contexts via `makeTestField`.

Stage 2 manual verification:
```
bun run score-task -- web/samples/comps/corryong-cup-2026-open-t1/*.xctsk \
  web/samples/comps/corryong-cup-2026-open-t1/ --wing HG --field-analysis
bun run score-task -- --comp corryong-cup-2026
bun run score-task -- --comp kosci-loop
```
Eyeball: horserace matches the airscore-parity task's known results; wind plausible; `race.time_behind` |ρ| ≈ 1; runtime < ~30 s for the 6-task comp (`web/engine/cli/bench-analysis.ts` exists if profiling is needed).

## Todo list / staging DAG (for parallel agents)

### Stage 0 — serial, ONE agent (foundation; types.ts, registry.ts, test helpers FROZEN after) — DONE
- [x] Merge `origin/master` into this branch
- [x] Commit this plan as `docs/2026-07-18-field-analysis-plan.md`
- [x] `field-analysis/`: `types.ts` (full contract above), `stats.ts`, `resample.ts`, `shared-thermals.ts`, `phase-partition.ts`, `working-band.ts`, `context.ts`, `evaluate.ts`, `report.ts`, `aggregate.ts`, `index.ts`; one export line in `web/engine/src/index.ts`
- [x] Six `metrics/*.ts` stubs each exporting a typed empty array (`export const CLIMBING_METRICS: MetricComputer[] = []` etc.); `registry.ts` concatenating them into `ALL_METRICS`
- [x] CLI: `--field-analysis`, `--comp`, `cli/comp-manifest.ts`; stub metrics yield a valid (nearly empty) report end-to-end
- [x] Foundation tests + integration skeleton + `tests/field-test-helpers.ts`; `bun run test` green

**Stage 0 as-built notes for Stage 1 agents:**
- The contract deltas vs the spec above: no `PilotAnalysisContext.events` (see NOTE), `MetricComputer.shortLabel?` added, `WorkingBand.usedFallback: boolean` added, and `resample.ts` also exports `stepFor(grid, tMs)` (clamped grid-step lookup).
- `tests/field-test-helpers.ts` (FROZEN) exports `makeTestField(specs, opts?)` — runs the REAL foundation pass over hand-built fixes with a faked score — plus `makeTestTask`, `makeEmptyTurnpointResult`, `straightFixes`, `circlingFixes`, `TEST_ORIGIN`, `DEG_LAT_PER_M`, `DEG_LON_PER_M`.
- `tests/field-analysis.test.ts` has the metric authoring template: the `test.flown_distance` case shows a full MetricComputer, evaluation, correlation assertion, and render check. Copy its shape.
- `evaluateField` re-aligns `perPilot` by trackFile (order-tolerant), turns a thrown `compute()` into `MetricReport.error`, and skips correlation below 3 non-null values. Family sections render in `FAMILY_ORDER` (day first).
- Correlation sanity from the stub run: kosci-loop-t1 `test.flown_distance` shows ρ ≈ −0.9 vs rank.

### Stage 1 — SIX parallel agents (each owns exactly two files; no other edits)

| Pkg | Owns | Metrics | Foundation APIs consumed |
|---|---|---|---|
| P1 climbing | `metrics/climbing.ts`, `tests/field-metrics-climbing.test.ts` | 1–6 | sharedThermals, workingBand, thermals, circles, stats |
| P2 gliding | `metrics/gliding.ts`, `tests/field-metrics-gliding.test.ts` | 7–11 | glides, phases, legs, turnpointResult, geo |
| P3 decision | `metrics/decision.ts`, `tests/field-metrics-decision.test.ts` | 12–15 | phases, workingBand, thermals, score |
| P4 gaggle | `metrics/gaggle.ts`, `tests/field-metrics-gaggle.test.ts` | 16–18 | grid, gaggles, sharedThermals, turnpointResult |
| P5 racecraft | `metrics/racecraft.ts`, `tests/field-metrics-racecraft.test.ts` | 19–23 | turnpointResult, grid, legs, `../gap-stopped` helpers |
| P6 day | `metrics/day-profile.ts`, `tests/field-metrics-day.test.ts` | 24–26 | circles wind, ThermalUses, track vario |

Cross-package needs (shared thermals for P1+P4, grid for P4+P5, working band for P1+P3, phases for P2+P3) are all Stage 0 outputs — no Stage 1 package imports another Stage 1 file.

- [ ] P1 · [ ] P2 · [ ] P3 · [ ] P4 · [ ] P5 · [ ] P6 (each: implement + tests green in isolation)

### Stage 2 — serial, ONE agent
- [ ] Tighten kosci-loop-t1 integration assertions (all 23 per-pilot metrics populated for ≥ 80% of started pilots; wind/day tables non-empty; `race.time_behind` |ρ| > 0.9)
- [ ] Run corryong single-task + `--comp corryong-cup-2026` + `--comp kosci-loop`; polish column widths/ordering/wording; check runtime
- [ ] Usage note in `score-task.ts` header comment; `bun run test` + `bun run typecheck:all` green

## Deferred — for later (all wanted, in time; recorded so nothing gets lost)

| Deferred item | Why deferred | What unblocks it |
|---|---|---|
| Lift-line map per leg | Inherently spatial; CLI can't draw maps. Learnable essence covered by `glide.ld_vs_field` | Map UI surface for analysis output |
| Thermal probability map / house thermals / trigger points | Spatial + cross-comp aggregation | Map UI + a store of analysis results across comps |
| Wind field reconstruction beyond one task (site wind climatology) | Cross-comp; task-scoped wind ships now (#24) | Cross-comp aggregation store |
| Gaggle lead/follow index (front vs back of gaggle, first to leave shared thermals) | Not selected this round; GAP leading points already partially capture it | Refinement pass after the eval says gaggle metrics separate |
| True MacCready speed-to-fly discipline | No glider polar data; proxy ships now (#9) | Polar database per glider class |
| Consistency & long game (rank variance, throwaway-task profile, skill trajectory, behavioural fingerprint radar) | Cross-comp per-pilot identity + history needed | Pilot identity across comps + stored per-task metric results |
| Task debrief surface (per pilot per task: annotated timeline, personal waterfall narrative) | UI/UX surface; out of scope this round | SPA task-page integration of `FieldAnalysisReport` |
| Site guide & pilot report card surfaces | Cross-comp + UI | Both of the above |
| Horserace as a visual animation | CLI is text; the table ships now (#21) | UI surface (would make a great task-page feature) |

## Verification

1. `bun run test` — all foundation + metric-family unit tests and the kosci-loop-t1 integration test pass; `bun run typecheck:all` clean.
2. `bun run score-task -- web/samples/comps/corryong-cup-2026-open-t1/*.xctsk web/samples/comps/corryong-cup-2026-open-t1/ --wing HG --field-analysis` — scores table unchanged, field-analysis report printed after it, all family sections populated, correlation table sorted by |ρ| with `race.time_behind` near the top (sanity |ρ| ≈ 1).
3. `bun run score-task -- --comp corryong-cup-2026` — six tasks across two classes each print scores + analysis, then two per-class comp aggregates; classes never mixed; runtime < ~30 s.
4. `--json` modes emit well-formed JSON including `fieldAnalysis`.
5. Existing behaviour untouched: `score-task` without new flags byte-identical output; `airscore-parity.test.ts` still green.
