/**
 * Score explanation builder.
 *
 * Turns a pilot's scored result into a structured, human-readable
 * explanation of every decision that shaped the score: the flight
 * narrative (start crossings — including re-entries and which crossing
 * was scored — turnpoint reachings, ESS, goal or best progress), the
 * task validity and available points, and each point component with the
 * formula and its substituted inputs.
 *
 * The output is pure data (sections → items) so it can be unit-tested,
 * rendered as prose by any UI, and each item can carry a map anchor
 * (coordinates + time) so the UI can show the supporting evidence on a
 * map.
 *
 * Authoritative point values come from the caller (the published score);
 * this module never re-scores — it explains the numbers it is given,
 * deriving only presentation values (fractions, formula substitutions)
 * from the same inputs the scorer used.
 */

import type { XCTask, Turnpoint } from './xctsk-parser';
import {
  getEffectiveSSSIndex,
  getEffectiveESSIndex,
  getGoalIndex,
} from './xctsk-parser';
import type {
  TurnpointSequenceResult,
  TurnpointReaching,
} from './turnpoint-sequence';
import type { GAPParameters } from './gap-scoring';
import { DEFAULT_GAP_PARAMETERS, calculateSpeedFraction } from './gap-scoring';
import type { OpenDistanceGeometry } from './open-distance-scoring';
import type { IGCFix } from './igc-parser';

// ---------------------------------------------------------------------------
// Output types
// ---------------------------------------------------------------------------

/** What an anchored item points at — lets the UI pick a marker style. */
export type ExplanationAnchorKind =
  | 'start'
  | 'start_candidate'
  | 'turnpoint'
  | 'ess'
  | 'goal'
  | 'best_progress'
  | 'origin'
  | 'furthest';

/** A location on the track/task that an explanation item refers to. */
export interface ExplanationAnchor {
  kind: ExplanationAnchorKind;
  latitude: number;
  longitude: number;
  /** GNSS altitude in metres, when known. */
  altitude?: number;
  /** Epoch milliseconds, when known (JSON-safe). */
  timeMs?: number;
}

/** One explainable fact or step in the calculation. */
export interface ScoreExplanationItem {
  id: string;
  /** Primary human-readable sentence. */
  text: string;
  /** Short figure shown alongside the text, e.g. "12:45:03" or "343.2 pts". */
  value?: string;
  /** Secondary line, e.g. the formula with substituted values. */
  detail?: string;
  /** Rendering hint: muted = supporting fact, warning = scoring caveat. */
  emphasis?: 'normal' | 'muted' | 'warning';
  /** Where this happened — lets the UI pan a map to the evidence. */
  anchor?: ExplanationAnchor;
}

export type ScoreExplanationSectionId =
  | 'flight'
  | 'validity'
  | 'distance'
  | 'time'
  | 'leading'
  | 'arrival'
  | 'penalty'
  | 'total';

export interface ScoreExplanationSection {
  id: ScoreExplanationSectionId;
  title: string;
  /** One-line section summary. */
  summary?: string;
  /** The points this section contributed, when it is a point component. */
  points?: number;
  items: ScoreExplanationItem[];
}

