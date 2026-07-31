// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Decision-making metric family — how pilots manage altitude and risk after
 * the start: how low they let themselves get before taking a climb, whether
 * they pull off genuine low saves, how often they stop to circle per distance
 * flown, and how much speed-section time evaporates into searching.
 *
 * Stage 1 package P3 of docs/2026-07-18-field-analysis-plan.md (metrics
 * 12–15). Metrics only read the FieldContext — no detectors are re-run.
 */

import { fixAltitude as altOf } from '../../igc-parser';
import type {
  FieldContext,
  MetricComputer,
  MetricOutput,
  PilotAnalysisContext,
  PilotMetricValue,
} from '../types';
import { mean, median, percentile } from '../stats';

// --- Tunables (named constants so the explanations stay honest) -------------

/** A gap between two climbs must descend this far to count as getting low. */
const MIN_DESCENT_METERS = 100;
/** A low save starts below floor + this fraction of the working-band span. */
const LOW_SAVE_ENTRY_BAND_FRACTION = 0.15;
/** …and must go on to gain at least this much. */
const LOW_SAVE_MIN_GAIN_METERS = 300;
/** km_between_climbs needs at least this much flown distance to be meaningful. */
const MIN_FLOWN_DISTANCE_METERS = 20_000;

// --- Small shared helpers ---------------------------------------------------

/** A null (not-applicable) per-pilot value. */
function na(p: PilotAnalysisContext): PilotMetricValue {
  return { trackFile: p.trackFile, value: null };
}

/**
 * Per-pilot climb percentiles within multi-pilot shared thermals, ranked as
 * the P1 spec does: within one shared thermal a use's percentile is
 * 100·(#uses with strictly lower avgClimbRate)/(n−1).
 */
function sharedClimbPercentiles(field: FieldContext): Map<number, number[]> {
  const byPilot = new Map<number, number[]>();
  for (const st of field.sharedThermals) {
    if (st.pilotCount < 2 || st.uses.length < 2) continue;
    const n = st.uses.length;
    for (const use of st.uses) {
      let slower = 0;
      for (const other of st.uses) {
        if (other.avgClimbRate < use.avgClimbRate) slower++;
      }
      const pct = (100 * slower) / (n - 1);
      let list = byPilot.get(use.pilotIndex);
      if (!list) byPilot.set(use.pilotIndex, (list = []));
      list.push(pct);
    }
  }
  return byPilot;
}

/** Post-SSS thermals of a pilot (thermal start fix at/after sssMs). */
function postSssThermals(p: PilotAnalysisContext) {
  const sssMs = p.sssMs;
  if (sssMs === null) return [];
  return p.thermals.filter((t) => {
    const start = p.fixes[t.startIndex];
    return start !== undefined && start.time.getTime() >= sssMs;
  });
}

/**
 * The lowest altitude between each consecutive pair of post-start climbs,
 * keeping only gaps that descended ≥ `minDescent` from the previous climb's
 * exit — a 40 m top-up between two climbs is not the pilot getting low.
 *
 * Walking thermal PAIRS is what makes "between climbs" structural rather than
 * incidental: the run out to the first climb, the final glide, and a sled run
 * are all excluded because they have no climb on both sides, with no threshold
 * doing the excluding. It also needs no smoothing — the minimum of a real fix
 * range is the altitude the pilot actually reached, so a deep save is not
 * flattened up into the surrounding air.
 */
function betweenClimbLows(p: PilotAnalysisContext, minDescent: number): number[] {
  const climbs = postSssThermals(p);
  const lows: number[] = [];
  for (let i = 0; i + 1 < climbs.length; i++) {
    const from = climbs[i].endIndex;
    const to = climbs[i + 1].startIndex;
    if (to <= from) continue;
    let low = Infinity;
    for (let j = from; j <= to; j++) low = Math.min(low, altOf(p.fixes[j]));
    if (climbs[i].endAltitude - low >= minDescent) lows.push(low);
  }
  return lows;
}

// --- Metric 12: decision.altitude_floor -------------------------------------

