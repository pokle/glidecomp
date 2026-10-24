/**
 * Wire shapes of the task-analysis endpoints, plus re-exports of the
 * engine's own presentation helpers.
 *
 * The formatting helpers are re-exported rather than reimplemented so the UI
 * and the CLI's text report can never disagree about what a number means —
 * `formatMetricValue` is the single source of truth for decimal places per
 * unit, and FAMILY_ORDER/FAMILY_LABELS for how families are named and
 * sequenced.
 */
export {
  formatMetricValue,
  FAMILY_ORDER,
  FAMILY_LABELS,
  MIN_CORRELATION_N,
  // Style clustering is computed HERE, at read time, from the stored report —
  // the same pure function the CLI report uses, so the two can never
  // disagree about who flew alike.
  clusterPilotStyles,
  MIN_CLUSTER_PILOTS,
  // Cosine similarity between pilots over a chosen set of behaviours —
  // computed here at read time from the same stored report, like clustering.
  findSimilarPilots,
  similarityNoiseFloor,
  // The metric registry itself: the comp aggregate stores no method
  // descriptions, so the comp page's glossary reads them from here — the
  // same definitions the engine computes with.
  combineWindEstimates,
  ALL_METRICS,
} from "@glidecomp/engine";
export type {
  TaskAnalysisReport,
  TaskAnalysisBasis,
  FieldThermalsSummary,
  MetricReport,
  MetricFamily,
  MetricDirection,
  CorrelationVerdict,
  MetricCorrelation,
  CompAnalysisReport,
  CompMetricAggregate,
  SignSummary,
  SignConsistency,
  ReportCell,
  ReportTable,
  ReportSeries,
  CategoricalReportSeries,
  WindHourlySeries,
  WindLegsSeries,
  ClimbHourlySeries,
  DayTimingSeries,
  PilotMetricValue,
  StyleClusterReport,
  StyleCluster,
  StyleClusterMember,
  StyleSignature,
  UnclusteredPilot,
  SimilarityContribution,
  SimilarityRanking,
  SimilarPilot,
  PilotSimilarityReport,
} from "@glidecomp/engine";

import type {
  CompAnalysisReport,
  CompMetricAggregate,
  MetricCorrelation,
  MetricFamily,
  MetricReport,
  ReportCell,
  SignConsistency,
  TaskAnalysisReport,
} from "@glidecomp/engine";
import { formatTimeOfDay, formatTimeRange } from "../lib/time";

/** One pilot class's analysis, as the task endpoint serves it. */
export interface TaskAnalysisClassData {
  pilot_class: string;
  report: TaskAnalysisReport;
  pilot_key_by_track_file: Record<string, string>;
  totals: { trackFile: string; pilotName: string; totalScore: number }[];
  /** Pilots the analysis could not include (manual flights, unreadable
   * tracks). Surfaced so nobody reads the correlations as covering the
   * whole field. */
  excluded: { pilot_name: string; reason: string }[];
}

/** GET /api/comp/:comp_id/task/:task_id/analysis */
export interface TaskAnalysisData {
  task_id: string;
  comp_id: string;
  task_date?: string;
  classes: TaskAnalysisClassData[];
  computed_at: string | null;
  stale: boolean;
  /** No report stored yet — one is being computed in the background. */
  pending: boolean;
  /** Why there is no report and never will be for this task as it stands
   * (open distance, no tracks, too many tracks). */
  error: string | null;
}

/** GET /api/comp/:comp_id/analysis */
export interface CompAnalysisData {
  comp_id: string;
  comp_name: string;
  tasks: { task_id: string; task_name: string; task_date: string; label: string }[];
  task_labels: string[];
  classes: { pilot_class: string; aggregate: CompAnalysisReport }[];
  computed_at: string | null;
  stale: boolean;
  pending_task_count: number;
  total_task_count: number;
}

// ── Reading a report ────────────────────────────────────────────────────────


export interface RankedMetric {
  metric: MetricReport;
  correlation: MetricCorrelation;
}

/**
 * The behavioural ranking. Outcome-derived metrics (time behind the leader,
 * …) correlate with rank by construction, so they are excluded here — from
 * the headline table, the top-3 family auto-open, and the auto-selected
 * scatter — and presented apart as eval sanity checks.
 */
export function rankMetrics(metrics: MetricReport[]): RankedMetric[] {
  return metrics
    .filter((m) => !m.outcome)
    .flatMap((m) => (m.correlation ? [{ metric: m, correlation: m.correlation }] : []))
    .sort((a, b) => b.correlation.absRho - a.correlation.absRho);
}

