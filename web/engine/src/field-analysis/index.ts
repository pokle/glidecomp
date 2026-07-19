// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

// Field analysis — per-task/per-comp behavioural metrics computed across a
// whole field of tracks. See docs/2026-07-18-field-analysis-plan.md.

export type {
  PilotAnalysisContext,
  LegInfo,
  FieldContext,
  MetricFamily,
  MetricDirection,
  PilotMetricValue,
  ReportTable,
  MetricOutput,
  MetricComputer,
  CorrelationVerdict,
  MetricCorrelation,
  MetricReport,
  FieldAnalysisBasis,
  FieldAnalysisReport,
  CompTaskResult,
  CompMetricAggregate,
  CompAggregateReport,
} from './types';
export { buildFieldContext, airborneSeconds, type BuildFieldContextOptions } from './context';
export { buildTimeGrid, sampleAt, stepFor, type ResampledSample, type ResampledTrack, type TimeGrid } from './resample';
export { clusterSharedThermals, DEFAULT_SHARED_THERMAL_OPTIONS, type SharedThermal, type SharedThermalOptions, type ThermalUse } from './shared-thermals';
export { partitionPhases, DEFAULT_PHASE_OPTIONS, type FlightPhase, type PhaseInterval, type PhasePartitionOptions } from './phase-partition';
export { estimateWorkingBand, type WorkingBand, type WorkingBandHour } from './working-band';
export { percentile, median, mean, rankWithTies, spearman, circularMeanWind, type WindSample, type MeanWind } from './stats';
export { evaluateField, MIN_CORRELATION_N } from './evaluate';
export { renderFieldReport, renderCompReport, formatMetricValue } from './report';
export { aggregateComp } from './aggregate';
export { ALL_METRICS, FAMILY_ORDER, FAMILY_LABELS } from './registry';
export { FIELD_ANALYSIS_VERSION } from './version';