export interface ScoreExplanation {
  format: 'gap' | 'open_distance';
  /** One-sentence outcome, e.g. "Made goal in 1:42:07 — 845 points". */
  headline: string;
  sections: ScoreExplanationSection[];
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

/**
 * The published (authoritative) score for the pilot — snake_case so the
 * competition API's PilotScoreEntry can be passed straight through.
 */
export interface ScoreEntryInput {
  made_goal: boolean;
  reached_ess: boolean;
  /** Scored distance in metres (minimum-distance floor already applied). */
  flown_distance: number;
  speed_section_time: number | null;
  distance_points: number;
  distance_linear_points: number;
  distance_difficulty_points: number;
  time_points: number;
  leading_points: number;
  arrival_points: number;
  penalty_points: number;
  penalty_reason: string | null;
  total_score: number;
  /** Seconds started before the first start gate (S7F §12.2), when early. */
  early_start_seconds?: number | null;
  /** How the early start reshaped the score — see engine PilotScore. */
  early_start_outcome?: 'pg_launch_to_sss' | 'hg_penalty' | 'hg_min_distance' | null;
  /** Automatic jump-the-gun penalty points deducted (HG early starts). */
  jump_the_gun_penalty?: number | null;
}

/** The pilot's class context — the field the score was computed against. */
export interface ClassContextInput {
  task_validity: { launch: number; distance: number; time: number; task: number };
  available_points: {
    distance: number;
    time: number;
    leading: number;
    arrival: number;
    total: number;
  };
  /** Every scored pilot in the class (including this one). */
  pilots: Array<{
    flown_distance: number;
    speed_section_time: number | null;
    made_goal: boolean;
    reached_ess: boolean;
  }>;
}

export interface ExplainGapScoreInput {
  /**
   * The task the turnpoint sequence was resolved against — after any
   * distance-origin trim (see {@link taskForDistanceOrigin}), so that
   * `result.sequence[].taskIndex` lines up with `task.turnpoints`.
   */
  task: XCTask;
  /** The pilot's resolved turnpoint sequence (transparency data). */
  result: TurnpointSequenceResult;
  /** The published score being explained. */
  entry: ScoreEntryInput;
  /** The class the pilot was scored in. */
  classContext: ClassContextInput;
  /** The comp's GAP parameters (defaults applied for missing fields). */
  params?: Partial<GAPParameters>;
  /** Time formatter — defaults to UTC HH:MM:SS. */
  formatTime?: (d: Date) => string;
}

/** Time/altitude for an open-distance anchor when fixes aren't at hand. */
export interface OpenDistanceAnchorInfo {
  timeMs?: number;
  altitude?: number;
}

export interface ExplainOpenDistanceInput {
  /** The task (first turnpoint is the launch cylinder). */
  task: XCTask;
  /** The scored geometry, or null when the flight could not be scored. */
  geometry: OpenDistanceGeometry | null;
  /** The pilot's fixes — used to timestamp the origin/furthest anchors. */
  fixes?: IGCFix[];
  /**
   * Anchor time/altitude supplied directly (e.g. from the competition API's
   * analysis endpoint, which has the fixes server-side). Takes precedence
   * over the `fixes` lookup.
   */
  anchorInfo?: {
    origin?: OpenDistanceAnchorInfo;
    furthest?: OpenDistanceAnchorInfo;
  };
  /** The published score being explained. */
  entry: Pick<
    ScoreEntryInput,
    'flown_distance' | 'penalty_points' | 'penalty_reason' | 'total_score'
  >;
  formatTime?: (d: Date) => string;
}

// ---------------------------------------------------------------------------
// Formatting helpers (fixed metric — the UI can localise via formatTime)
// ---------------------------------------------------------------------------

function km(meters: number, decimals = 1): string {
  return `${(meters / 1000).toFixed(decimals)} km`;
}

function pts(points: number): string {
  const rounded = Math.round(points * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} pts`;
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(0)}%`;
}

// Floors like the scores tables do, so the same time never differs by a second.
function duration(seconds: number): string {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = m.toString().padStart(2, '0');
  const ss = sec.toString().padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

function defaultFormatTime(d: Date): string {
  return `${d.toISOString().slice(11, 19)} UTC`;
}

/** Human label for a task position: Takeoff / Start / TP3 / ESS / Goal. */
export function turnpointLabel(task: XCTask, taskIndex: number): string {
  const tp: Turnpoint | undefined = task.turnpoints[taskIndex];
  if (!tp) return `TP${taskIndex + 1}`;
  if (tp.type === 'TAKEOFF') return 'Takeoff';
  if (tp.type === 'SSS') return 'Start';
  if (tp.type === 'ESS') return 'ESS';
  if (taskIndex === getGoalIndex(task)) return 'Goal';
  return `TP${taskIndex + 1}`;
}

function turnpointName(task: XCTask, taskIndex: number): string {
  return task.turnpoints[taskIndex]?.waypoint.name ?? '';
}

function reachingAnchor(
  r: TurnpointReaching,
  kind: ExplanationAnchorKind,
): ExplanationAnchor {
  return {
    kind,
    latitude: r.latitude,
    longitude: r.longitude,
    altitude: r.altitude,
    timeMs: r.time.getTime(),
  };
}

// ---------------------------------------------------------------------------
// GAP explanation
// ---------------------------------------------------------------------------

/** Cap on individually listed start crossings — beyond this, summarise. */
const MAX_START_CROSSINGS_LISTED = 12;

/**
 * Build the flight-narrative section: what the pilot flew, in task order,
 * with the reason each crossing was (or wasn't) the one that scored.
 */
function buildFlightSection(
  task: XCTask,
  result: TurnpointSequenceResult,
  entry: ScoreEntryInput,
  fmt: (d: Date) => string,
): ScoreExplanationSection {
  const items: ScoreExplanationItem[] = [];
  const sssIdx = getEffectiveSSSIndex(task);
  const essIdx = getEffectiveESSIndex(task);

  if (result.startFallback === 'first_turnpoint') {
    items.push({
      id: 'start-fallback',
      text: 'This task has no start (SSS) turnpoint — the first turnpoint is treated as the start.',
      emphasis: 'warning',
    });
  }

  if (!result.sssReaching) {
    items.push({
      id: 'no-start',
      text: 'No valid start — the track never crossed the start cylinder in the required direction, so only pre-start progress can score.',
      emphasis: 'warning',
    });
  } else {
    const sss = result.sssReaching;
    const startName = turnpointName(task, sss.taskIndex);

    // Re-entry story: every raw crossing of the start cylinder, so a pilot
    // who went back for a later start can see exactly which exit scored.
    if (sss.candidateCount > 1) {
      const startCrossings = result.crossings.filter(
        (c) => c.taskIndex === sssIdx,
      );
      // Careful wording: the scored crossing can be the first one (later
      // crossings were just flying back through the cylinder mid-task) or a
      // later one (a re-start superseded an earlier start).
      items.push({
        id: 'start-multiple',
        text: `Crossed the start cylinder boundary ${startCrossings.length} times. The scored start is the latest crossing from which the flight still makes its best run along the course — re-starting supersedes an earlier start, while simply flying back through the cylinder later in the task changes nothing.`,
        emphasis: 'muted',
      });
      const listed = startCrossings.slice(0, MAX_START_CROSSINGS_LISTED);
      for (let i = 0; i < listed.length; i++) {
        const c = listed[i];
        const scored = c.time.getTime() === sss.time.getTime();
        items.push({
          id: `start-crossing-${i}`,
          text: scored
            ? `${c.direction === 'enter' ? 'Entered' : 'Exited'} the start cylinder — this is the scored start`
            : `${c.direction === 'enter' ? 'Entered' : 'Exited'} the start cylinder`,
          value: fmt(c.time),
          emphasis: scored ? 'normal' : 'muted',
          anchor: {
            kind: scored ? 'start' : 'start_candidate',
            latitude: c.latitude,
            longitude: c.longitude,
            altitude: c.altitude,
            timeMs: c.time.getTime(),
          },
        });
      }
      if (startCrossings.length > listed.length) {
        items.push({
          id: 'start-crossings-more',
          text: `…and ${startCrossings.length - listed.length} more crossings`,
          emphasis: 'muted',
        });
      }
    } else if (sss.selectionReason === 'track_start') {
      items.push({
        id: 'start',
        text: 'Track began outside the start cylinder — the start is measured from the first fix.',
        value: fmt(sss.time),
        emphasis: 'warning',
        anchor: reachingAnchor(sss, 'start'),
      });
    } else {
      items.push({
        id: 'start',
        text: `Started${startName ? ` at ${startName}` : ''}`,
        value: fmt(sss.time),
        anchor: reachingAnchor(sss, 'start'),
      });
    }

    // Start-gate story (gated races): the official start time is the gate
    // taken, not the crossing — make the snapping visible.
    if (result.earlyStart) {
      items.push({
        id: 'early-start',
        text: `Crossed the start ${duration(result.earlyStart.secondsEarly)} before the first start gate opened at ${fmt(result.earlyStart.firstGateTime)} — an early start ("jumping the gun", FAI S7F §12.2). The speed-section clock runs from the first gate.`,
        emphasis: 'warning',
      });
    } else if (result.startGate) {
      const gate = result.startGate;
      items.push({
        id: 'start-gate',
        text:
          gate.gateCount > 1
            ? `Start time taken: gate ${gate.index + 1} of ${gate.gateCount} — the last start gate at or before the crossing. The speed-section clock runs from the gate, not from the crossing (FAI S7F §8.3.1).`
            : 'Start time taken: the start gate — the speed-section clock runs from the gate, not from the crossing (FAI S7F §8.3.1).',
        value: fmt(gate.time),
        emphasis: 'muted',
      });
    }
  }

  // Turnpoints after the start, in scored order.
  for (const reaching of result.sequence) {
    if (result.sssReaching && reaching.taskIndex <= result.sssReaching.taskIndex) {
      continue; // start handled above; pre-start TPs don't shape the score
    }
    const label = turnpointLabel(task, reaching.taskIndex);
    const name = turnpointName(task, reaching.taskIndex);
    const isESS = reaching.taskIndex === essIdx;
    const isGoal = reaching.taskIndex === getGoalIndex(task);

    let detail: string | undefined;
    if (reaching.candidateCount > 1) {
      detail = `First of ${reaching.candidateCount} crossings — once a turnpoint is reached, later crossings don't matter.`;
    }
    if (isESS) {
      const t = entry.speed_section_time ?? result.speedSectionTime;
      if (t !== null) {
        detail = `Speed section completed in ${duration(t)}.${detail ? ` ${detail}` : ''}`;
      }
      if (result.essFallback === 'last_turnpoint') {
        detail = `${detail ? `${detail} ` : ''}This task has no ESS turnpoint — the last turnpoint is treated as the end of the speed section.`;
      }
    }

    items.push({
      id: `reaching-${reaching.taskIndex}`,
      text: `${isGoal ? 'Goal' : label}${name ? ` — ${name}` : ''}`,
      value: fmt(reaching.time),
      detail,
      anchor: reachingAnchor(reaching, isGoal ? 'goal' : isESS ? 'ess' : 'turnpoint'),
    });
  }

  if (entry.made_goal) {
    items.push({
      id: 'made-goal',
      text: 'Completed the task — full task distance is credited.',
    });
  } else if (result.bestProgress) {
    items.push({
      id: 'best-progress',
      text: `Landed out — closest approach to goal was ${km(result.bestProgress.distanceToGoal)} short`,
      value: fmt(result.bestProgress.time),
      detail: `Scored distance is measured along the task to this point: ${km(entry.flown_distance)}.`,
      anchor: {
        kind: 'best_progress',
        latitude: result.bestProgress.latitude,
        longitude: result.bestProgress.longitude,
        timeMs: result.bestProgress.time.getTime(),
      },
    });
  }

  return {
    id: 'flight',
    title: 'The flight',
    summary: 'What the tracklog shows, and which crossings scored.',
    items,
  };
}

function buildValiditySection(
  classContext: ClassContextInput,
): ScoreExplanationSection {
  const v = classContext.task_validity;
  const ap = classContext.available_points;
  const items: ScoreExplanationItem[] = [
    {
      id: 'launch-validity',
      text: 'Launch validity — did enough registered pilots launch?',
      value: pct(v.launch),
    },
    {
      id: 'distance-validity',
      text: 'Distance validity — did the field fly far enough relative to the nominal distance?',
      value: pct(v.distance),
    },
    {
      id: 'time-validity',
      text: 'Time validity — was the winning time long enough relative to the nominal time?',
      value: pct(v.time),
    },
    {
      id: 'available-total',
      text: 'Points on offer for the day',
      value: pts(ap.total),
      detail: `1000 × ${v.launch.toFixed(2)} × ${v.distance.toFixed(2)} × ${v.time.toFixed(2)} = ${Math.round(ap.total)}`,
    },
    {
      id: 'available-split',
      text: 'Split between the components by the goal ratio',
      detail: [
        `distance ${Math.round(ap.distance)}`,
        `time ${Math.round(ap.time)}`,
        ...(ap.leading > 0 ? [`leading ${Math.round(ap.leading)}`] : []),
        ...(ap.arrival > 0 ? [`arrival ${Math.round(ap.arrival)}`] : []),
      ].join(' · '),
      emphasis: 'muted',
    },
  ];
  return {
    id: 'validity',
    title: 'Day quality — points on offer',
    summary: `Task validity ${pct(v.task)} of a perfect day, so ${Math.round(ap.total)} of 1000 points were available.`,
    items,
  };
}

function buildDistanceSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  result: TurnpointSequenceResult,
  params: GAPParameters,
): ScoreExplanationSection {
  const ap = classContext.available_points;
  const best = Math.max(...classContext.pilots.map((p) => p.flown_distance), 0);
  const useDifficulty =
    params.scoring === 'HG' &&
    params.useDistanceDifficulty &&
    entry.distance_difficulty_points > 0;

  const items: ScoreExplanationItem[] = [];

  if (entry.early_start_outcome === 'pg_launch_to_sss') {
    items.push({
      id: 'early-start-distance',
      text: 'Early start (FAI S7F §12.2): paraglider pilots who start before the first start gate are scored only for the distance from launch to the start cylinder — the rest of the flight earns no points.',
      emphasis: 'warning',
    });
  } else if (entry.early_start_outcome === 'hg_min_distance') {
    items.push({
      id: 'early-start-distance',
      text: `Early start of ${duration(entry.early_start_seconds ?? 0)} — more than the ${params.jumpTheGunMaxSeconds} s jump-the-gun limit (FAI S7F §12.2), so the flight is scored as the minimum distance.`,
      emphasis: 'warning',
    });
  } else if (result.flownDistance < params.minimumDistance) {
    items.push({
      id: 'minimum-distance',
      text: `Flew ${km(result.flownDistance)}, less than the ${km(params.minimumDistance)} minimum — scored as the minimum distance.`,
      emphasis: 'warning',
    });
  }

  items.push({
    id: 'scored-distance',
    text: 'Scored distance',
    value: km(entry.flown_distance),
    detail: 'Measured along the optimized task line, up to the furthest point on course.',
  });
  items.push({
    id: 'best-distance',
    text: 'Best distance in class',
    value: km(best),
    emphasis: 'muted',
  });

  if (entry.made_goal) {
    items.push({
      id: 'distance-formula',
      text: 'Made goal — full available distance points.',
      value: pts(entry.distance_points),
    });
  } else if (useDifficulty) {
    items.push({
      id: 'distance-linear',
      text: 'Linear half — half the available points scale with your share of the best distance',
      value: pts(entry.distance_linear_points),
      detail: `0.5 × (${km(entry.flown_distance)} ÷ ${km(best)}) × ${Math.round(ap.distance)} = ${entry.distance_linear_points.toFixed(1)}`,
    });
    items.push({
      id: 'distance-difficulty',
      text: 'Difficulty half — rewards flying past stretches where many pilots landed',
      value: pts(entry.distance_difficulty_points),
      detail:
        'The difficulty curve is built from where the whole field landed out (FAI S7F §11.1.1).',
    });
  } else {
    items.push({
      id: 'distance-formula',
      text: 'Distance points scale linearly with your share of the best distance',
      value: pts(entry.distance_points),
      detail: `(${km(entry.flown_distance)} ÷ ${km(best)}) × ${Math.round(ap.distance)} available = ${entry.distance_points.toFixed(1)}`,
    });
  }

  return {
    id: 'distance',
    title: 'Distance points',
    points: entry.distance_points,
    items,
  };
}

function buildTimeSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
  result: TurnpointSequenceResult,
  fmt: (d: Date) => string,
): ScoreExplanationSection {
  const ap = classContext.available_points;
  const items: ScoreExplanationItem[] = [];

  // Mirrors calculateTimePoints: PG requires goal, HG requires ESS.
  const qualifies =
    params.scoring === 'PG' ? entry.made_goal : entry.reached_ess;

  const bestTimes = classContext.pilots
    .filter((p) => (params.scoring === 'PG' ? p.made_goal : p.reached_ess))
    .map((p) => p.speed_section_time)
    .filter((t): t is number => t !== null && t > 0);
  const bestTime = bestTimes.length > 0 ? Math.min(...bestTimes) : null;

  if (!qualifies || entry.speed_section_time === null || bestTime === null) {
    items.push({
      id: 'no-time-points',
      text:
        params.scoring === 'PG'
          ? 'Time points are only awarded to pilots who complete the task.'
          : 'Time points are only awarded to pilots who reach the end of the speed section.',
      emphasis: 'muted',
    });
  } else {
    const exponent = params.leadingFormula === 'classic' ? 2 / 3 : 5 / 6;
    const sf = calculateSpeedFraction(
      entry.speed_section_time,
      bestTime,
      exponent,
    );
    items.push({
      id: 'your-time',
      text: 'Your speed section time',
      value: duration(entry.speed_section_time),
      // In a gated race the clock ran from the gate, not the crossing —
      // spell it out so the time never looks wrong next to the tracklog.
      detail: result.startGate
        ? `Timed from your ${fmt(result.startGate.time)} start gate to the end of the speed section (FAI S7F §8.7)${
            result.sssReaching &&
            result.sssReaching.time.getTime() !== result.startGate.time.getTime()
              ? ` — you crossed the start at ${fmt(result.sssReaching.time)}`
              : ''
          }.`
        : undefined,
    });
    items.push({
      id: 'best-time',
      text: 'Fastest time in class',
      value: duration(bestTime),
      emphasis: 'muted',
    });
    if (entry.speed_section_time <= bestTime) {
      items.push({
        id: 'time-formula',
        text: 'Fastest through the speed section — full available time points.',
        value: pts(entry.time_points),
      });
    } else {
      const exponentLabel =
        params.leadingFormula === 'classic' ? '2⁄3' : '5⁄6';
      items.push({
        id: 'time-formula',
        text: 'Time points fall off with the gap to the fastest time',
        value: pts(entry.time_points),
        detail: `speed fraction = max(0, 1 − ((T − Tbest) ÷ √Tbest)^${exponentLabel}) = ${sf.toFixed(3)}; × ${Math.round(ap.time)} available = ${entry.time_points.toFixed(1)} (times in hours)`,
      });
    }
  }

  return {
    id: 'time',
    title: 'Time points',
    points: entry.time_points,
    items,
  };
}

