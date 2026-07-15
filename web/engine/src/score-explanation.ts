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
import {
  DEFAULT_GAP_PARAMETERS,
  calculateSpeedFraction,
  resolveTimePointsExponent,
  speedExponentValue,
} from './gap-scoring';
import type { OpenDistanceGeometry } from './open-distance-scoring';
import type { ManualFlightGeometry } from './manual-flight';
import type { IGCFix } from './igc-parser';
import { calculateOptimizedTaskLine, computeTurnpointDirections } from './task-optimizer';
import { computeGoalLine } from './goal-line';

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
  /**
   * An optional routed polyline the UI can draw for this anchor. For a
   * landed-out pilot's `best_progress` point this is the remaining task
   * route — from that point, through each un-reached turnpoint's optimal
   * tag point, to goal — so the "measured along the task" / "X km short"
   * wording is visible on the map rather than implied by a lone pin.
   */
  path?: Array<{ latitude: number; longitude: number }>;
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
  /** The pilot's fixes — used to timestamp the furthest anchor. */
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
  /**
   * True for a manual flight (issue #306): a track-less pilot whose landing
   * point was recorded by an official. The scored line is the same
   * cylinder-edge measurement a track gets, but the endpoint is the recorded
   * landing, so the wording is adjusted and no fix times are shown.
   */
  manual?: boolean;
}

// ---------------------------------------------------------------------------
// Formatting helpers (fixed metric — the UI can localise via formatTime)
// ---------------------------------------------------------------------------

function km(meters: number, decimals = 1): string {
  return `${(meters / 1000).toFixed(decimals)} km`;
}

function pts(points: number): string {
  return `${fmtPoints(points)} pts`;
}

/**
 * Format a point value at the spec's one-decimal precision (S7F §11), dropping
 * a trailing ".0" so whole scores read as whole numbers.
 */
