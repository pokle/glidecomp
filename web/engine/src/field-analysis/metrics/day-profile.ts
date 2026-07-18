// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Day-profile metric family — what the DAY did, mostly field-level.
 *
 * #24 day.wind — per-circle wind estimates across all pilots, vector-averaged
 *     for the whole task, per UTC hour, and per speed-section leg.
 * #25 day.climb_by_hour — hourly median/p90 climb over every ThermalUse.
 * #26 day.launch_timing — per pilot, the share of airborne time spent in
 *     non-sinking air (did they fly the day's window?).
 *
 * See docs/2026-07-18-field-analysis-plan.md §"P6 day profile & wind".
 * Metrics read ONLY the FieldContext (contract in ../types.ts). All hour and
 * clock labels are UTC — deterministic, never the runtime's locale/timezone.
 */

import type {
  FieldContext,
  MetricComputer,
  PilotAnalysisContext,
  PilotMetricValue,
  ReportTable,
} from '../types';
import type { XCTask } from '../../xctsk-parser';
import { circularMeanWind, median, percentile, type WindSample } from '../stats';

const HOUR_MS = 3_600_000;

/** 30 s smoothing window and the "non-sinking" vario floor for #26. */
const SMOOTH_WINDOW_SECONDS = 30;
const NON_SINK_VARIO_MPS = -0.5;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** One null entry per pilot — the shape field-level metrics must return. */
function allNullPerPilot(field: FieldContext): PilotMetricValue[] {
  return field.pilots.map((p) => ({ trackFile: p.trackFile, value: null }));
}

/** Epoch ms of the start of the UTC hour containing `tMs`. */
function hourStartMs(tMs: number): number {
  return Math.floor(tMs / HOUR_MS) * HOUR_MS;
}

/** "13:00 UTC" for an hour-start epoch ms. Deterministic (UTC, no locale). */
function hourLabel(hourMs: number): string {
  return `${String(new Date(hourMs).getUTCHours()).padStart(2, '0')}:00 UTC`;
}

/** "13:07" (UTC clock time, no suffix — callers add "UTC" once per line). */
function clockLabel(tMs: number): string {
  const d = new Date(tMs);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** Short turnpoint label: SSS / ESS / GOAL / TP<n> (1-based over the task). */
function tpLabel(task: XCTask, taskIndex: number): string {
  const tp = task.turnpoints[taskIndex];
  if (tp?.type === 'SSS') return 'SSS';
  if (tp?.type === 'ESS') return 'ESS';
  if (taskIndex === task.turnpoints.length - 1) return 'GOAL';
  return `TP${taskIndex + 1}`;
}

function pushInto<K>(map: Map<K, WindSample[]>, key: K, sample: WindSample): void {
  const list = map.get(key);
  if (list) list.push(sample);
  else map.set(key, [sample]);
}

// ---------------------------------------------------------------------------
// #24 day.wind
// ---------------------------------------------------------------------------

interface CircleWindSample {
  sample: WindSample;
  /** Midpoint time of the circle, epoch ms. */
  tMs: number;
  pilot: PilotAnalysisContext;
}

/**
 * Every circle's wind estimate across the field, centre-drift preferred over
 * ground-speed modulation. One pass over each pilot's circles.
 */
function collectCircleWinds(field: FieldContext): CircleWindSample[] {
  const out: CircleWindSample[] = [];
  for (const pilot of field.pilots) {
    for (const c of pilot.circles.circles) {
      const est = c.windFromCenterDrift ?? c.windFromGroundSpeed;
      if (!est) continue;
      const start = pilot.fixes[c.startIndex];
      const end = pilot.fixes[c.endIndex];
      if (!start || !end) continue;
      const tMs = (start.time.getTime() + end.time.getTime()) / 2;
      out.push({ sample: { speed: est.speed, direction: est.direction }, tMs, pilot });
    }
  }
  return out;
}

/**
 * The speed-section leg (identified by its from-turnpoint task index) the
 * pilot occupied at `tMs`, from their turnpoint reaching times. Null before
 * SSS or after the pilot's last reaching (the leg in progress at landing was
 * never completed, so we can't bound it).
 */
function legIndexAt(pilot: PilotAnalysisContext, tMs: number): number | null {
  if (pilot.sssMs === null || tMs < pilot.sssMs) return null;
  const seq = pilot.score.turnpointResult.sequence;
  let last = -1;
  for (let i = 0; i < seq.length; i++) {
    if (seq[i].time.getTime() <= tMs) last = i;
    else break;
  }
  if (last < 0 || last >= seq.length - 1) return null;
  return seq[last].taskIndex;
}

/** A wind table row: Scope / Speed km/h (1 dp) / Dir ° FROM / n. */
function windRow(scope: string, samples: WindSample[]): string[] {
  const w = circularMeanWind(samples);
  return [
    scope,
    w ? (w.speed * 3.6).toFixed(1) : '—',
    w ? String(Math.round(w.direction) % 360) : '—',
    String(samples.length),
  ];
}

const dayWind: MetricComputer = {
  id: 'day.wind',
  label: 'Wind (task / hourly / per leg)',
  shortLabel: 'Wind',
  unit: 'km/h',
  family: 'day',
  direction: 'neutral',
  explanation:
    'Wind estimated from every pilot’s circling (centre drift preferred, ground-speed ' +
    'modulation as fallback), vector-averaged over the whole task, each UTC hour, and each ' +
    'speed-section leg. Field-level only — no per-pilot value.',
  compute(field) {
    const winds = collectCircleWinds(field);

    const rows: string[][] = [windRow('Task', winds.map((w) => w.sample))];

    // Per hour, by each circle's midpoint time.
    const byHour = new Map<number, WindSample[]>();
    for (const w of winds) pushInto(byHour, hourStartMs(w.tMs), w.sample);
    for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
      rows.push(windRow(hourLabel(h), byHour.get(h)!));
    }

    // Per speed-section leg, by where each circle's pilot was at that moment.
    const sssIndex = field.task.turnpoints.findIndex((tp) => tp.type === 'SSS');
    if (sssIndex >= 0) {
      const byLeg = new Map<number, WindSample[]>();
      for (const w of winds) {
        const legIndex = legIndexAt(w.pilot, w.tMs);
        if (legIndex !== null) pushInto(byLeg, legIndex, w.sample);
      }
      for (const leg of field.legs) {
        if (leg.fromTaskIndex < sssIndex) continue;
        const label = `${tpLabel(field.task, leg.fromTaskIndex)}→${tpLabel(field.task, leg.toTaskIndex)}`;
        rows.push(windRow(label, byLeg.get(leg.fromTaskIndex) ?? []));
      }
    }

    const table: ReportTable = {
      title: 'Wind (from circling drift)',
      columns: [
        { header: 'Scope', align: 'left' },
        { header: 'Speed (km/h)', align: 'right' },
        { header: 'Dir (°)', align: 'right' },
        { header: 'n', align: 'right' },
      ],
      rows,
      footnotes: [
        'Vector mean of per-circle wind estimates; centre-drift estimates preferred over ground-speed modulation.',
        'Dir is degrees the wind blows FROM (0° = north). Leg rows cover the speed section only.',
        'Read hour and leg rows against leg outcomes to spot e.g. a mid-task wind switch.',
      ],
    };

    return { perPilot: allNullPerPilot(field), extraTables: [table] };
  },
};

// ---------------------------------------------------------------------------
// #25 day.climb_by_hour
// ---------------------------------------------------------------------------

/**
 * Hourly buckets (UTC, by climb start time) of every pilot's thermal-use
 * average climb rate, singletons included. Shared with #26's field summary.
 */
function hourlyClimbBuckets(field: FieldContext): Map<number, number[]> {
  const buckets = new Map<number, number[]>();
  for (const shared of field.sharedThermals) {
    for (const use of shared.uses) {
      const h = hourStartMs(use.startMs);
      const list = buckets.get(h);
      if (list) list.push(use.avgClimbRate);
      else buckets.set(h, [use.avgClimbRate]);
    }
  }
  return buckets;
}

const dayClimbByHour: MetricComputer = {
  id: 'day.climb_by_hour',
  label: 'Climb by hour',
  shortLabel: 'Climb/hr',
  unit: 'm/s',
  family: 'day',
  direction: 'neutral',
  explanation:
    'All pilots’ thermal climbs bucketed by the UTC hour the climb started: median and ' +
    '90th-percentile average climb rate per hour show how the day’s lift developed. ' +
    'Field-level only — no per-pilot value.',
  compute(field) {
    const buckets = hourlyClimbBuckets(field);
    const rows: string[][] = [];
    for (const h of [...buckets.keys()].sort((a, b) => a - b)) {
      const rates = buckets.get(h)!;
      const sorted = [...rates].sort((a, b) => a - b);
      rows.push([
        hourLabel(h),
        median(rates).toFixed(1),
        percentile(sorted, 90).toFixed(1),
        String(rates.length),
      ]);
    }
    const table: ReportTable = {
      title: 'Climb by hour',
      columns: [
        { header: 'Hour', align: 'left' },
        { header: 'Median (m/s)', align: 'right' },
        { header: 'p90 (m/s)', align: 'right' },
        { header: 'n', align: 'right' },
      ],
      rows,
      footnotes: [
        'Average climb rate of every thermal use across the field, bucketed by climb start (UTC).',
      ],
    };
    return { perPilot: allNullPerPilot(field), extraTables: [table] };
  },
};

// ---------------------------------------------------------------------------
// #26 day.launch_timing
// ---------------------------------------------------------------------------

/**
 * Percentage of a pilot's sampled grid steps whose 30 s-smoothed vario is at
 * or above −0.5 m/s. Null when the pilot has no grid samples.
 */
function nonSinkingSharePct(field: FieldContext, pilot: PilotAnalysisContext): number | null {
  const samples = pilot.track.samples;
  const windowSteps = Math.max(1, Math.round(SMOOTH_WINDOW_SECONDS / field.grid.stepSeconds));
  const half = Math.floor(windowSteps / 2);
  let total = 0;
  let nonSinking = 0;
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i]) continue;
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(samples.length - 1, i + half); j++) {
      const s = samples[j];
      if (!s) continue;
      sum += s.vario;
      count++;
    }
    total++;
    if (sum / count >= NON_SINK_VARIO_MPS) nonSinking++;
  }
  if (total === 0) return null;
  return (100 * nonSinking) / total;
}

