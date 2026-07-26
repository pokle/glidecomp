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
    'How fast the pilot moves down the course when they are not circling. Duration-weighted '
    + 'mean ground speed over every glide after the start (glide distance ÷ glide time). Higher '
    + 'means more ground covered per minute between climbs.',
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
    'Whether the pilot found better air on glide than everyone else flying the same leg. For '
    + "each completed speed-section leg, the pilot's glide-phase L/D (path distance ÷ net "
    + `altitude lost while gliding; legs losing under ${MIN_LEG_GLIDE_LOSS_M} m skipped) is `
    + "divided by the field's median L/D on that same leg, then averaged over legs. 1.10 means "
    + 'the pilot glided 10% further per metre lost than the typical pilot on those legs.',
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
    'Speed to fly: racing on when a good climb is waiting, easing off when it is not. Each '
    + 'glide after the start is paired with the climb rate of the next thermal starting within '
    + '5 minutes; the value is the mean glide speed flown before stronger-than-median climbs '
    + 'minus the mean before weaker ones, so +8 km/h means the pilot pushed 8 km/h harder into '
    + 'the good climbs. A PROXY, not true speed to fly — no glider polar data exists.',
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
    'How much further the pilot flew than the optimised course line demanded. Route distance on '
    + 'each completed speed-section leg (full path outside climbs, each climb counted as its '
    + "net drift) is compared with the leg's optimized distance, weighted by optimized distance. "
    + 'Circling path is excluded, so stopping to climb does not read as flying wide. READ THIS '
    + 'BETWEEN PILOTS, NOT AS AN ABSOLUTE: a fixed geometric offset is baked in, because a '
    + "pilot's leg is measured between their cylinder crossings while the optimized distance "
    + 'runs between the optimizer’s tag points, so even a perfectly flown line reads above 0%. '
    + 'The offset is the same for everyone on a leg — the gap between two pilots is the finding.',
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
        // Route distance, not raw path (same phase-clipping as
        // pilotGlideLDByLeg): a pilot taking 30 turns per thermal used to
        // log ~300 m of "line deviation" per circle, so the raw path mostly
        // re-measured climb count — collinear with
        // decision.km_between_climbs — while the explanation claimed line
        // choice. Outside climbs the full path counts; a climb contributes
        // its entry→exit displacement, because drifting downwind in a
        // thermal still covers route the pilot doesn't have to glide.
        // (Reported as a percentage EXCESS over the optimized line, not as
        // the raw ratio: "flew 12% further than they had to" is graspable in
        // a way "1.12" is not. Monotone in the ratio, so ρ is unchanged.)
        const legStart = clampIndex(p, from.fixIndex);
        const legEnd = clampIndex(p, to.fixIndex);
        for (const phase of p.phases) {
          const s = Math.max(phase.startIndex, legStart);
          const e = Math.min(phase.endIndex, legEnd);
          if (e <= s) continue;
          actualSum +=
            phase.phase === 'climb'
              ? andoyerDistance(
                  p.fixes[s].latitude,
                  p.fixes[s].longitude,
                  p.fixes[e].latitude,
                  p.fixes[e].longitude,
                )
              : calculateTrackDistance(p.fixes, s, e);
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
    'Dolphin flying: how much of the height the pilot gained came on the run rather than from '
    + 'stopping to turn. Share of altitude gain after the start (10 s-smoothed) made outside '
    + 'detected thermals. No expected direction — the correlation sign shows whether dolphining '
    + 'paid on this day.',
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
