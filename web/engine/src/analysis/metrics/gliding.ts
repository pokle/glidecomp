// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Gliding metric family (Stage 1 package P2, metrics 7–11 of
 * docs/2026-07-18-field-analysis-plan.md): how fast, how efficiently, and
 * along which lines pilots glide between climbs. Metrics only read the
 * precomputed FieldContext — detectors are never re-run here — and all geo
 * math goes through geo.ts (project rule).
 */

import { fixAltitude as fixAlt, type IGCFix } from '../../igc-parser';
import type { GlideSegment } from '../../event-types';
import type { TurnpointReaching } from '../../turnpoint-sequence-types';
import { ellipsoidDistance, calculateTrackDistance } from '../../geo';
import { getEffectiveSSSIndex } from '../../xctsk-parser';
import { mean, median, percentile } from '../stats';
import { pushInto } from '../util';
import { fixMsAt, na } from './util';
import type {
  MetricComputer,
  PilotAnalysisContext,
  PilotMetricValue,
} from '../types';

// --- Tuning constants (surfaced in each metric's explanation string) ---

/** A leg's glide phases must lose at least this much altitude to yield an L/D. */
const MIN_LEG_GLIDE_LOSS_M = 100;
/** Legs with a shorter optimized distance are skipped (division-by-~0 guard). */
const MIN_LEG_OPTIMIZED_M = 500;
/** Minimum total smoothed altitude gain for the dolphin fraction to apply. */
const MIN_DOLPHIN_TOTAL_GAIN_M = 200;
/** Half-width of the "10 s-smoothed" altitude window. */
const SMOOTH_HALF_WINDOW_MS = 5_000;

// --- Small shared helpers ---

function clampIndex(p: PilotAnalysisContext, i: number): number {
  return Math.min(Math.max(i, 0), p.fixes.length - 1);
}

/** Post-SSS glide segments (segment start at/after the pilot's start). */
function postSssGlides(p: PilotAnalysisContext): GlideSegment[] {
  const sss = p.sssMs;
  if (sss === null) return [];
  return p.glides.filter((g) => g.duration > 0 && fixMsAt(p, g.startIndex) >= sss);
}

interface CompletedLeg {
  from: TurnpointReaching;
  to: TurnpointReaching;
}

/**
 * The pilot's completed speed-section legs: consecutive TurnpointReachings in
 * the resolved sequence, restricted to legs starting at/after the SSS
 * turnpoint index. Zero-fix-span legs (presence-credited reachings that share
 * the previous reaching's fix) are skipped — there is no track between them.
 */
function completedSpeedSectionLegs(p: PilotAnalysisContext, sssIdx: number): CompletedLeg[] {
  const seq = p.score.turnpointResult.sequence;
  const legs: CompletedLeg[] = [];
  for (let i = 0; i + 1 < seq.length; i++) {
    const from = seq[i];
    const to = seq[i + 1];
    if (to.taskIndex !== from.taskIndex + 1) continue; // defensive: legs are i → i+1
    if (from.taskIndex < sssIdx) continue; // pre-start legs excluded
    if (clampIndex(p, to.fixIndex) <= clampIndex(p, from.fixIndex)) continue;
    legs.push({ from, to });
  }
  return legs;
}

/**
 * Per-leg glide L/D for one pilot: fix-path distance inside 'glide'
 * PhaseIntervals within the leg's fix range ÷ net altitude lost in those
 * intervals. Legs whose glide phases lose < MIN_LEG_GLIDE_LOSS_M are skipped.
 * Keyed by the leg's fromTaskIndex.
 */
function pilotGlideLDByLeg(p: PilotAnalysisContext, sssIdx: number): Map<number, number> {
  const out = new Map<number, number>();
  for (const { from, to } of completedSpeedSectionLegs(p, sssIdx)) {
    const legStart = clampIndex(p, from.fixIndex);
    const legEnd = clampIndex(p, to.fixIndex);
    let distance = 0;
    let loss = 0;
    for (const phase of p.phases) {
      if (phase.phase !== 'glide') continue;
      const s = Math.max(phase.startIndex, legStart);
      const e = Math.min(phase.endIndex, legEnd);
      if (e <= s) continue;
      distance += calculateTrackDistance(p.fixes, s, e);
      loss += fixAlt(p.fixes[s]) - fixAlt(p.fixes[e]);
    }
    if (loss < MIN_LEG_GLIDE_LOSS_M) continue;
    out.set(from.taskIndex, distance / loss);
  }
  return out;
}

