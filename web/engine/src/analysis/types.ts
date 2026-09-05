// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Task analysis — shared types and the MetricComputer contract.
 *
 * THIS FILE IS THE CONTRACT between the task-analysis foundation and the
 * metric families in `metrics/*.ts`. Metric implementations may ONLY read the
 * FieldContext (never re-run detectors) and must express cross-pilot proximity
 * through `grid` / `gaggles` / `sharedThermals`, never nested per-fix loops
 * over pilots. See docs/2026-07-18-field-analysis-plan.md.
 */

import type { IGCFix } from '../igc-parser';
import type { XCTask } from '../xctsk-parser';
import type { ThermalSegment, GlideSegment } from '../event-types';
import type { CircleDetectionResult } from '../circle-detector';
import type { GaggleResult } from '../cluster-detector';
import type { PilotScore, TaskScoreResult } from '../gap-scoring';
import type { TimeGrid, ResampledTrack } from './resample';
import type { SharedThermal } from './shared-thermals';
import type { PhaseInterval } from './phase-partition';
import type { WorkingBand } from './working-band';

// ---------------------------------------------------------------------------
// Context — everything a metric may read, computed once per field
// ---------------------------------------------------------------------------

/** One pilot's fully-analysed flight. All detector output is precomputed. */
export interface PilotAnalysisContext {
  pilotName: string;
  /** Pairing key across every per-pilot structure (project rule: never pair by array index). */
  trackFile: string;
  /** Index into FieldContext.pilots AND the grid frames' PilotState.pilot. */
  pilotIndex: number;
  fixes: IGCFix[];
  /** GAP score, including the full turnpointResult (crossing times, legs, gates). */
  score: PilotScore;
  /** Fix indices are absolute (into `fixes`). */
  thermals: ThermalSegment[];
  /** Fix indices are absolute (into `fixes`). */
  glides: GlideSegment[];
  /**
   * detectCircles over the takeoff→landing slice, with segment/circle fix
   * indices offset back to absolute. `bearingRates` stays aligned to the
   * sliced fixes (index i ↔ fixes[takeoffIndex + i]).
   */
  circles: CircleDetectionResult;
  /** Three-way climb/glide/search partition covering takeoff..landing exactly. */
  phases: PhaseInterval[];
  takeoffIndex: number;
  landingIndex: number;
  /** SSS reaching time (epoch ms), null when the pilot never started. */
  sssMs: number | null;
  /** ESS reaching time (epoch ms), null when not reached. */
  essMs: number | null;
  /** This pilot on the shared time grid. */
  track: ResampledTrack;
}

/** One speed-section (or reference) leg of the task. */
export interface LegInfo {
  fromTaskIndex: number;
  toTaskIndex: number;
  /** Optimized leg distance in metres (getOptimizedSegmentDistances). */
  optimizedMeters: number;
}

/** The whole scored field, analysed. The single input to every metric. */
export interface FieldContext {
  task: XCTask;
  category: 'hg' | 'pg';
  scoreResult: TaskScoreResult;
  /** Sorted by score.rank ascending. */
  pilots: PilotAnalysisContext[];
  /** Shared time grid + per-step cluster-detector frames. */
  grid: TimeGrid;
  /** detectGaggles over the grid frames, start-cylinder excluded. */
  gaggles: GaggleResult;
  /** Cross-pilot thermal clusters, singletons included, ascending by start. */
  sharedThermals: SharedThermal[];
  workingBand: WorkingBand;
  /** One entry per task leg (turnpoint i → i+1). */
  legs: LegInfo[];
  /** ENU origin every grid east/north is measured from (first turnpoint's waypoint). */
  origin: { lat: number; lon: number };
}

// ---------------------------------------------------------------------------
// MetricComputer — the parallel-work interface
// ---------------------------------------------------------------------------

export type MetricFamily = 'climbing' | 'gliding' | 'decision' | 'gaggle' | 'racecraft' | 'day';

/**
 * Expected relationship to GAP rank: 'higher' = a larger value should mean a
 * better (numerically lower) rank; 'neutral' = no prior, the Spearman sign
 * itself is the finding.
 */
export type MetricDirection = 'higher' | 'lower' | 'neutral';

