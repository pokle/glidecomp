/**
 * Leading-coefficient scoring (FAI S7F 2026 §12.3).
 *
 * The whole leading pipeline: the §12.3.1 weight envelope and its exact
 * closed-form integral, the per-pilot tracklog scan
 * ({@link computeLeadingAggregate} — the expensive, cacheable half), the
 * field-level clock ({@link resolveLeadingMaxTime}), the fold that combines
 * them into a coefficient ({@link combineLeadingCoefficient}), and the
 * leading-points formula ({@link calculateLeadingPoints}). Split out of
 * ./gap-formulas so that module keeps to the per-component validity and
 * point formulas; the whole-field orchestration lives in ./gap-scoring,
 * which re-exports everything here, so the public surface and existing
 * imports are unchanged.
 */

import type { XCTask } from './xctsk-parser';
import type { IGCFix } from './igc-parser';
import type { TurnpointReaching } from './turnpoint-sequence';
import { getEffectiveSSSIndex, getEffectiveESSIndex } from './xctsk-parser';
import { getOptimizedSegmentDistances } from './task-optimizer';
import { resolveStartGates } from './time-gates';
import { ellipsoidDistance } from './geo';
import type { LeadingFormula } from './gap-params';

// Leading-area weighting envelope (S7F 2026 §12.3.1, PG). Written here in
// terms of the REMAINING fraction p = minToESS / speedSectionDistance; the
// spec writes weight(v) over the done fraction v = 1 − p, with
// weight(v) = weightRising(1 − v) · weightFalling(1 − v) — the same curve.
// At p≈1 (just left SSS) and p≈0 (at ESS) the weight is ~0; it peaks in the
// middle, so leading is rewarded most for being out front mid-course.
function weightRising(p: number): number {
  return Math.pow(1 - Math.pow(10, 9 * p - 9), 5);
}
function weightFalling(p: number): number {
  return Math.pow(1 - Math.pow(10, -3 * p), 2);
}
/**
 * The §12.3.1 leading-weight envelope at remaining fraction p — exported for
 * the derivative check in tests ({@link leadWeightIntegral} must integrate
 * exactly this curve) and for the report card's chart sampling.
 */
export function leadWeight(p: number): number {
  return weightRising(p) * weightFalling(p);
}

// Binomial coefficients of (1 − u)^5 and (1 − v)^2 — the envelope expands
// into 18 exponential terms, so its integral has an exact closed form.
const RISING_COEFFS = [1, -5, 10, -10, 5, -1];
const FALLING_COEFFS = [1, -2, 1];
const LN10 = Math.LN10;

/**
 * Cumulative integral of the leading-weight envelope over the remaining
 * fraction: W(p) = ∫₀^p leadWeight(q) dq, exactly.
 *
 * The §12.3.1 leadingArea integrates weight(x) over the DONE fraction x;
 * with x = 1 − q that interval integral is a difference of this cumulative:
 * ∫_{done(prev)}^{done(cur)} weight(x) dx = W(p_prev) − W(p_cur), where
 * p = minToESS / speedSectionDistance at each end.
 *
 * Derivation: leadWeight(q) = (1 − 10^{9q−9})⁵ · (1 − 10^{−3q})² expands to
 * Σⱼₖ aⱼbₖ · 10^{−9j} · 10^{(9j−3k)q}; each term integrates to
 * 10^{(9j−3k)q} / ((9j−3k)·ln10) except the (0,0) constant term, which
 * integrates to q. Exact and deterministic — no quadrature error to move a
 * score between runs.
 */
export function leadWeightIntegral(p: number): number {
  const q = Math.min(1, Math.max(0, p));
  let total = 0;
  for (let j = 0; j <= 5; j++) {
    for (let k = 0; k <= 2; k++) {
      const c = RISING_COEFFS[j] * FALLING_COEFFS[k] * Math.pow(10, -9 * j);
      const alpha = 9 * j - 3 * k;
      if (alpha === 0) {
        total += c * q;
      } else {
        const scale = alpha * LN10;
        total += (c * (Math.pow(10, alpha * q) - 1)) / scale;
      }
    }
  }
  return total;
}

/**
 * The field-independent part of a pilot's leading coefficient.
 *
 * The leading coefficient depends on the whole field only through two
 * scalars — the first pilot's start time and the last pilot's ESS time.
 * Everything else is a single-pilot tracklog scan. {@link computeLeadingAggregate}
 * does that scan once and captures the per-pilot pieces here, so the backend
 * can cache it per track and {@link combineLeadingCoefficient} can fold in the
 * field scalars cheaply — no re-scan when another pilot uploads.
 *
 * Plain numbers/booleans only, so it JSON round-trips losslessly.
 */
