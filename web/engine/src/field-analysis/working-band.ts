// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The day's usable altitude band, estimated from the whole field's climbing.
 *
 * Floor = p10 of every thermal ENTRY altitude, ceiling = p90 of every thermal
 * EXIT altitude — where the field actually started and stopped climbing, which
 * is what "low" and "high" mean to a competition pilot that day. Metrics
 * express altitudes as a fraction of this band so "dug out from 12% of band"
 * reads the same on a 1,500 m Corryong day and a 3,500 m alpine day.
 */

import type { IGCFix } from '../igc-parser';
import type { ThermalSegment } from '../event-types';
import { percentile } from './stats';

export interface WorkingBandHour {
  hourStartMs: number;
  floor: number;
  ceiling: number;
  samples: number;
}

export interface WorkingBand {
  floorMeters: number;
  ceilingMeters: number;
  /** ceiling − floor, floored at 1 so band fractions never divide by zero. */
  spanMeters: number;
  /** Thermal samples the estimate is built from. */
  sampleCount: number;
  /** True when < MIN_THERMAL_SAMPLES thermals existed and fix altitudes were used instead. */
  usedFallback: boolean;
  /** Per-hour floor/ceiling, ascending by hour; empty in fallback mode. */
  hourly: WorkingBandHour[];
  /** (alt − floor) / span, clamped to [−0.5, 1.5]. */
  bandFraction(altMeters: number): number;
}

/** Below this many field-wide thermals the band falls back to fix altitudes. */
const MIN_THERMAL_SAMPLES = 10;

/** Fallback mode samples every Nth fix — the p10/p90 doesn't need them all. */
const FALLBACK_FIX_STRIDE = 10;

interface PilotBandSpec {
  thermals: ThermalSegment[];
  fixes: IGCFix[];
}

export function estimateWorkingBand(pilots: PilotBandSpec[]): WorkingBand {
  const entries: number[] = [];
  const exits: number[] = [];
  const timed: { startMs: number; entry: number; exit: number }[] = [];
  for (const p of pilots) {
    for (const t of p.thermals) {
      const start = p.fixes[t.startIndex];
      if (!start) continue;
      entries.push(t.startAltitude);
      exits.push(t.endAltitude);
      timed.push({ startMs: start.time.getTime(), entry: t.startAltitude, exit: t.endAltitude });
    }
  }

  let floorMeters: number;
  let ceilingMeters: number;
  let usedFallback = false;
  let sampleCount = entries.length;
  let hourly: WorkingBandHour[] = [];

  if (entries.length >= MIN_THERMAL_SAMPLES) {
    floorMeters = percentile(entries.sort((a, b) => a - b), 10);
    ceilingMeters = percentile(exits.sort((a, b) => a - b), 90);
    hourly = buildHourly(timed);
  } else {
    // Too few thermals to define the band (a glide-out day, a tiny field):
    // fall back to the spread of fix altitudes. Metrics should note this.
    usedFallback = true;
    const alts: number[] = [];
    for (const p of pilots) {
      for (let i = 0; i < p.fixes.length; i += FALLBACK_FIX_STRIDE) {
        alts.push(p.fixes[i].gnssAltitude !== 0 ? p.fixes[i].gnssAltitude : p.fixes[i].pressureAltitude);
      }
    }
    sampleCount = alts.length;
    alts.sort((a, b) => a - b);
    floorMeters = percentile(alts, 10);
    ceilingMeters = percentile(alts, 90);
  }

  if (!isFinite(floorMeters)) floorMeters = 0;
  if (!isFinite(ceilingMeters)) ceilingMeters = floorMeters;
  const spanMeters = Math.max(1, ceilingMeters - floorMeters);
  const floor = floorMeters;

  return {
    floorMeters,
    ceilingMeters,
    spanMeters,
    sampleCount,
    usedFallback,
    hourly,
    bandFraction(altMeters: number): number {
      const f = (altMeters - floor) / spanMeters;
      return Math.min(1.5, Math.max(-0.5, f));
    },
  };
}

function buildHourly(timed: { startMs: number; entry: number; exit: number }[]): WorkingBandHour[] {
  const byHour = new Map<number, { entries: number[]; exits: number[] }>();
  for (const t of timed) {
    const hour = Math.floor(t.startMs / 3_600_000) * 3_600_000;
    let b = byHour.get(hour);
    if (!b) byHour.set(hour, (b = { entries: [], exits: [] }));
    b.entries.push(t.entry);
    b.exits.push(t.exit);
  }
  return [...byHour.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hourStartMs, b]) => ({
      hourStartMs,
      floor: percentile(b.entries.sort((x, y) => x - y), 10),
      ceiling: percentile(b.exits.sort((x, y) => x - y), 90),
      samples: b.entries.length,
    }));
}