function buildTotalSection(entry: ScoreEntryInput): ScoreExplanationSection {
  const components = [
    entry.distance_points,
    entry.time_points,
    entry.leading_points,
    entry.arrival_points,
  ];
  const sum = Math.round(components.reduce((a, b) => a + b, 0));
  const parts = components
    .filter((c, i) => c > 0 || i < 2) // always show distance + time, others only when earned
    .map((c) => c.toFixed(1))
    .join(' + ');
  const jtg = entry.jump_the_gun_penalty ?? 0;
  let detail: string;
  if (jtg === 0 && entry.penalty_points === 0) {
    detail = `round(${parts}) = ${entry.total_score}`;
  } else {
    const steps = [`round(${parts}) = ${sum}`];
    if (jtg !== 0) {
      steps.push(`− ${jtg} jump-the-gun (never below the minimum-distance score)`);
    }
    if (entry.penalty_points !== 0) {
      steps.push(
        `${entry.penalty_points > 0 ? '−' : '+'} ${Math.abs(entry.penalty_points)} penalty (scores never go below 0)`,
      );
    }
    detail = `${steps.join(' ')} = ${entry.total_score}`;
  }
  return {
    id: 'total',
    title: 'Total',
    points: entry.total_score,
    items: [
      {
        id: 'total-sum',
        text: 'Distance + time + leading + arrival, minus penalties',
        value: `${entry.total_score} pts`,
        detail,
      },
    ],
  };
}