export interface LeadingAggregate {
  /** false → pilot never started / had no in-window fixes; LC is Infinity. */
  valid: boolean;
  /** Speed-section length along the optimized course (km). */
  ssKm: number;
  /** Best (minimum) distance-to-ESS reached along the course (km). */
  bestDistKm: number;
  /** Whether the pilot reached ESS (drives the land-out tail term). */
  reachedESS: boolean;
  /** Pilot's own SSS reaching time (epoch ms). */
  pilotSSSMs: number;
  /**
   * Time of the pilot's last fix (epoch ms) — when the pilot didn't reach
   * ESS this is their outlanding time, which the field's §12.3.1 `maxTime`
   * is the latest of (see {@link resolveLeadingMaxTime}).
   */
  lastFixMs: number;
  /**
   * weighted (S7F 2026 §12.3.1): Σ minToESSᵢ·ΔWᵢ·(tᵢ − pilotSSS), where ΔWᵢ
   * is the exact weight-envelope integral over the done-fraction interval —
   * summed against the pilot's OWN start so the epoch-second terms stay
   * small (no catastrophic cancellation). combineLeadingCoefficient
   * re-references it to the field's first start.
   */
  weightedTimeSum: number;
  /** weighted: Σ minToESSᵢ·ΔWᵢ — the multiplier for the start-time shift. */
  weightedDeltaSum: number;
  /** classic: the field-independent Σ (already referenced to the pilot's own start). */
  classicSum: number;
}

/**
 * Scan one pilot's tracklog and capture the field-independent pieces of the
 * leading coefficient (see {@link LeadingAggregate}). This is the expensive
 * per-fix pass; it is independent of the rest of the field, so it can be
 * computed once and cached.
 *
 * @param fixes - Pilot's tracklog fixes (time-ordered)
 * @param task - The competition task (already trimmed for the distance origin)
 * @param sequence - The pilot's resolved turnpoint reachings (for progress)
 * @param pilotSSSTime - The pilot's own start time (ms), or null if no start
 * @param pilotESSTime - The pilot's ESS time (ms), or null if not reached
 * @param formula - 'weighted' (modern default) or 'classic'
 */
