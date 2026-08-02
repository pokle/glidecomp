// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Altitude cleaning: repair GPS altitude glitches using physical plausibility
 * instead of trusting the raw GNSS channel.
 *
 * Why: across 3.7M archive fixes, transient GNSS glitches (altitude jumps
 * faster than any glider can fly, returning within a few fixes) outnumber
 * zero-dropouts ~80:1, and every zero-dropout in that sample carried the
 * B-record "A" (valid) flag — the format's own validity signal is useless in
 * practice. A plain "0 means missing" rule also can't tell a dropout from a
 * genuine sea-level fix at a coastal site.
 *
 * How: the B-record carries two altitude channels (GNSS + barometric) that
 * must track each other with a slowly-varying offset (QNH + geoid + ISA
 * temperature error — the last grows with altitude, which is why the
 * baseline below is a ROLLING median, not a global one). A genuine dive
 * moves both channels together, so the residual stays flat; a GPS glitch
 * moves only the GNSS channel, so the residual jumps. When only one channel
 * is alive there is no cross-check, and the fallback is pure rate physics:
 * an excursion entered faster than any glider descends or climbs, that
 * returns to the pre-excursion altitude within seconds, is a glitch.
 *
 * The raw channels on each fix are never modified — repairs land in
 * `IGCFix.cleanedAltitude`, which `fixAltitude()` prefers, and every repair
 * is reported with its time range so downstream surfaces can disclose
 * exactly what was touched (the explainability rule).
 */

import type { IGCFix } from './igc-parser';
import { SlidingMedian } from './sliding-median';

/** A glider cannot sustain vertical speed beyond this — spiral dives reach
 * ~25 m/s, freefall ~50. Anything faster between adjacent fixes is a
 * measurement artefact. */
const MAX_PLAUSIBLE_VERTICAL_MS = 40;

/** GNSS−baro residual departure from its rolling baseline that marks a GNSS
 * error. Real ISA/QNH drift moves the residual tens of metres over a whole
 * flight; within one ±60 s window it moves single-digit metres. */
const RESIDUAL_TOLERANCE_M = 150;

/** Half-width of the rolling residual-baseline window. */
const BASELINE_HALF_WINDOW_MS = 60_000;

/** A rate-detected excursion must return within this long to be a glitch —
 * anything longer is treated as real (or a logger restart) and left alone. */
const EXCURSION_MAX_MS = 30_000;

/** ...and must return to within this of the pre-excursion altitude. */
const EXCURSION_RETURN_TOLERANCE_M = 150;

/** A channel with more zeros than this fraction of fixes is dead (a
 * GPS-only logger writes pressure 0; a pressure-only logger writes GNSS 0). */
const DEAD_CHANNEL_ZERO_FRACTION = 0.5;

/** One contiguous run of repaired fixes. */
export interface AltitudeRepairRange {
  /** First and last repaired fix index (inclusive). */
  startIndex: number;
  endIndex: number;
  /** Fix times of the range bounds (epoch ms — serializes cleanly). */
  startTimeMs: number;
  endTimeMs: number;
  fixCount: number;
  /** Largest |raw − cleaned| in the range, metres. */
  maxCorrectionMeters: number;
  /** What flagged it: the GNSS-vs-baro cross-check, or the vertical-rate
   * excursion rule (single-channel tracks). */
  method: 'cross-channel' | 'rate';
}

export interface AltitudeCleaningReport {
  /** Fixes examined. */
  totalFixCount: number;
  /** Fixes whose altitude was repaired. */
  repairedFixCount: number;
  /** Contiguous repaired ranges, ascending. */
  ranges: AltitudeRepairRange[];
  /** True when both channels were alive and the cross-check ran. */
  crossChecked: boolean;
}

const EMPTY_REPORT: AltitudeCleaningReport = Object.freeze({
  totalFixCount: 0,
  repairedFixCount: 0,
  ranges: [],
  crossChecked: false,
});

