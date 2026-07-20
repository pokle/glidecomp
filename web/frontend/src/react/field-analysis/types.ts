/**
 * Wire shapes of the field-analysis endpoints, plus re-exports of the
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
  // The metric registry itself: the comp aggregate stores no method
  // descriptions, so the comp page's glossary reads them from here — the
  // same definitions the engine computes with.
  ALL_METRICS,
} from "@glidecomp/engine";
export type {
  FieldAnalysisReport,
  FieldAnalysisBasis,
  MetricReport,
  MetricFamily,
  MetricDirection,
  MetricCorrelation,
  CompAggregateReport,
  CompMetricAggregate,
  ReportCell,
  ReportTable,
  ReportSeries,
  CategoricalReportSeries,
  WindHourlySeries,
  WindLegsSeries,
  ClimbHourlySeries,
  DayTimingSeries,
  PilotMetricValue,
} from "@glidecomp/engine";

import type { FieldAnalysisReport, CompAggregateReport } from "@glidecomp/engine";

/** One pilot class's analysis, as the task endpoint serves it. */
export interface FieldAnalysisClassData {
  pilot_class: string;
  report: FieldAnalysisReport;
  pilot_key_by_track_file: Record<string, string>;
  totals: { trackFile: string; pilotName: string; totalScore: number }[];
  /** Pilots the analysis could not include (manual flights, unreadable
   * tracks). Surfaced so nobody reads the correlations as covering the
   * whole field. */
  excluded: { pilot_name: string; reason: string }[];
}

/** GET /api/comp/:comp_id/task/:task_id/field-analysis */
export interface TaskFieldAnalysisData {
  task_id: string;
  comp_id: string;
  task_date?: string;
  classes: FieldAnalysisClassData[];
  computed_at: string | null;
  stale: boolean;
  /** No report stored yet — one is being computed in the background. */
  pending: boolean;
  /** Why there is no report and never will be for this task as it stands
   * (open distance, no tracks, too many tracks). */
  error: string | null;
}

/** GET /api/comp/:comp_id/field-analysis */
export interface CompFieldAnalysisData {
  comp_id: string;
  comp_name: string;
  tasks: { task_id: string; task_name: string; task_date: string; label: string }[];
  task_labels: string[];
  classes: { pilot_class: string; aggregate: CompAggregateReport }[];
  computed_at: string | null;
  stale: boolean;
  pending_task_count: number;
  total_task_count: number;
}