export function computeLeadingAggregate(
  fixes: IGCFix[],
  task: XCTask,
  sequence: TurnpointReaching[],
  pilotSSSTime: number | null,
  pilotESSTime: number | null,
  formula: LeadingFormula = 'weighted',
): LeadingAggregate {
  const invalid: LeadingAggregate = {
    valid: false, ssKm: 0, bestDistKm: 0,
    reachedESS: pilotESSTime !== null,
    pilotSSSMs: pilotSSSTime ?? 0, lastFixMs: 0,
    weightedTimeSum: 0, weightedDeltaSum: 0, classicSum: 0,
  };

  const essIdx = getEffectiveESSIndex(task);
  const sssIdx = Math.max(0, getEffectiveSSSIndex(task));
  // Pilots who never started get the worst possible LC.
  if (essIdx <= sssIdx || fixes.length === 0 || pilotSSSTime === null) {
    return invalid;
  }

  // Optimized along-course distance from each turnpoint to ESS (meters).
  const segs = getOptimizedSegmentDistances(task);
  const cumToESS: number[] = new Array(essIdx + 1).fill(0);
  for (let j = essIdx - 1; j >= 0; j--) {
    cumToESS[j] = cumToESS[j + 1] + segs[j];
  }
  const ssKm = cumToESS[sssIdx] / 1000; // speed-section length (km)
  if (ssKm <= 0) return invalid;

  // Reaching time per task index, so we know which turnpoint the pilot is
  // flying toward at each fix (the next un-reached one before ESS).
  const reachTime: Array<number | undefined> = [];
  for (const r of sequence) reachTime[r.taskIndex] = r.time.getTime();

  // Reference times to the pilot's OWN start. For classic this is exactly the
  // spec's time origin; for weighted it keeps the summed terms small and is
  // rebased to the field's first start in combineLeadingCoefficient.
  const pilotSSSSec = pilotSSSTime / 1000;
  const endTime = pilotESSTime ?? Infinity;

  // §12.3.1/§12.2: in a gated race the leading clock starts at the first
  // gate. An early ("jump the gun") starter's own SSS crossing precedes it,
  // so once combineLeadingCoefficient rebases the sum to the gate their
  // pre-gate progress would contribute NEGATIVE time — driving their LC
  // below every honest leader's and, at LC ≤ 0, zeroing the whole field's
  // leading points. Clamp each fix's time at the first gate so pre-gate
  // progress counts as happening at gate-open. Gates resolve from the task
  // alone (the pilot's own crossing just anchors them on the right day), so
  // this stays field-independent and cacheable.
  const gates = resolveStartGates(task, pilotSSSTime);
  const clockStartMs = gates ? gates[0] : -Infinity;

  let prevBestKm = ssKm; // best_dist_to_ess ratchet, starts at full SS length
  let weightedTimeSum = 0;
  let weightedDeltaSum = 0;
  let classicSum = 0;
  let nextReq = Math.min(sssIdx + 1, essIdx);
  let prevDistKm: number | null = null;

  for (const fix of fixes) {
    const tms = fix.time.getTime();
    if (tms < pilotSSSTime) continue;
    if (tms > endTime) break;

    // Advance to the next un-reached required turnpoint (capped at ESS).
    while (
      nextReq < essIdx &&
      reachTime[nextReq] !== undefined &&
      (reachTime[nextReq] as number) <= tms
    ) {
      nextReq++;
    }
    const tp = task.turnpoints[nextReq];
    const edge = Math.max(
      0,
      ellipsoidDistance(fix.latitude, fix.longitude, tp.waypoint.lat, tp.waypoint.lon) - tp.radius,
    );
    const distKm = (edge + cumToESS[nextReq]) / 1000;

    if (prevDistKm !== null) {
      // The ratchet appends this fix's distance to the window, then weights
      // the interval by this ("next") fix's time — the spec's taskTime(tpᵢ).
      const curBestKm = Math.min(prevDistKm, ssKm, prevBestKm);
      if (formula === 'classic') {
        // classic (HG, §12.3.1): task_time · (best[i−1]² − best[i]²).
        // Referenced to the pilot's own start and never rebased, so its
        // times are non-negative as-is — no gate clamp.
        if (prevBestKm > curBestKm) {
          const localTimeSec = tms / 1000 - pilotSSSSec;
          classicSum +=
            localTimeSec * (prevBestKm * prevBestKm - curBestKm * curBestKm);
        }
      } else if (prevBestKm > curBestKm) {
        // weighted (PG, S7F 2026 §12.3.1):
        //   minToESS(tpᵢ) · taskTime(tpᵢ) · ∫ weight(x) dx
        // over the done-fraction interval this fix advanced through. Split
        // the taskTime factor into (Σ Δ·time) and (Σ Δ) so the field's
        // start-time offset can be applied later.
        const delta =
          curBestKm *
          (leadWeightIntegral(prevBestKm / ssKm) -
            leadWeightIntegral(curBestKm / ssKm));
        if (delta !== 0) {
          weightedTimeSum += delta * (Math.max(tms, clockStartMs) / 1000 - pilotSSSSec);
          weightedDeltaSum += delta;
        }
      }
      prevBestKm = curBestKm;
    }
    prevDistKm = distKm;
  }

  if (prevDistKm === null) return invalid; // no fixes in the leading window
  // Fold the final fix's distance into the ratchet (used by the tail term).
  const bestDistKm = Math.min(prevDistKm, ssKm, prevBestKm);

  return {
    valid: true, ssKm, bestDistKm,
    reachedESS: pilotESSTime !== null,
    pilotSSSMs: pilotSSSTime,
    lastFixMs: fixes[fixes.length - 1].time.getTime(),
    weightedTimeSum, weightedDeltaSum, classicSum,
  };
}

/**
 * The whole-field times the §12.3.1 leading clock is built from. Absolute
 * epoch milliseconds throughout; {@link resolveLeadingMaxTime} turns them
 * into the single `maxTime` the land-out tail runs to.
 */
export interface LeadingFieldTimes {
  /**
   * The leading clock's origin (`firstTaskStartTime`): the first start gate
   * in a gated race, otherwise the first SSS crossing in the field.
   */
  firstStartMs: number;
  /** When the last pilot reached ESS, or null when nobody did. */
  lastESSMs: number | null;
  /**
   * When the last landed-out pilot landed — the end of the latest tracklog
   * among pilots who never reached ESS — or null when nobody landed out.
   */
  lastOutlandingMs: number | null;
  /** The task's goal deadline (§9.2), or null when the task sets none. */
  deadlineMs: number | null;
  /** The task stop time (§13.4.1) on a stopped task, else null. */
  stopTimeMs: number | null;
}