/**
 * The metric's name written as the behaviour that WON, one phrasing per sign
 * of the correlation.
 *
 * A metric's own label is deliberately neutral, because which direction wins
 * is not a property of the metric — it is the sign of ρ on that task, and for
 * the twelve metrics whose {@link MetricDirection} is 'neutral' the engine
 * holds no prior at all. "Gliding wide of the optimal course line" separated
 * the field on Corryong 2026 open T2 at ρ = +0.80, meaning the pilots who
 * held the line won; a surface that presents that row as a winning behaviour
 * without flipping the words says the opposite of the finding.
 *
 * So a surface that CLAIMS a direction picks by sign:
 *
 *     ρ < 0  →  larger values went with better ranks  →  `more`
 *     ρ > 0  →  smaller values went with better ranks →  `less`
 *
 * Only the findings digest does that today. Every other surface — the
 * ranking tables, the family tables, the glossary, the CLI report — keeps the
 * neutral label, because each shows ρ and a diverging meter whose bar already
 * carries the sign.
 *
 * A side is OMITTED where no honest phrasing of it reads as a behaviour worth
 * naming (being out-climbed, departures that did not pay). Consumers fall back
 * to the neutral label there, and must do the same for a whole metric with no
 * `winning` at all — reports stored before this field existed are served while
 * they revalidate.
 */
export interface MetricWinningPhrasings {
  /** Use when ρ < 0: more of this metric went with better ranks. */
  more?: string;
  /** Use when ρ > 0: less of this metric went with better ranks. */
  less?: string;
}

export interface PilotMetricValue {
  /** Pairing key back to FieldContext.pilots. */
  trackFile: string;
  /** null = not applicable for this pilot (no thermals, never started, …). */
  value: number | null;
  /** Optional short per-pilot note, e.g. "3 low saves, deepest at 12% of band". */
  note?: string;
}

/**
 * A report table cell:
 *  - literal text; or
 *  - `{ t }` — a single instant (ISO 8601), rendered as a time of day; or
 *  - `{ from, to }` — an instant range, rendered as "13:05–14:30 AEDT".
 *
 * The CONSUMER formats the times in the reader's zone: the engine never bakes a
 * zone into the report, so the same report reads in competition time on the web
 * (frontend uses `comp.timezone`) and in the task's local time on the CLI
 * (`renderTaskAnalysis({ timeZone })`). See ./format-time.ts and the frontend's
 * `formatTimeOfDay` / `formatTimeRange`.
 */
export type ReportCell = string | { t: string } | { from: string; to: string };

/** A generic table a metric wants printed (horserace, waterfall, wind…). Cells
 * are text or `{ t }` instants — see {@link ReportCell}. */
export interface ReportTable {
  title: string;
  columns: { header: string; align: 'left' | 'right' }[];
  rows: ReportCell[][];
  footnotes?: string[];
}

/**
 * A structured numeric series a metric wants CHARTED — the data twin of an
 * extraTable, emitted alongside it (never instead: the table is the CLI's
 * rendering and the UI's accessible equivalent, so it always ships).
 *
 * Discriminated by `kind`. A consumer that doesn't recognise a kind must
 * ignore the series (an older UI in front of a newer engine degrades to the
 * tables). Values are raw numbers and times are ISO instants — presentation
 * (decimal places, time zone) stays with the consumer, same rule as
 * {@link ReportCell}.
 */
export interface ReportSeriesBase {
  /** Stable id, unique within the metric (e.g. 'race.time_behind.horserace'). */
  id: string;
  title: string;
}

/**
 * Categorical-x, one-line-per-pilot series (the horserace and the leg
 * waterfall). Every pilot's points array aligns to xLabels, with null = not
 * reached / leg not completed.
 */
export interface CategoricalReportSeries extends ReportSeriesBase {
  kind: 'horserace' | 'waterfall';
  /** Categorical x positions, in order (turnpoint or leg labels). */
  xLabels: string[];
  /** Unit of point values, in the metric unit vocabulary ('min', 's', …). */
  yUnit: string;
  /** One row per pilot with any data; points align to xLabels. */
  perPilot: { trackFile: string; points: (number | null)[] }[];
}

/**
 * Hourly wind — the data twin of the "Wind by hour" table. One point per
 * hour bucket that produced any circle wind estimate; `t` is the bucket's
 * hour-start instant (the bucket covers [t, t+1h)).
 */
export interface WindHourlySeries extends ReportSeriesBase {
  kind: 'wind-hourly';
  hours: { t: string; speedKmh: number; directionDeg: number; n: number }[];
  /** Combined wind over the whole task (the table's "Whole task" row) —
   * median magnitude, vector-mean direction (stats.ts combineWindEstimates). */
  wholeTask: { speedKmh: number; directionDeg: number; n: number } | null;
}