function buildPenaltySection(
  entry: {
    penalty_points: number;
    penalty_reason: string | null;
    early_start_seconds?: number | null;
    jump_the_gun_penalty?: number | null;
  },
  jumpTheGunFactor = DEFAULT_GAP_PARAMETERS.jumpTheGunFactor,
): ScoreExplanationSection | null {
  const jtg = entry.jump_the_gun_penalty ?? 0;
  if (entry.penalty_points === 0 && jtg === 0) return null;
  const items: ScoreExplanationItem[] = [];
  if (jtg > 0) {
    const secs = entry.early_start_seconds ?? 0;
    items.push({
      id: 'jump-the-gun',
      text: `Jump the gun (FAI S7F §12.2): started ${duration(secs)} before the first start gate. The complete flight is scored, with 1 penalty point per ${jumpTheGunFactor} seconds early; the total never drops below the minimum-distance score.`,
      value: `−${jtg} pts`,
      detail: `${Math.round(secs)} s early ÷ ${jumpTheGunFactor} s per point = ${jtg} points`,
      emphasis: 'warning',
    });
  }
  if (entry.penalty_points !== 0) {
    const isBonus = entry.penalty_points < 0;
    items.push({
      id: 'penalty',
      text: entry.penalty_reason || (isBonus ? 'Bonus applied by the scorer.' : 'Penalty applied by the scorer.'),
      value: `${isBonus ? '+' : '−'}${Math.abs(entry.penalty_points)} pts`,
      detail: 'Applied after scoring — see the competition audit log for who applied it and when.',
      emphasis: isBonus ? 'normal' : 'warning',
    });
  }
  const isBonusOnly = jtg === 0 && entry.penalty_points < 0;
  return {
    id: 'penalty',
    title: isBonusOnly ? 'Bonus' : 'Penalty',
    points: -(entry.penalty_points + jtg),
    items,
  };
}