/** Which of the {@link LeadingFieldTimes} the resolved `maxTime` came from. */
export type LeadingMaxTimeSource =
  | 'last_outlanding'
  | 'last_ess'
  | 'deadline'
  | 'stop'
  | 'fallback';

/** A resolved §12.3.1 `maxTime`, and the field time it came from. */
export interface LeadingMaxTime {
  /** The instant the land-out tail runs to (epoch ms). */
  timeMs: number;
  source: LeadingMaxTimeSource;
}

/**
 * How long the tail runs when the field gives nothing to measure it by —
 * nobody reached ESS and nobody has a scannable tracklog. Arbitrary, and
 * only reachable on a degenerate field.
 */
const LEADING_TAIL_FALLBACK_MS = 3_600_000;

/**
 * Resolve the field's §12.3.1 `maxTime`:
 *
 *   maxTime = min(max(lastOutlandingTime, lastESStime), taskDeadline)
 *
 * This is the instant a landed-out pilot's leading graph is carried to, and
 * it is a property of the FIELD, not of the pilot: "for pilots who land out
 * after the last pilot reached ESS, the calculation keeps going until they
 * land" extends the clock for everyone still owed a tail, not only for the
 * pilot who flew longest.
 *
 * A stopped task (§13.4.1) bounds it the same way the deadline does —
 * nothing after the stop time is scored, so a tracklog that kept recording
 * past it cannot lengthen anyone's tail.
 */
export function resolveLeadingMaxTime(times: LeadingFieldTimes): LeadingMaxTime {
  const { firstStartMs, lastESSMs, lastOutlandingMs, deadlineMs, stopTimeMs } = times;

  let timeMs: number;
  let source: LeadingMaxTimeSource;
  if (lastOutlandingMs !== null && (lastESSMs === null || lastOutlandingMs > lastESSMs)) {
    timeMs = lastOutlandingMs;
    source = 'last_outlanding';
  } else if (lastESSMs !== null) {
    timeMs = lastESSMs;
    source = 'last_ess';
  } else {
    timeMs = firstStartMs + LEADING_TAIL_FALLBACK_MS;
    source = 'fallback';
  }

  // The two caps. Reported as the source when either actually bites, because
  // "the tail stopped at the deadline" is a different fact about the day from
  // "the tail stopped when the last pilot landed".
  if (stopTimeMs !== null && stopTimeMs < timeMs) {
    timeMs = stopTimeMs;
    source = 'stop';
  }
  if (deadlineMs !== null && deadlineMs < timeMs) {
    timeMs = deadlineMs;
    source = 'deadline';
  }
  return { timeMs, source };
}

/**
 * Fold the field-level scalars into a per-pilot {@link LeadingAggregate} to
 * produce the final leading coefficient — the cheap, field-dependent half of
 * `tot_lc_calculation` (late-start rectangle for classic, land-out tail, and
 * normalization). Lower LC = more leading = more points.
 *
 * @param agg - The pilot's cached/computed field-independent aggregate
 * @param taskFirstSSSTime - The leading clock's origin (ms since epoch): the
 *   first start gate, else the field's first SSS crossing
 * @param taskMaxTime - The field's §12.3.1 `maxTime` (ms since epoch), from
 *   {@link resolveLeadingMaxTime} — where a landed-out pilot's graph ends
 * @param formula - 'weighted' (modern default) or 'classic'
 * @returns Normalized leading coefficient (lower is better), or Infinity
 */
export function combineLeadingCoefficient(
  agg: LeadingAggregate,
  taskFirstSSSTime: number,
  taskMaxTime: number,
  formula: LeadingFormula = 'weighted',
): number {
  if (!agg.valid) return Infinity;
  const { ssKm, bestDistKm, reachedESS, pilotSSSMs } = agg;

  if (formula === 'classic') {
    let total = agg.classicSum;
    if (pilotSSSMs > taskFirstSSSTime) {
      // Full-distance rectangle for the time before this pilot started.
      total += ssKm * ssKm * (pilotSSSMs - taskFirstSSSTime) / 1000;
    }
    if (!reachedESS) {
      // Measured from the pilot's own start because classicSum is: the
      // rectangle above already carries the graph back to the field's first
      // start. Floored at zero — the deadline cap can land maxTime before a
      // very late starter's own crossing, and a NEGATIVE tail would hand
      // that pilot the field's best coefficient.
      total += bestDistKm * bestDistKm * Math.max(0, taskMaxTime - pilotSSSMs) / 1000;
    }
    return total / (1800 * ssKm * ssKm);
  }

  // weighted: rebase the per-pilot sum from the pilot's own start to the
  // field's first start — Σ Δ·(t − first) = weightedTimeSum + (pilotSSS − first)·weightedDeltaSum.
  const shiftSec = pilotSSSMs / 1000 - taskFirstSSSTime / 1000;
  let total = agg.weightedTimeSum + shiftSec * agg.weightedDeltaSum;
  if (!reachedESS) {
    // §12.3.1 missingArea: minToESS(best) · maxTime · ∫ weight over the
    // remaining (never-flown) part of the speed section.
    const missingTimeSec = Math.max(0, (taskMaxTime - taskFirstSSSTime) / 1000);
    total += bestDistKm * missingTimeSec * leadWeightIntegral(bestDistKm / ssKm);
  }
  return total / (1800 * ssKm);
}

