// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Gaggle metric family — how each pilot uses (or avoids) the field around
 * them. All cross-pilot proximity comes from the Stage 0 foundation
 * (`field.gaggles` over the shared time grid, `field.sharedThermals`) — this
 * file never re-runs detectors and never loops per-fix across pilots.
 *
 * Metrics 16–18 of docs/2026-07-18-field-analysis-plan.md:
 *   gaggle.affinity          — share of post-start flying time spent in a gaggle
 *   gaggle.marker_usage      — share of climbs entered on another pilot's marker
 *   gaggle.departure_winrate — did leaving a still-flying gaggle pay off?
 *
 * All three are direction-neutral: the Spearman sign against GAP rank is the
 * finding (does gaggle flying pay on this day, or does independence?).
 */

import { median } from '../stats';
import type { FieldContext, MetricComputer, MetricOutput, PilotMetricValue } from '../types';

/** A marker must have entered the thermal at least this long before the pilot. */
const MARKER_LEAD_MS = 30_000;

/** Minimum post-SSS thermal uses before marker usage is meaningful. */
const MIN_MARKER_USES = 3;

/** A departure only counts when the gaggle keeps flying at least this long after it. */
const MIN_CONTINUATION_SECONDS = 120;

/** ... and keeps at least this many remaining members in every later snapshot. */
const MIN_REMAINING_MEMBERS = 2;

/** Minimum stayers who reached the leaver's next turnpoint, for a fair median. */
const MIN_COMPARATORS = 2;

/**
 * gaggle.affinity — % of a pilot's sampled grid steps from SSS onwards where
 * they appear in some gaggle episode's membership snapshot.
 *
 * Membership is looked up via a per-step index built once from the episodes'
 * timelines (snapshot t is relative seconds = stepIndex × stepSeconds), so the
 * whole metric is O(timeline entries + pilots × steps).
 */
const affinity: MetricComputer = {
  id: 'gaggle.affinity',
  label: 'Gaggle affinity (post-start time in a gaggle)',
  shortLabel: 'Affinity',
  unit: 'pct',
  family: 'gaggle',
  direction: 'neutral',
  explanation:
    "Share of a pilot's post-start flying time spent inside a detected gaggle " +
    '(clustered with at least one other racing pilot on the shared time grid). ' +
    'Neutral: the correlation sign says whether sticking with company paid on the day.',
  compute(field: FieldContext): MetricOutput {
    const { grid, gaggles } = field;

    // step index → set of pilotIndexes inside some gaggle at that step.
    const stepMembers: (Set<number> | null)[] = new Array(grid.count).fill(null);
    for (const ep of gaggles.episodes) {
      for (const snap of ep.timeline) {
        const step = Math.round(snap.t / grid.stepSeconds);
        if (step < 0 || step >= grid.count) continue;
        let set = stepMembers[step];
        if (!set) stepMembers[step] = set = new Set<number>();
        for (const m of snap.members) set.add(m);
      }
    }

    const stepMs = grid.stepSeconds * 1000;
    const perPilot = field.pilots.map((p): PilotMetricValue => {
      if (p.sssMs === null || p.track.endStep < 0) {
        return { trackFile: p.trackFile, value: null };
      }
      // First grid step whose absolute time is at/after the pilot's start.
      const firstStep = Math.max(0, Math.ceil((p.sssMs - grid.t0Ms) / stepMs));
      let sampled = 0;
      let inGaggle = 0;
      for (let i = firstStep; i <= p.track.endStep; i++) {
        if (!p.track.samples[i]) continue;
        sampled++;
        if (stepMembers[i]?.has(p.pilotIndex)) inGaggle++;
      }
      if (sampled === 0) return { trackFile: p.trackFile, value: null };
      return { trackFile: p.trackFile, value: (100 * inGaggle) / sampled };
    });

    const eps = gaggles.episodes;
    const peak = eps.reduce((m, e) => Math.max(m, e.peakSize), 0);
    const fieldSummary = [
      eps.length === 0
        ? 'No gaggle episodes detected outside the start cylinder.'
        : `${eps.length} gaggle episode${eps.length === 1 ? '' : 's'} detected (peak size ${peak} pilots).`,
    ];
    return { perPilot, fieldSummary };
  },
};

/**
 * gaggle.marker_usage — of the pilot's post-SSS thermal uses, the % entered
 * while another pilot was already established (≥ 30 s) and still climbing in
 * the same shared thermal.
 */
