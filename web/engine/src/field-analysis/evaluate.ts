// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Field evaluation: run every registered metric over the FieldContext, then
 * Spearman-correlate each metric's per-pilot values against GAP rank. The
 * correlation ranking is the point of the whole exercise — it says which
 * behaviours actually separate the leaderboard, and therefore which metrics
 * deserve refinement.
 */

import { spearman } from './stats';
import { ALL_METRICS } from './registry';
import { airborneSeconds } from './context';
import type {
  CorrelationVerdict,
  FieldAnalysisBasis,
  FieldAnalysisReport,
  FieldContext,
  MetricComputer,
  MetricCorrelation,
  MetricOutput,
  MetricReport,
  PilotMetricValue,
} from './types';

/** Below this many paired values a correlation is shown but not trusted. */
export const MIN_CORRELATION_N = 8;

export function evaluateField(
  field: FieldContext,
  metrics: MetricComputer[] = ALL_METRICS,
): FieldAnalysisReport {
  const pilots = field.pilots.map((p) => ({
    trackFile: p.trackFile,
    pilotName: p.pilotName,
    rank: p.score.rank,
  }));

  const reports: MetricReport[] = metrics.map((m) => {
    let output: MetricOutput | null = null;
    let error: string | undefined;
    try {
      output = m.compute(field);
    } catch (err) {
      // A broken metric shows its failure in the report instead of killing
      // the whole analysis (and every other metric) with it.
      error = err instanceof Error ? err.message : String(err);
    }

    const perPilot = alignPerPilot(field, m.id, output?.perPilot ?? []);
    const correlation = correlate(m.id, perPilot, pilots.map((p) => p.rank));
    return {
      id: m.id,
      label: m.label,
      shortLabel: m.shortLabel,
      unit: m.unit,
      family: m.family,
      direction: m.direction,
      explanation: m.explanation,
      ...(m.outcome ? { outcome: true as const } : {}),
      perPilot,
      fieldSummary: output?.fieldSummary,
      extraTables: output?.extraTables,
      extraSeries: output?.extraSeries,
      correlation,
      ...(error !== undefined ? { error } : {}),
    };
  });

  return { basis: buildBasis(field), pilots, metrics: reports };
}

/**
 * Re-align a metric's perPilot array to FieldContext.pilots order by
 * trackFile. Tolerates any order; a missing pilot becomes null, a duplicate
 * or unknown trackFile is an authoring bug worth failing loudly on.
 */
function alignPerPilot(
  field: FieldContext,
  metricId: string,
  values: PilotMetricValue[],
): PilotMetricValue[] {
  const byTrack = new Map<string, PilotMetricValue>();
  for (const v of values) {
    if (byTrack.has(v.trackFile)) {
      throw new Error(`metric ${metricId}: duplicate perPilot entry for ${v.trackFile}`);
    }
    byTrack.set(v.trackFile, v);
  }
  const aligned = field.pilots.map(
    (p) => byTrack.get(p.trackFile) ?? { trackFile: p.trackFile, value: null },
  );
  for (const p of field.pilots) byTrack.delete(p.trackFile);
  if (byTrack.size > 0) {
    throw new Error(
      `metric ${metricId}: perPilot entries for unknown trackFiles: ${[...byTrack.keys()].join(', ')}`,
    );
  }
  return aligned;
}

function correlate(
  metricId: string,
  perPilot: PilotMetricValue[],
  ranks: number[],
): MetricCorrelation | null {
  const values: number[] = [];
  const pairedRanks: number[] = [];
  for (let i = 0; i < perPilot.length; i++) {
    const v = perPilot[i].value;
    if (v === null || !isFinite(v)) continue;
    values.push(v);
    pairedRanks.push(ranks[i]);
  }
  const n = values.length;
  const rho = spearman(values, pairedRanks);
  if (!isFinite(rho)) return null;
  const absRho = Math.abs(rho);
  const verdict: CorrelationVerdict =
    n < MIN_CORRELATION_N ? 'n too small' : absRho >= 0.5 ? 'strong' : absRho >= 0.3 ? 'moderate' : 'weak';
  return { metricId, rho, absRho, n, verdict };
}

function buildBasis(field: FieldContext): FieldAnalysisBasis {
  let coverageSum = 0;
  let coverageN = 0;
  for (const p of field.pilots) {
    const total = airborneSeconds(p);
    if (total <= 0) continue;
    let covered = 0;
    for (const ph of p.phases) covered += ph.durationSeconds;
    coverageSum += (covered / total) * 100;
    coverageN++;
  }
  return {
    pilotCount: field.pilots.length,
    gridStepSeconds: field.grid.stepSeconds,
    sharedThermalCount: field.sharedThermals.length,
    multiPilotThermalCount: field.sharedThermals.filter((s) => s.pilotCount >= 2).length,
    workingBandFloor: field.workingBand.floorMeters,
    workingBandCeiling: field.workingBand.ceilingMeters,
    workingBandFallback: field.workingBand.usedFallback,
    phaseCoveragePct: coverageN > 0 ? coverageSum / coverageN : 0,
  };
}