/**
 * Explain a GAP-scored pilot's result.
 *
 * The narrative uses the pilot's resolved turnpoint sequence; the point
 * values come from the published score entry so the explanation always
 * matches the scoreboard.
 */
export function explainGapScore(input: ExplainGapScoreInput): ScoreExplanation {
  const { task, result, entry, classContext } = input;
  const params: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...input.params };
  const fmt = input.formatTime ?? defaultFormatTime;

  const sections: ScoreExplanationSection[] = [
    buildFlightSection(task, result, entry, fmt),
    buildValiditySection(classContext),
    buildDistanceSection(entry, classContext, result, params),
    buildTimeSection(entry, classContext, params, result, fmt),
  ];

  if (classContext.available_points.leading > 0 || entry.leading_points > 0) {
    sections.push({
      id: 'leading',
      title: 'Leading points',
      points: entry.leading_points,
      items: [
        {
          id: 'leading',
          text: 'Leading points reward flying out front during the speed section — the pilot with the best leading coefficient takes all available leading points, others fall off with the gap.',
          value: pts(entry.leading_points),
        },
      ],
    });
  }

  if (classContext.available_points.arrival > 0 || entry.arrival_points > 0) {
    sections.push({
      id: 'arrival',
      title: 'Arrival points',
      points: entry.arrival_points,
      items: [
        {
          id: 'arrival',
          text: 'Arrival points reward crossing the end of the speed section early relative to the other pilots who reached it.',
          value: pts(entry.arrival_points),
        },
      ],
    });
  }

  const penalty = buildPenaltySection(entry, params.jumpTheGunFactor);
  if (penalty) sections.push(penalty);
  sections.push(buildTotalSection(entry));

  let headline: string;
  if (entry.early_start_outcome === 'pg_launch_to_sss') {
    headline = `Early start — scored to the start cylinder only — ${entry.total_score} points`;
  } else if (entry.early_start_outcome === 'hg_min_distance') {
    headline = `Early start beyond the limit — scored minimum distance — ${entry.total_score} points`;
  } else if (entry.made_goal && entry.speed_section_time !== null) {
    headline = `Made goal in ${duration(entry.speed_section_time)} — ${entry.total_score} points`;
  } else if (entry.made_goal) {
    headline = `Made goal — ${entry.total_score} points`;
  } else if (result.sssReaching) {
    headline = `Landed out at ${km(entry.flown_distance)} — ${entry.total_score} points`;
  } else {
    headline = `No valid start — ${entry.total_score} points`;
  }

  return { format: 'gap', headline, sections };
}

