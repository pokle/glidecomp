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

import type { IGCFix } from '../../igc-parser';
import type {
  FieldContext,
  MetricComputer,
  MetricOutput,
  PilotAnalysisContext,
  PilotMetricValue,
} from '../types';
import { mean, median, percentile } from '../stats';

// --- Tunables (named constants so the explanations stay honest) -------------

/** Rolling-mean window for the altitude-floor minima search. */
const SMOOTH_WINDOW_MS = 30_000;
/** A local minimum must sit at least this far below its neighbouring maxima. */
const MIN_PROMINENCE_METERS = 100;
/** A low save starts below floor + this fraction of the working-band span. */
const LOW_SAVE_ENTRY_BAND_FRACTION = 0.15;
/** …and must go on to gain at least this much. */
const LOW_SAVE_MIN_GAIN_METERS = 300;
/** climbs_per_100km needs at least this much flown distance to be meaningful. */
const MIN_FLOWN_DISTANCE_METERS = 20_000;

// --- Small shared helpers ---------------------------------------------------

/** Altitude of a fix — GNSS, falling back to pressure when the GNSS value is 0. */
function altOf(fix: IGCFix): number {
  return fix.gnssAltitude !== 0 ? fix.gnssAltitude : fix.pressureAltitude;
}

/** A null (not-applicable) per-pilot value. */
function na(p: PilotAnalysisContext): PilotMetricValue {
  return { trackFile: p.trackFile, value: null };
}

/**
 * First fix index in [takeoffIndex, landingIndex] at/after `ms`, or null when
 * the pilot's flight ends before it.
 */
function firstIndexAtOrAfter(p: PilotAnalysisContext, ms: number): number | null {
  for (let i = p.takeoffIndex; i <= p.landingIndex && i < p.fixes.length; i++) {
    if (p.fixes[i].time.getTime() >= ms) return i;
  }
  return null;
}

/**
 * Centred rolling-mean altitude over fixes[startIndex..endIndex] with a
 * `windowMs` time window. Two-pointer sweep — O(n).
 */
function smoothedAltitudes(
  fixes: IGCFix[],
  startIndex: number,
  endIndex: number,
  windowMs: number,
): number[] {
  const n = endIndex - startIndex + 1;
  const out = new Array<number>(n);
  const half = windowMs / 2;
  let lo = startIndex; // first fix inside the window
  let hi = startIndex; // first fix PAST the window
  let sum = 0;
  for (let i = startIndex; i <= endIndex; i++) {
    const t = fixes[i].time.getTime();
    while (hi <= endIndex && fixes[hi].time.getTime() <= t + half) {
      sum += altOf(fixes[hi]);
      hi++;
    }
    while (lo < hi && fixes[lo].time.getTime() < t - half) {
      sum -= altOf(fixes[lo]);
      lo++;
    }
    out[i - startIndex] = sum / (hi - lo);
  }
  return out;
}

/**
 * Local minima of `values` with at least `prominence` of both preceding drop
 * and following rise — a simple alternating-extrema sweep. A minimum only
 * counts once the series has fallen ≥ `prominence` from the previous maximum
 * AND risen ≥ `prominence` afterwards, so endpoints (e.g. the final descent
 * to landing) never qualify. Kept simple and explainable by design.
 */
function prominentMinima(values: number[], prominence: number): number[] {
  const minima: number[] = [];
  if (values.length === 0) return minima;
  let descending = false;
  let extreme = values[0]; // running max while ascending, running min while descending
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (descending) {
      if (v < extreme) {
        extreme = v;
      } else if (v - extreme >= prominence) {
        minima.push(extreme); // confirmed: fell ≥ prominence in, rose ≥ prominence out
        descending = false;
        extreme = v;
      }
    } else {
      if (v > extreme) {
        extreme = v;
      } else if (extreme - v >= prominence) {
        descending = true;
        extreme = v;
      }
    }
  }
  return minima;
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

// --- Metric 12: decision.altitude_floor -------------------------------------

const altitudeFloor: MetricComputer = {
  id: 'decision.altitude_floor',
  label: 'Altitude floor (band % at climb decisions)',
  shortLabel: 'Floor%',
  unit: 'pct',
  family: 'decision',
  direction: 'higher',
  explanation:
    "Finds each pilot's post-start altitude minima (30 s-smoothed, at least 100 m below the " +
    'surrounding maxima) — the points where they stopped descending and committed to a climb — ' +
    "and reports the median as a percentage of the day's working band. Higher means the pilot " +
    'keeps more margin in hand before taking a climb.',
  compute(field: FieldContext): MetricOutput {
    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null) return na(p);
      const start = firstIndexAtOrAfter(p, p.sssMs);
      if (start === null || start >= p.landingIndex) return na(p);
      const smoothed = smoothedAltitudes(p.fixes, start, p.landingIndex, SMOOTH_WINDOW_MS);
      const minima = prominentMinima(smoothed, MIN_PROMINENCE_METERS);
      if (minima.length < 2) return na(p);
      const bandPcts = minima.map((m) => 100 * field.workingBand.bandFraction(m));
      const lowest = Math.min(...bandPcts);
      return {
        trackFile: p.trackFile,
        value: median(bandPcts),
        note: `${minima.length} dips, lowest ${Math.round(lowest)}% of band`,
      };
    });
    return { perPilot };
  },
};

// --- Metric 13: decision.low_saves ------------------------------------------

const lowSaves: MetricComputer = {
  id: 'decision.low_saves',
  label: 'Low saves (climbs from the bottom of the band)',
  shortLabel: 'LowSaves',
  unit: 'count',
  family: 'decision',
  direction: 'neutral',
  explanation:
    'Counts post-start climbs entered below 15% of the working band that went on to gain at ' +
    'least 300 m — genuine low saves. Zero is a real score for a started pilot; the correlation ' +
    'sign says whether digging out or never getting low is what pays.',
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

// --- Metric 14: decision.climbs_per_100km -----------------------------------

const climbsPer100km: MetricComputer = {
  id: 'decision.climbs_per_100km',
  label: 'Climbs per 100 km flown',
  shortLabel: 'Clm/100km',
  unit: 'count',
  family: 'decision',
  direction: 'lower',
  explanation:
    'Post-start thermal count per 100 km of scored flown distance — how often the pilot stops ' +
    "to circle. Each pilot's note adds their mean climb percentile within shared thermals, so " +
    'few stops can be read together with climb strength.',
  compute(field: FieldContext): MetricOutput {
    const pctByPilot = sharedClimbPercentiles(field);
    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null) return na(p);
      if (p.score.flownDistance < MIN_FLOWN_DISTANCE_METERS) return na(p);
      const count = postSssThermals(p).length;
      const value = count / (p.score.flownDistance / 100_000);
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
  label: 'Search fraction of the speed section',
  shortLabel: 'Search%',
  unit: 'pct',
  family: 'decision',
  direction: 'lower',
  explanation:
    'Share of speed-section time (start to ESS, or landing) spent searching — neither climbing ' +
    'in a thermal nor gliding with real net speed. Lower means less time leaks away between ' +
    'climbs.',
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
  climbsPer100km,
  searchFraction,
];
