// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Climbing metric family (Stage 1, P1) — how well each pilot climbs, split
 * from WHERE they chose to climb. Shared thermals rank centering skill inside
 * the same air; the rest read each pilot's own thermals, circling segments and
 * fitted circles. Metrics only read the precomputed FieldContext (project
 * rule: never re-run detectors, no nested per-fix loops across pilots).
 * Specs: docs/2026-07-18-field-analysis-plan.md §"P1 climbing" (metrics 1–6).
 */

import { fixAltitude as fixAlt, type IGCFix } from '../../igc-parser';
import type { ThermalSegment } from '../../event-types';
import type { MetricComputer, PilotMetricValue, ReportCell, ReportTable } from '../types';
import { mean, median } from '../stats';
import { sharedClimbPercentiles } from '../shared-thermals';
import { hourStartMs, pushInto } from '../util';
import { fixMs, na } from './util';

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
  label: 'Climbing faster than the pilots sharing the thermal',
  shortLabel: 'Out-climb',
  unit: 'pct',
  family: 'climbing',
  direction: 'higher',
  explanation:
    'When this pilot and other pilots were in the SAME thermal, who climbed faster? In every ' +
    'thermal that two pilots or more used, we rank each use by its average climb rate. The ' +
    'percentile of a use is the share of uses that were strictly slower. The value is the ' +
    'duration-weighted mean percentile over the shared climbs of the pilot. 50% is exactly ' +
    'average. 80% means they climbed faster than four in five of the pilots they shared lift ' +
    'with. The shared thermal is what separates centring skill from thermal selection: a pilot ' +
    'who only found better air gets no higher value here.',
  compute(field) {
    const n = field.pilots.length;
    const weightedSum = new Array<number>(n).fill(0);
    const weight = new Array<number>(n).fill(0);
    const useCount = new Array<number>(n).fill(0);

    // The ranking is shared-thermals' sharedClimbPercentiles; the duration
    // weighting of each use is this metric's own.
    for (const { use: u, percentile: pct } of sharedClimbPercentiles(field.sharedThermals)) {
      const durationMs = Math.max(1, u.endMs - u.startMs);
      weightedSum[u.pilotIndex] += pct * durationMs;
      weight[u.pilotIndex] += durationMs;
      useCount[u.pilotIndex]++;
    }

    return {
      perPilot: field.pilots.map((p): PilotMetricValue => {
        const i = p.pilotIndex;
        if (weight[i] <= 0) return na(p);
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
  label: 'Time to core thermals',
  shortLabel: 'Core s',
  unit: 's',
  family: 'climbing',
  direction: 'lower',
  explanation:
    'How long the pilot takes to get into the best lift after they arrive in a thermal. For ' +
    'each thermal of 60 s or more, we measure the seconds from the entry until the 30 s rolling ' +
    'climb rate first reaches 90% of its peak in that thermal. The value is the median across ' +
    'the thermals of the pilot. Every second here is a second spent climbing slower than the ' +
    'thermal can carry them.',
  compute(field) {
    return {
      perPilot: field.pilots.map((p): PilotMetricValue => {
        const values: number[] = [];
        for (const t of p.thermals) {
          if (t.duration < MIN_CORE_THERMAL_SECONDS) continue;
          const ttc = timeToCoreSeconds(p.fixes, t);
          if (ttc !== null) values.push(ttc);
        }
        if (values.length === 0) return na(p);
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
  label: 'Climb rate at thermal exit',
  shortLabel: 'LeaveRate',
  unit: 'm/s',
  family: 'climbing',
  direction: 'neutral',
  explanation:
    'The median climb rate that the pilot left thermals at. For each thermal of 90 s or more, we take the climb ' +
    'rate over its final 30 s. A high value means they leave lift that still works. ' +
    'A low value means they stay in a climb until nothing is left. ' +
    'This is an absolute rate, so read it against the day: compare it with the ' +
    'median climb in "How strong the day’s climbs were". A pilot who leaves at 1.5 m/s leaves a ' +
    'good climb on a 1 m/s day, and takes the worst lift available on a 4 m/s day. There is no ' +
    'expected direction. The sign of the correlation says which behaviour paid on this task.',
  compute(field) {
    return {
      perPilot: field.pilots.map((p): PilotMetricValue => {
        const values: number[] = [];
        for (const t of p.thermals) {
          if (t.duration < MIN_DECAY_THERMAL_SECONDS) continue;
          const rate = exitDecayRate(p.fixes, t);
          if (rate !== null) values.push(rate);
        }
        if (values.length === 0) return na(p);
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
  label: 'Share of lift turned in that was kept as a climb',
  shortLabel: 'Kept%',
  unit: 'pct',
  family: 'climbing',
  direction: 'neutral',
  explanation:
    'How selective the pilot is about the lift they stop for. Each period of circling of 30 s ' +
    'or more after the start counts as lift that the pilot sampled. If the period overlaps a ' +
    'detected thermal, the pilot kept that lift. If it does not, they turned a few circles and ' +
    'left it. The value is the percentage kept. A low value means they are selective. A high ' +
    'value means they keep almost every climb they turn in. There is no expected direction: ' +
    'selection wins on a strong day and wastes time on a weak one.',
  compute(field) {
    // hour bucket (epoch ms) → per-pilot acceptance percentages in that hour.
    const hourly = new Map<number, number[]>();

    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null) return na(p);
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

        const hour = hourStartMs(startMs);
        const bucket = byHour.get(hour) ?? { acc: 0, tot: 0 };
        bucket.tot++;
        if (isAccepted) bucket.acc++;
        byHour.set(hour, bucket);
      }

      for (const [hour, bucket] of byHour) {
        pushInto(hourly, hour, (100 * bucket.acc) / bucket.tot);
      }

      if (encounters < MIN_ENCOUNTERS) return na(p);
      return {
        trackFile: p.trackFile,
        value: (100 * accepted) / encounters,
        note: `${accepted}/${encounters} circling bouts led to climbs`,
      };
    });

    // Acceptance-by-hour as a table of instants (the consumer renders each
    // hour in the reader's zone) rather than a "HH:00 UTC" prose line.
    let extraTables: ReportTable[] | undefined;
    if (hourly.size > 0) {
      const rows: ReportCell[][] = [...hourly.entries()]
        .sort(([a], [b]) => a - b)
        .map(([hour, pcts]) => [
          { t: new Date(hour).toISOString() },
          String(Math.round(median(pcts))),
          String(pcts.length),
        ]);
      extraTables = [
        {
          title: 'Acceptance by hour',
          columns: [
            { header: 'Hour', align: 'left' },
            { header: 'Median accepted (%)', align: 'right' },
            { header: 'pilots', align: 'right' },
          ],
          rows,
          footnotes: ['Median per-pilot acceptance %, bucketed by the hour (competition time zone).'],
        },
      ];
    }

    return { perPilot, extraTables };
  },
};

// ---------------------------------------------------------------------------
// 5. climb.departure_band
// ---------------------------------------------------------------------------

/** Stride for the mean on-course altitude sample (feeds a note, not the value). */
const ON_COURSE_FIX_STRIDE = 5;

const departureBand: MetricComputer = {
  id: 'climb.departure_band',
  label: 'How much of the thermal the pilot climbed before leaving it',
  shortLabel: 'TopOut%',
  unit: 'pct',
  family: 'climbing',
  direction: 'neutral',
  explanation:
    'Does the pilot climb to the top of every thermal, or leave with lift still above them? We ' +
    'take the altitude where they left each thermal after the start, as a percentage of the ' +
    'day’s working band. 0% is the floor of the field and 100% is its ceiling. The value is the ' +
    'median. There is no expected direction: a climb to the top buys height in reserve, and an ' +
    'early departure buys time.',
  compute(field) {
    const band = field.workingBand;

    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null) return na(p);

      const exits: number[] = [];
      for (const t of p.thermals) {
        const startMs = thermalStartMs(p.fixes, t);
        if (startMs === null || startMs < p.sssMs) continue;
        exits.push(100 * band.bandFraction(t.endAltitude));
      }
      if (exits.length === 0) return na(p);

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
  label: 'How round and consistent the circles were',
  shortLabel: 'Round',
  unit: 'ratio',
  family: 'climbing',
  direction: 'lower',
  explanation:
    'Whether the pilot flies clean, repeatable circles, or moves around the thermal. We fit ' +
    'each detected circle by least squares. The RMS fit error divided by the fitted radius ' +
    'measures how round the turn was. The value is the median over all of the circles of the ' +
    'pilot. A lower value means smoother and more consistent turns.',
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