// ---------------------------------------------------------------------------
// Open-distance explanation
// ---------------------------------------------------------------------------

/**
 * Explain an open-distance-scored pilot's result: where the scored line
 * starts (the last exit of the launch cylinder), where it ends (the
 * furthest fix), and how that becomes the score.
 */
export function explainOpenDistanceScore(
  input: ExplainOpenDistanceInput,
): ScoreExplanation {
  const { task, geometry, fixes, entry } = input;
  const fmt = input.formatTime ?? defaultFormatTime;
  const launchRadius = task.turnpoints[0]?.radius ?? 0;

  const items: ScoreExplanationItem[] = [];

  if (!geometry || entry.flown_distance <= 0) {
    items.push({
      id: 'no-exit',
      text: `The flight never left the ${km(launchRadius)} launch cylinder — open distance is measured from the cylinder exit, so the flight scores 0.`,
      emphasis: 'warning',
    });
  } else {
    const originFix = fixes?.[geometry.origin.fixIndex];
    const furthestFix = fixes?.[geometry.furthest.fixIndex];
    const originTimeMs =
      input.anchorInfo?.origin?.timeMs ?? originFix?.time.getTime();
    const originAltitude =
      input.anchorInfo?.origin?.altitude ?? originFix?.gnssAltitude;
    const furthestTimeMs =
      input.anchorInfo?.furthest?.timeMs ?? furthestFix?.time.getTime();
    const furthestAltitude =
      input.anchorInfo?.furthest?.altitude ?? furthestFix?.gnssAltitude;
    items.push({
      id: 'origin',
      text: `Left the ${km(launchRadius)} launch cylinder — the scored distance starts here (the last outward crossing counts).`,
      value: originTimeMs !== undefined ? fmt(new Date(originTimeMs)) : undefined,
      anchor: {
        kind: 'origin',
        latitude: geometry.origin.latitude,
        longitude: geometry.origin.longitude,
        altitude: originAltitude,
        timeMs: originTimeMs,
      },
    });
    items.push({
      id: 'furthest',
      text: 'Furthest point reached after the exit — the scored distance ends here.',
      value: furthestTimeMs !== undefined ? fmt(new Date(furthestTimeMs)) : undefined,
      anchor: {
        kind: 'furthest',
        latitude: geometry.furthest.latitude,
        longitude: geometry.furthest.longitude,
        altitude: furthestAltitude,
        timeMs: furthestTimeMs,
      },
    });
    items.push({
      id: 'distance',
      text: 'Straight-line distance between the two points',
      value: km(entry.flown_distance),
      detail: 'WGS84 ellipsoid distance — the score is this distance in metres.',
    });
  }

  const sections: ScoreExplanationSection[] = [
    {
      id: 'flight',
      title: 'The flight',
      summary: 'Open distance: fly as far as possible from the launch cylinder exit.',
      items,
    },
  ];

  const penalty = buildPenaltySection(entry);
  if (penalty) sections.push(penalty);

  sections.push({
    id: 'total',
    title: 'Total',
    points: entry.total_score,
    items: [
      {
        id: 'total-sum',
        text: 'The score is the flown distance in metres, minus any penalty',
        value: `${entry.total_score} pts`,
        detail:
          entry.penalty_points !== 0
            ? `${Math.round(entry.flown_distance)} ${entry.penalty_points > 0 ? '−' : '+'} ${Math.abs(entry.penalty_points)} penalty = ${entry.total_score}`
            : `${Math.round(entry.flown_distance)} m flown = ${entry.total_score} points`,
      },
    ],
  });

  const headline =
    entry.flown_distance > 0
      ? `Flew ${km(entry.flown_distance)} open distance — ${entry.total_score} points`
      : `Never left the launch cylinder — ${entry.total_score} points`;

  return { format: 'open_distance', headline, sections };
}