/**
 * Per-leg wind — the data twin of the "Wind by leg" table. Legs are in
 * course order.
 *
 * TWO windows per leg, and confusing them is the whole reason both are here.
 * `flownFrom`/`flownTo` bound when the FIELD WAS ON the leg (first entry to
 * last exit); `from`/`to` bound only the circles the wind was estimated from.
 * Glides produce no estimate, so the circling window can be a sliver of the
 * flown one — a final leg the leaders glide but one pilot thermals on gets a
 * two-minute circling window that, drawn alone, reads as the leg happening
 * before the leg preceding it. Circle attribution counts only legs a pilot
 * completed, so the circling window is always INSIDE the flown one.
 *
 * `n` counts circle estimates and `pilotsWithEstimates` the distinct pilots
 * behind them: a leg's wind can be one pilot's two minutes, and nothing else
 * in the row says so.
 */
export interface WindLegsSeries extends ReportSeriesBase {
  kind: 'wind-legs';
  legs: {
    label: string;
    /** Circling window — null when nobody circled there, in which case
     * speed/direction are null too and n is 0. */
    from: string | null;
    to: string | null;
    /**
     * Flown (occupancy) window over pilots who started and completed the
     * leg; null when nobody did. Optional so reports stored before
     * TASK_ANALYSIS_VERSION 17 still parse — a stale row is served while it
     * revalidates, so consumers must fall back to `from`/`to` without it.
     */
    flownFrom?: string | null;
    flownTo?: string | null;
    /** Pilots who flew the whole leg (the flown window's population). */
    pilotsOnLeg?: number;
    speedKmh: number | null;
    directionDeg: number | null;
    /** Circle wind-estimates behind this leg's figure. */
    n: number;
    /** Distinct pilots those estimates came from (see the note above). */
    pilotsWithEstimates?: number;
  }[];
}

/**
 * The quantile fan of a set of climb rates, in m/s, over `n` thermal uses.
 *
 * One sample is one pilot's average climb rate in one shared thermal, and the
 * samples are pooled UNWEIGHTED — a pilot who took four short climbs
 * contributes four samples, one who took a single long climb contributes one.
 * That is the same population the hourly buckets count, which is the point:
 * weighting by climb duration would make the whole-task figure describe a
 * different day from the hours beneath it.
 */
export interface ClimbQuantiles {
  p10: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
  n: number;
}

/**
 * Hourly climb-rate distribution — the data twin of the "Climb by hour"
 * table, with the full quantile fan (the table prints median and p90). All
 * rates are m/s; `t` is the bucket's hour-start instant.
 */
export interface ClimbHourlySeries extends ReportSeriesBase {
  kind: 'climb-hourly';
  hours: ({ t: string } & ClimbQuantiles)[];
  /**
   * The same fan over EVERY climb of the task, cut from one pooled sort —
   * never assembled from the hourly rows, because a quantile of quantiles is
   * not a quantile: the hours hold wildly different climb counts, so an
   * average of six hourly medians answers "what did a typical HOUR look like"
   * when the question is "what did a typical CLIMB look like".
   *
   * Null when the task has no shared thermals at all. Optional so reports
   * stored before TASK_ANALYSIS_VERSION 25 still parse — such a row is
   * served stale while it revalidates, so consumers must render without it.
   */
  wholeTask?: ClimbQuantiles | null;
}

/**
 * The day's timing marks — the data twin of the "Day timing" table, plus
 * the task's own clock (gates, launch window, deadline) so a chart can
 * anchor the field's behaviour to the race. All ISO instants.
 */
export interface DayTimingSeries extends ReportSeriesBase {
  kind: 'day-timing';
  /** The best-conditions one-hour window, null when there were no climbs. */
  bestHour: { from: string; to: string } | null;
  /** Every pilot's takeoff instant, ascending. */
  takeoffs: string[];
  /** Resolved start-gate instants, ascending ([] when the task has none). */
  startGates: string[];
  /** Launch-window open instant, null when the task doesn't define one. */
  launchOpen: string | null;
  /** Goal-deadline instant, null when the task doesn't define one. */
  deadline: string | null;
}

export type ReportSeries =
  | CategoricalReportSeries
  | WindHourlySeries
  | WindLegsSeries
  | ClimbHourlySeries
  | DayTimingSeries;