/**
 * Detect and repair implausible altitudes, annotating `cleanedAltitude` on
 * repaired fixes (raw channels untouched). Idempotent; pure apart from the
 * annotations. Returns the repair report.
 */
export function cleanAltitudes(fixes: IGCFix[]): AltitudeCleaningReport {
  const n = fixes.length;
  if (n < 10) return { ...EMPTY_REPORT, totalFixCount: n };

  let zeroGnss = 0;
  let zeroBaro = 0;
  for (const f of fixes) {
    if (f.gnssAltitude === 0) zeroGnss++;
    if (f.pressureAltitude === 0) zeroBaro++;
  }
  const gnssAlive = zeroGnss < n * DEAD_CHANNEL_ZERO_FRACTION;
  const baroAlive = zeroBaro < n * DEAD_CHANNEL_ZERO_FRACTION;

  if (gnssAlive && baroAlive) return crossChannelClean(fixes);
  // Single live channel (or none — tiny/degenerate tracks): no cross-check
  // possible, fall back to rate physics on the per-fix sentinel view.
  return rateClean(fixes);
}

/** The raw per-fix altitude view the rest of the engine used before
 * cleaning existed: GNSS unless the zero sentinel, then pressure. */
function rawAltitude(fix: IGCFix): number {
  return fix.gnssAltitude !== 0 ? fix.gnssAltitude : fix.pressureAltitude;
}

// ---------------------------------------------------------------------------
// Cross-channel path — both altimeters alive
// ---------------------------------------------------------------------------

function crossChannelClean(fixes: IGCFix[]): AltitudeCleaningReport {
  const n = fixes.length;
  const times = fixes.map((f) => f.time.getTime());

  // Residuals where both channels report; NaN marks unusable samples.
  const residual = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    residual[i] =
      fixes[i].gnssAltitude !== 0 && fixes[i].pressureAltitude !== 0
        ? fixes[i].gnssAltitude - fixes[i].pressureAltitude
        : NaN;
  }

  // Rolling median of the residual over ±60 s. A median tolerates glitch
  // bursts (well under half a window) without chasing them.
  //
  // The median is maintained incrementally: both window ends only ever move
  // forward, so each residual is added once and removed once — O(N log N)
  // however the timestamps are distributed. Rebuilding and sorting the window
  // per fix was O(N² log N) when degenerate timestamps (every fix stamped the
  // same second) made every window span the whole track: a crafted IGC file
  // became a per-upload CPU sink (issue #470, SEC-32). The structure yields
  // the exact order statistics the sort produced, so cleaned altitudes are
  // unchanged on every input.
  //
  // The live multiset is always { j ∈ [lo, hi) : residual[j] not NaN }. With
  // non-monotone timestamps lo can overtake hi (the old loop then read an
  // empty window); the lo<hi / hi>=lo guards reproduce that: an index skipped
  // because hi < lo can never enter a later window (lo never decreases), so
  // it is correctly never removed either.
  const corrections = new Map<number, number>(); // index → cleaned altitude
  const med = new SlidingMedian(residual);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    while (lo < n && times[lo] < times[i] - BASELINE_HALF_WINDOW_MS) {
      if (lo < hi && !Number.isNaN(residual[lo])) med.remove(residual[lo]);
      lo++;
    }
    while (hi < n && times[hi] <= times[i] + BASELINE_HALF_WINDOW_MS) {
      if (hi >= lo && !Number.isNaN(residual[hi])) med.add(residual[hi]);
      hi++;
    }
    if (med.size() === 0) continue;
    const baseline =
      med.size() % 2 === 1 ? med.medianLow() : (med.medianLow() + med.medianHigh()) / 2;

    const f = fixes[i];
    if (f.pressureAltitude === 0) continue; // nothing to substitute with
    const isDropout = f.gnssAltitude === 0;
    const deviates =
      !isDropout && Math.abs(residual[i] - baseline) > RESIDUAL_TOLERANCE_M;
    if (isDropout || deviates) {
      corrections.set(i, f.pressureAltitude + baseline);
    }
  }

  return applyCorrections(fixes, corrections, 'cross-channel');
}

