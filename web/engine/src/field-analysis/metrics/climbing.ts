// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Climbing metric family (Stage 1, P1) — how well each pilot climbs, split
 * from WHERE they chose to climb. Shared thermals rank centering skill inside
 * the same air; the rest read each pilot's own thermals, circling segments and
 * fitted circles. Metrics only read the precomputed FieldContext (project
 * rule: never re-run detectors, no nested per-fix loops across pilots).
 * Specs: docs/2026-07-18-field-analysis-plan.md §"P1 climbing" (metrics 1–6).
 */

import type { IGCFix } from '../../igc-parser';
import type { ThermalSegment } from '../../event-types';
import type { MetricComputer, PilotMetricValue } from '../types';
import { mean, median } from '../stats';
import { hhmmInZone, zoneToken } from '../format-time';

/** Fix altitude with the same pressure fallback the resampler uses. */
function fixAlt(f: IGCFix): number {
  return f.gnssAltitude !== 0 ? f.gnssAltitude : f.pressureAltitude;
}

function fixMs(f: IGCFix): number {
  return f.time.getTime();
}

/** Thermal start time (epoch ms) from its start fix; null when out of range. */
function thermalStartMs(fixes: IGCFix[], t: ThermalSegment): number | null {
  const f = fixes[t.startIndex];
  return f ? fixMs(f) : null;
}

// ---------------------------------------------------------------------------
// 1. climb.shared_percentile
// ---------------------------------------------------------------------------