/**
 * Calculate the leading coefficient (LC) for a single pilot — the `classic`
 * (HG) and `weighted` (PG) formulas of CIVL GAP / FAI S7F §12.3.1.
 *
 * The curve is distance-to-ESS measured **along the optimized course**
 * (distance to the next un-reached turnpoint's cylinder edge plus the
 * optimized legs from there to ESS), sampled per fix, with a ratchet:
 * the best distance never increases even if the pilot flies away from ESS.
 * Lower LC = more leading = more points. The raw per-interval sum is then
 * normalized and given a late-start (classic) and/or land-out tail term, as
 * in AirScore's `tot_lc_calculation` — except that the tail runs to the
 * spec's field-level `maxTime` (issue #585) rather than to AirScore's
 * per-pilot landing / last-ESS time.
 *
 * Thin wrapper over {@link computeLeadingAggregate} + {@link combineLeadingCoefficient};
 * see those for the cacheable split.
 *
 * @param fixes - Pilot's tracklog fixes (time-ordered)
 * @param task - The competition task
 * @param sequence - The pilot's resolved turnpoint reachings (for progress)
 * @param taskFirstSSSTime - The leading clock's origin (ms since epoch)
 * @param taskMaxTime - The field's §12.3.1 `maxTime` (ms since epoch), from
 *   {@link resolveLeadingMaxTime}
 * @param pilotSSSTime - The pilot's own start time (ms), or null if no start
 * @param pilotESSTime - The pilot's ESS time (ms), or null if not reached
 * @param formula - 'weighted' (modern default) or 'classic'
 * @returns Normalized leading coefficient (lower is better), or Infinity
 */
export function calculateLeadingCoefficient(
  fixes: IGCFix[],
  task: XCTask,
  sequence: TurnpointReaching[],
  taskFirstSSSTime: number,
  taskMaxTime: number,
  pilotSSSTime: number | null,
  pilotESSTime: number | null,
  formula: LeadingFormula = 'weighted',
): number {
  const agg = computeLeadingAggregate(fixes, task, sequence, pilotSSSTime, pilotESSTime, formula);
  return combineLeadingCoefficient(agg, taskFirstSSSTime, taskMaxTime, formula);
}

// ---------------------------------------------------------------------------
// Leading Points
// ---------------------------------------------------------------------------

/**
 * Calculate leading points for a single pilot.
 *
 * LeadingFactor = max(0, 1 − ((LCp − LCmin) / √LCmin)^(2/3)), and
 * LeadingPoints = LeadingFactor × available — exactly AirScore's
 * `pilot_leadout` (gap.py / pwc.py). The pilot with the best (minimum)
 * LC scores full points; others fall off with the 2/3-power curve.
 *
 * "No valid LC in the field" is signalled by a non-finite minLC (pilots
 * without a valid LC already carry Infinity themselves) — NOT by minLC ≤ 0.
 * A genuinely non-positive minLC is a degenerate input (the LC pipeline
 * produces positive coefficients); the √LCmin normalization is undefined
 * there, so the pilot(s) holding the minimum still take full points and
 * everyone else takes none, rather than zeroing the whole field.
 */
export function calculateLeadingPoints(
  pilotLC: number,
  minLC: number,
  availableLeadingPoints: number,
): number {
  if (!isFinite(pilotLC) || !isFinite(minLC)) return 0;
  const lcDiff = pilotLC - minLC;
  if (lcDiff <= 0) return availableLeadingPoints;
  if (minLC <= 0) return 0; // degenerate normalization — see docblock
  // ((LCp − LCmin) / √LCmin)^(2/3) === cbrt((LCp − LCmin)² / LCmin)
  const factor = Math.max(0, 1 - Math.cbrt((lcDiff * lcDiff) / minLC));
  return factor * availableLeadingPoints;
}