// ---------------------------------------------------------------------------
// Rate path — one live channel, no cross-check
// ---------------------------------------------------------------------------

function rateClean(fixes: IGCFix[]): AltitudeCleaningReport {
  const n = fixes.length;
  const alt = fixes.map(rawAltitude);
  const times = fixes.map((f) => f.time.getTime());
  const corrections = new Map<number, number>();

  let i = 1;
  while (i < n) {
    const dt = (times[i] - times[i - 1]) / 1000;
    if (dt <= 0) {
      i++;
      continue;
    }
    const rate = (alt[i] - alt[i - 1]) / dt;
    if (Math.abs(rate) <= MAX_PLAUSIBLE_VERTICAL_MS) {
      i++;
      continue;
    }
    // Implausible step at i: a glitch if the series returns near the
    // pre-step altitude soon; otherwise leave it alone (a sustained shift
    // could be a logger restart mid-retrieve — repairing it would invent
    // data).
    const base = alt[i - 1];
    let ret = -1;
    for (let j = i; j < n && times[j] - times[i - 1] <= EXCURSION_MAX_MS; j++) {
      // Non-forward time: corrupt ordering — stop so the scan stays bounded.
      // Never fires on non-decreasing times (a trigger needs dt > 0, so every
      // j ≥ i has times[j] ≥ times[i] > times[i-1]). With it, triggers whose
      // scans share a fix have strictly increasing base times inside one 30 s
      // span at the format's 1 s resolution, so ≤ ~31 scans touch any fix —
      // O(N) overall instead of quadratic on backwards-jumping timestamps.
      if (times[j] <= times[i - 1]) break;
      if (Math.abs(alt[j] - base) <= EXCURSION_RETURN_TOLERANCE_M) {
        ret = j;
        break;
      }
    }
    if (ret < 0) {
      i++;
      continue;
    }
    // Repair (i .. ret-1) by linear interpolation between the sound
    // endpoints i-1 and ret.
    const t0 = times[i - 1];
    const span = times[ret] - t0;
    for (let j = i; j < ret; j++) {
      const frac = span > 0 ? (times[j] - t0) / span : 0;
      corrections.set(j, base + (alt[ret] - base) * frac);
    }
    i = ret + 1;
  }

  return applyCorrections(fixes, corrections, 'rate');
}

// ---------------------------------------------------------------------------
// Shared: annotate fixes, build the report
// ---------------------------------------------------------------------------

function applyCorrections(
  fixes: IGCFix[],
  corrections: Map<number, number>,
  method: AltitudeRepairRange['method'],
): AltitudeCleaningReport {
  const indices = [...corrections.keys()].sort((a, b) => a - b);
  const ranges: AltitudeRepairRange[] = [];
  let range: AltitudeRepairRange | null = null;

  for (const i of indices) {
    const cleaned = corrections.get(i)!;
    fixes[i].cleanedAltitude = cleaned;
    const correction = Math.abs(rawAltitude(fixes[i]) - cleaned);
    // Runs separated by ≤ 2 sound fixes read as one incident.
    if (range && i - range.endIndex <= 3) {
      range.endIndex = i;
      range.endTimeMs = fixes[i].time.getTime();
      range.fixCount++;
      range.maxCorrectionMeters = Math.max(range.maxCorrectionMeters, correction);
    } else {
      range = {
        startIndex: i,
        endIndex: i,
        startTimeMs: fixes[i].time.getTime(),
        endTimeMs: fixes[i].time.getTime(),
        fixCount: 1,
        maxCorrectionMeters: correction,
        method,
      };
      ranges.push(range);
    }
  }

  return {
    totalFixCount: fixes.length,
    repairedFixCount: indices.length,
    ranges,
    crossChecked: method === 'cross-channel',
  };
}