/**
 * Time-centred moving average of altitude over ±halfWindowMs, for fixes
 * start..end inclusive. Two-pointer sweep, O(n).
 */
function smoothedAltitudes(
  fixes: IGCFix[],
  start: number,
  end: number,
  halfWindowMs: number,
): number[] {
  const out = new Array<number>(end - start + 1);
  let lo = start;
  let hi = start - 1;
  let sum = 0;
  let count = 0;
  for (let i = start; i <= end; i++) {
    const t = fixes[i].time.getTime();
    while (hi + 1 <= end && fixes[hi + 1].time.getTime() <= t + halfWindowMs) {
      hi++;
      sum += fixAlt(fixes[hi]);
      count++;
    }
    while (lo <= hi && fixes[lo].time.getTime() < t - halfWindowMs) {
      sum -= fixAlt(fixes[lo]);
      lo++;
      count--;
    }
    out[i - start] = count > 0 ? sum / count : fixAlt(fixes[i]);
  }
  return out;
}

// --- Metric 7: glide.speed ---

const glideSpeed: MetricComputer = {
  id: 'glide.speed',
  label: 'Glide speed between climbs',
  shortLabel: 'GlideSpd',
  unit: 'km/h',
  family: 'gliding',
  direction: 'higher',
  /** Directional names for a surface that claims a winner — see
   * MetricWinningPhrasings. */
  winning: {
    more: 'Fast glides',
    less: 'Slow glides',
  },
  explanation:
    'How fast the pilot moves down the course when they are on a glide. The value is the '
    + 'duration-weighted mean ground speed over every glide after the start, which is the glide '
    + 'distance divided by the glide time. A higher value means more ground covered in each '
    + 'minute between climbs.',
  compute(field) {
    const perPilot: PilotMetricValue[] = field.pilots.map((p) => {
      const glides = postSssGlides(p);
      let distance = 0;
      let duration = 0;
      for (const g of glides) {
        distance += g.distance;
        duration += g.duration;
      }
      if (duration <= 0) return na(p);
      return {
        trackFile: p.trackFile,
        value: (distance / duration) * 3.6,
        note: `${glides.length} glides, ${Math.round(duration / 60)} min gliding`,
      };
    });
    const sorted = perPilot
      .map((v) => v.value)
      .filter((v): v is number => v !== null)
      .sort((a, b) => a - b);
    const fieldSummary =
      sorted.length > 0
        ? [
            `Field glide speed: median ${percentile(sorted, 50).toFixed(1)} km/h · `
              + `p90 ${percentile(sorted, 90).toFixed(1)} km/h (${sorted.length} pilots)`,
          ]
        : undefined;
    return { perPilot, fieldSummary };
  },
};

// --- Metric 8: glide.ld_vs_field ---

