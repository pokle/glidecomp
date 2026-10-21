// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Race-craft metric family (Stage 1 package P5, metrics 19–23 of
 * docs/2026-07-18-field-analysis-plan.md): start execution, the leg-by-leg
 * time waterfall, the turnpoint-by-turnpoint horserace, ESS altitude margin,
 * and final-glide initiation.
 *
 * Everything here is derived from the retained GAP `turnpointResult` (crossing
 * times, gates), the shared time grid, and the optimized leg distances — no
 * detector is re-run and no geo math is inlined (project rules).
 */

import type {
  FieldContext,
  MetricComputer,
  MetricOutput,
  PilotAnalysisContext,
  PilotMetricValue,
  CategoricalReportSeries,
  ReportCell,
  ReportTable,
} from '../types';
import type { TurnpointReaching } from '../../turnpoint-sequence-types';

type LatLon = { lat: number; lon: number };
import { combineWindEstimates, mean, median } from '../stats';
import { allNullPerPilot, na } from './util';
import { stepFor } from '../resample';
import { ellipsoidDistance, localEastNorth } from '../../geo';
import { getEffectiveESSIndex, getEffectiveSSSIndex, getGoalIndex } from '../../xctsk-parser';
import { optimizeRemainingRoute } from '../../task-optimizer';
import { resolveGoalAltitude, stoppedGlideRatio } from '../../gap-stopped';

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** "m:ss" (negative values get a leading '-'). */
function fmtMinSec(seconds: number): string {
  const neg = seconds < 0;
  const abs = Math.round(Math.abs(seconds));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}`;
}

/** Signed "m:ss" offset: "+1:23" / "-0:45" (zero renders "+0:00"). */
function fmtSignedMinSec(seconds: number): string {
  return seconds < 0 ? fmtMinSec(seconds) : `+${fmtMinSec(seconds)}`;
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/** The top min(n, field) pilots by rank (pilots are sorted rank-ascending). */
function topByRank(field: FieldContext, n = 10): PilotAnalysisContext[] {
  return field.pilots.slice(0, Math.min(n, field.pilots.length));
}

/**
 * A pilot's official start time (epoch ms): the gate taken in a gated race,
 * else their own SSS crossing (elapsed-time convention). Null = never started.
 */
function officialStartMs(p: PilotAnalysisContext): number | null {
  const tr = p.score.turnpointResult;
  if (!tr.sssReaching) return null;
  return tr.startGate ? tr.startGate.time.getTime() : tr.sssReaching.time.getTime();
}

/** Short label for a task turnpoint: SSS/ESS role names, else the waypoint name. */
function tpLabel(field: FieldContext, taskIndex: number, sssIdx: number, essIdx: number): string {
  if (taskIndex === sssIdx) return 'SSS';
  if (taskIndex === essIdx) return 'ESS';
  const name = field.task.turnpoints[taskIndex]?.waypoint.name ?? '';
  return trunc(name, 6) || `TP${taskIndex + 1}`;
}

/**
 * The pilot's reaching for a task position: sequence entry, with the resolved
 * sssReaching/essReaching taking precedence for those roles.
 */
function reachingAt(
  p: PilotAnalysisContext,
  taskIndex: number,
  sssIdx: number,
  essIdx: number,
): TurnpointReaching | null {
  const tr = p.score.turnpointResult;
  if (taskIndex === sssIdx && tr.sssReaching) return tr.sssReaching;
  if (taskIndex === essIdx && tr.essReaching) return tr.essReaching;
  return tr.sequence.find((r) => r.taskIndex === taskIndex) ?? null;
}

/**
 * Speed-section leg times (seconds) for one pilot, keyed "from-to". A leg is
 * a consecutive pair of reachings within [sssIdx, essIdx] whose task indices
 * are adjacent (a pair spanning a gap is not a completed leg).
 */
function speedSectionLegTimes(
  p: PilotAnalysisContext,
  sssIdx: number,
  essIdx: number,
): Map<string, number> {
  const seq = p.score.turnpointResult.sequence.filter(
    (r) => r.taskIndex >= sssIdx && r.taskIndex <= essIdx,
  );
  const times = new Map<string, number>();
  for (let i = 0; i + 1 < seq.length; i++) {
    const a = seq[i];
    const b = seq[i + 1];
    if (b.taskIndex !== a.taskIndex + 1) continue;
    times.set(`${a.taskIndex}-${b.taskIndex}`, (b.time.getTime() - a.time.getTime()) / 1000);
  }
  return times;
}

// ---------------------------------------------------------------------------
// 19 — race.start_delay
// ---------------------------------------------------------------------------

const startDelay: MetricComputer = {
  id: 'race.start_delay',
  label: 'How long after the gate opened the pilot started',
  shortLabel: 'StartDly',
  unit: 's',
  family: 'racecraft',
  direction: 'lower',
  /** Directional names for a surface that claims a winner — see
   * MetricWinningPhrasings. */
  winning: {
    more: 'Starting well after the gate opened',
    less: 'Timing the start gate well',
  },
  explanation:
    'Every second between the opening of the gate and the crossing of the start line is a ' +
    'second lost for nothing. The value is the seconds from the start gate taken to the scored ' +
    'SSS crossing. On an elapsed-time task, the pilot’s own crossing is the reference, so the ' +
    'delay is 0 by definition. The start table adds the crossing altitude, and the distance ' +
    'behind the leading pilot who had already started.',
  compute(field): MetricOutput {
    const sssIdx = getEffectiveSSSIndex(field.task);
    const nextIdx = sssIdx >= 0 && sssIdx + 1 < field.task.turnpoints.length ? sssIdx + 1 : -1;
    const nextEN =
      nextIdx >= 0
        ? localEastNorth(
            field.origin.lat,
            field.origin.lon,
            field.task.turnpoints[nextIdx].waypoint.lat,
            field.task.turnpoints[nextIdx].waypoint.lon,
          )
        : null;

    /** Remaining ENU distance to the next turnpoint's center at a grid step. */
    const remainingAt = (p: PilotAnalysisContext, step: number): number | null => {
      if (!nextEN || step < 0) return null;
      const s = p.track.samples[step];
      if (!s) return null;
      return Math.hypot(s.east - nextEN.east, s.north - nextEN.north);
    };

    const perPilot: PilotMetricValue[] = [];
    const rows: string[][] = [];
    for (const p of field.pilots) {
      const tr = p.score.turnpointResult;
      if (!tr.sssReaching || p.sssMs === null) {
        perPilot.push(na(p));
        continue;
      }
      const gateMs = tr.startGate?.time.getTime() ?? p.sssMs;
      const delay = (p.sssMs - gateMs) / 1000;
      perPilot.push({ trackFile: p.trackFile, value: delay });

      const bandPct = field.workingBand.bandFraction(tr.sssReaching.altitude) * 100;
      let behindCell = '—';
      const step = stepFor(field.grid, p.sssMs);
      const own = remainingAt(p, step);
      if (own !== null) {
        let minRemaining = own;
        for (const q of field.pilots) {
          if (q === p || q.sssMs === null || q.sssMs > p.sssMs) continue;
          const r = remainingAt(q, step);
          if (r !== null && r < minRemaining) minRemaining = r;
        }
        behindCell = ((own - minRemaining) / 1000).toFixed(1);
      }
      rows.push([
        trunc(p.pilotName, 20),
        fmtMinSec(delay),
        String(Math.round(tr.sssReaching.altitude)),
        bandPct.toFixed(0),
        behindCell,
      ]);
    }

    const table: ReportTable = {
      title: 'Start execution',
      columns: [
        { header: 'Pilot', align: 'left' },
        { header: 'Delay', align: 'right' },
        { header: 'Alt m', align: 'right' },
        { header: 'Band %', align: 'right' },
        { header: 'Behind km', align: 'right' },
      ],
      rows,
      footnotes: [
        'Delay = gate taken → SSS crossing. Behind km = extra distance to the next turnpoint vs ' +
          'the furthest-along already-started pilot at the moment of this start (time grid).',
      ],
    };

    return { perPilot, extraTables: rows.length > 0 ? [table] : undefined };
  },
};

// ---------------------------------------------------------------------------
// 20 — race.leg_time_lost (the waterfall)
// ---------------------------------------------------------------------------

const legTimeLost: MetricComputer = {
  id: 'race.leg_time_lost',
  label: 'Race time lost against the fastest pilots, leg by leg',
  shortLabel: 'TimeLost',
  unit: 's',
  family: 'racecraft',
  direction: 'lower',
  outcome: true,
  explanation:
    'For each completed speed-section leg, we compare the leg time of the pilot with the mean ' +
    'of the top 10 pilots by rank who completed that leg. Only the losses count, and we add ' +
    'them together. The sum of the leg times is the race time, and the rank defines the ' +
    'reference, so this metric follows the result by construction. Read the waterfall table, ' +
    'which shows every leg against the task winner, for the diagnosis. Do not read the ' +
    'correlation as a finding.',
  compute(field): MetricOutput {
    const sssIdx = getEffectiveSSSIndex(field.task);
    const essIdx = getEffectiveESSIndex(field.task);
    if (sssIdx < 0 || essIdx <= sssIdx) {
      return { perPilot: allNullPerPilot(field) };
    }

    const legKeys: { from: number; to: number; key: string }[] = [];
    for (let i = sssIdx; i < essIdx; i++) legKeys.push({ from: i, to: i + 1, key: `${i}-${i + 1}` });

    const timesByPilot = new Map<string, Map<string, number>>();
    for (const p of field.pilots) {
      timesByPilot.set(p.trackFile, speedSectionLegTimes(p, sssIdx, essIdx));
    }

    // Reference B: mean leg time of the top-10-by-rank pilots who completed the leg.
    const top = topByRank(field);
    const topMeanByLeg = new Map<string, number>();
    for (const leg of legKeys) {
      const vals: number[] = [];
      for (const p of top) {
        const t = timesByPilot.get(p.trackFile)?.get(leg.key);
        if (t !== undefined) vals.push(t);
      }
      if (vals.length > 0) topMeanByLeg.set(leg.key, mean(vals));
    }

    // Reference A: the winner's (rank 1 = first pilot) leg times drive the table cells.
    const winnerTimes =
      field.pilots.length > 0
        ? timesByPilot.get(field.pilots[0].trackFile)!
        : new Map<string, number>();

    const perPilot: PilotMetricValue[] = [];
    const rows: string[][] = [];
    const seriesPilots: CategoricalReportSeries['perPilot'] = [];
    for (const p of field.pilots) {
      const own = timesByPilot.get(p.trackFile)!;
      if (own.size === 0) {
        perPilot.push(na(p));
        continue;
      }
      let lost = 0;
      for (const [key, t] of own) {
        const ref = topMeanByLeg.get(key);
        if (ref !== undefined) lost += Math.max(0, t - ref);
      }
      perPilot.push({ trackFile: p.trackFile, value: lost });

      const cells: string[] = [];
      const points: (number | null)[] = [];
      let totalVsWinner = 0;
      let comparedLegs = 0;
      for (const leg of legKeys) {
        const t = own.get(leg.key);
        const w = winnerTimes.get(leg.key);
        if (t === undefined || w === undefined) {
          cells.push('—');
          points.push(null);
        } else {
          cells.push(fmtSignedMinSec(t - w));
          points.push(t - w);
          totalVsWinner += t - w;
          comparedLegs++;
        }
      }
      rows.push([
        trunc(p.pilotName, 20),
        ...cells,
        comparedLegs > 0 ? fmtSignedMinSec(totalVsWinner) : '—',
      ]);
      seriesPilots.push({ trackFile: p.trackFile, points });
    }

    const table: ReportTable = {
      title: 'Leg waterfall — leg time vs the task winner',
      columns: [
        { header: 'Pilot', align: 'left' },
        ...legKeys.map((leg) => ({
          header: `${tpLabel(field, leg.from, sssIdx, essIdx)}→${tpLabel(field, leg.to, sssIdx, essIdx)}`,
          align: 'right' as const,
        })),
        { header: 'Total', align: 'right' },
      ],
      rows,
      footnotes: [
        'Each cell is the leg time of this pilot minus the leg time of the winner. A + value is ' +
          'slower than the winner, and a − value is faster. A — means that the pilot or the ' +
          'winner did not complete the leg.',
        `The scalar metric instead adds the losses against the mean of the top ${top.length} ` +
          'pilots who completed each leg. A leg flown faster than that reference contributes 0.',
      ],
    };

    // The table's data twin: signed seconds vs the winner, per leg, for the
    // waterfall chart.
    const series: CategoricalReportSeries = {
      id: 'race.leg_time_lost.waterfall',
      title: table.title,
      kind: 'waterfall',
      xLabels: legKeys.map(
        (leg) =>
          `${tpLabel(field, leg.from, sssIdx, essIdx)}→${tpLabel(field, leg.to, sssIdx, essIdx)}`,
      ),
      yUnit: 's',
      perPilot: seriesPilots,
    };

    return {
      perPilot,
      extraTables: rows.length > 0 ? [table] : undefined,
      extraSeries: seriesPilots.length > 0 ? [series] : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// 21 — race.time_behind (the horserace)
// ---------------------------------------------------------------------------

const timeBehind: MetricComputer = {
  id: 'race.time_behind',
  label: 'Race time behind the leader at ESS',
  shortLabel: 'Behind',
  unit: 'min',
  family: 'racecraft',
  direction: 'lower',
  outcome: true,
  explanation:
    'At each speed-section turnpoint, we compare the elapsed race time of the pilot, which is ' +
    'the reaching time minus their own start, with the fastest pilot to that turnpoint. The ' +
    'value is the minutes behind at ESS. It follows the final rank almost exactly, because this ' +
    'metric is the sanity check of the evaluation.',
  compute(field): MetricOutput {
    const sssIdx = getEffectiveSSSIndex(field.task);
    const essIdx = getEffectiveESSIndex(field.task);
    const goalIdx = getGoalIndex(field.task);
    if (sssIdx < 0 || essIdx <= sssIdx) {
      return { perPilot: allNullPerPilot(field) };
    }

    const tpIndices: number[] = [];
    for (let i = sssIdx; i <= essIdx; i++) tpIndices.push(i);
    if (goalIdx > essIdx) tpIndices.push(goalIdx);

    // Per started pilot: seconds from own start to reaching each tpIndices[k].
    const elapsedByPilot = new Map<string, (number | null)[]>();
    const minElapsed: (number | null)[] = tpIndices.map(() => null);
    for (const p of field.pilots) {
      const startMs = officialStartMs(p);
      if (startMs === null) continue;
      const elapsed = tpIndices.map((idx, k) => {
        const r = reachingAt(p, idx, sssIdx, essIdx);
        if (!r) return null;
        const e = (r.time.getTime() - startMs) / 1000;
        const cur = minElapsed[k];
        if (cur === null || e < cur) minElapsed[k] = e;
        return e;
      });
      elapsedByPilot.set(p.trackFile, elapsed);
    }

    const essCol = tpIndices.indexOf(essIdx);
    const perPilot: PilotMetricValue[] = [];
    const rows: string[][] = [];
    const seriesPilots: CategoricalReportSeries['perPilot'] = [];
    for (const p of field.pilots) {
      const elapsed = elapsedByPilot.get(p.trackFile);
      if (!elapsed) {
        perPilot.push(na(p));
        continue;
      }
      const behindMin = elapsed.map((e, k) => {
        const min = minElapsed[k];
        return e === null || min === null ? null : (e - min) / 60;
      });
      const essBehind = p.score.turnpointResult.essReaching ? behindMin[essCol] : null;
      perPilot.push({ trackFile: p.trackFile, value: essBehind });
      rows.push([
        trunc(p.pilotName, 20),
        ...behindMin.map((b) => (b === null ? '—' : b.toFixed(1))),
      ]);
      seriesPilots.push({ trackFile: p.trackFile, points: behindMin });
    }

    const table: ReportTable = {
      title: 'Horserace — minutes behind the leader at each turnpoint',
      columns: [
        { header: 'Pilot', align: 'left' },
        ...tpIndices.map((idx) => ({
          header: trunc(field.task.turnpoints[idx].waypoint.name || `TP${idx + 1}`, 8),
          align: 'right' as const,
        })),
      ],
      rows,
      footnotes: [
        'The elapsed race time, from the pilot’s own start, minus the fastest elapsed time to ' +
          'that turnpoint. A — means that the pilot did not reach the turnpoint.',
      ],
    };

    // The table's data twin: minutes behind at each turnpoint, for the
    // horserace chart.
    const series: CategoricalReportSeries = {
      id: 'race.time_behind.horserace',
      title: table.title,
      kind: 'horserace',
      xLabels: tpIndices.map((idx) =>
        trunc(field.task.turnpoints[idx].waypoint.name || `TP${idx + 1}`, 8),
      ),
      yUnit: 'min',
      perPilot: seriesPilots,
    };

    return {
      perPilot,
      extraTables: rows.length > 0 ? [table] : undefined,
      extraSeries: seriesPilots.length > 0 ? [series] : undefined,
    };
  },
};

// ---------------------------------------------------------------------------
// 22 — race.ess_margin
// ---------------------------------------------------------------------------

const essMargin: MetricComputer = {
  id: 'race.ess_margin',
  label: 'Arriving at ESS with height to spare',
  shortLabel: 'Spare m',
  unit: 'm',
  family: 'racecraft',
  direction: 'lower',
  /** Directional names for a surface that claims a winner — see
   * MetricWinningPhrasings. */
  winning: {
    more: 'Arriving at ESS with height to spare',
    less: 'Arriving at ESS with nothing left over',
  },
  explanation:
    'Height still available at ESS that the pilot no longer needed. That altitude was available ' +
    'for more speed, and the pilot did not use it. The value is the altitude at ESS minus the altitude ' +
    'needed to glide to goal at the standard glide ratio of the sport, which is 5.0 for HG and ' +
    '4.0 for PG (S7F §13.4.6). A large positive margin means the pilot arrived too high. A ' +
    'margin near zero means they flew the final glide with little height to spare.',
  compute(field): MetricOutput {
    const goalIdx = getGoalIndex(field.task);
    const goalWp = goalIdx >= 0 ? field.task.turnpoints[goalIdx].waypoint : null;
    const goalAlt = resolveGoalAltitude(field.task);
    const ratio = stoppedGlideRatio(field.category === 'pg' ? 'PG' : 'HG');

    const perPilot: PilotMetricValue[] = [];
    const margins = new Map<string, number>();
    for (const p of field.pilots) {
      const ess = p.score.turnpointResult.essReaching;
      if (!ess || !goalWp) {
        perPilot.push(na(p));
        continue;
      }
      const distanceToGoal = ellipsoidDistance(ess.latitude, ess.longitude, goalWp.lat, goalWp.lon);
      const required = goalAlt + distanceToGoal / ratio;
      const margin = ess.altitude - required;
      margins.set(p.trackFile, margin);
      perPilot.push({ trackFile: p.trackFile, value: margin });
    }

    const fieldSummary: string[] = [];
    if (margins.size > 0) {
      const top = topByRank(field);
      const topSet = new Set(top.map((p) => p.trackFile));
      const topVals: number[] = [];
      const restVals: number[] = [];
      for (const [trackFile, m] of margins) {
        (topSet.has(trackFile) ? topVals : restVals).push(m);
      }
      const part = (label: string, vals: number[]) =>
        vals.length > 0 ? `${label} median ${Math.round(median(vals))} m (n=${vals.length})` : null;
      const parts = [part(`top-${top.length}`, topVals), part('rest', restVals)].filter(
        (s): s is string => s !== null,
      );
      fieldSummary.push(`ESS altitude margin over final glide: ${parts.join(' vs ')}.`);
    }

    return { perPilot, fieldSummary: fieldSummary.length > 0 ? fieldSummary : undefined };
  },
};

// ---------------------------------------------------------------------------
// 23 — race.final_glide_init
// ---------------------------------------------------------------------------

/**
 * Legs shorter than this are ignored when anchoring the final-glide distance
 * gate. On the standard "ESS at goal" layout the last leg is the zero-length
 * hop between the co-located ESS and goal cylinders, and 1.5 × 0 would reject
 * every pilot (#626). The final glide runs from the last climb back up the
 * course, so the gate belongs on the last leg of real length.
 */
const MIN_FINAL_LEG_METERS = 1000;

/** Centre-drift estimates the last climb needs before its wind is trusted. */
const MIN_FINAL_GLIDE_WIND_CIRCLES = 3;
/** A shorter glide gives no stable ground speed to time the wind over. */
const MIN_FINAL_GLIDE_SECONDS = 60;
/**
 * Slower than this over the ground, it was not a glide. A pilot far above
 * glide who spirals off height near goal takes minutes over a few kilometres
 * (Corryong 2026 T1: 1,600 m over 3.6 km at 18 km/h), and dividing the wind by
 * that speed would "correct" a glide that never needed it. 407 of the
 * archive's 408 measured final glides were faster.
 */
const MIN_FINAL_GLIDE_SPEED_MPS = 7;
/** The share by which the wind must move the ratio to be counted as changing it. */
const THROUGH_AIR_CHANGE = 0.1;

interface ThroughAir {
  /** Wind component along the line to goal, km/h; negative is a headwind. */
  tailwindKmh: number;
  /** Through-the-air ratio ÷ over-the-ground ratio. */
  factor: number;
}

/**
 * How the wind the pilot's own last climb measured changes the glide they
 * committed to. The glide to goal takes D / vg at the pilot's made-good
 * ground speed vg, and over that time the air moves W·t, so the path through
 * the air is D·û − W·D/vg and the ratio scales by |û − W/vg|. A route that
 * still turns at a turnpoint is summed leg by leg, each leg weighted by its
 * length. Over the archive this moves the committed ratio by 10% or more for
 * 41% of ESS pilots (docs/2026-10-20-logger-interval-evidence.md, "Final
 * glide").
 *
 * Centre drift only, combined by the shared policy, like day.wind. Null when
 * the climb has too few estimates or the glide too little time or speed.
 */
function throughTheAir(
  p: PilotAnalysisContext,
  thermal: PilotAnalysisContext['thermals'][number],
  route: { line: LatLon[]; distance: number },
  end: { ms: number; lat: number; lon: number; inGoal: boolean },
): ThroughAir | null {
  const samples = p.circles.circles
    .filter((c) => c.startIndex >= thermal.startIndex && c.endIndex <= thermal.endIndex)
    .flatMap((c) => (c.windFromCenterDrift ? [c.windFromCenterDrift] : []));
  if (samples.length < MIN_FINAL_GLIDE_WIND_CIRCLES) return null;
  const wind = combineWindEstimates(samples);
  if (!wind) return null;

  const exit = p.fixes[thermal.endIndex];
  const seconds = (end.ms - exit.time.getTime()) / 1000;
  if (seconds < MIN_FINAL_GLIDE_SECONDS) return null;
  // In goal, the pilot flew the route; landed out, only as far as the field.
  const made = end.inGoal
    ? route.distance
    : ellipsoidDistance(exit.latitude, exit.longitude, end.lat, end.lon);
  const groundSpeed = made / seconds;
  if (groundSpeed < MIN_FINAL_GLIDE_SPEED_MPS) return null;

  // Wind FROM `direction` blows toward direction + 180°.
  const rad = (wind.direction * Math.PI) / 180;
  const wx = -wind.speed * Math.sin(rad);
  const wy = -wind.speed * Math.cos(rad);
  let total = 0;
  let tail = 0;
  let air = 0;
  for (let i = 1; i < route.line.length; i++) {
    const a = route.line[i - 1];
    const b = route.line[i];
    const leg = localEastNorth(a.lat, a.lon, b.lat, b.lon);
    const length = Math.hypot(leg.east, leg.north);
    if (length <= 0) continue;
    const ux = leg.east / length;
    const uy = leg.north / length;
    total += length;
    tail += length * (wx * ux + wy * uy);
    air += length * Math.hypot(ux - wx / groundSpeed, uy - wy / groundSpeed);
  }
  if (total <= 0) return null;
  return { tailwindKmh: (tail / total) * 3.6, factor: air / total };
}

/**
 * The last task index a pilot had reached at `ms` (−1 before the first).
 * The remaining route from a fix runs through every turnpoint after it.
 */
function lastReachedBefore(p: PilotAnalysisContext, ms: number): number {
  const tr = p.score.turnpointResult;
  let last = -1;
  for (const r of [...tr.sequence, tr.sssReaching, tr.essReaching]) {
    if (r && r.time.getTime() <= ms && r.taskIndex > last) last = r.taskIndex;
  }
  return last;
}

const finalGlideInit: MetricComputer = {
  id: 'race.final_glide_init',
  label: 'Final glide committed to when leaving the last climb',
  shortLabel: 'FinalGl',
  unit: 'ratio',
  family: 'racecraft',
  direction: 'neutral',
  /** Directional names for a surface that claims a winner — see
   * MetricWinningPhrasings. */
  winning: {
    more: 'High required glide ratio on final glide',
    less: 'Low required glide ratio on final glide',
  },
  explanation:
    'How optimistic the pilot was about their final glide. A pilot wins or loses a task by the ' +
    'height at which they leave the last climb. At the last climb of the pilot before goal, or ' +
    'before the landing, we divide the distance still to fly to goal, through every turnpoint ' +
    'not yet reached, by their height above goal. That is the ' +
    'glide ratio they committed to. 8 means they left and needed 8:1 to make goal. The value ' +
    'counts only when that climb ended within 1.5 times the length of the last course leg ' +
    'longer than 1 km from goal — when ESS and goal share a waypoint, the zero-length hop ' +
    'between them is not that leg. There is no expected direction: a marginal glide wins if ' +
    'it connects, and loses if it does not. We also give the ratio through the air. The ' +
    'pilot’s own last climb measured the wind, and we remove its effect over the time the ' +
    'glide took. A tailwind makes the glide easier than the number over the ground, and a ' +
    'headwind makes it harder.',
  compute(field): MetricOutput {
    const goalIdx = getGoalIndex(field.task);
    const goalWp = goalIdx >= 0 ? field.task.turnpoints[goalIdx].waypoint : null;
    const goalAlt = resolveGoalAltitude(field.task);
    const lastLeg =
      [...field.legs].reverse().find((l) => l.optimizedMeters > MIN_FINAL_LEG_METERS) ?? null;
    const maxDistance = lastLeg ? 1.5 * lastLeg.optimizedMeters : null;

    const perPilot: PilotMetricValue[] = [];
    const airRows: ReportCell[][] = [];
    let changed = 0;
    for (const p of field.pilots) {
      if (!goalWp || maxDistance === null || p.sssMs === null) {
        perPilot.push(na(p));
        continue;
      }
      // The final glide ends at GOAL, not ESS: with ESS short of goal, most
      // pilots climb again after ESS (Bright 2023 T1: 31 of 49), and that
      // climb is the final one (engine review 6.2).
      const goalReaching =
        p.score.turnpointResult.madeGoal
          ? p.score.turnpointResult.sequence.find((r) => r.taskIndex === goalIdx) ?? null
          : null;
      const landing = p.fixes[p.landingIndex];
      const end = goalReaching
        ? {
            ms: goalReaching.time.getTime(),
            lat: goalReaching.latitude,
            lon: goalReaching.longitude,
            inGoal: true,
          }
        : landing
          ? { ms: landing.time.getTime(), lat: landing.latitude, lon: landing.longitude, inGoal: false }
          : null;
      if (!end) {
        perPilot.push(na(p));
        continue;
      }
      // Last post-SSS thermal whose exit is before goal (or landing).
      let last: { exitMs: number; thermal: (typeof p.thermals)[number] } | null = null;
      for (const t of p.thermals) {
        const exitFix = p.fixes[t.endIndex];
        if (!exitFix) continue;
        const exitMs = exitFix.time.getTime();
        if (exitMs < p.sssMs) continue;
        if (exitMs > end.ms) continue;
        if (!last || exitMs > last.exitMs) last = { exitMs, thermal: t };
      }
      if (!last) {
        perPilot.push(na(p));
        continue;
      }
      const exitFix = p.fixes[last.thermal.endIndex];
      // The distance still to fly is the optimised route from the exit
      // through every turnpoint not yet reached to the goal's edge — the
      // straight line to the goal centre ignored a turnpoint still ahead
      // (37 % of HG values) and could be a ninth of the real glide.
      const route = optimizeRemainingRoute(
        field.task,
        lastReachedBefore(p, last.exitMs),
        { lat: exitFix.latitude, lon: exitFix.longitude },
      );
      const height = last.thermal.endAltitude - goalAlt;
      if (!route || route.distance > maxDistance || height <= 0) {
        perPilot.push(na(p));
        continue;
      }
      const ratio = route.distance / height;
      perPilot.push({
        trackFile: p.trackFile,
        value: ratio,
        note: `left last climb ${(route.distance / 1000).toFixed(1)} km from goal at ${Math.round(
          last.thermal.endAltitude,
        )} m`,
      });
      const air = throughTheAir(p, last.thermal, route, end);
      if (air) {
        if (Math.abs(air.factor - 1) >= THROUGH_AIR_CHANGE) changed++;
        const tail = Math.round(air.tailwindKmh);
        airRows.push([
          p.pilotName,
          ratio.toFixed(1),
          tail > 0 ? `+${tail}` : String(tail),
          (ratio * air.factor).toFixed(1),
        ]);
      }
    }

    if (airRows.length === 0) return { perPilot };
    const n = airRows.length;
    return {
      perPilot,
      fieldSummary: [
        `Through the air, the wind changed the committed glide by 10% or more for ${changed} of ${n} pilot${n === 1 ? '' : 's'}.`,
      ],
      extraTables: [
        {
          title: 'Final glide through the air',
          columns: [
            { header: 'Pilot', align: 'left' },
            { header: 'Over the ground', align: 'right' },
            { header: 'Tailwind (km/h)', align: 'right' },
            { header: 'Through the air', align: 'right' },
          ],
          rows: airRows,
          footnotes: ['A negative tailwind is a headwind.'],
        },
      ],
    };
  },
};

export const RACECRAFT_METRICS: MetricComputer[] = [
  startDelay,
  legTimeLost,
  timeBehind,
  essMargin,
  finalGlideInit,
];
