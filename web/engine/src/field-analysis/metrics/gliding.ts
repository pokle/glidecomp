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
import { andoyerDistance, calculateTrackDistance } from '../../geo';
import { getEffectiveSSSIndex } from '../../xctsk-parser';
import { mean, median, percentile } from '../stats';
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
/** A "next climb" must start within this gap after the glide ends (STF proxy). */
const MAX_NEXT_CLIMB_GAP_MS = 5 * 60 * 1000;
/** Minimum glide→climb pairs for the STF proxy to be meaningful. */
const MIN_STF_PAIRS = 4;
/** Minimum total smoothed altitude gain for the dolphin fraction to apply. */
const MIN_DOLPHIN_TOTAL_GAIN_M = 200;
/** Half-width of the "10 s-smoothed" altitude window. */
const SMOOTH_HALF_WINDOW_MS = 5_000;

// --- Small shared helpers ---

function fixMs(p: PilotAnalysisContext, fixIndex: number): number {
  return p.fixes[fixIndex].time.getTime();
}

function clampIndex(p: PilotAnalysisContext, i: number): number {
  return Math.min(Math.max(i, 0), p.fixes.length - 1);
}

/** Post-SSS glide segments (segment start at/after the pilot's start). */
function postSssGlides(p: PilotAnalysisContext): GlideSegment[] {
  const sss = p.sssMs;
  if (sss === null) return [];
  return p.glides.filter((g) => g.duration > 0 && fixMs(p, g.startIndex) >= sss);
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
  label: 'Gliding speed between climbs',
  shortLabel: 'GlideSpd',
  unit: 'km/h',
  family: 'gliding',
  direction: 'higher',
  explanation:
    'How fast the pilot moves down the course when they do not circle. The value is the '
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
      if (duration <= 0) return { trackFile: p.trackFile, value: null };
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
  label: 'Gliding further per metre lost than the rest of the field',
  shortLabel: 'GlideL/D',
  unit: 'ratio',
  family: 'gliding',
  direction: 'higher',
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
        const list = ldsByLeg.get(leg);
        if (list) list.push(ld);
        else ldsByLeg.set(leg, [ld]);
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
      if (ratios.length === 0) return { trackFile: p.trackFile, value: null };
      return {
        trackFile: p.trackFile,
        value: mean(ratios),
        note: `${ratios.length} leg${ratios.length === 1 ? '' : 's'} compared`,
      };
    });
    return { perPilot };
  },
};

// --- Metric 9: glide.stf_proxy ---

const glideStfProxy: MetricComputer = {
  id: 'glide.stf_proxy',
  label: 'Gliding faster when the next climb is stronger',
  shortLabel: 'SpeedToFly',
  unit: 'km/h',
  family: 'gliding',
  direction: 'higher',
  explanation:
    'Speed to fly: the pilot flies faster when a good climb is in front of them, and slower '
    + 'when it is not. We pair each glide after the start with the climb rate of the next '
    + 'thermal that starts within 5 minutes. The value is the mean glide speed before climbs '
    + 'stronger than the median, minus the mean glide speed before weaker climbs. +8 km/h means '
    + 'the pilot flew 8 km/h faster into the good climbs. This is a PROXY, and not true speed '
    + 'to fly, because there is no glider polar data.',
  compute(field) {
    const perPilot: PilotMetricValue[] = field.pilots.map((p) => {
      if (p.sssMs === null) return { trackFile: p.trackFile, value: null };
      const thermals = [...p.thermals].sort((a, b) => a.startIndex - b.startIndex);
      const pairs: { speedKmh: number; climb: number }[] = [];
      for (const g of postSssGlides(p)) {
        const glideEndMs = fixMs(p, g.endIndex);
        const next = thermals.find((t) => {
          const startMs = fixMs(p, t.startIndex);
          return startMs >= glideEndMs && startMs - glideEndMs <= MAX_NEXT_CLIMB_GAP_MS;
        });
        if (!next) continue;
        pairs.push({ speedKmh: (g.distance / g.duration) * 3.6, climb: next.avgClimbRate });
      }
      if (pairs.length < MIN_STF_PAIRS) return { trackFile: p.trackFile, value: null };
      const med = median(pairs.map((x) => x.climb));
      const strong = pairs.filter((x) => x.climb > med);
      const weak = pairs.filter((x) => x.climb < med);
      if (strong.length === 0 || weak.length === 0) {
        return {
          trackFile: p.trackFile,
          value: null,
          note: 'next-climb rates too uniform to split',
        };
      }
      return {
        trackFile: p.trackFile,
        value: mean(strong.map((x) => x.speedKmh)) - mean(weak.map((x) => x.speedKmh)),
        note: `${pairs.length} glide→climb pairs`,
      };
    });
    return { perPilot };
  },
};

// --- Metric 10: glide.extra_distance ---

const glideExtraDistance: MetricComputer = {
  id: 'glide.extra_distance',
  label: 'Gliding wide of the optimal course line',
  shortLabel: 'Wide%',
  unit: 'pct',
  family: 'gliding',
  direction: 'lower',
  explanation:
    'How much further the pilot flew on glide than the optimised course line needed. 0% is a '
    + 'flight exactly along the line, and 12% is a glide 12% further than necessary. On each '
    + "completed speed-section leg, we compare the pilot's route with the optimised distance of "
    + 'the leg, weighted by that optimised distance. Only the glides are measured at their full '
    + 'path length. Circling and searching contribute their entry-to-exit displacement instead. '
    + 'A climb or a search for lift therefore never reads as a wide line, because a pilot '
    + 'chooses a line only on glide. 0% is a real value that a pilot can reach: a pilot who '
    + 'flies the line of the optimiser scores exactly zero.',
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
              : andoyerDistance(
                  p.fixes[s].latitude,
                  p.fixes[s].longitude,
                  p.fixes[e].latitude,
                  p.fixes[e].longitude,
                );
        }
        optimizedSum += optimized;
        legCount++;
      }
      if (optimizedSum <= 0) return { trackFile: p.trackFile, value: null };
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
  label: 'Gliding through lift instead of stopping to circle',
  shortLabel: 'Dolphin%',
  unit: 'pct',
  family: 'gliding',
  direction: 'neutral',
  explanation:
    'Dolphin flying: how much of the height that the pilot gained came while they flew on, and '
    + 'not from a stop to turn. The value is the share of the altitude gain after the start, '
    + 'smoothed over 10 s, that the pilot made outside a detected thermal. There is no expected '
    + 'direction. The sign of the correlation shows whether dolphin flying paid on this day.',
  compute(field) {
    const perPilot: PilotMetricValue[] = field.pilots.map((p) => {
      const sss = p.sssMs;
      if (sss === null) return { trackFile: p.trackFile, value: null };
      let start = p.takeoffIndex;
      while (start <= p.landingIndex && fixMs(p, start) < sss) start++;
      const end = p.landingIndex;
      if (end - start < 1) return { trackFile: p.trackFile, value: null };

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
        return { trackFile: p.trackFile, value: null };
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
  glideStfProxy,
  glideExtraDistance,
  glideDolphinFraction,
];