/** One line: best-conditions hour vs the field's takeoff-time spread. */
function launchTimingSummary(field: FieldContext): string {
  const buckets = hourlyClimbBuckets(field);
  let bestHour: number | null = null;
  let bestMedian = -Infinity;
  for (const h of [...buckets.keys()].sort((a, b) => a - b)) {
    const m = median(buckets.get(h)!);
    if (m > bestMedian) {
      bestMedian = m;
      bestHour = h;
    }
  }
  const conditions =
    bestHour !== null
      ? `Best conditions around ${hourLabel(bestHour)} (median climb ${bestMedian.toFixed(1)} m/s)`
      : 'No thermal data to pick a best-conditions hour';

  const takeoffs = field.pilots
    .filter((p) => p.fixes.length > 0 && p.fixes[p.takeoffIndex] !== undefined)
    .map((p) => p.fixes[p.takeoffIndex].time.getTime())
    .sort((a, b) => a - b);
  const spread =
    takeoffs.length > 0
      ? `takeoffs earliest ${clockLabel(takeoffs[0])}, median ${clockLabel(percentile(takeoffs, 50))}, ` +
        `latest ${clockLabel(takeoffs[takeoffs.length - 1])} UTC`
      : 'no takeoffs recorded';

  return `${conditions}; ${spread}.`;
}

const dayLaunchTiming: MetricComputer = {
  id: 'day.launch_timing',
  label: 'Time in non-sinking air',
  shortLabel: 'NonSink%',
  unit: 'pct',
  family: 'day',
  direction: 'higher',
  explanation:
    'Share of a pilot’s airborne time (on the shared grid) spent in non-sinking air — ' +
    '30 s-smoothed vario at or above −0.5 m/s. A low share suggests flying outside the ' +
    'day’s best window (launched too early or too late).',
  compute(field) {
    return {
      perPilot: field.pilots.map((p) => ({
        trackFile: p.trackFile,
        value: nonSinkingSharePct(field, p),
      })),
      fieldSummary: [launchTimingSummary(field)],
    };
  },
};

export const DAY_METRICS: MetricComputer[] = [dayWind, dayClimbByHour, dayLaunchTiming];