const glideLdVsField: MetricComputer = {
  id: 'glide.ld_vs_field',
  label: 'Glide L/D against the field median',
  shortLabel: 'GlideL/D',
  unit: 'ratio',
  family: 'gliding',
  direction: 'higher',
  /** Directional names for a surface that claims a winner — see
   * MetricWinningPhrasings. */
  winning: {
    more: 'Higher glide ratio than the field',
    less: 'Lower glide ratio than the field',
  },
  explanation:
    'Whether the pilot found better air on glide than the other pilots on the same leg. For '
    + "each completed speed-section leg, we take the pilot's glide-phase L/D. That is the path "
    + 'distance divided by the net altitude lost during the glides, and we skip a leg that '
    + `loses less than ${MIN_LEG_GLIDE_LOSS_M} m. We divide it by the median L/D of the field on `
    + 'that same leg, and then average over the legs. 1.10 means the pilot glided 10% further '
    + 'for each metre lost than the usual pilot on those legs.',
  compute(field) {
    const sssIdx = Math.max(0, getEffectiveSSSIndex(field.task));
    const perPilotLegs = field.pilots.map((p) => pilotGlideLDByLeg(p, sssIdx));

    // Field distribution per leg (keyed by fromTaskIndex).
    const ldsByLeg = new Map<number, number[]>();
    for (const legMap of perPilotLegs) {
      for (const [leg, ld] of legMap) {
        pushInto(ldsByLeg, leg, ld);
      }
    }
    const medianByLeg = new Map<number, number>();
    for (const [leg, lds] of ldsByLeg) medianByLeg.set(leg, median(lds));

    const perPilot: PilotMetricValue[] = field.pilots.map((p, i) => {
      const ratios: number[] = [];
      for (const [leg, ld] of perPilotLegs[i]) {
        const fieldMedian = medianByLeg.get(leg);
        if (fieldMedian === undefined || fieldMedian <= 0) continue;
        ratios.push(ld / fieldMedian);
      }
      if (ratios.length === 0) return na(p);
      return {
        trackFile: p.trackFile,
        value: mean(ratios),
        note: `${ratios.length} leg${ratios.length === 1 ? '' : 's'} compared`,
      };
    });
    return { perPilot };
  },
};

// Metric 9 was glide.stf_proxy, removed in TASK_ANALYSIS_VERSION 26 — the
// numbers are a global sequence across the family files, so 9 stays vacant
// rather than renumbering every metric after it.

// --- Metric 10: glide.extra_distance ---

const glideExtraDistance: MetricComputer = {
  id: 'glide.extra_distance',
  label: 'Gliding wide of the optimal course line',
  shortLabel: 'Wide%',
  unit: 'pct',
  family: 'gliding',
  /**
   * Neutral since TASK_ANALYSIS_VERSION 27, and the ONE metric measured to
   * reverse outright with the day: flying wide costs on a day most of the
   * field completes, and goes with a BETTER result on a day most of it lands
   * out. See docs/2026-09-02-metric-evidence.md.
   */
  direction: 'neutral',
  /** Directional names for a surface that claims a winner — see
   * MetricWinningPhrasings. */
  winning: {
    more: 'Flying wide of the optimised route',
    less: 'Flying close to the optimised route',
  },
  explanation:
    'How much further the pilot flew on glide than the optimised course line needed. 0% is a '
    + 'flight exactly along the line, and 12% is a glide 12% further than necessary. On each '
    + "completed speed-section leg, we compare the pilot's route with the optimised distance of "
    + 'the leg, weighted by that optimised distance. Only the glides are measured at their full '
    + 'path length. Circling and searching contribute their entry-to-exit displacement instead. '
    + 'A climb or a search for lift therefore never reads as a wide line, because a pilot '
    + 'chooses a line only on glide. 0% is a real value that a pilot can reach: a pilot who '
    + 'flies the line of the optimiser scores exactly zero. There is no expected direction, '
    + 'and this metric changes sides with the day: on a day when most of the field completes '
    + 'the course, flying wide costs you, but on a day when most of it lands out, the pilots '
    + 'who leave the line to hunt for lift are the ones still in the air. Read the sign of the '
    + 'correlation against how many pilots made goal.',
  compute(field) {
    const sssIdx = Math.max(0, getEffectiveSSSIndex(field.task));
    const optimizedByLeg = new Map<number, number>();
    for (const leg of field.legs) {
      if (leg.toTaskIndex === leg.fromTaskIndex + 1) {
        optimizedByLeg.set(leg.fromTaskIndex, leg.optimizedMeters);
      }
    }
    const perPilot: PilotMetricValue[] = field.pilots.map((p) => {
      let actualSum = 0;
      let optimizedSum = 0;
      let legCount = 0;
      for (const { from, to } of completedSpeedSectionLegs(p, sssIdx)) {
        const optimized = optimizedByLeg.get(from.taskIndex);
        if (optimized === undefined || optimized < MIN_LEG_OPTIMIZED_M) continue;
        // ROUTE distance, not raw path: the full path counts only where the
        // pilot was GLIDING — that is where a line is chosen — and every
        // other phase contributes its entry→exit displacement, because a
        // pilot who circles or scratches still covers the route they drift
        // across without having to glide it.
        //
        // Both exclusions were found the same way, by a metric quietly
        // re-measuring its neighbour. Circling went first (v9): 30 turns per
        // thermal logged ~300 m of "line deviation" each, so the raw path
        // mostly counted climbs — collinear with decision.km_between_climbs.
        // Searching is the same error and the bigger one (v16): a scratching
        // pilot's path runs 1.6–2.0× its own displacement and search fills
        // 17–44% of a leg, so most of the excess this metric reported was
        // hunting for lift — collinear with decision.search_fraction — while
        // the name promised line choice. The rule that survives both: only a
        // glide can be flown wide.
        const legStart = clampIndex(p, from.fixIndex);
        const legEnd = clampIndex(p, to.fixIndex);
        for (const phase of p.phases) {
          const s = Math.max(phase.startIndex, legStart);
          const e = Math.min(phase.endIndex, legEnd);
          if (e <= s) continue;
          actualSum +=
            phase.phase === 'glide'
              ? calculateTrackDistance(p.fixes, s, e)
              : ellipsoidDistance(
                  p.fixes[s].latitude,
                  p.fixes[s].longitude,
                  p.fixes[e].latitude,
                  p.fixes[e].longitude,
                );
        }
        optimizedSum += optimized;
        legCount++;
      }
      if (optimizedSum <= 0) return na(p);
      // Optimized-distance-weighted mean of per-leg ratios = Σ actual ÷ Σ optimized,
      // expressed as the percentage excess over the line.
      return {
        trackFile: p.trackFile,
        value: 100 * (actualSum / optimizedSum - 1),
        note: `${legCount} leg${legCount === 1 ? '' : 's'} completed`,
      };
    });
    return { perPilot };
  },
};