const altitudeFloor: MetricComputer = {
  id: 'decision.altitude_floor',
  label: 'How low the pilot gets between climbs',
  shortLabel: 'Floor%',
  unit: 'pct',
  family: 'decision',
  direction: 'neutral',
  explanation:
    'How low the pilot goes before the next climb. A high value is a race with height in ' +
    'reserve, and a low value is a flight that goes down near the ground. We take each pair of ' +
    'climbs that the pilot made after the start, and we find the lowest point between them. We ' +
    'keep only the gaps that go down 100 m or more, because a top-up between two climbs is not ' +
    'a descent. We do not count a sled run or the glide to goal, because the pilot made no ' +
    "climb after them. The value is the median of those low points, as a percentage of the day's " +
    "working band. 0% is where the lowest tenth of the field's climbs started, and 100% is where " +
    'the highest tenth stopped. Thus a negative value shows that the pilot went lower than ' +
    'almost all of the field. The pilot must have two or more of these descents. There is no ' +
    'expected direction. The sign of the correlation says whether height in reserve pays.',
  compute(field: FieldContext): MetricOutput {
    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null) return na(p);
      // Everything up to landing, not up to ESS (unlike search_fraction below):
      // a gap needs a climb on both sides, so the glide from ESS to goal and the
      // descent to land are excluded by construction rather than by a window.
      // A pilot who misses ESS is then measured exactly like one who makes it —
      // and they are the pilot this question is most often asked about.
      const lows = betweenClimbLows(p, MIN_DESCENT_METERS);
      if (lows.length < 2) return na(p);
      const bandPcts = lows.map((m) => 100 * field.workingBand.bandFraction(m));
      const lowest = Math.min(...bandPcts);
      return {
        trackFile: p.trackFile,
        value: median(bandPcts),
        note: `${lows.length} descents, lowest ${Math.round(lowest)}% of band`,
      };
    });
    return { perPilot };
  },
};

// --- Metric 13: decision.low_saves ------------------------------------------

const lowSaves: MetricComputer = {
  id: 'decision.low_saves',
  label: 'Low saves dug out from the bottom of the band',
  shortLabel: 'LowSaves',
  unit: 'count',
  family: 'decision',
  direction: 'neutral',
  explanation:
    'How many times the pilot got low and climbed out again. We count the climbs after the ' +
    'start that the pilot entered below 15% of the working band, and that then gained 300 m or ' +
    'more. Those are true low saves. Zero is a real value, and not a missing one: it means the ' +
    'pilot never got that low. There is no expected direction. The sign of the correlation says ' +
    'whether a climb-out or a flight that stays high pays.',
  compute(field: FieldContext): MetricOutput {
    const { floorMeters, spanMeters, bandFraction } = field.workingBand;
    const entryThreshold = floorMeters + LOW_SAVE_ENTRY_BAND_FRACTION * spanMeters;
    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null) return na(p);
      let count = 0;
      let deepestBandPct = Infinity;
      for (const t of postSssThermals(p)) {
        const gain = t.endAltitude - t.startAltitude;
        if (t.startAltitude < entryThreshold && gain >= LOW_SAVE_MIN_GAIN_METERS) {
          count++;
          deepestBandPct = Math.min(deepestBandPct, 100 * bandFraction(t.startAltitude));
        }
      }
      return {
        trackFile: p.trackFile,
        value: count,
        ...(count > 0 ? { note: `deepest save from ${Math.round(deepestBandPct)}% of band` } : {}),
      };
    });
    return { perPilot };
  },
};

// --- Metric 14: decision.km_between_climbs ----------------------------------