export interface MetricOutput {
  /**
   * One entry per FieldContext.pilots element. Entries are re-aligned by
   * trackFile during evaluation, so order mismatches are tolerated — but
   * every pilot must appear exactly once.
   */
  perPilot: PilotMetricValue[];
  /** Free-form lines printed under the family heading (field-level summaries). */
  fieldSummary?: string[];
  /** Rich tables printed after the family's per-pilot table. */
  extraTables?: ReportTable[];
  /** Structured twins of extraTables, for charting. Ignored by the CLI. */
  extraSeries?: ReportSeries[];
}

export interface MetricComputer {
  /** Stable id, family-prefixed: 'climb.shared_percentile', 'race.leg_time_lost', … */
  id: string;
  /** Full label, e.g. "Climb vs field (shared thermals)". */
  label: string;
  /** Column header in the family table (≤ 10 chars); falls back to a truncated label. */
  shortLabel?: string;
  /** 'pct' | 'm/s' | 's' | 'min' | 'km/h' | 'count' | 'ratio' | 'm'. */
  unit: string;
  family: MetricFamily;
  direction: MetricDirection;
  /** 1–2 sentence method description, printed once per report (explainability rule). */
  explanation: string;
  /**
   * True for metrics DERIVED FROM the race outcome (time behind the leader,
   * time lost vs the top ranks) rather than a flying behaviour. They correlate
   * with rank by construction, so every ranking surface presents them apart —
   * as eval sanity checks, never as behavioural findings — and they never set
   * a family's headline |ρ| or get auto-selected. Absent = behavioural.
   */
  outcome?: true;
  /**
   * The label rewritten as the winning behaviour, per sign of ρ. Absent on a
   * metric no surface ever claims a direction for (the outcome checks, and
   * the two day metrics with no per-pilot value).
   */
  winning?: MetricWinningPhrasings;
  /** Pure function of the field context. Must not mutate it. */
  compute(field: FieldContext): MetricOutput;
}

// ---------------------------------------------------------------------------
// Evaluation & report model
// ---------------------------------------------------------------------------

/**
 * How to read a correlation. 'strong'/'moderate'/'weak' are the |ρ| ≥ 0.5 /
 * ≥ 0.3 / below conventions — but only AFTER clearing the n-dependent noise
 * floor: 'within noise' means |ρ| is under what shuffled ranks produce 5% of
 * the time at this n, whatever its magnitude, and 'n too small' means fewer
 * than MIN_CORRELATION_N pilots entered at all.
 */
export type CorrelationVerdict = 'strong' | 'moderate' | 'weak' | 'within noise' | 'n too small';

/** Spearman correlation of a metric's values against GAP rank (rank 1 = best). */
export interface MetricCorrelation {
  metricId: string;
  /**
   * Signed ρ of (value, rank). Because rank 1 is best, a well-behaved
   * 'higher' metric shows NEGATIVE ρ and a 'lower' metric positive ρ.
   */
  rho: number;
  absRho: number;
  /** Pilots with a non-null value that entered the correlation. */
  n: number;
  /**
   * The α = 0.05 two-tailed critical |ρ| for this n ({@link
   * spearmanNoiseFloor}): below it, shuffled ranks do this well 5% of the
   * time. Optional so reports stored before the field existed still parse.
   */
  noiseFloor?: number;
  verdict: CorrelationVerdict;
}

/** One metric's computed output plus its correlation, ready to render. */
export interface MetricReport {
  id: string;
  label: string;
  shortLabel?: string;
  unit: string;
  family: MetricFamily;
  direction: MetricDirection;
  explanation: string;
  /** Outcome-derived sanity check, not a behaviour — see MetricComputer.outcome.
   * Optional so reports stored before the flag existed still parse (absent =
   * behavioural). */
  outcome?: true;
  /**
   * The label rewritten as the winning behaviour, per sign of ρ — see
   * {@link MetricWinningPhrasings}. Optional twice over: a metric may have no
   * directional phrasing at all, and reports stored before this field existed
   * are served while they revalidate. Consumers fall back to `label`.
   */
  winning?: MetricWinningPhrasings;
  /** Aligned to TaskAnalysisReport.pilots order. */
  perPilot: PilotMetricValue[];
  fieldSummary?: string[];
  extraTables?: ReportTable[];
  extraSeries?: ReportSeries[];
  /** Null when too few non-null values (< 3) or zero variance. */
  correlation: MetricCorrelation | null;
  /** Set when compute() threw — the report shows the failure instead of dying. */
  error?: string;
}