const markerUsage: MetricComputer = {
  id: 'gaggle.marker_usage',
  label: "Marker usage (climbs entered on another pilot's climb)",
  shortLabel: 'Marked%',
  unit: 'pct',
  family: 'gaggle',
  direction: 'neutral',
  explanation:
    "Share of a pilot's post-start climbs where another pilot was already established " +
    '(at least 30 s) and still climbing in the same thermal when they joined. ' +
    "High = climbs on others' markers; low = finds their own lift.",
  compute(field: FieldContext): MetricOutput {
    const uses = field.pilots.map(() => 0);
    const marked = field.pilots.map(() => 0);

    for (const st of field.sharedThermals) {
      for (const use of st.uses) {
        const pilot = field.pilots[use.pilotIndex];
        if (!pilot || pilot.sssMs === null || use.startMs < pilot.sssMs) continue;
        uses[use.pilotIndex]++;
        const wasMarked = st.uses.some(
          (o) =>
            o.pilotIndex !== use.pilotIndex &&
            o.startMs <= use.startMs - MARKER_LEAD_MS &&
            o.endMs >= use.startMs,
        );
        if (wasMarked) marked[use.pilotIndex]++;
      }
    }

    const perPilot = field.pilots.map((p): PilotMetricValue => {
      const n = uses[p.pilotIndex];
      if (n < MIN_MARKER_USES) return { trackFile: p.trackFile, value: null };
      const m = marked[p.pilotIndex];
      return {
        trackFile: p.trackFile,
        value: (100 * m) / n,
        note: `${m}/${n} climbs marked`,
      };
    });
    return { perPilot };
  },
};

/**
 * gaggle.departure_winrate — for each time a pilot left a gaggle that kept
 * flying (≥ 120 s more, ≥ 2 remaining members), did they beat the median of
 * the stayers to the next turnpoint they reached?
 */
const departureWinrate: MetricComputer = {
  id: 'gaggle.departure_winrate',
  label: 'Gaggle departure win rate',
  shortLabel: 'DepartWin',
  unit: 'pct',
  family: 'gaggle',
  direction: 'neutral',
  // Verbatim per the plan — this metric must be self-explanatory.
  explanation:
    'When a pilot leaves a gaggle that keeps flying, did leaving pay off? We compare the ' +
    "leaver's arrival at the next turnpoint against the median arrival of the pilots who " +
    'stayed. Win rate > 50% means their departures beat the gaggle.',
  compute(field: FieldContext): MetricOutput {
    const { grid } = field;
    const wins = field.pilots.map(() => 0);
    const departures = field.pilots.map(() => 0);

    for (const ep of field.gaggles.episodes) {
      const timeline = ep.timeline;
      if (timeline.length < 2) continue;

      // Each pilot's last snapshot in this episode (present at k, absent after).
      const lastSeen = new Map<number, number>();
      for (let k = 0; k < timeline.length; k++) {
        for (const m of timeline[k].members) lastSeen.set(m, k);
      }
      const lastT = timeline[timeline.length - 1].t;

      for (const [pilotIndex, k] of lastSeen) {
        if (k === timeline.length - 1) continue; // stayed until the episode ended
        const tDep = timeline[k].t;
        if (lastT - tDep < MIN_CONTINUATION_SECONDS) continue;

        // The gaggle must keep ≥ 2 remaining members after the departure.
        let keptFlying = true;
        for (let j = k + 1; j < timeline.length; j++) {
          let remaining = 0;
          for (const m of timeline[j].members) if (m !== pilotIndex) remaining++;
          if (remaining < MIN_REMAINING_MEMBERS) {
            keptFlying = false;
            break;
          }
        }
        if (!keptFlying) continue;

        const leaver = field.pilots[pilotIndex];
        if (!leaver) continue;
        const tAbsMs = grid.t0Ms + tDep * 1000;
        const next = leaver.score.turnpointResult.sequence.find(
          (r) => r.time.getTime() > tAbsMs,
        );
        if (!next) continue;

        // Comparators: pilots in the departure snapshot (minus the leaver)
        // who also reached that same turnpoint.
        const comparatorTimes: number[] = [];
        for (const m of timeline[k].members) {
          if (m === pilotIndex) continue;
          const stayer = field.pilots[m];
          const r = stayer?.score.turnpointResult.sequence.find(
            (s) => s.taskIndex === next.taskIndex,
          );
          if (r) comparatorTimes.push(r.time.getTime());
        }
        if (comparatorTimes.length < MIN_COMPARATORS) continue;

        departures[pilotIndex]++;
        if (next.time.getTime() < median(comparatorTimes)) wins[pilotIndex]++;
      }
    }

    const perPilot = field.pilots.map((p): PilotMetricValue => {
      const d = departures[p.pilotIndex];
      if (d === 0) return { trackFile: p.trackFile, value: null };
      const w = wins[p.pilotIndex];
      return {
        trackFile: p.trackFile,
        value: (100 * w) / d,
        note: `${w}W–${d - w}L (${d} departure${d === 1 ? '' : 's'})`,
      };
    });
    return { perPilot };
  },
};

export const GAGGLE_METRICS: MetricComputer[] = [affinity, markerUsage, departureWinrate];
