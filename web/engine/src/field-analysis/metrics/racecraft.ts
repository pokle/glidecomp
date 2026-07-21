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
  ReportTable,
} from '../types';
import type { TurnpointReaching } from '../../turnpoint-sequence-types';
import { mean, median } from '../stats';
import { stepFor } from '../resample';
import { andoyerDistance, localEastNorth } from '../../geo';
import { getEffectiveESSIndex, getEffectiveSSSIndex, getGoalIndex } from '../../xctsk-parser';
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
  label: 'Start delay (gate to crossing)',
  shortLabel: 'StartDly',
  unit: 's',
  family: 'racecraft',
  direction: 'lower',
  explanation:
    'Seconds from the start gate taken (or the pilot’s own crossing on elapsed-time tasks, ' +
    'where the delay is 0 by definition) to the scored SSS crossing. The start table adds ' +
    'crossing altitude and how far behind the leading already-started pilot each start was.',
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
        perPilot.push({ trackFile: p.trackFile, value: null });
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
  label: 'Time lost on speed-section legs',
  shortLabel: 'LegLost',
  unit: 's',
  family: 'racecraft',
  direction: 'lower',
  outcome: true,
  explanation:
    'For each completed speed-section leg, the pilot’s leg time is compared with the mean of the ' +
    'top-10 (by rank) pilots who completed that leg; only losses count, and the losses are summed. ' +
    'Summed leg times are race time and the reference is defined by rank, so this tracks the ' +
    'outcome by construction — read the waterfall table (every leg against the task winner) for ' +
    'the diagnostic, not the correlation for a finding.',
  compute(field): MetricOutput {
    const sssIdx = getEffectiveSSSIndex(field.task);
    const essIdx = getEffectiveESSIndex(field.task);
    if (sssIdx < 0 || essIdx <= sssIdx) {
      return { perPilot: field.pilots.map((p) => ({ trackFile: p.trackFile, value: null })) };
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
        perPilot.push({ trackFile: p.trackFile, value: null });
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
        'Cells: this pilot’s leg time minus the winner’s (+ = slower than the winner, − = faster); ' +
          '— = leg not completed by pilot or winner.',
        `The scalar metric instead sums losses vs the mean of the top ${top.length} pilots who ` +
          'completed each leg (legs flown faster than that reference contribute 0).',
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
  label: 'Time behind the leader at ESS',
  shortLabel: 'Behind',
  unit: 'min',
  family: 'racecraft',
  direction: 'lower',
  outcome: true,
  explanation:
    'At each speed-section turnpoint, elapsed race time (reaching minus own start) is compared with ' +
    'the fastest pilot to that turnpoint; the scalar is minutes behind at ESS. Expected to track ' +
    'final rank almost perfectly — this metric is the eval’s sanity check.',
  compute(field): MetricOutput {
    const sssIdx = getEffectiveSSSIndex(field.task);
    const essIdx = getEffectiveESSIndex(field.task);
    const goalIdx = getGoalIndex(field.task);
    if (sssIdx < 0 || essIdx <= sssIdx) {
      return { perPilot: field.pilots.map((p) => ({ trackFile: p.trackFile, value: null })) };
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
        perPilot.push({ trackFile: p.trackFile, value: null });
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
        'Elapsed race time (from each pilot’s own start) minus the fastest elapsed time to that ' +
          'turnpoint; — = turnpoint not reached.',
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
  label: 'Altitude margin over final glide at ESS',
  shortLabel: 'ESSMargin',
  unit: 'm',
  family: 'racecraft',
  direction: 'lower',
  explanation:
    'Altitude at ESS minus the altitude needed to glide to goal at the sport’s standard glide ' +
    'ratio (S7F §12.3.6: 5.0 HG / 4.0 PG). A big positive margin is altitude — i.e. time — left unspent.',
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
        perPilot.push({ trackFile: p.trackFile, value: null });
        continue;
      }
      const distanceToGoal = andoyerDistance(ess.latitude, ess.longitude, goalWp.lat, goalWp.lon);
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

const finalGlideInit: MetricComputer = {
  id: 'race.final_glide_init',
  label: 'Required glide ratio when leaving the last climb',
  shortLabel: 'FinalGl',
  unit: 'ratio',
  family: 'racecraft',
  direction: 'neutral',
  explanation:
    'At the pilot’s last climb before ESS (or landing): distance to goal divided by height above ' +
    'goal — the glide ratio they committed to. Only counted when that climb ended within 1.5× the ' +
    'final leg’s distance of goal.',
  compute(field): MetricOutput {
    const goalIdx = getGoalIndex(field.task);
    const goalWp = goalIdx >= 0 ? field.task.turnpoints[goalIdx].waypoint : null;
    const goalAlt = resolveGoalAltitude(field.task);
    const lastLeg = field.legs.length > 0 ? field.legs[field.legs.length - 1] : null;
    const maxDistance = lastLeg ? 1.5 * lastLeg.optimizedMeters : null;

    const perPilot: PilotMetricValue[] = [];
    for (const p of field.pilots) {
      if (!goalWp || maxDistance === null || p.sssMs === null) {
        perPilot.push({ trackFile: p.trackFile, value: null });
        continue;
      }
      const endMs = p.essMs ?? p.fixes[p.landingIndex]?.time.getTime() ?? null;
      // Last post-SSS thermal whose exit is before ESS (or landing).
      let last: { exitMs: number; thermal: (typeof p.thermals)[number] } | null = null;
      for (const t of p.thermals) {
        const exitFix = p.fixes[t.endIndex];
        if (!exitFix) continue;
        const exitMs = exitFix.time.getTime();
        if (exitMs < p.sssMs) continue;
        if (endMs !== null && exitMs > endMs) continue;
        if (!last || exitMs > last.exitMs) last = { exitMs, thermal: t };
      }
      if (!last) {
        perPilot.push({ trackFile: p.trackFile, value: null });
        continue;
      }
      const exitFix = p.fixes[last.thermal.endIndex];
      const distanceToGoal = andoyerDistance(
        exitFix.latitude,
        exitFix.longitude,
        goalWp.lat,
        goalWp.lon,
      );
      const height = last.thermal.endAltitude - goalAlt;
      if (distanceToGoal > maxDistance || height <= 0) {
        perPilot.push({ trackFile: p.trackFile, value: null });
        continue;
      }
      perPilot.push({
        trackFile: p.trackFile,
        value: distanceToGoal / height,
        note: `left last climb ${(distanceToGoal / 1000).toFixed(1)} km out at ${Math.round(
          last.thermal.endAltitude,
        )} m`,
      });
    }

    return { perPilot };
  },
};

export const RACECRAFT_METRICS: MetricComputer[] = [
  startDelay,
  legTimeLost,
  timeBehind,
  essMargin,
  finalGlideInit,
];