/**
 * How the field's airborne TIME divided between the three flight phases.
 *
 * Named for the measure, not the partition: a "phase split" over a set of
 * flights could as easily be a split of distance, and on a page full of
 * distance-derived metrics that ambiguity is live. Percentages here are
 * always seconds over seconds.
 *
 * This replaced the old `phaseCoveragePct` fact, which was 100% on every task
 * by construction: `partitionPhases` tiles takeoff→landing with no gaps and no
 * overlaps, so coverage restated its own invariant instead of describing the
 * day (that invariant is now guarded only by the phase-partition tests). The
 * split moves — a booming day is mostly glide, a broken one is mostly search —
 * so it characterises the conditions the metrics below were measured in.
 */
export interface FieldAirtimeSplit {
  /** Percentages of `airborneSeconds`; sum to 100. */
  climbPct: number;
  glidePct: number;
  searchPct: number;
  /**
   * Denominator: phase seconds summed over every analysed pilot. Equal to the
   * summed takeoff→landing time by the partition invariant above.
   */
  airborneSeconds: number;
}

/** Field-level facts printed in the report header. */
export interface TaskAnalysisBasis {
  pilotCount: number;
  gridStepSeconds: number;
  sharedThermalCount: number;
  /** Shared thermals used by ≥ 2 pilots. */
  multiPilotThermalCount: number;
  workingBandFloor: number;
  workingBandCeiling: number;
  workingBandFallback: boolean;
  /**
   * Optional so reports stored before TASK_ANALYSIS_VERSION 13 still parse —
   * those carry the retired `phaseCoveragePct` (≤ 10) or the same data under
   * its old name `phaseSplit` (11–12). A stale row is served while it
   * revalidates, so consumers must render without this.
   */
  airtimeSplit?: FieldAirtimeSplit;
  /**
   * When the field was flying: first takeoff → last landing across the
   * analysed pilots, as ISO instants. The CONSUMER renders the zone (comp
   * time on the web, task-local on the CLI) — same rule as {@link ReportCell},
   * the engine never bakes one in.
   *
   * Optional: added in TASK_ANALYSIS_VERSION 14, and stored reports from
   * before it are served stale while they revalidate.
   */
  analysisWindow?: { from: string; to: string };
  /**
   * How many of the {@link pilotCount} analysed pilots made goal — the day's
   * difficulty, in the terms pilots themselves use for it.
   *
   * It is the context every other reading on the page needs. Several
   * behaviours only separate the field on one kind of day: leaving a climb
   * while it still works pays on an easy day and makes no measurable
   * difference on a hard one, and flying wide of the course line REVERSES
   * sign — it costs on an easy day and goes with a better result on a hard
   * one, where the pilots deviating to hunt lift are the ones still airborne.
   * v27 accordingly tells the reader to read glide.extra_distance "against
   * how many pilots made goal"; before this field the page could not say what
   * that number was. (Issue #683; evidence from the archive sweep behind
   * #681.)
   *
   * Counted over the ANALYSED field, so the share is CHECKABLE against the
   * report it sits on: its denominator is the same `pilotCount` behind every
   * correlation here, and its numerator is countable in the per-pilot tables.
   * `scoreResult.pilotScores` was the alternative and is rejected — it can
   * hold pilots `buildFieldContext` dropped for having no usable fixes, so on
   * the CLI (which has no exclusion note) the report would state a
   * denominator larger than its own tables with nothing to explain the gap.
   *
   * The cost is a known, bounded disagreement with the sweep that produced
   * the goal-rate bands: audit-metric-conditions.ts measures
   * `goal / scores.length` over the SCORED field. Across the bundled comps
   * the goal COUNT is identical under both definitions on every task — only
   * the denominator moves, and only where tracks were unanalysable:
   * corryong-2021-open-t1 reads 52% here against the sweep's 47% (the
   * largest gap, and enough to cross a band edge), corryong-2026-open-t1 38%
   * against 36%, unungra-2020-open-t3 69% against 64%. In the BACKEND the
   * two coincide exactly, because task-analysis.ts filters `pilotScores` down
   * to the analysed set before calling buildFieldContext — so this only ever
   * bites a sweep run from the CLI.
   *
   * ESS rate is not published beside it: the two run ρ ≈ 0.99 over the
   * archive, so it would be the same fact twice, and goal is the one pilots
   * talk in.
   *
   * Optional: added in TASK_ANALYSIS_VERSION 28, and stored reports from
   * before it are served stale while they revalidate. **Zero is a real
   * reading** — a day nobody completed is the hardest kind there is — so a
   * consumer must test for `undefined`, never for falsiness.
   */
  goalCount?: number;
}

