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
 * Metrics read ONLY the FieldContext (contract in ../types.ts). Times of day
 * are emitted as machine-readable instants (ReportCell `{ t: ISO }`), NEVER as
 * pre-formatted "HH:00 UTC" strings — the consumer (the web UI in comp time,
 * the CLI in the task's local time) renders them in the reader's zone.
 */

import type {
  FieldContext,
  MetricComputer,
  PilotAnalysisContext,
  PilotMetricValue,
  ReportCell,
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

/** A time-of-day report cell — an instant the consumer formats in its zone. */
function timeCell(tMs: number): ReportCell {
  return { t: new Date(tMs).toISOString() };
}

/**
 * Turnpoint label using the waypoint name, tagged with its role where it has a
 * special one: "ELLIOT (SSS)", "GOAL FIELD (GOAL)", or plain "KANGCK". Falls
 * back to "TP<n>" (1-based) when the waypoint has no name.
 */
function tpLabel(task: XCTask, taskIndex: number): string {
  const tp = task.turnpoints[taskIndex];
  const name = tp?.waypoint.name?.trim() || `TP${taskIndex + 1}`;
  const role =
    tp?.type === 'SSS'
      ? 'SSS'
      : tp?.type === 'ESS'
        ? 'ESS'
        : taskIndex === task.turnpoints.length - 1
          ? 'GOAL'
          : null;
  return role ? `${name} (${role})` : name;
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

/** Speed (km/h, 1 dp) / Dir (° FROM) / n cells for a set of wind samples. */
function windStats(samples: WindSample[]): [string, string, string] {
  const w = circularMeanWind(samples);
  return [
    w ? (w.speed * 3.6).toFixed(1) : '—',
    w ? String(Math.round(w.direction) % 360) : '—',
    String(samples.length),
  ];
}

/** A time-of-day range cell — the consumer renders it "13:05–14:30 AEDT". */
function rangeCell(fromMs: number, toMs: number): ReportCell {
  return { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() };
}

const WIND_METHOD_FOOTNOTE =
  'Vector mean of per-circle wind estimates (centre-drift preferred over ' +
  'ground-speed modulation); direction is degrees the wind blows FROM (0° = north).';

const dayWind: MetricComputer = {
  id: 'day.wind',
  label: 'Wind (by hour and by leg)',
  shortLabel: 'Wind',
  unit: 'km/h',
  family: 'day',
  direction: 'neutral',
  explanation:
    'Wind estimated from every pilot’s circling (centre drift preferred, ground-speed ' +
    'modulation as fallback), vector-averaged two ways: by hour of day (how the wind built ' +
    'and shifted through the day) and by speed-section leg (the wind each part of the course ' +
    'saw). Field-level only — no per-pilot value.',
  compute(field) {
    const winds = collectCircleWinds(field);

    // 1) By hour of day — a time view. The whole-task total leads as the
    // baseline the hourly rows vary around.
    const byHour = new Map<number, WindSample[]>();
    for (const w of winds) pushInto(byHour, hourStartMs(w.tMs), w.sample);
    const hourRows: ReportCell[][] = [['Whole task', ...windStats(winds.map((w) => w.sample))]];
    for (const h of [...byHour.keys()].sort((a, b) => a - b)) {
      hourRows.push([timeCell(h), ...windStats(byHour.get(h)!)]);
    }
    const byHourTable: ReportTable = {
      title: 'Wind by hour',
      columns: [
        { header: 'Period', align: 'left' },
        { header: 'Speed (km/h)', align: 'right' },
        { header: 'Dir (°)', align: 'right' },
        { header: 'n', align: 'right' },
      ],
      rows: hourRows,
      footnotes: [WIND_METHOD_FOOTNOTE, 'Hours are shown in the competition’s time zone.'],
    };

    const tables: ReportTable[] = [byHourTable];

    // 2) By speed-section leg — a course view. Each leg carries the time span
    // its estimates were drawn from, so a leg row is anchored in time.
    const sssIndex = field.task.turnpoints.findIndex((tp) => tp.type === 'SSS');
    if (sssIndex >= 0) {
      const byLeg = new Map<number, CircleWindSample[]>();
      for (const w of winds) {
        const legIndex = legIndexAt(w.pilot, w.tMs);
        if (legIndex === null) continue;
        const list = byLeg.get(legIndex);
        if (list) list.push(w);
        else byLeg.set(legIndex, [w]);
      }
      const legRows: ReportCell[][] = [];
      for (const leg of field.legs) {
        if (leg.fromTaskIndex < sssIndex) continue;
        const label = `${tpLabel(field.task, leg.fromTaskIndex)}→${tpLabel(field.task, leg.toTaskIndex)}`;
        const legWinds = byLeg.get(leg.fromTaskIndex) ?? [];
        const when: ReportCell = legWinds.length
          ? rangeCell(
              Math.min(...legWinds.map((w) => w.tMs)),
              Math.max(...legWinds.map((w) => w.tMs)),
            )
          : '—';
        legRows.push([label, when, ...windStats(legWinds.map((w) => w.sample))]);
      }
      tables.push({
        title: 'Wind by leg',
        columns: [
          { header: 'Leg', align: 'left' },
          { header: 'When', align: 'left' },
          { header: 'Speed (km/h)', align: 'right' },
          { header: 'Dir (°)', align: 'right' },
          { header: 'n', align: 'right' },
        ],
        rows: legRows,
        footnotes: [
          WIND_METHOD_FOOTNOTE,
          '“When” is the whole field’s circling window for the leg — from the first to the ' +
            'last circle wind-estimate any pilot logged while on it (the exact times behind ' +
            'that leg’s wind). Glides produce no estimate, so a leg no one circled on shows “—”.',
        ],
      });
    }

    return { perPilot: allNullPerPilot(field), extraTables: tables };
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
    'All pilots’ thermal climbs bucketed by the hour the climb started (labelled in the ' +
    'competition’s time zone): median and 90th-percentile average climb rate per hour show ' +
    'how the day’s lift developed. Field-level only — no per-pilot value.',
  compute(field) {
    const buckets = hourlyClimbBuckets(field);
    const rows: ReportCell[][] = [];
    for (const h of [...buckets.keys()].sort((a, b) => a - b)) {
      const rates = buckets.get(h)!;
      const sorted = [...rates].sort((a, b) => a - b);
      rows.push([
        timeCell(h),
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
        'Average climb rate of every thermal use across the field, bucketed by climb start; ' +
          'hours shown in the competition’s time zone.',
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

/**
 * Best-conditions hour vs the field's takeoff-time spread, as a small table of
 * time-of-day instants (rendered in the reader's zone by the consumer). Null
 * when there is neither thermal data nor a recorded takeoff.
 */
function launchTimingTable(field: FieldContext): ReportTable | null {
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

  const takeoffs = field.pilots
    .filter((p) => p.fixes.length > 0 && p.fixes[p.takeoffIndex] !== undefined)
    .map((p) => p.fixes[p.takeoffIndex].time.getTime())
    .sort((a, b) => a - b);

  const rows: ReportCell[][] = [];
  if (bestHour !== null) rows.push(['Best conditions', timeCell(bestHour)]);
  if (takeoffs.length > 0) {
    rows.push(['Earliest takeoff', timeCell(takeoffs[0])]);
    rows.push(['Median takeoff', timeCell(percentile(takeoffs, 50))]);
    rows.push(['Latest takeoff', timeCell(takeoffs[takeoffs.length - 1])]);
  }
  if (rows.length === 0) return null;

  return {
    title: 'Day timing',
    columns: [
      { header: '', align: 'left' },
      { header: 'Time', align: 'right' },
    ],
    rows,
    footnotes:
      bestHour !== null
        ? [`Best-conditions hour carries the day’s highest median climb (${bestMedian.toFixed(1)} m/s).`]
        : undefined,
  };
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
    const timing = launchTimingTable(field);
    return {
      perPilot: field.pilots.map((p) => ({
        trackFile: p.trackFile,
        value: nonSinkingSharePct(field, p),
      })),
      extraTables: timing ? [timing] : undefined,
    };
  },
};

export const DAY_METRICS: MetricComputer[] = [dayWind, dayClimbByHour, dayLaunchTiming];
