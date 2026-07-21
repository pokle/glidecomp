// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Field analysis — shared types and the MetricComputer contract.
 *
 * THIS FILE IS THE CONTRACT between the field-analysis foundation and the
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
 * (`renderFieldReport({ timeZone })`). See ./format-time.ts and the frontend's
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
  /** Vector mean over the whole task (the table's "Whole task" row). */
  wholeTask: { speedKmh: number; directionDeg: number; n: number } | null;
}

/**
 * Per-leg wind — the data twin of the "Wind by leg" table. Legs are in
 * course order; `from`/`to` bound the field's circling window on the leg
 * (null when nobody circled there, in which case speed/direction are null
 * too and n is 0).
 */
export interface WindLegsSeries extends ReportSeriesBase {
  kind: 'wind-legs';
  legs: {
    label: string;
    from: string | null;
    to: string | null;
    speedKmh: number | null;
    directionDeg: number | null;
    n: number;
  }[];
}

/**
 * Hourly climb-rate distribution — the data twin of the "Climb by hour"
 * table, with the full quantile fan (the table prints median and p90). All
 * rates are m/s; `t` is the bucket's hour-start instant.
 */
export interface ClimbHourlySeries extends ReportSeriesBase {
  kind: 'climb-hourly';
  hours: {
    t: string;
    p10: number;
    p25: number;
    median: number;
    p75: number;
    p90: number;
    n: number;
  }[];
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
  /** Pure function of the field context. Must not mutate it. */
  compute(field: FieldContext): MetricOutput;
}

// ---------------------------------------------------------------------------
// Evaluation & report model
// ---------------------------------------------------------------------------

export type CorrelationVerdict = 'strong' | 'moderate' | 'weak' | 'n too small';

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
  /** Aligned to FieldAnalysisReport.pilots order. */
  perPilot: PilotMetricValue[];
  fieldSummary?: string[];
  extraTables?: ReportTable[];
  extraSeries?: ReportSeries[];
  /** Null when too few non-null values (< 3) or zero variance. */
  correlation: MetricCorrelation | null;
  /** Set when compute() threw — the report shows the failure instead of dying. */
  error?: string;
}

/** Field-level facts printed in the report header. */
export interface FieldAnalysisBasis {
  pilotCount: number;
  gridStepSeconds: number;
  sharedThermalCount: number;
  /** Shared thermals used by ≥ 2 pilots. */
  multiPilotThermalCount: number;
  workingBandFloor: number;
  workingBandCeiling: number;
  workingBandFallback: boolean;
  /** Mean over pilots of (time in any phase) / (takeoff→landing time), %. */
  phaseCoveragePct: number;
}

export interface FieldAnalysisReport {
  basis: FieldAnalysisBasis;
  /** Rank order — every perPilot array is aligned to this. */
  pilots: { trackFile: string; pilotName: string; rank: number }[];
  /** Registry order. */
  metrics: MetricReport[];
}

// ---------------------------------------------------------------------------
// Whole-comp aggregation model
// ---------------------------------------------------------------------------

/** One task's inputs to the comp aggregate. */
export interface CompTaskResult {
  /** e.g. "Task 1 (2026-01-05)". */
  label: string;
  report: FieldAnalysisReport;
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
  /** Signed per-task ρ, parallel to CompAggregateReport.taskLabels (null = not computed). */
  perTaskRho: (number | null)[];
  /** n-weighted mean |ρ| across tasks; null when no task produced one. */
  meanAbsRho: number | null;
  /** Correlation of per-pilot cross-task metric means vs comp rank. */
  compRho: MetricCorrelation | null;
}

export interface CompAggregateReport {
  taskLabels: string[];
  /** Comp standings: total score across tasks, rank 1 = best. */
  pilots: { key: string; name: string; taskCount: number; totalScore: number; rank: number }[];
  /** Registry order (union across tasks, first-seen order). */
  metrics: CompMetricAggregate[];
}