const sharedPercentile: MetricComputer = {
  id: 'climb.shared_percentile',
  label: 'Climb rate vs field in shared thermals',
  shortLabel: 'SharedPct',
  unit: 'pct',
  family: 'climbing',
  direction: 'higher',
  explanation:
    'In every thermal two or more pilots used, each use is ranked by average climb rate; a use’s ' +
    'percentile is the share of strictly slower uses. The value is the duration-weighted mean ' +
    'percentile over the pilot’s shared climbs — centering skill isolated from thermal selection.',
  compute(field) {
    const n = field.pilots.length;
    const weightedSum = new Array<number>(n).fill(0);
    const weight = new Array<number>(n).fill(0);
    const useCount = new Array<number>(n).fill(0);

    for (const st of field.sharedThermals) {
      if (st.pilotCount < 2) continue;
      const uses = st.uses;
      if (uses.length < 2) continue;
      for (const u of uses) {
        let slower = 0;
        for (const v of uses) {
          if (v.avgClimbRate < u.avgClimbRate) slower++;
        }
        const pct = (100 * slower) / (uses.length - 1);
        const durationMs = Math.max(1, u.endMs - u.startMs);
        weightedSum[u.pilotIndex] += pct * durationMs;
        weight[u.pilotIndex] += durationMs;
        useCount[u.pilotIndex]++;
      }
    }

    return {
      perPilot: field.pilots.map((p): PilotMetricValue => {
        const i = p.pilotIndex;
        if (weight[i] <= 0) return { trackFile: p.trackFile, value: null };
        return {
          trackFile: p.trackFile,
          value: weightedSum[i] / weight[i],
          note: `${useCount[i]} shared climb${useCount[i] === 1 ? '' : 's'}`,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// 2. climb.time_to_core
// ---------------------------------------------------------------------------

const ROLLING_WINDOW_MS = 30_000;
const CORE_FRACTION = 0.9;
const MIN_CORE_THERMAL_SECONDS = 60;

/**
 * Seconds from thermal start until the 30 s rolling climb rate first reaches
 * 90% of its in-thermal peak. Null when no positive peak exists.
 */
function timeToCoreSeconds(fixes: IGCFix[], seg: ThermalSegment): number | null {
  const startFix = fixes[seg.startIndex];
  if (!startFix) return null;
  const startMs = fixMs(startFix);

  const rates: { tMs: number; rate: number }[] = [];
  let j = seg.startIndex;
  for (let i = seg.startIndex + 1; i <= seg.endIndex; i++) {
    const fi = fixes[i];
    if (!fi) break;
    const ti = fixMs(fi);
    while (j < i && ti - fixMs(fixes[j]) > ROLLING_WINDOW_MS) j++;
    const k = j < i ? j : i - 1;
    const dtSeconds = (ti - fixMs(fixes[k])) / 1000;
    if (dtSeconds <= 0) continue;
    rates.push({ tMs: ti, rate: (fixAlt(fi) - fixAlt(fixes[k])) / dtSeconds });
  }
  if (rates.length === 0) return null;

  let peak = -Infinity;
  for (const r of rates) peak = Math.max(peak, r.rate);
  if (peak <= 0) return null;

  const threshold = CORE_FRACTION * peak;
  for (const r of rates) {
    if (r.rate >= threshold) return (r.tMs - startMs) / 1000;
  }
  return null;
}

const timeToCore: MetricComputer = {
  id: 'climb.time_to_core',
  label: 'Time to core a thermal',
  shortLabel: 'Core s',
  unit: 's',
  family: 'climbing',
  direction: 'lower',
  explanation:
    'For each thermal of at least 60 s, the seconds from entering until the 30 s rolling climb ' +
    'rate first reaches 90% of its peak in that thermal. The value is the median across the ' +
    'pilot’s thermals — how fast they centre the best lift after arriving.',
  compute(field) {
    return {
      perPilot: field.pilots.map((p): PilotMetricValue => {
        const values: number[] = [];
        for (const t of p.thermals) {
          if (t.duration < MIN_CORE_THERMAL_SECONDS) continue;
          const ttc = timeToCoreSeconds(p.fixes, t);
          if (ttc !== null) values.push(ttc);
        }
        if (values.length === 0) return { trackFile: p.trackFile, value: null };
        return {
          trackFile: p.trackFile,
          value: median(values),
          note: `${values.length} climb${values.length === 1 ? '' : 's'} ≥ 60 s`,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// 3. climb.exit_decay
// ---------------------------------------------------------------------------

const EXIT_WINDOW_MS = 30_000;
const MIN_DECAY_THERMAL_SECONDS = 90;

/** Climb rate (m/s) over the final 30 s of a thermal segment. */
function exitDecayRate(fixes: IGCFix[], seg: ThermalSegment): number | null {
  const endFix = fixes[seg.endIndex];
  if (!endFix) return null;
  const endMs = fixMs(endFix);
  for (let i = seg.endIndex; i >= seg.startIndex; i--) {
    if (endMs - fixMs(fixes[i]) >= EXIT_WINDOW_MS) {
      const dtSeconds = (endMs - fixMs(fixes[i])) / 1000;
      return (fixAlt(endFix) - fixAlt(fixes[i])) / dtSeconds;
    }
  }
  return null;
}

const exitDecay: MetricComputer = {
  id: 'climb.exit_decay',
  label: 'Climb rate over the last 30 s of each thermal',
  shortLabel: 'ExitDecay',
  unit: 'm/s',
  family: 'climbing',
  direction: 'neutral',
  explanation:
    'For each thermal of at least 90 s, the climb rate over its final 30 s — the "give-up rate". ' +
    'The value is the median: low means the pilot abandons weakening lift early, high means they ' +
    'ride climbs to the end; the correlation sign says which behaviour paid on this task.',
  compute(field) {
    return {
      perPilot: field.pilots.map((p): PilotMetricValue => {
        const values: number[] = [];
        for (const t of p.thermals) {
          if (t.duration < MIN_DECAY_THERMAL_SECONDS) continue;
          const rate = exitDecayRate(p.fixes, t);
          if (rate !== null) values.push(rate);
        }
        if (values.length === 0) return { trackFile: p.trackFile, value: null };
        return {
          trackFile: p.trackFile,
          value: median(values),
          note: `${values.length} climb${values.length === 1 ? '' : 's'} ≥ 90 s`,
        };
      }),
    };
  },
};

// ---------------------------------------------------------------------------
// 4. climb.selectivity
// ---------------------------------------------------------------------------

const MIN_ENCOUNTER_SECONDS = 30;
const MIN_ENCOUNTERS = 3;

const selectivity: MetricComputer = {
  id: 'climb.selectivity',
  label: 'Share of circling encounters accepted as climbs',
  shortLabel: 'Accept%',
  unit: 'pct',
  family: 'climbing',
  direction: 'neutral',
  explanation:
    'Post-start circling bouts of at least 30 s are lift encounters; one that overlaps a detected ' +
    'thermal was accepted, otherwise the pilot circled and rejected the lift. The value is the ' +
    'percentage accepted — low means picky, high means they take almost everything they turn in.',
  compute(field) {
    // hour bucket (epoch ms) → per-pilot acceptance percentages in that hour.
    const hourly = new Map<number, number[]>();

    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null) return { trackFile: p.trackFile, value: null };
      const sssMs = p.sssMs;

      let encounters = 0;
      let accepted = 0;
      const byHour = new Map<number, { acc: number; tot: number }>();
      for (const seg of p.circles.circlingSegments) {
        const start = p.fixes[seg.startIndex];
        const end = p.fixes[seg.endIndex];
        if (!start || !end) continue;
        const startMs = fixMs(start);
        if (startMs < sssMs) continue;
        if ((fixMs(end) - startMs) / 1000 < MIN_ENCOUNTER_SECONDS) continue;

        const isAccepted = p.thermals.some(
          (t) => t.startIndex <= seg.endIndex && seg.startIndex <= t.endIndex,
        );
        encounters++;
        if (isAccepted) accepted++;

        const hour = Math.floor(startMs / 3_600_000) * 3_600_000;
        const bucket = byHour.get(hour) ?? { acc: 0, tot: 0 };
        bucket.tot++;
        if (isAccepted) bucket.acc++;
        byHour.set(hour, bucket);
      }

      for (const [hour, bucket] of byHour) {
        let list = hourly.get(hour);
        if (!list) hourly.set(hour, (list = []));
        list.push((100 * bucket.acc) / bucket.tot);
      }

      if (encounters < MIN_ENCOUNTERS) return { trackFile: p.trackFile, value: null };
      return {
        trackFile: p.trackFile,
        value: (100 * accepted) / encounters,
        note: `${accepted}/${encounters} circling bouts led to climbs`,
      };
    });

    let fieldSummary: string[] | undefined;
    if (hourly.size > 0) {
      const sorted = [...hourly.entries()].sort(([a], [b]) => a - b);
      const parts = sorted.map(([hour, pcts]) => {
        const hh = hhmmInZone(hour, field.timeZone);
        return `${hh} ${Math.round(median(pcts))}% (${pcts.length} pilot${pcts.length === 1 ? '' : 's'})`;
      });
      const token = zoneToken(sorted[0][0], field.timeZone);
      fieldSummary = [`Median acceptance by hour (${token}): ${parts.join(' · ')}`];
    }

    return { perPilot, fieldSummary };
  },
};

// ---------------------------------------------------------------------------
// 5. climb.departure_band
// ---------------------------------------------------------------------------

/** Stride for the mean on-course altitude sample (feeds a note, not the value). */
const ON_COURSE_FIX_STRIDE = 5;

const departureBand: MetricComputer = {
  id: 'climb.departure_band',
  label: 'Thermal departure altitude as % of the working band',
  shortLabel: 'ExitBand%',
  unit: 'pct',
  family: 'climbing',
  direction: 'neutral',
  explanation:
    'The altitude at which the pilot left each post-start thermal, as a percentage of the day’s ' +
    'working band (0% = field floor, 100% = field ceiling); the value is the median. High means ' +
    'topping out every climb, low means leaving early with climb still available.',
  compute(field) {
    const band = field.workingBand;

    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null) return { trackFile: p.trackFile, value: null };

      const exits: number[] = [];
      for (const t of p.thermals) {
        const startMs = thermalStartMs(p.fixes, t);
        if (startMs === null || startMs < p.sssMs) continue;
        exits.push(100 * band.bandFraction(t.endAltitude));
      }
      if (exits.length === 0) return { trackFile: p.trackFile, value: null };

      // Note: the pilot's mean altitude on course (post-start), as band %.
      const onCourse: number[] = [];
      for (let i = p.takeoffIndex; i <= p.landingIndex; i += ON_COURSE_FIX_STRIDE) {
        const f = p.fixes[i];
        if (!f || fixMs(f) < p.sssMs) continue;
        onCourse.push(100 * band.bandFraction(fixAlt(f)));
      }
      return {
        trackFile: p.trackFile,
        value: median(exits),
        note:
          onCourse.length > 0
            ? `mean on-course altitude ${Math.round(mean(onCourse))}% of band`
            : undefined,
      };
    });

    return {
      perPilot,
      fieldSummary: band.usedFallback
        ? [
            'Working band fell back to fix altitudes (too few field thermals) — band percentages are approximate.',
          ]
        : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// 6. climb.circle_smoothness
// ---------------------------------------------------------------------------

const MIN_CIRCLES = 10;

const circleSmoothness: MetricComputer = {
  id: 'climb.circle_smoothness',
  label: 'Circle fit error relative to circle radius',
  shortLabel: 'Smooth',
  unit: 'ratio',
  family: 'climbing',
  direction: 'lower',
  explanation:
    'Each detected circle is least-squares fitted; its RMS fit error divided by the fitted radius ' +
    'measures how round the turn really was. The value is the median over all the pilot’s ' +
    'circles — lower means smoother, more consistent turning.',
  compute(field) {
    let fieldLeft = 0;
    let fieldTotal = 0;

    const perPilot = field.pilots.map((p): PilotMetricValue => {
      const ratios: number[] = [];
      let left = 0;
      for (const c of p.circles.circles) {
        fieldTotal++;
        if (c.turnDirection === 'left') {
          fieldLeft++;
          left++;
        }
        if (c.fittedCircle.radiusMeters > 0) {
          ratios.push(c.fittedCircle.fitErrorRMS / c.fittedCircle.radiusMeters);
        }
      }
      const total = p.circles.circles.length;
      return {
        trackFile: p.trackFile,
        value: ratios.length >= MIN_CIRCLES ? median(ratios) : null,
        note: total > 0 ? `${total} circles, ${Math.round((100 * left) / total)}% left` : undefined,
      };
    });

    return {
      perPilot,
      fieldSummary:
        fieldTotal > 0
          ? [
              `Turn direction across the field: ${Math.round((100 * fieldLeft) / fieldTotal)}% left (${fieldTotal} circles).`,
            ]
          : undefined,
    };
  },
};

export const CLIMBING_METRICS: MetricComputer[] = [
  sharedPercentile,
  timeToCore,
  exitDecay,
  selectivity,
  departureBand,
  circleSmoothness,
];