const kmBetweenClimbs: MetricComputer = {
  id: 'decision.km_between_climbs',
  label: 'Distance covered between climbs',
  shortLabel: 'km/climb',
  unit: 'km',
  family: 'decision',
  direction: 'higher',
  explanation:
    'How far the pilot gets down the course before they must stop and circle again. This is the ' +
    'direct reading of how often they stop. The value is the scored flown distance divided by ' +
    'the number of thermals taken after the start, so 3 km means three kilometres of course for ' +
    "each climb. The pilot must fly 20 km or more. The note of each pilot adds their mean climb "
    + 'percentile inside shared thermals, so you can read the number of stops together with the ' +
    'climb strength. Long legs between weak climbs is a different day from long legs between ' +
    'strong ones.',
  compute(field: FieldContext): MetricOutput {
    const pctByPilot = sharedClimbPercentiles(field);
    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null) return na(p);
      if (p.score.flownDistance < MIN_FLOWN_DISTANCE_METERS) return na(p);
      const count = postSssThermals(p).length;
      // No climbs at all after the start is not "infinitely efficient" — it is
      // a glide-out with no thermalling to measure. (As climbs-per-100 km this
      // read 0, i.e. the BEST possible score under 'lower is better'.)
      if (count === 0) {
        return { trackFile: p.trackFile, value: null, note: 'no climbs after the start' };
      }
      const value = p.score.flownDistance / 1000 / count;
      const pcts = pctByPilot.get(p.pilotIndex);
      return {
        trackFile: p.trackFile,
        value,
        ...(pcts && pcts.length > 0
          ? { note: `mean shared-climb pctile ${Math.round(mean(pcts))}%` }
          : {}),
      };
    });
    return { perPilot };
  },
};

// --- Metric 15: decision.search_fraction ------------------------------------

const searchFraction: MetricComputer = {
  id: 'decision.search_fraction',
  label: 'Share of race time spent hunting for the next climb',
  shortLabel: 'Search%',
  unit: 'pct',
  family: 'decision',
  direction: 'lower',
  explanation:
    'Time that goes into neither a climb nor progress down the course. This is the time spent ' +
    'to find lift, to stay up, and to decide what to do next. The value is the share of the ' +
    'speed-section time, from the start to ESS or to the landing, in which the pilot neither ' +
    'climbed in a thermal nor glided with real net speed. A lower value means less time lost ' +
    'between climbs.',
  compute(field: FieldContext): MetricOutput {
    const shares: { climb: number; glide: number; search: number }[] = [];
    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null || p.phases.length === 0) return na(p);
      const landingFix = p.fixes[p.landingIndex];
      if (!landingFix) return na(p);
      const winStart = p.sssMs;
      const winEnd = p.essMs ?? landingFix.time.getTime();
      if (winEnd <= winStart) return na(p);
      let climbMs = 0;
      let glideMs = 0;
      let searchMs = 0;
      for (const iv of p.phases) {
        const overlap = Math.min(iv.endMs, winEnd) - Math.max(iv.startMs, winStart);
        if (overlap <= 0) continue;
        if (iv.phase === 'climb') climbMs += overlap;
        else if (iv.phase === 'glide') glideMs += overlap;
        else searchMs += overlap;
      }
      const total = climbMs + glideMs + searchMs;
      if (total <= 0) return na(p);
      const share = {
        climb: (100 * climbMs) / total,
        glide: (100 * glideMs) / total,
        search: (100 * searchMs) / total,
      };
      shares.push(share);
      return { trackFile: p.trackFile, value: share.search };
    });

    let fieldSummary: string[] | undefined;
    if (shares.length > 0) {
      const q = (values: number[], p: number) =>
        Math.round(percentile([...values].sort((a, b) => a - b), p));
      const part = (label: string, values: number[]) =>
        `${label} ${q(values, 25)}/${q(values, 50)}/${q(values, 75)}%`;
      fieldSummary = [
        'Speed-section phase shares, field p25/median/p75: ' +
          [
            part('climb', shares.map((s) => s.climb)),
            part('glide', shares.map((s) => s.glide)),
            part('search', shares.map((s) => s.search)),
          ].join(' · '),
      ];
    }
    return { perPilot, ...(fieldSummary ? { fieldSummary } : {}) };
  },
};

export const DECISION_METRICS: MetricComputer[] = [
  altitudeFloor,
  lowSaves,
  kmBetweenClimbs,
  searchFraction,
];