/**
 * The task's reconstructed thermals — shape summaries (no point clouds) of
 * every shared thermal enough pilots climbed in to measure. See
 * thermal-shape.ts for what a summary carries and how it is measured.
 */
export interface FieldThermalsSummary {
  /**
   * Chronological. Only shapes with ≥ 2 pilots and ≥ 3 altitude bands —
   * below that there is no cross-pilot structure worth drawing — and capped
   * by pilot count so one task cannot balloon the stored report.
   */
  shapes: import('./thermal-shape').ThermalShapeSummary[];
  /** How many qualifying shapes existed before the cap; equal to
   * shapes.length when nothing was dropped. The UI must say when it is
   * showing fewer than existed — no silent caps. */
  totalShapeCount: number;
}

export interface TaskAnalysisReport {
  basis: TaskAnalysisBasis;
  /** Rank order — every perPilot array is aligned to this. */
  pilots: { trackFile: string; pilotName: string; rank: number }[];
  /** Registry order. */
  metrics: MetricReport[];
  /**
   * Optional: added in TASK_ANALYSIS_VERSION 20, and stored reports from
   * before it are served stale while they revalidate — consumers must
   * render without it.
   */
  thermals?: FieldThermalsSummary;
}

// ---------------------------------------------------------------------------
// Whole-comp aggregation model
// ---------------------------------------------------------------------------

/** One task's inputs to the comp aggregate. */
export interface CompTaskResult {
  /** e.g. "Task 1 (2026-01-05)". */
  label: string;
  report: TaskAnalysisReport;
  /** trackFile → cross-task pilot key (see cli pilotKeyFor). */
  pilotKeyByTrackFile: Record<string, string>;
  /** Per-pilot totals for comp ranking. */
  totals: { trackFile: string; pilotName: string; totalScore: number }[];
}

export interface CompMetricAggregate {
  id: string;
  label: string;
  unit: string;
  direction: MetricDirection;
  /** Outcome-derived sanity check, not a behaviour — see MetricComputer.outcome. */
  outcome?: true;
  /** Signed per-task ρ, parallel to CompAnalysisReport.taskLabels (null = not computed). */
  perTaskRho: (number | null)[];
  /**
   * Per-task correlation summary, parallel to taskLabels (null = no
   * correlation on that task). noiseFloor is the α = 0.05 critical |ρ| for
   * that task's n — a task is "informative" when |rho| clears it.
   */
  perTaskCorrelation: ({ rho: number; n: number; noiseFloor: number } | null)[];
  /** n-weighted mean |ρ| across tasks; null when no task produced one. */
  meanAbsRho: number | null;
  /**
   * n-weighted mean of SIGNED per-task ρ; null when no task produced one.
   * Flip-flopping tasks cancel here, so |meanSignedRho| ranks consistent
   * separation while meanAbsRho ranks per-day power regardless of
   * direction — the gap between them is the day-dependence signal.
   */
  meanSignedRho: number | null;
  /** Sign counts over informative tasks (|ρ| ≥ that task's noise floor). */
  signSummary: SignSummary;
  /** Classification of signSummary — the finding, not a warning. */
  consistency: SignConsistency;
  /** Correlation of per-pilot cross-task metric means vs comp rank. */
  compRho: MetricCorrelation | null;
}

/** Sign counts across a metric's informative tasks. */
export interface SignSummary {
  /** Informative tasks with ρ < 0 (larger value ↔ better rank). */
  negative: number;
  /** Informative tasks with ρ > 0 (larger value ↔ worse rank). */
  positive: number;
  /** Tasks whose |ρ| sat under their noise floor (signs not counted). */
  quiet: number;
}

/**
 * How a metric's informative per-task signs read across the comp:
 *  - 'consistent': ≥ 2 informative tasks, all one sign — a trait signal.
 *  - 'leaning': a ≥ 2:1 majority one way.
 *  - 'split': near-even — the payoff depended on the day (the most
 *    interesting outcome, not a failure).
 *  - 'quiet': fewer than 2 informative tasks; nothing to read.
 */
export type SignConsistency = 'consistent' | 'leaning' | 'split' | 'quiet';

export interface CompAnalysisReport {
  taskLabels: string[];
  /** Comp scores: total score across tasks, rank 1 = best. */
  pilots: { key: string; name: string; taskCount: number; totalScore: number; rank: number }[];
  /** Registry order (union across tasks, first-seen order). */
  metrics: CompMetricAggregate[];
}
