// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Scaffolding shared by the metric families — the per-pilot null shapes and
 * fix-time readers every computer spells out. Metric MATHS stays in each
 * family's file; only the boilerplate lives here.
 */

import type { IGCFix } from '../../igc-parser';
import type { FieldContext, PilotAnalysisContext, PilotMetricValue } from '../types';

/** A null (not-applicable) per-pilot value. */
export function na(p: PilotAnalysisContext): PilotMetricValue {
  return { trackFile: p.trackFile, value: null };
}

/** One null entry per pilot — the shape field-level metrics must return. */
export function allNullPerPilot(field: FieldContext): PilotMetricValue[] {
  return field.pilots.map(na);
}

/** Whole seconds as "5", anything else to one decimal ("2.5"). */
function formatSeconds(s: number): string {
  return Math.abs(s - Math.round(s)) < 0.05 ? String(Math.round(s)) : s.toFixed(1);
}

/**
 * Pilots whose logger records too seldom for a metric that reads fine
 * detail. Thinning 1 Hz tracks over the 187-task archive showed what each
 * such metric can stand before a coarse logger alone moves a pilot against
 * the field (docs/2026-10-20-logger-interval-evidence.md), so the metric
 * leaves them out — a null, never a guess — and says why.
 *
 * `excluded` holds the ready-made null entry (with its note) per trackFile;
 * `summaryLine` is the field-summary sentence, or null when nobody is out.
 */
export interface CoarseLoggerGate {
  excluded: Map<string, PilotMetricValue>;
  summaryLine: string | null;
}

/**
 * The slowest logger each detail-hungry metric still reads truly. Measured
 * with the seconds-based thermal detector, as the mean shift of a pilot
 * thinned from 1 s against an unthinned field, in percentile points:
 *   dolphin share, circle shape   2 s: −2, +6   5 s: −30, +33
 *   time to core, km per climb    2 s: +4, +4   5 s:  +9, +15
 * Dolphin share and circle shape read the circles themselves, so only a
 * 1–2 s logger shows them. Time to core and km per climb read the thermal
 * edges, which degrade slowly; 3–4 s loggers (3% of the archive) are kept.
 */
export const CIRCLE_DETAIL_MAX_INTERVAL_S = 2;
export const THERMAL_EDGE_MAX_INTERVAL_S = 4;

export function coarseLoggerGate(field: FieldContext, maxIntervalSeconds: number): CoarseLoggerGate {
  const excluded = new Map<string, PilotMetricValue>();
  const intervals: number[] = [];
  for (const p of field.pilots) {
    const s = p.fixIntervalSeconds;
    if (s === null || s <= maxIntervalSeconds) continue;
    intervals.push(s);
    excluded.set(p.trackFile, {
      trackFile: p.trackFile,
      value: null,
      note:
        `instrument records every ${formatSeconds(s)} s; ` +
        `this measure needs every ${formatSeconds(maxIntervalSeconds)} s or faster`,
    });
  }
  if (intervals.length === 0) return { excluded, summaryLine: null };
  const lo = formatSeconds(Math.min(...intervals));
  const hi = formatSeconds(Math.max(...intervals));
  const every = lo === hi ? `${lo} s` : `${lo}–${hi} s`;
  const summaryLine =
    intervals.length === 1
      ? `1 pilot left out: their instrument records a position only every ${every}, too seldom for this measure.`
      : `${intervals.length} pilots left out: their instruments record a position only every ${every}, too seldom for this measure.`;
  return { excluded, summaryLine };
}

/** Epoch ms of a fix. */
export function fixMs(f: IGCFix): number {
  return f.time.getTime();
}

/**
 * Epoch ms of the pilot's fix at `fixIndex`. The index-taking twin of
 * {@link fixMs}, for call sites that hold an index into a known-good range
 * rather than the fix itself.
 */
export function fixMsAt(p: PilotAnalysisContext, fixIndex: number): number {
  return p.fixes[fixIndex].time.getTime();
}