function fmtPoints(points: number): string {
  const rounded = Math.round(points * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
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

/**
 * Name the leading-coefficient variant actually used (S7F §11.3.1), decoupled
 * from the time-points exponent since issue #258.
 */
function leadingVariantSentence(formula: GAPParameters['leadingFormula']): string {
  return formula === 'classic'
    ? 'Measured with the classic squared-distance leading coefficient (S7F §11.3.1, the hang-gliding / GAP2016–2018 variant).'
    : 'Measured with the weighted-area leading coefficient (S7F §11.3.1, the paragliding / GAP2020+ variant).';
}

/** Cap on individually listed start crossings — beyond this, summarise. */
const MAX_START_CROSSINGS_LISTED = 12;

/** Cap on individually listed post-deadline crossings — beyond this, summarise. */
const MAX_DEADLINE_CROSSINGS_LISTED = 6;

/**
 * Shown when a crossing was credited by the cylinder tolerance band rather
 * than a physical crossing of the nominal radius (FAI S7F §8.1).
 */
const TOLERANCE_NOTE =
  'Credited by the cylinder tolerance band (FAI S7F §8.1) — the track came within tolerance of the cylinder edge but did not physically cross the nominal radius.';

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
  // Per-turnpoint crossing directions, inferred from the task geometry —
  // an exit cylinder (one the route reaches from inside) counts when the
  // pilot flies OUT of it, and the narrative must say so.
  const directions = computeTurnpointDirections(task);

  if (result.startFallback === 'first_turnpoint') {
    items.push({
      id: 'start-fallback',
      text: 'This task has no start (SSS) turnpoint — the first turnpoint is treated as the start.',
      emphasis: 'warning',
    });
  }

  // Launch-window violation (FAI S7F §8.6.1): start crossings before the
  // window even opened prove the pilot was airborne before launching was
  // allowed — they were excluded from start validation.
  if (result.launchWindow && result.launchWindow.droppedStartCrossings > 0) {
    const lw = result.launchWindow;
    items.push({
      id: 'launch-window',
      text: `${lw.droppedStartCrossings === 1 ? 'A start-cylinder crossing' : `${lw.droppedStartCrossings} start-cylinder crossings`} before the launch window opened at ${fmt(lw.openTime)} ${lw.droppedStartCrossings === 1 ? 'was' : 'were'} ignored (FAI S7F §8.6.1) — a crossing before the window opens means the pilot was airborne before launching was allowed, so it cannot validate a start.`,
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
      // The scored start is usually one of the LAST crossings for a pilot
      // who milled around the start cylinder — exactly the case this
      // narrative exists for — so it must never fall behind the listing cap.
      // Take the latest crossing matching the scored time (re-starts
      // supersede), list the first crossings up to the cap, and when the
      // scored one lies beyond it, elide the middle instead.
      let scoredIdx = -1;
      for (let i = startCrossings.length - 1; i >= 0; i--) {
        if (startCrossings[i].time.getTime() === sss.time.getTime()) {
          scoredIdx = i;
          break;
        }
      }
      const listIndices: number[] = [];
      if (scoredIdx < MAX_START_CROSSINGS_LISTED) {
        const n = Math.min(startCrossings.length, MAX_START_CROSSINGS_LISTED);
        for (let i = 0; i < n; i++) listIndices.push(i);
      } else {
        for (let i = 0; i < MAX_START_CROSSINGS_LISTED - 1; i++) listIndices.push(i);
        listIndices.push(scoredIdx);
      }
      let prevListed = -1;
      for (const i of listIndices) {
        if (i > prevListed + 1) {
          items.push({
            id: `start-crossings-elided-${prevListed + 1}`,
            text: `…${i - prevListed - 1} more crossings…`,
            emphasis: 'muted',
          });
        }
        const c = startCrossings[i];
        const scored = i === scoredIdx;
        items.push({
          id: `start-crossing-${i}`,
          text: scored
            ? `${c.direction === 'enter' ? 'Entered' : 'Exited'} the start cylinder — this is the scored start`
            : `${c.direction === 'enter' ? 'Entered' : 'Exited'} the start cylinder`,
          value: fmt(c.time),
          detail: c.toleranceCredited ? TOLERANCE_NOTE : undefined,
          emphasis: scored ? 'normal' : 'muted',
          anchor: {
            kind: scored ? 'start' : 'start_candidate',
            latitude: c.latitude,
            longitude: c.longitude,
            altitude: c.altitude,
            timeMs: c.time.getTime(),
          },
        });
        prevListed = i;
      }
      if (prevListed < startCrossings.length - 1) {
        items.push({
          id: 'start-crossings-more',
          text: `…and ${startCrossings.length - prevListed - 1} more crossings`,
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
        detail: sss.toleranceCredited ? TOLERANCE_NOTE : undefined,
        emphasis: sss.toleranceCredited ? 'muted' : undefined,
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
    // Non-null when this task ends at a goal LINE (S7F §6.3.1) — the goal
    // reaching is then a line crossing (or a semicircle fix), not a
    // cylinder entry, and the wording must say so.
    const goalLine = isGoal ? computeGoalLine(task) : null;

    // An exit cylinder (never the goal — goal is always entered) is reached
    // by flying out of it, and the narrative must make that visible: it is
    // the one case where a pilot can be "at" the turnpoint the whole flight
    // yet never reach it.
    const isExitTP = !isGoal && directions[reaching.taskIndex] === 'exit';
    const radiusKm = km(task.turnpoints[reaching.taskIndex]?.radius ?? 0);

    let detail: string | undefined;
    if (reaching.selectionReason === 'already_inside') {
      detail = goalLine
        ? 'Already inside the control semicircle behind the goal line when the previous turnpoint was reached — credited at that same moment, no extra crossing needed.'
        : 'Already inside this cylinder when the previous turnpoint was reached — credited at that same moment, no extra crossing needed.';
    } else if (reaching.selectionReason === 'already_outside') {
      detail = `Already outside this exit cylinder when the previous turnpoint was reached — credited at that same moment, no extra crossing needed.`;
    } else if (isExitTP) {
      detail = `An exit turnpoint — the route reaches this ${radiusKm} cylinder from inside, so it counts when the pilot crosses its boundary flying OUT.${reaching.candidateCount > 1 ? ` First outward crossing of ${reaching.candidateCount} boundary crossings — once a turnpoint is reached, later crossings don't matter.` : ''}`;
    } else if (reaching.candidateCount > 1) {
      detail = `First of ${reaching.candidateCount} crossings — once a turnpoint is reached, later crossings don't matter.`;
    }
    if (goalLine) {
      // Say what the goal geometry was and how this reaching satisfied it —
      // the line itself, or a fix in the control semicircle behind it.
      const lineDesc = `the ${Math.round(goalLine.halfWidth * 2)} m goal line, perpendicular to the final leg (S7F §6.3.1)`;
      const goalNote = reaching.goalSemicircleCredited
        ? `Recorded in the control semicircle behind ${lineDesc} — a fix in the semicircle counts as goal even when the line crossing itself falls between tracklog fixes.`
        : reaching.selectionReason === 'already_inside'
          ? `Goal is ${lineDesc}.`
          : `Crossed ${lineDesc}.`;
      detail = `${goalNote}${detail ? ` ${detail}` : ''}`;
    }
    if (reaching.toleranceCredited) {
      detail = `${detail ? `${detail} ` : ''}${TOLERANCE_NOTE}`;
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
      text: `${isGoal ? 'Goal' : label}${name ? ` — ${name}` : ''}${isExitTP ? ' (exit cylinder)' : ''}`,
      value: fmt(reaching.time),
      detail,
      anchor: reachingAnchor(reaching, isGoal ? 'goal' : isESS ? 'ess' : 'turnpoint'),
    });
  }

  // Task deadline (FAI S7F §8.3.c, §11.1): crossings after it were excluded
  // from the sequence and distance was measured only up to it. Shown when it
  // actually shaped this flight — crossings were ignored, or a landed-out
  // pilot's track continues past the deadline.
  const dl = result.deadline;
  if (dl && (dl.crossingsAfter > 0 || (!entry.made_goal && dl.trackContinuesPastDeadline))) {
    items.push({
      id: 'task-deadline',
      text: 'Task deadline — turnpoint crossings after this time do not count, and distance is measured only up to it (FAI S7F §8.3, §11.1).',
      value: fmt(dl.time),
      emphasis: dl.crossingsAfter > 0 ? 'warning' : 'muted',
    });
    // List the ignored crossings so a pilot who tagged a turnpoint (or goal)
    // too late can see exactly what was dropped and where.
    const ignored = result.crossings.filter(
      (c) => c.time.getTime() > dl.time.getTime(),
    );
    const goalIdx = getGoalIndex(task);
    for (const [i, c] of ignored.slice(0, MAX_DEADLINE_CROSSINGS_LISTED).entries()) {
      // Same labelling rule as the reachings above: the goal position reads
      // "Goal" even when it doubles as the ESS cylinder.
      const label =
        c.taskIndex === goalIdx ? 'Goal' : turnpointLabel(task, c.taskIndex);
      const name = turnpointName(task, c.taskIndex);
      const isGoalCrossing = c.taskIndex === goalIdx && c.direction === 'enter';
      items.push({
        id: `deadline-ignored-${i}`,
        text: `${c.direction === 'enter' ? 'Entered' : 'Exited'} ${label}${name ? ` (${name})` : ''} after the deadline — not counted`,
        value: fmt(c.time),
        // Reaching goal too late is the heartbreaker worth flagging loudly.
        emphasis: isGoalCrossing ? 'warning' : 'muted',
        anchor: {
          kind: 'turnpoint',
          latitude: c.latitude,
          longitude: c.longitude,
          altitude: c.altitude,
          timeMs: c.time.getTime(),
        },
      });
    }
    if (ignored.length > MAX_DEADLINE_CROSSINGS_LISTED) {
      items.push({
        id: 'deadline-ignored-more',
        text: `…and ${ignored.length - MAX_DEADLINE_CROSSINGS_LISTED} more crossings after the deadline`,
        emphasis: 'muted',
      });
    }
  }

  if (entry.made_goal) {
    items.push({
      id: 'made-goal',
      text: 'Completed the task — full task distance is credited.',
    });
  } else if (result.bestProgress) {
    // The marked point is where the flight made the most distance along the
    // task route — i.e. where the track came closest to the *next* un-reached
    // turnpoint (routed on toward goal), not the point nearest goal in a
    // straight line. Name that turnpoint so the map marker makes sense.
    const nextIdx = result.lastTurnpointReached + 1;
    const nextIsGoal = nextIdx === getGoalIndex(task);
    const goalIsLine = nextIsGoal && computeGoalLine(task) !== null;
    const nextIsExit = !nextIsGoal && directions[nextIdx] === 'exit';
    const nextName = turnpointName(task, nextIdx);
    const nextDesc = `${turnpointLabel(task, nextIdx)}${nextName ? ` (${nextName})` : ''}`;
    // The remaining routed line: from the best-progress point, through each
    // un-reached turnpoint's optimal tag point, to goal. calculateOptimizedTaskLine
    // returns one tag point per turnpoint, index-aligned to task.turnpoints, so
    // slice(nextIdx) is exactly the un-reached tail (next TP … goal).
    const remainingTags = calculateOptimizedTaskLine(task).slice(nextIdx);
    const path: Array<{ latitude: number; longitude: number }> = [
      {
        latitude: result.bestProgress.latitude,
        longitude: result.bestProgress.longitude,
      },
      ...remainingTags.map((p) => ({ latitude: p.lat, longitude: p.lon })),
    ];
    items.push({
      id: 'best-progress',
      text: `Landed out — best distance made good along the task, ${km(result.bestProgress.distanceToGoal)} short of goal`,
      value: fmt(result.bestProgress.time),
      detail: nextIsGoal
        ? `The marked point is where the track came closest to ${goalIsLine ? 'the goal line' : 'goal'}${nextName ? ` (${nextName})` : ''}. Scored distance is measured along the task to this point: ${km(entry.flown_distance)}.`
        : nextIsExit
          ? `The next turnpoint, ${nextDesc}, is an exit cylinder — it counts only when the pilot flies OUT of its ${km(task.turnpoints[nextIdx]?.radius ?? 0)} boundary, and this flight never did. The marked point is where the track came closest to that boundary from inside; distance is measured along the task route from here, out to the boundary and on through the remaining turnpoints to goal, so the scored distance is ${km(entry.flown_distance)}.`
          : `The marked point is where the track came closest to the next turnpoint, ${nextDesc} — not the point nearest goal. Distance is measured along the task route from here, on through the remaining turnpoints to goal, so the scored distance is ${km(entry.flown_distance)}.`,
      anchor: {
        kind: 'best_progress',
        latitude: result.bestProgress.latitude,
        longitude: result.bestProgress.longitude,
        timeMs: result.bestProgress.time.getTime(),
        // Only a genuine multi-point line is worth drawing.
        path: path.length >= 2 ? path : undefined,
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

/**
 * The engine computes the points on offer as `1000 × launch × distance ×
 * time` at full precision, so the printed equation can always be made to
 * reconcile — the only question is how many decimal places the factors
 * need. Start at the 2 the GAP spec prints validities at and add decimals
 * until the displayed figures multiply to the displayed total; 5 always
 * suffices (worst-case rounding error 1000 × 3 × 0.5e-5 ≈ 0.015 pt, under
 * the 0.05 pt display step).
 */
const VALIDITY_MIN_DECIMALS = 2;
const VALIDITY_MAX_DECIMALS = 5;

function validityFactorDecimals(
  v: ClassContextInput['task_validity'],
  total: number,
): number {
  for (let d = VALIDITY_MIN_DECIMALS; d < VALIDITY_MAX_DECIMALS; d++) {
    const product = [v.launch, v.distance, v.time].reduce(
      (p, f) => p * Number(f.toFixed(d)),
      1000,
    );
    if (Math.round(product * 10) === Math.round(total * 10)) return d;
  }
  return VALIDITY_MAX_DECIMALS;
}

/**
 * Every equation the explainer prints states an identity the engine computed
 * at full precision, so the printed figures can always be made to visibly
 * reconcile — the only question is how many decimals they need. Find the
 * fewest decimals in [min, max] at which the display-rounded figures
 * (`evaluate`) match the printed result at the 0.1-pt step; when even `max`
 * doesn't reconcile (inconsistent stored data), the caller prints "≈".
 */
function reconcileDecimals(
  min: number,
  max: number,
  target: number,
  evaluate: (decimals: number) => number,
): { decimals: number; reconciles: boolean } {
  for (let d = min; d <= max; d++) {
    if (Math.round(evaluate(d) * 10) === Math.round(target * 10)) {
      return { decimals: d, reconciles: true };
    }
  }
  return { decimals: min, reconciles: false };
}

/**
 * Available-points figure + factor decimals that make a component equation
 * reconcile. Tries the 0.1-step available first; when the full-precision
 * product sits on a rounding boundary (e.g. 59.951 printing as 60 while
 * factor × 514.4 lands at 59.947), retries with the available at 2 dp.
 */
function reconcileWithAvailable(
  available: number,
  minDecimals: number,
  maxDecimals: number,
  target: number,
  evaluate: (decimals: number, availableShown: number) => number,
): { availStr: string; decimals: number; reconciles: boolean } {
  for (const availStr of [fmtPoints(available), trimZeros(available.toFixed(2), 1)]) {
    const shown = Number(availStr);
    const r = reconcileDecimals(minDecimals, maxDecimals, target, (d) =>
      evaluate(d, shown),
    );
    if (r.reconciles) return { availStr, ...r };
  }
  return { availStr: fmtPoints(available), decimals: minDecimals, reconciles: false };
}

/** A km figure at the given precision, as the number the reader sees. */
function kmNum(meters: number, decimals: number): number {
  return Number((meters / 1000).toFixed(decimals));
}

/** A km figure for an equation, trailing zeros trimmed to at least 1 dp. */
function kmEq(meters: number, decimals: number): string {
  return `${trimZeros((meters / 1000).toFixed(decimals), 1)} km`;
}

/** Trim trailing zeros from a fixed-decimal string, keeping at least `min` decimals. */
function trimZeros(s: string, min: number): string {
  const dot = s.indexOf('.');
  if (dot === -1) return s;
  let end = s.length;
  while (end - dot - 1 > min && s[end - 1] === '0') end--;
  if (end - dot - 1 === 0) end--;
  return s.slice(0, end);
}

/** A validity factor at the section's precision, e.g. 0.9993 → "0.9993", 1 → "1.00". */
function fmtValidityFactor(f: number, decimals: number): string {
  return trimZeros(f.toFixed(decimals), VALIDITY_MIN_DECIMALS);
}

/**
 * A validity as a percentage at the section's precision, so a 0.9993 day
 * reads 99.93% rather than a misleading 100%.
 */
function pctValidity(fraction: number, decimals: number): string {
  const percentDecimals = Math.max(0, decimals - 2);
  return `${trimZeros((fraction * 100).toFixed(percentDecimals), 0)}%`;
}

/** The `1000 × launch × distance × time` equation for the points on offer. */
function availableTotalDetail(
  v: ClassContextInput['task_validity'],
  total: number,
  decimals: number,
): string {
  const factors = [v.launch, v.distance, v.time].map((f) =>
    fmtValidityFactor(f, decimals),
  );
  const product = factors.reduce((p, f) => p * Number(f), 1000);
  const reconciles = Math.round(product * 10) === Math.round(total * 10);
  const equation = `1000 × ${factors.join(' × ')}`;
  return reconciles
    ? `${equation} = ${fmtPoints(total)}`
    : `${equation} ≈ ${fmtPoints(total)} — the validity factors are shown rounded to ${decimals} decimal places; the points on offer come from their full precision.`;
}

function buildValiditySection(
  classContext: ClassContextInput,
): ScoreExplanationSection {
  const v = classContext.task_validity;
  const ap = classContext.available_points;
  // One precision for the whole section, so the three factor rows, the task
  // validity in the summary and the equation all visibly agree.
  const decimals = validityFactorDecimals(v, ap.total);
  const items: ScoreExplanationItem[] = [
    {
      id: 'launch-validity',
      text: 'Launch validity — did enough registered pilots launch?',
      value: pctValidity(v.launch, decimals),
    },
    {
      id: 'distance-validity',
      text: 'Distance validity — did the field fly far enough relative to the nominal distance?',
      value: pctValidity(v.distance, decimals),
    },
    {
      id: 'time-validity',
      text: 'Time validity — was the winning time long enough relative to the nominal time?',
      value: pctValidity(v.time, decimals),
    },
    {
      id: 'available-total',
      text: 'Points on offer for the day',
      value: pts(ap.total),
      detail: availableTotalDetail(v, ap.total, decimals),
    },
    {
      id: 'available-split',
      text: 'Split between the components by the goal ratio',
      // 0.1 precision like the total above, so the split visibly sums to it
      // ("distance 855.9 · time 143.4" for a 999.3 day, not "856 · 144").
      detail: [
        `distance ${fmtPoints(ap.distance)}`,
        `time ${fmtPoints(ap.time)}`,
        ...(ap.leading > 0 ? [`leading ${fmtPoints(ap.leading)}`] : []),
        ...(ap.arrival > 0 ? [`arrival ${fmtPoints(ap.arrival)}`] : []),
      ].join(' · '),
      emphasis: 'muted',
    },
  ];
  return {
    id: 'validity',
    title: 'Day quality — points on offer',
    summary: `Task validity ${pctValidity(v.task, decimals)} of a perfect day, so ${fmtPoints(ap.total)} of 1000 points were available.`,
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
  // Mirror scoreFlights' predicate exactly — the engine applies the linear/
  // difficulty split for every HG pilot when useDistanceDifficulty is on,
  // including one whose difficulty half is legitimately 0. Gating on the
  // point value would drop such a pilot into the pure-linear branch, whose
  // printed equation omits the 0.5 factor the engine actually applied.
  const useDifficulty = params.scoring === 'HG' && params.useDistanceDifficulty;

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
    // The engine computed linear = 0.5 × (flown ÷ best) × available at full
    // precision; print the km figures precisely enough that the equation
    // visibly multiplies out (4 decimals nearly always suffices).
    const { availStr, decimals, reconciles } = reconcileWithAvailable(
      ap.distance, 1, 5, entry.distance_linear_points,
      (d, avail) => 0.5 * (kmNum(entry.flown_distance, d) / kmNum(best, d)) * avail,
    );
    items.push({
      id: 'distance-linear',
      text: 'Linear half — half the available points scale with your share of the best distance',
      value: pts(entry.distance_linear_points),
      detail: `0.5 × (${kmEq(entry.flown_distance, decimals)} ÷ ${kmEq(best, decimals)}) × ${availStr} ${
        reconciles
          ? `= ${fmtPoints(entry.distance_linear_points)}`
          : `≈ ${fmtPoints(entry.distance_linear_points)} — the figures are shown rounded; the points come from their full precision.`
      }`,
    });
    items.push({
      id: 'distance-difficulty',
      text: 'Difficulty half — rewards flying past stretches where many pilots landed',
      value: pts(entry.distance_difficulty_points),
      detail:
        'The difficulty curve is built from where the whole field landed out (FAI S7F §11.1.1).',
    });
  } else {
    const { availStr, decimals, reconciles } = reconcileWithAvailable(
      ap.distance, 1, 5, entry.distance_points,
      (d, avail) => (kmNum(entry.flown_distance, d) / kmNum(best, d)) * avail,
    );
    items.push({
      id: 'distance-formula',
      text: 'Distance points scale linearly with your share of the best distance',
      value: pts(entry.distance_points),
      detail: `(${kmEq(entry.flown_distance, decimals)} ÷ ${kmEq(best, decimals)}) × ${availStr} available ${
        reconciles
          ? `= ${fmtPoints(entry.distance_points)}`
          : `≈ ${fmtPoints(entry.distance_points)} — the figures are shown rounded; the points come from their full precision.`
      }`,
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

  // Mirrors calculateTimePoints / scoreFlights: PG requires goal (the spec
  // fixes its ESS-but-not-goal factor at 0); HG requires ESS, and a pilot
  // who lands before goal keeps only the essNotGoalFactor share (§12.1).
  const essNotGoalFactor =
    params.scoring === 'PG' ? 0 : params.essNotGoalFactor;
  const qualifies =
    params.scoring === 'PG'
      ? entry.made_goal
      : entry.reached_ess && (entry.made_goal || essNotGoalFactor > 0);
  // §12.1 reduction applies: the pilot earns time points, docked below.
  const essReduction =
    params.scoring === 'HG' &&
    entry.reached_ess &&
    !entry.made_goal &&
    essNotGoalFactor > 0;

  // Best time — same source scoreFlights used: goal-validated when the
  // factor is 0 (always for PG, §11.2.1), otherwise the fastest ESS pilot.
  const bestTimes = classContext.pilots
    .filter((p) => (essNotGoalFactor > 0 ? p.reached_ess : p.made_goal))
    .map((p) => p.speed_section_time)
    .filter((t): t is number => t !== null && t > 0);
  const bestTime = bestTimes.length > 0 ? Math.min(...bestTimes) : null;

  if (!qualifies || entry.speed_section_time === null || bestTime === null) {
    items.push({
      id: 'no-time-points',
      text:
        params.scoring === 'PG'
          ? 'Time points are only awarded to pilots who complete the task.'
          : entry.reached_ess && !entry.made_goal && essNotGoalFactor === 0
            ? 'Reached the end of the speed section but not goal — this competition scores that at 0% of time and arrival points (FAI S7F §12.1).'
            : 'Time points are only awarded to pilots who reach the end of the speed section.',
      emphasis: 'muted',
    });
  } else {
    // Time-points exponent (S7F §11.2) actually used for this comp, decoupled
    // from the leading-coefficient variant (issue #258).
    const exp = resolveTimePointsExponent(params);
    const exponentLabel = exp === '2/3' ? '2⁄3' : '5⁄6';
    const exponentName =
      exp === '2/3' ? 'the older GAP2016/2018 curve' : 'the current FAI S7F';
    const sf = calculateSpeedFraction(
      entry.speed_section_time,
      bestTime,
      speedExponentValue(exp),
    );
    items.push({
      id: 'time-exponent',
      text: `Time points use the ${exponentLabel} speed-fraction exponent (${exponentName}, S7F §11.2).`,
      emphasis: 'muted',
    });
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
      text:
        essNotGoalFactor > 0
          ? 'Fastest time in class'
          : 'Fastest time in class (among pilots who made goal)',
      value: duration(bestTime),
      emphasis: 'muted',
    });
    // §12.1 reduction, stated before the formula so its ×factor is explained.
    if (essReduction) {
      items.push({
        id: 'ess-not-goal',
        text: `Reached the end of the speed section but landed before goal — reaching goal "validates" the speed section, so only ${trimZeros((essNotGoalFactor * 100).toFixed(1), 0)}% of time and arrival points are kept (FAI S7F §12.1).`,
        emphasis: 'warning',
      });
    }
    // The ×factor the engine applied (1 when no reduction) — folded into the
    // printed equations so they reconcile with the published points.
    const factor = essReduction ? essNotGoalFactor : 1;
    const factorEq = essReduction
      ? ` × ${trimZeros(essNotGoalFactor.toFixed(2), 1)} (ESS but not goal, §12.1)`
      : '';
    if (entry.speed_section_time <= bestTime) {
      const { availStr, reconciles } = reconcileWithAvailable(
        ap.time, 0, 0, entry.time_points,
        (_d, avail) => avail * factor,
      );
      items.push({
        id: 'time-formula',
        text: essReduction
          ? 'Fastest through the speed section — full available time points, before the goal-validation reduction'
          : 'Fastest through the speed section — full available time points.',
        value: pts(entry.time_points),
        detail: essReduction
          ? `${availStr} available${factorEq} ${reconciles ? '=' : '≈'} ${fmtPoints(entry.time_points)}`
          : undefined,
      });
    } else {
      // time points = speed fraction × available (× the §12.1 factor),
      // exactly — print the fraction with enough decimals that the
      // multiplication visibly holds at the 0.1-pt step. exponentLabel is the
      // decoupled time-points exponent resolved above (issue #258).
      const { availStr, decimals, reconciles } = reconcileWithAvailable(
        ap.time, 3, 6, entry.time_points,
        (d, avail) => Number(sf.toFixed(d)) * avail * factor,
      );
      items.push({
        id: 'time-formula',
        text: 'Time points fall off with the gap to the fastest time',
        value: pts(entry.time_points),
        detail: `speed fraction = max(0, 1 − ((T − Tbest) ÷ √Tbest)^${exponentLabel}) = ${trimZeros(sf.toFixed(decimals), 3)}; × ${availStr} available${factorEq} ${
          reconciles
            ? `= ${fmtPoints(entry.time_points)}`
            : `≈ ${fmtPoints(entry.time_points)} — the figures are shown rounded; the points come from their full precision`
        } (times in hours)`,
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

/**
 * The §12.1 "ESS but not goal" caveat for the arrival section: an HG pilot
 * who reaches ESS but lands before goal keeps only the competition's
 * essNotGoalFactor share of their arrival points (same factor as time).
 */
function buildArrivalEssNotGoalItems(
  entry: Pick<ScoreEntryInput, 'made_goal' | 'reached_ess'>,
  params: GAPParameters,
): ScoreExplanationItem[] {
  if (
    params.scoring !== 'HG' ||
    !entry.reached_ess ||
    entry.made_goal ||
    params.essNotGoalFactor >= 1
  ) {
    return [];
  }
  return [
    {
      id: 'arrival-ess-not-goal',
      text: `Reached the end of the speed section but landed before goal — only ${trimZeros((params.essNotGoalFactor * 100).toFixed(1), 0)}% of arrival points are kept, the same reduction as time points (FAI S7F §12.1).`,
      emphasis: 'warning',
    },
  ];
}

function buildTotalSection(entry: ScoreEntryInput): ScoreExplanationSection {
  const components = [
    entry.distance_points,
    entry.time_points,
    entry.leading_points,
    entry.arrival_points,
  ];
  const shownComponents = components
    .filter((c, i) => c > 0 || i < 2) // always show distance + time, others only when earned
    .map((c) => Number(c.toFixed(1)));
  const parts = shownComponents.map((c) => c.toFixed(1)).join(' + ');
  // FAI S7F §11 rounds the total to one decimal place; §12.4 does that
  // rounding *after* penalties, so the penalties sit inside the round().
  const jtg = entry.jump_the_gun_penalty ?? 0;
  const jtgShown = Number(fmtPoints(jtg));
  const penaltySteps: string[] = [];
  if (jtg !== 0) {
    penaltySteps.push(`− ${fmtPoints(jtg)} jump-the-gun`);
  }
  if (entry.penalty_points !== 0) {
    penaltySteps.push(
      `${entry.penalty_points > 0 ? '−' : '+'} ${Math.abs(entry.penalty_points)} penalty`,
    );
  }
  const equation = [parts, ...penaltySteps].join(' ');
  const total = fmtPoints(entry.total_score);
  // What the printed figures come to, in tenths (exact in integer space).
  // Evaluate from the figures the reader sees, not the engine's full
  // precision: hidden components that each round down while their exact sum
  // rounds up would otherwise print an "=" between figures that don't
  // equate. And when a floor engaged (§12.2 minimum-distance score, §12.4
  // zero) the printed arithmetic isn't the operation performed at all.
  const evaluatedTenths = Math.round(
    (shownComponents.reduce((s, c) => s + c, 0) - jtgShown - entry.penalty_points) * 10,
  );
  const totalTenths = Math.round(entry.total_score * 10);
  const evaluated =
    evaluatedTenths < 0
      ? `−${fmtPoints(-evaluatedTenths / 10)}`
      : fmtPoints(evaluatedTenths / 10);
  let detail: string;
  if (evaluatedTenths === totalTenths) {
    detail = `round(${equation}, 1 dp) = ${total}`;
  } else if (entry.penalty_points > 0 && totalTenths === 0 && evaluatedTenths < 0) {
    // §12.4 zero floor: the penalty took the score below zero.
    detail = `${equation} would come to ${evaluated}, but scores never go below 0 (FAI S7F §12.4) — so the total is 0.`;
  } else if (jtg > 0 && totalTenths - evaluatedTenths > 3) {
    // §12.2 floor: more than display-rounding drift above the printed sum
    // means the jump-the-gun deduction was floored.
    detail = `${equation} would come to ${evaluated}, but the jump-the-gun penalty never drops a pilot below the minimum-distance score (FAI S7F §12.2) — so the total is ${total}.`;
  } else {
    detail = `${equation} ≈ ${total} — the points above are shown rounded to 0.1; the total is rounded from their exact sum.`;
  }
  return {
    id: 'total',
    title: 'Total',
    points: entry.total_score,
    items: [
      {
        id: 'total-sum',
        text: 'Distance + time + leading + arrival, minus penalties',
        value: `${total} pts`,
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
    // The penalty is exactly secondsEarly ÷ factor — print the seconds with
    // enough decimals that the division visibly holds (73.6 s ÷ 2 = 36.8,
    // never a contradictory "74 s ÷ 2 = 36.8").
    const { decimals, reconciles } = reconcileDecimals(
      0, 2, jtg,
      (d) => Number(secs.toFixed(d)) / jumpTheGunFactor,
    );
    items.push({
      id: 'jump-the-gun',
      text: `Jump the gun (FAI S7F §12.2): started ${duration(secs)} before the first start gate. The complete flight is scored, with 1 penalty point per ${jumpTheGunFactor} seconds early; the total never drops below the minimum-distance score.`,
      value: `−${fmtPoints(jtg)} pts`,
      detail: `${trimZeros(secs.toFixed(decimals), 0)} s early ÷ ${jumpTheGunFactor} s per point ${reconciles ? '=' : '≈'} ${fmtPoints(jtg)} points`,
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
 * Name the leading-weight generation that set this task's leading↔time split,
 * so the explanation is self-describing (issue #257). Hang gliding is
 * generation-independent, so it needs no note.
 */
function leadingWeightDetail(params: GAPParameters): string | undefined {
  if (params.scoring !== 'PG') return undefined;
  if (params.leadingWeightFormula === 's7f2024') {
    const ratioPct = Math.round(params.leadingTimeRatio * 100);
    return `Leading weight follows the FAI S7F 2024 §10 formula: ${ratioPct}% of the non-distance weight (LeadingTimeRatio) goes to leading when someone makes goal, and all of it when nobody does.`;
  }
  return 'Leading weight follows the GAP2020 formula (AirScore parity): 35% of the non-distance weight when someone makes goal, and 0.1 × best distance ÷ task distance when nobody does.';
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
          detail: leadingWeightDetail(params),
        },
        {
          id: 'leading-variant',
          text: leadingVariantSentence(params.leadingFormula),
          emphasis: 'muted',
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
        ...buildArrivalEssNotGoalItems(entry, params),
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
 * starts (the launch cylinder edge, toward the furthest point), where it
 * ends (the furthest fix), and how that becomes the score.
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
      text: `The flight never left the ${km(launchRadius)} launch cylinder — open distance is measured from the cylinder edge, so the flight scores 0.`,
      emphasis: 'warning',
    });
  } else {
    const furthestFix = fixes?.[geometry.furthest.fixIndex];
    // The origin is the cylinder edge toward the furthest point — a derived
    // point, not a track fix, so it carries no time/altitude of its own
    // (anchorInfo may still supply them for older cached analyses).
    const originTimeMs = input.anchorInfo?.origin?.timeMs;
    const originAltitude = input.anchorInfo?.origin?.altitude;
    const furthestTimeMs =
      input.anchorInfo?.furthest?.timeMs ?? furthestFix?.time.getTime();
    const furthestAltitude =
      input.anchorInfo?.furthest?.altitude ?? furthestFix?.gnssAltitude;
    items.push({
      id: 'origin',
      text: input.manual
        ? `Take-off cylinder exit — the scored distance starts at the ${km(launchRadius)} take-off cylinder edge, toward the landing point.`
        : `The scored distance starts at the ${km(launchRadius)} launch cylinder edge, toward the furthest point — leaving the cylinder starts the score; where it was crossed (or crossed again later) doesn't matter.`,
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
      text: input.manual
        ? 'Recorded landing point — the scored distance ends here.'
        : 'Furthest point reached from launch — the scored distance ends here.',
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
      summary: 'Open distance: fly as far as possible from the launch cylinder edge.',
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

// ---------------------------------------------------------------------------
// Manual flight explanation
// ---------------------------------------------------------------------------

export interface ExplainManualFlightInput {
  /**
   * The scoring task (already trimmed for the distance origin) — the same
   * frame as `geometry.lastReachedIndex`, so turnpoint labels line up.
   */
  task: XCTask;
  /** The made-good geometry from {@link ManualFlightGeometry}. */
  geometry: ManualFlightGeometry;
  /** The published score being explained. */
  entry: ScoreEntryInput;
  /** The class the pilot was scored in. */
  classContext: ClassContextInput;
  /** The comp's GAP parameters (defaults applied for missing fields). */
  params?: Partial<GAPParameters>;
}

/**
 * The flight-narrative section for a manual flight — no tracklog, so it states
 * the last turnpoint reached and the landing point, and attaches the routed
 * "distance to goal" line to the landing anchor (kind `best_progress`) exactly
 * as a landed-out track does, so the map shows the same evidence.
 */
function buildManualFlightSection(
  task: XCTask,
  geometry: ManualFlightGeometry,
  entry: ScoreEntryInput,
): ScoreExplanationSection {
  const items: ScoreExplanationItem[] = [
    {
      id: 'manual-flight',
      text: 'Manual flight — recorded by an official for a pilot with no tracklog (FAI S7F §8.4). The distance is computed from the last turnpoint reached and the landing point, exactly as a real track at the same place would score.',
      emphasis: 'muted',
    },
    {
      id: 'manual-last-tp',
      text: (() => {
        const label = turnpointLabel(task, geometry.lastReachedIndex);
        const name = turnpointName(task, geometry.lastReachedIndex);
        return `Last turnpoint reached: ${label}${name ? ` — ${name}` : ''}`;
      })(),
    },
  ];

  if (geometry.madeGoal) {
    items.push({
      id: 'made-goal',
      text: 'Recorded in goal — full task distance is credited.',
    });
    items.push({
      id: 'landing',
      text: 'Recorded landing point',
      anchor: {
        kind: 'goal',
        latitude: geometry.landing.lat,
        longitude: geometry.landing.lon,
      },
    });
  } else {
    const nextIdx = geometry.lastReachedIndex + 1;
    const nextIsGoal = nextIdx === getGoalIndex(task);
    const nextName = turnpointName(task, nextIdx);
    const nextDesc = `${turnpointLabel(task, nextIdx)}${nextName ? ` (${nextName})` : ''}`;
    const path = geometry.routeToGoal.map((p) => ({
      latitude: p.lat,
      longitude: p.lon,
    }));
    items.push({
      id: 'best-progress',
      text: `Recorded landing point — ${km(geometry.distanceToGoal)} short of goal along the task route`,
      detail: nextIsGoal
        ? `Distance is measured along the task from the landing point to goal, so the scored distance is ${km(entry.flown_distance)}.`
        : `Distance is measured along the task from the landing point, through the next turnpoint ${nextDesc} and on to goal, so the scored distance is ${km(entry.flown_distance)}.`,
      anchor: {
        kind: 'best_progress',
        latitude: geometry.landing.lat,
        longitude: geometry.landing.lon,
        // Only a genuine multi-point line is worth drawing.
        path: path.length >= 2 ? path : undefined,
      },
    });
  }

  return {
    id: 'flight',
    title: 'The flight',
    summary: 'A manual flight report — no tracklog.',
    items,
  };
}

/**
 * Explain a manual-flight-scored pilot's result (FAI S7F §8.4). The narrative
 * states the last turnpoint reached and the landing point (with the routed
 * distance-to-goal line on the map); the point-component sections reuse the
 * same GAP builders, driven by the authoritative published score entry, so the
 * numbers always match the scoreboard.
 */
export function explainManualFlightScore(
  input: ExplainManualFlightInput,
): ScoreExplanation {
  const { task, geometry, entry, classContext } = input;
  const params: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...input.params };

  // The point-component builders read only a few fields off a turnpoint result
  // (flownDistance for the minimum-distance caveat; startGate / sssReaching for
  // the gated-race note, both absent for a manual flight). Feed them a synthetic
  // result so a manual flight reuses the exact same points prose as a track.
  const synthResult: TurnpointSequenceResult = {
    crossings: [],
    sequence: [],
    sssReaching: null,
    essReaching: null,
    madeGoal: geometry.madeGoal,
    lastTurnpointReached: geometry.lastReachedIndex,
    bestProgress: null,
    taskDistance: geometry.madeGood + geometry.distanceToGoal,
    flownDistance: geometry.madeGood,
    legs: [],
    speedSectionTime: entry.speed_section_time ?? null,
  };

  const sections: ScoreExplanationSection[] = [
    buildManualFlightSection(task, geometry, entry),
    buildValiditySection(classContext),
    buildDistanceSection(entry, classContext, synthResult, params),
    buildTimeSection(entry, classContext, params, synthResult, defaultFormatTime),
  ];

  if (classContext.available_points.leading > 0 || entry.leading_points > 0) {
    sections.push({
      id: 'leading',
      title: 'Leading points',
      points: entry.leading_points,
      items: [
        {
          id: 'leading',
          text: 'Leading points reward flying out front during the speed section. A manual flight has no tracklog to measure leading from, so it earns none.',
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
        ...buildArrivalEssNotGoalItems(entry, params),
      ],
    });
  }

  const penalty = buildPenaltySection(entry, params.jumpTheGunFactor);
  if (penalty) sections.push(penalty);
  sections.push(buildTotalSection(entry));

  const headline = geometry.madeGoal
    ? `Manual flight — made goal — ${fmtPoints(entry.total_score)} points`
    : `Manual flight — ${km(entry.flown_distance)} made good — ${fmtPoints(entry.total_score)} points`;

  return { format: 'gap', headline, sections };
}