/** The strongest correlation among a set of metrics — the badge on each
 * family, which needs the whole correlation (not just |ρ|) to name its
 * verdict. Outcome-derived metrics don't count: a family must not owe its
 * headline to a metric that correlates by construction. */
export function bestCorrelation(metrics: MetricReport[]): MetricCorrelation | null {
  return metrics.reduce<MetricCorrelation | null>((best, m) => {
    if (!m.correlation || m.outcome) return best;
    return best === null || m.correlation.absRho > best.absRho ? m.correlation : best;
  }, null);
}

/** Group a report's metrics by family, preserving registry order. */
export function metricsByFamily(metrics: MetricReport[]): Map<MetricFamily, MetricReport[]> {
  const map = new Map<MetricFamily, MetricReport[]>();
  for (const m of metrics) {
    const list = map.get(m.family) ?? [];
    list.push(m);
    map.set(m.family, list);
  }
  return map;
}

/**
 * The behaviour written as the thing that WON.
 *
 * The ranking orders by |ρ|, so neither it nor the verdict says which WAY a
 * behaviour won — and a neutral label under the words "winning strategies"
 * can assert the exact opposite of the finding. ρ < 0 means larger values
 * went with better ranks. Falls back to the neutral label when a metric has
 * no wording for that side, and on any report stored before the field
 * existed.
 */
export function winningLabel(metric: Pick<MetricReport, "label" | "winning">, rho: number): string {
  return (rho < 0 ? metric.winning?.more : metric.winning?.less) ?? metric.label;
}

/** Verdicts loud enough to name a winning strategy: weak and above. */
export const STRATEGY_VERDICTS: ReadonlySet<string> = new Set(["strong", "moderate", "weak"]);


/**
 * A report table cell as text: literal text as it is, an instant as a time
 * of day and a range as "13:05–14:30 AEDT", in the competition's zone — the
 * engine never bakes a zone into a report, so the reader's page chooses it.
 */
export function reportCellText(cell: ReportCell, timeZone: string | null): string {
  const tz = timeZone ?? undefined;
  if (typeof cell === "string") return cell;
  if ("t" in cell) return formatTimeOfDay(cell.t, tz);
  return formatTimeRange(cell.from, cell.to, tz);
}

/** "ρ −0.62": the signed coefficient, two places, a real minus sign. */
export function rhoText(rho: number): string {
  return `ρ ${rho < 0 ? "−" : ""}${Math.abs(rho).toFixed(2)}`;
}

// ── The competition analysis ─────────────────────────────────────────────────


/** Has this behaviour a coefficient anywhere — on a task, or against the comp scores? */
export function hasAnyCorrelation(m: CompMetricAggregate): boolean {
  return m.compRho !== null || m.perTaskRho.some((rho) => rho !== null);
}

/**
 * The comp analysis's three lists. Behaviours rank by |mean signed ρ|, so
 * days that pull opposite ways cancel and CONSISTENT separation leads (the
 * CLI's comp report orders the same way); outcome checks rank apart, as on
 * the task page; the day-describing metrics with no per-pilot value have no
 * row at all and are only counted.
 */
export function compAnalysisRows(aggregate: CompAnalysisReport): {
  ranked: CompMetricAggregate[];
  outcomes: CompMetricAggregate[];
  uncorrelated: CompMetricAggregate[];
} {
  const strength = (m: CompMetricAggregate) => (m.meanSignedRho === null ? -1 : Math.abs(m.meanSignedRho));
  const correlated = aggregate.metrics.filter(hasAnyCorrelation).sort((a, b) => strength(b) - strength(a));
  return {
    ranked: correlated.filter((m) => !m.outcome),
    outcomes: correlated.filter((m) => m.outcome),
    uncorrelated: aggregate.metrics.filter((m) => !hasAnyCorrelation(m)),
  };
}

/**
 * The consistency verdict in words. `quiet` says HOW few tasks were clear:
 * "no clear task" and "one clear task only" are different situations for a
 * reader deciding whether to believe the row.
 */
export function consistencyWords(consistency: SignConsistency, informative: number): string {
  switch (consistency) {
    case "consistent":
      return "same way each task";
    case "leaning":
      return "mostly one way";
    case "split":
      return "depended on the day";
    default:
      return informative === 0 ? "no clear task" : "one clear task only";
  }
}