// --- Metric 11: glide.dolphin_fraction ---

const glideDolphinFraction: MetricComputer = {
  id: 'glide.dolphin_fraction',
  label: 'Share of the height gain made outside thermals',
  shortLabel: 'Dolphin%',
  unit: 'pct',
  family: 'gliding',
  direction: 'neutral',
  /** Directional names for a surface that claims a winner — see
   * MetricWinningPhrasings. */
  winning: {
    more: 'Using lifty air outside thermals',
    less: 'Climbing mostly in thermals',
  },
  explanation:
    'Dolphin flying: how much of the height that the pilot gained came outside of circling. '
    + 'The value is the share of the altitude gain after the start, '
    + 'smoothed over 10 s, that the pilot made outside a detected thermal. There is no expected '
    + 'direction. The sign of the correlation shows whether dolphin flying paid on this day.',
  compute(field) {
    const perPilot: PilotMetricValue[] = field.pilots.map((p) => {
      const sss = p.sssMs;
      if (sss === null) return na(p);
      let start = p.takeoffIndex;
      while (start <= p.landingIndex && fixMsAt(p, start) < sss) start++;
      const end = p.landingIndex;
      if (end - start < 1) return na(p);

      const smoothed = smoothedAltitudes(p.fixes, start, end, SMOOTH_HALF_WINDOW_MS);
      const inThermal = new Array<boolean>(end - start + 1).fill(false);
      for (const t of p.thermals) {
        const s = Math.max(t.startIndex, start);
        const e = Math.min(t.endIndex, end);
        for (let i = s; i <= e; i++) inThermal[i - start] = true;
      }

      let totalGain = 0;
      let dolphinGain = 0;
      for (let i = start; i < end; i++) {
        const delta = smoothed[i + 1 - start] - smoothed[i - start];
        if (delta <= 0) continue;
        totalGain += delta;
        if (!inThermal[i - start] && !inThermal[i + 1 - start]) dolphinGain += delta;
      }
      if (totalGain < MIN_DOLPHIN_TOTAL_GAIN_M) {
        return na(p);
      }
      return {
        trackFile: p.trackFile,
        value: (100 * dolphinGain) / totalGain,
        note: `${Math.round(dolphinGain)} of ${Math.round(totalGain)} m gained outside thermals`,
      };
    });
    return { perPilot };
  },
};

export const GLIDING_METRICS: MetricComputer[] = [
  glideSpeed,
  glideLdVsField,
  glideExtraDistance,
  glideDolphinFraction,
];
