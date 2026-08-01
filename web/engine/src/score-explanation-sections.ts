/**
 * Score-explanation section builders.
 *
 * Turns a scored result into the flight-narrative, validity, per-component,
 * penalty, and total sections (plus the task-position labels/anchors they
 * use). The public explain* entry points in ./score-explanation compose these.
 */

import type { XCTask, Turnpoint } from './xctsk-parser';
import { getEffectiveSSSIndex, getEffectiveESSIndex, getGoalIndex } from './xctsk-parser';
import type { TurnpointSequenceResult, TurnpointReaching } from './turnpoint-sequence';
import type { GAPParameters } from './gap-scoring';
import {
  DEFAULT_GAP_PARAMETERS,
  calculateArrivalPoints,
  calculateSpeedFraction,
  resolveTimePointsExponent,
  speedExponentValue,
} from './gap-scoring';
import type { ManualFlightGeometry } from './manual-flight';
import { calculateOptimizedTaskLine, computeTurnpointDirections, type TurnpointDirection } from './task-optimizer';
import { computeGoalLine } from './goal-line';
import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
  ScoreEntryInput,
  ClassContextInput,
  ClassPilotInput,
  ExplanationAnchor,
  ExplanationAnchorKind,
} from './score-explanation-types';
import {
  km,
  pts,
  fmtPoints,
  duration,
  validityFactorDecimals,
  reconcileWithAvailable,
  reconcileDecimals,
  kmNum,
  kmEq,
  trimZeros,
  pctValidity,
  pctWeight,
  availableTotalDetail,
  defaultFormatTime,
} from './score-explanation-format';

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
export function leadingVariantSentence(formula: GAPParameters['leadingFormula']): string {
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

/** The inputs every flight-narrative phase builder shares. */
interface FlightNarrativeCtx {
  task: XCTask;
  result: TurnpointSequenceResult;
  entry: ScoreEntryInput;
  fmt: (d: Date) => string;
  sssIdx: number;
  essIdx: number;
  directions: TurnpointDirection[];
}

function buildStartItems(ctx: FlightNarrativeCtx): ScoreExplanationItem[] {
  const { task, result, fmt, sssIdx } = ctx;
  const out: ScoreExplanationItem[] = [];
  if (result.startFallback === 'first_turnpoint') {
    out.push({
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
    out.push({
      id: 'launch-window',
      text: `${lw.droppedStartCrossings === 1 ? 'A start-cylinder crossing' : `${lw.droppedStartCrossings} start-cylinder crossings`} before the launch window opened at ${fmt(lw.openTime)} ${lw.droppedStartCrossings === 1 ? 'was' : 'were'} ignored (FAI S7F §8.6.1) — a crossing before the window opens means the pilot was airborne before launching was allowed, so it cannot validate a start.`,
      emphasis: 'warning',
    });
  }

  if (!result.sssReaching) {
    out.push({
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
      out.push({
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
          out.push({
            id: `start-crossings-elided-${prevListed + 1}`,
            text: `…${i - prevListed - 1} more crossings…`,
            emphasis: 'muted',
          });
        }
        const c = startCrossings[i];
        const scored = i === scoredIdx;
        out.push({
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
        out.push({
          id: 'start-crossings-more',
          text: `…and ${startCrossings.length - prevListed - 1} more crossings`,
          emphasis: 'muted',
        });
      }
      // Why THIS crossing, for THIS flight. The rule above is general; a
      // pilot looking at five crossings wants the specific consequence, and
      // the sequence already knows what had been reached by the time of each
      // later crossing.
      const later = startCrossings.filter(
        (c) => c.time.getTime() > sss.time.getTime(),
      );
      if (later.length === 0) {
        out.push({
          id: 'start-chosen',
          text: `The ${fmt(sss.time)} crossing is the scored start — the last one made, so it supersedes every earlier crossing.`,
          emphasis: 'muted',
        });
      } else {
        const doneBefore = result.sequence.filter(
          (r) =>
            r.taskIndex > sssIdx && r.time.getTime() < later[0].time.getTime(),
        );
        const last = doneBefore[doneBefore.length - 1];
        const reachedDesc = last
          ? `${turnpointLabel(task, last.taskIndex)}${
              turnpointName(task, last.taskIndex)
                ? ` (${turnpointName(task, last.taskIndex)})`
                : ''
            }`
          : null;
        out.push({
          id: 'start-chosen',
          text: reachedDesc
            ? `The ${fmt(sss.time)} crossing is the scored start. By the ${fmt(later[0].time)} crossing the flight had already reached ${reachedDesc}, so treating that as a re-start would mean flying the course again from there — a shorter, later run that scores less.`
            : `The ${fmt(sss.time)} crossing is the scored start — starting from any of the later crossings would leave less of the course flown.`,
          emphasis: 'muted',
        });
      }
    } else if (sss.selectionReason === 'track_start') {
      out.push({
        id: 'start',
        text: 'Track began outside the start cylinder — the start is measured from the first fix.',
        value: fmt(sss.time),
        emphasis: 'warning',
        anchor: reachingAnchor(sss, 'start'),
      });
    } else {
      out.push({
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
      out.push({
        id: 'early-start',
        text: `Crossed the start ${duration(result.earlyStart.secondsEarly)} before the first start gate opened at ${fmt(result.earlyStart.firstGateTime)} — an early start ("jumping the gun", FAI S7F §12.2). The speed-section clock runs from the first gate.`,
        emphasis: 'warning',
      });
    } else if (result.startGate) {
      const gate = result.startGate;
      out.push({
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
  return out;
}

function buildTurnpointReachingItems(ctx: FlightNarrativeCtx): ScoreExplanationItem[] {
  const { task, result, entry, fmt, essIdx, directions } = ctx;
  const out: ScoreExplanationItem[] = [];
  const goalIndex = getGoalIndex(task);
  // Turnpoints after the start, in scored order.
  for (const reaching of result.sequence) {
    if (result.sssReaching && reaching.taskIndex <= result.sssReaching.taskIndex) {
      continue; // start handled above; pre-start TPs don't shape the score
    }
    // A separate ESS turnpoint co-located with goal (the common "ESS ring
    // around the goal cylinder" shape) is two task indices reached at one
    // instant. A row each printed the same time and the same "first of 11
    // crossings" twice for one event — which reads as a rendering fault at
    // the very moment the pilot finished the task. Fold the two into the
    // goal row, which is the one that also carries the speed-section time.
    const coLocatedWithGoal =
      essIdx !== goalIndex &&
      result.sequence.some(
        (r) =>
          r.taskIndex === goalIndex &&
          r.time.getTime() === reaching.time.getTime(),
      );
    if (reaching.taskIndex === essIdx && coLocatedWithGoal) continue;

    const label = turnpointLabel(task, reaching.taskIndex);
    const name = turnpointName(task, reaching.taskIndex);
    const isGoal = reaching.taskIndex === goalIndex;
    // The folded goal row inherits the ESS treatment: the speed-section time
    // and the ESS anchor kind belong on the row that survived.
    const foldedEss =
      isGoal &&
      essIdx !== goalIndex &&
      result.sequence.some(
        (r) => r.taskIndex === essIdx && r.time.getTime() === reaching.time.getTime(),
      );
    const isESS = reaching.taskIndex === essIdx || foldedEss;
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

    out.push({
      id: `reaching-${reaching.taskIndex}`,
      text: `${foldedEss ? 'ESS + Goal' : isGoal ? 'Goal' : label}${
        name ? ` — ${name}` : ''
      }${isExitTP ? ' (exit cylinder)' : ''}`,
      value: fmt(reaching.time),
      detail,
      anchor: reachingAnchor(reaching, isGoal ? 'goal' : isESS ? 'ess' : 'turnpoint'),
    });
  }
  return out;
}

function buildDeadlineItems(ctx: FlightNarrativeCtx): ScoreExplanationItem[] {
  const { task, result, entry, fmt } = ctx;
  const out: ScoreExplanationItem[] = [];
  // Task deadline (FAI S7F §8.3.c, §11.1): crossings after it were excluded
  // from the sequence and distance was measured only up to it. Shown when it
  // actually shaped this flight — crossings were ignored, or a landed-out
  // pilot's track continues past the deadline.
  const dl = result.deadline;
  if (dl && (dl.crossingsAfter > 0 || (!entry.made_goal && dl.trackContinuesPastDeadline))) {
    out.push({
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
      out.push({
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
      out.push({
        id: 'deadline-ignored-more',
        text: `…and ${ignored.length - MAX_DEADLINE_CROSSINGS_LISTED} more crossings after the deadline`,
        emphasis: 'muted',
      });
    }
  }
  return out;
}

function buildStopItems(ctx: FlightNarrativeCtx): ScoreExplanationItem[] {
  const { result, entry, fmt } = ctx;
  const out: ScoreExplanationItem[] = [];
  // Stopped task (FAI S7F §12.3): narrate how the stop shaped this flight —
  // the scored window's end, the complete-flight exemption for pilots
  // at/after ESS (§12.3.5), and any crossings dropped by the clip.
  const stop = result.stopInfo;
  if (!stop) return out;
  const windowDiffers =
    stop.windowEnd.getTime() !== stop.stopTime.getTime();
  out.push({
    id: 'task-stopped',
    // A pilot already past ESS keeps their complete flight (§12.3.5, stated
    // next) — for them the stop is context, not a clip, so don't claim one.
    text: stop.essBeforeStop
      ? 'The task was stopped (FAI S7F §12.3).'
      : windowDiffers
        ? 'The task was stopped. With multiple start gates every pilot is scored for the time window the last-started pilot had (FAI S7F §12.3.4) — this flight scored up to the window end shown.'
        : 'The task was stopped — the flight is scored only up to the task stop time (FAI S7F §12.3).',
    value: fmt(stop.windowEnd),
    emphasis: stop.crossingsAfterStop > 0 ? 'warning' : 'muted',
    detail: windowDiffers
      ? `Task stop time ${fmt(stop.stopTime)}; this pilot's scored window ends ${fmt(stop.windowEnd)}.`
      : undefined,
  });
  if (stop.essBeforeStop && (entry.made_goal || result.essReaching)) {
    out.push({
      id: 'stop-ess-exemption',
      text: 'Already past the end of the speed section when the task was stopped — the complete flight is scored, including anything flown after the stop (FAI S7F §12.3.5).',
      emphasis: 'muted',
    });
  }
  if (stop.crossingsAfterStop > 0) {
    out.push({
      id: 'stop-ignored-crossings',
      text: `${stop.crossingsAfterStop} boundary crossing${stop.crossingsAfterStop === 1 ? '' : 's'} after the scored window ${stop.crossingsAfterStop === 1 ? 'was' : 'were'} not counted.`,
      emphasis: 'warning',
    });
  }
  return out;
}

function buildBestProgressItems(ctx: FlightNarrativeCtx): ScoreExplanationItem[] {
  const { task, result, entry, fmt, directions } = ctx;
  const out: ScoreExplanationItem[] = [];
  if (entry.made_goal) {
    out.push({
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
    out.push({
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
  return out;
}

/**
 * Build the flight-narrative section: what the pilot flew, in task order,
 * with the reason each crossing was (or wasn't) the one that scored. Composed
 * from four phase builders — start, turnpoint reachings, task deadline, and
 * goal / best-progress.
 */
export function buildFlightSection(
  task: XCTask,
  result: TurnpointSequenceResult,
  entry: ScoreEntryInput,
  fmt: (d: Date) => string,
): ScoreExplanationSection {
  const ctx: FlightNarrativeCtx = {
    task,
    result,
    entry,
    fmt,
    sssIdx: getEffectiveSSSIndex(task),
    essIdx: getEffectiveESSIndex(task),
    // Per-turnpoint crossing directions, inferred from the task geometry — an
    // exit cylinder (one the route reaches from inside) counts when the pilot
    // flies OUT of it, and the narrative must say so.
    directions: computeTurnpointDirections(task),
  };
  const items: ScoreExplanationItem[] = [
    ...buildStartItems(ctx),
    ...buildTurnpointReachingItems(ctx),
    ...buildDeadlineItems(ctx),
    ...buildStopItems(ctx),
    ...buildBestProgressItems(ctx),
  ];
  return {
    id: 'flight',
    title: 'The flight',
    summary: 'What the tracklog shows, and which crossings scored.',
    docHref: result.stopInfo
      ? '/scoring/gap#stopped-tasks'
      : '/scoring/gap#how-a-task-works',
    items,
  };
}

/**
 * The inputs behind each validity factor, as a detail sentence.
 *
 * Every other section on the page states a rule, names its inputs, and prints
 * the arithmetic; before these existed the validity section stated a rule and
 * asserted a percentage, which is the one thing a reader cannot check. The
 * numbers come from the published `validity_inputs`; when a payload predates
 * them (the stale-first store still serves those) each returns undefined and
 * the row falls back to the bare percentage it always showed.
 *
 * The ratio is printed, not the cubic: the S7F curves have no intuition to
 * offer in coefficient form, and the ratio — "the winner got round in 71% of
 * the nominal time" — is the fact the reader can act on. The curve itself is
 * one click away on /scoring/gap.
 */
function launchValidityDetail(
  vi: ClassContextInput['validity_inputs'],
  params: GAPParameters | undefined,
): string | undefined {
  if (!vi || !params) return undefined;
  // Whole pilots: the threshold is fractional (96% of 32 is 30.72) and
  // "30.7 pilots" reads like a unit error. Ceil, because 30 would not clear it.
  const target = Math.ceil(vi.num_present * params.nominalLaunch);
  const pilots = (n: number) => `${n} pilot${n === 1 ? '' : 's'}`;
  return (
    `${pilots(vi.num_flying)} flew out of ${vi.num_present} present. ` +
    `Nominal launch is ${trimZeros((params.nominalLaunch * 100).toFixed(1), 0)}%, ` +
    `so launch validity is full once ${pilots(target)} are in the air.`
  );
}

function distanceValidityDetail(
  vi: ClassContextInput['validity_inputs'],
  params: GAPParameters | undefined,
): string | undefined {
  if (!vi || !params) return undefined;
  return (
    `Measured against a ${km(params.nominalDistance)} nominal distance, ` +
    `a ${trimZeros((params.nominalGoal * 100).toFixed(1), 0)}% nominal goal ` +
    `and a ${km(params.minimumDistance)} minimum distance. ` +
    `The field flew ${km(vi.mean_distance_over_minimum)} past the minimum on average, ` +
    `with a best of ${km(vi.best_distance)}.`
  );
}

function timeValidityDetail(
  vi: ClassContextInput['validity_inputs'],
  params: GAPParameters | undefined,
): string | undefined {
  if (!vi || !params) return undefined;
  // No best time means nobody completed the speed section, and the spec falls
  // back to the distance ratio — a different comparison, so it must not be
  // described as a time one.
  if (vi.best_time === null || vi.best_time <= 0) {
    return (
      `Nobody completed the speed section, so the spec compares distance instead: ` +
      `the best distance of ${km(vi.best_distance)} against the ` +
      `${km(params.nominalDistance)} nominal distance.`
    );
  }
  const ratio = vi.best_time / params.nominalTime;
  const against =
    `The fastest pilot took ${duration(vi.best_time)} against a nominal task time of ` +
    `${duration(params.nominalTime)}`;
  // The spec's ratio is min(1, best ÷ nominal), so a winning time at or over
  // nominal is simply a full day. Printing the clamped "100% of nominal" beside
  // a time visibly LONGER than nominal reads as an arithmetic error.
  return ratio >= 1
    ? `${against} — the task took as long as it was meant to, so no time devaluation applies.`
    : `${against} — ${trimZeros((ratio * 100).toFixed(1), 0)}% of nominal.`;
}

/** "12 of 41 pilots made goal → goal ratio 0.29", the input to the weights. */
function goalRatioPhrase(vi: NonNullable<ClassContextInput['validity_inputs']>): string {
  return (
    `${vi.num_in_goal} of ${vi.num_flying} pilot${vi.num_flying === 1 ? '' : 's'} made goal ` +
    `— a goal ratio of ${trimZeros(vi.goal_ratio.toFixed(2), 2)}`
  );
}

export function buildValiditySection(
  classContext: ClassContextInput,
  params?: GAPParameters,
): ScoreExplanationSection {
  const v = classContext.task_validity;
  const ap = classContext.available_points;
  const vi = classContext.validity_inputs;
  // One precision for the whole section, so the three factor rows, the task
  // validity in the summary and the equation all visibly agree.
  const decimals = validityFactorDecimals(v, ap.total);
  const items: ScoreExplanationItem[] = [
    {
      id: 'launch-validity',
      text: 'Launch validity — the day counts for less if much of the field never got into the air.',
      value: pctValidity(v.launch, decimals),
      detail: launchValidityDetail(vi, params),
    },
    {
      id: 'distance-validity',
      text: 'Distance validity — the day counts for less if the field as a whole did not get far.',
      value: pctValidity(v.distance, decimals),
      detail: distanceValidityDetail(vi, params),
    },
    {
      // Deliberately not "was the winning time long enough": pilots read that
      // as a long winning time being the problem. The rule is that a day
      // nobody could stretch out was not a full day's task.
      id: 'time-validity',
      text: 'Time validity — the day counts for less if the fastest pilot got round much quicker than the task was meant to take.',
      value: pctValidity(v.time, decimals),
      detail: timeValidityDetail(vi, params),
    },
    // Stopped tasks (S7F §12.3.3): the fourth validity factor.
    ...(v.stopped !== undefined
      ? [{
          id: 'stopped-validity',
          text:
            classContext.stopped && !classContext.stopped.requirement_met
              ? 'Stopped-task validity — the task was stopped before running the minimum time (min(1 h, half the nominal time) after the start), so it cannot be scored (FAI S7F §12.3.2).'
              : 'Stopped-task validity — the task was stopped; when nobody has reached the end of the speed section, the day is devalued by how settled the field already was (FAI S7F §12.3.3).',
          value: pctValidity(v.stopped, decimals),
          emphasis: (v.stopped < 1 ? 'warning' : 'muted') as 'warning' | 'muted',
        }]
      : []),
    {
      id: 'available-total',
      text: 'Points on offer for the day',
      value: pts(ap.total),
      detail: availableTotalDetail(v, ap.total, decimals),
    },
    {
      id: 'available-split',
      // How many pilots got there decides the split, so say so — "the goal
      // ratio" alone names a term the reader has met nowhere else and gives
      // them no value to attach to it.
      text: vi
        ? `Split between the components: ${goalRatioPhrase(vi)}`
        : 'Split between the components by the goal ratio',
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
    // The weights are the actual mechanism, and they explain why two pilots
    // with the same distance and different times separate the way they do.
    ...(vi
      ? [{
          id: 'available-weights',
          text: 'The share each component takes of the day',
          detail: [
            `distance ${pctWeight(vi.weights.distance)}`,
            `time ${pctWeight(vi.weights.time)}`,
            ...(vi.weights.leading > 0 ? [`leading ${pctWeight(vi.weights.leading)}`] : []),
            ...(vi.weights.arrival > 0 ? [`arrival ${pctWeight(vi.weights.arrival)}`] : []),
          ].join(' · '),
          emphasis: 'muted' as const,
        }]
      : []),
    // The PG leading-weight generation belongs HERE, where the weights are
    // decided, not down in the leading section where it used to sit.
    ...(params && leadingWeightDetail(params)
      ? [{
          id: 'weight-formula',
          text: leadingWeightDetail(params)!,
          emphasis: 'muted' as const,
        }]
      : []),
  ];
  return {
    id: 'validity',
    title: 'Day quality — points on offer',
    summary: `Task validity ${pctValidity(v.task, decimals)} of a perfect day, so ${fmtPoints(ap.total)} of 1000 points were available.`,
    docHref: '/scoring/gap#task-validity',
    items,
  };
}

export function buildDistanceSection(
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

  // Stopped tasks (S7F §12.3.6): a pilot still flying at the stop gets a
  // bonus distance for their height above goal — it is already inside the
  // scored distance, so state it before the figure it explains.
  const altBonus = entry.stopped_altitude_bonus ?? result.stopInfo?.altitudeBonus ?? 0;
  if (altBonus > 0 && result.stopInfo) {
    items.push({
      id: 'stopped-altitude-bonus',
      text: `Still flying when the task was stopped — an altitude bonus of ${km(altBonus)} is included in the scored distance: height above goal glides out at a fixed ${result.stopInfo.glideRatio}:1 ratio (FAI S7F §12.3.6).`,
      // Print the arithmetic only when it reconciles — the bonus is clamped
      // at goal distance, and a clamped figure would contradict the equation.
      detail: result.stopInfo.bestPointAltitude !== undefined &&
        Math.abs(
          result.stopInfo.glideRatio *
            Math.max(0, result.stopInfo.bestPointAltitude - result.stopInfo.goalAltitude) -
            altBonus,
        ) < 0.5
        ? `${Math.round(result.stopInfo.bestPointAltitude)} m GNSS at the scored point vs a ${Math.round(result.stopInfo.goalAltitude)} m goal → ${result.stopInfo.glideRatio} × ${Math.round(Math.max(0, result.stopInfo.bestPointAltitude - result.stopInfo.goalAltitude))} m = ${km(altBonus)}.`
        : 'The bonus is capped at the remaining distance to goal.',
    });
  }

  // The scale everything else in this section is a fraction of. Without it a
  // goal pilot has to infer the task length from their own scored distance,
  // and a landed-out pilot is told they were "12.3 km short" of nothing.
  if (classContext.validity_inputs && classContext.validity_inputs.task_distance > 0) {
    items.push({
      id: 'task-distance',
      text: 'Task distance',
      value: km(classContext.validity_inputs.task_distance),
      detail: 'The optimized task line — the shortest legal way round the turnpoints.',
      emphasis: 'muted',
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

  // Where this pilot placed on the section's own input. A goal day is
  // degenerate — every goal pilot ties at full distance — so say that rather
  // than a meaningless "equal 1st of 30".
  const scoredPilots = classContext.pilots.filter((p) => !p.track_excluded);
  const goalCount = scoredPilots.filter((p) => p.made_goal).length;
  let rank: string | undefined;
  if (entry.made_goal) {
    rank =
      goalCount > 1
        ? `Full distance — one of ${goalCount} pilots in goal`
        : 'Full distance — the only pilot in goal';
  } else if (scoredPilots.length >= 2) {
    rank = rankLabel(
      rankAmong(
        scoredPilots.map((p) => p.flown_distance),
        entry.flown_distance,
        (a, b) => a > b,
      ),
      'furthest',
    );
  }

  return {
    id: 'distance',
    title: 'Distance points',
    points: entry.distance_points,
    ...(ap.distance > 0 ? { pointsAvailable: ap.distance } : {}),
    ...(rank ? { rank } : {}),
    docHref: useDifficulty
      ? '/scoring/gap#distance-difficulty'
      : '/scoring/gap#distance-points',
    items,
  };
}

export function buildTimeSection(
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
  let rank: string | undefined;

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
    // The header's standing, and the gap behind the fastest pilot: the two
    // facts a reader otherwise has to derive by subtracting the rows above.
    if (bestTimes.length >= 2) {
      rank = `${rankLabel(
        rankAmong(bestTimes, entry.speed_section_time, (a, b) => a < b),
        'fastest',
      )} through the speed section`;
    }
    const behind = entry.speed_section_time - bestTime;
    const fastestPilot =
      behind > 0
        ? classContext.pilots.find(
            (p) =>
              (essNotGoalFactor > 0 ? p.reached_ess : p.made_goal) &&
              p.speed_section_time === bestTime &&
              p.pilot_name,
          )
        : undefined;
    items.push({
      id: 'best-time',
      text:
        essNotGoalFactor > 0
          ? 'Fastest time in class'
          : 'Fastest time in class (among pilots who made goal)',
      value: duration(bestTime),
      detail:
        behind > 0
          ? `${
              fastestPilot?.pilot_name
                ? `Set by ${fastestPilot.pilot_name} — you`
                : 'You'
            } were ${duration(behind)} behind.`
          : undefined,
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
    // Stopped tasks (S7F §12.3.5): every goal pilot's time points are docked
    // by a fixed amount — the points a pilot reaching ESS exactly at the end
    // of the scored window would get. Stated before the formula, and folded
    // into the printed equations so they reconcile with the published points.
    const stopReduction =
      entry.made_goal && classContext.stopped
        ? classContext.stopped.time_points_reduction
        : 0;
    if (stopReduction > 0) {
      items.push({
        id: 'stopped-time-reduction',
        text: `The task was stopped: every goal pilot's time points are reduced by ${fmtPoints(stopReduction)} — the points a pilot reaching the end of the speed section exactly at the task stop would get — so finishing just before the stop scores no better than being stopped just after ESS (FAI S7F §12.3.5).`,
        emphasis: 'warning',
      });
    }
    // The ×factor the engine applied (1 when no reduction) — folded into the
    // printed equations so they reconcile with the published points.
    const factor = essReduction ? essNotGoalFactor : 1;
    const factorEq = essReduction
      ? ` × ${trimZeros(essNotGoalFactor.toFixed(2), 1)} (ESS but not goal, §12.1)`
      : '';
    const stopEq = stopReduction > 0
      ? ` − ${fmtPoints(stopReduction)} (task stopped, §12.3.5)`
      : '';
    if (entry.speed_section_time <= bestTime) {
      const { availStr, reconciles } = reconcileWithAvailable(
        ap.time, 0, 0, entry.time_points,
        (_d, avail) => Math.max(0, avail * factor - stopReduction),
      );
      items.push({
        id: 'time-formula',
        text: essReduction
          ? 'Fastest through the speed section — full available time points, before the goal-validation reduction'
          : stopReduction > 0
            ? 'Fastest through the speed section — full available time points, before the stopped-task reduction'
            : 'Fastest through the speed section — full available time points.',
        value: pts(entry.time_points),
        detail: essReduction || stopReduction > 0
          ? `${availStr} available${factorEq}${stopEq} ${reconciles ? '=' : '≈'} ${fmtPoints(entry.time_points)}`
          : undefined,
      });
    } else {
      // time points = speed fraction × available (× the §12.1 factor, − the
      // §12.3.5 stopped reduction), exactly — print the fraction with enough
      // decimals that the multiplication visibly holds at the 0.1-pt step.
      // exponentLabel is the decoupled time-points exponent (issue #258).
      const { availStr, decimals, reconciles } = reconcileWithAvailable(
        ap.time, 3, 6, entry.time_points,
        (d, avail) => Math.max(0, Number(sf.toFixed(d)) * avail * factor - stopReduction),
      );
      items.push({
        id: 'time-formula',
        text: 'Time points fall off with the gap to the fastest time',
        value: pts(entry.time_points),
        detail: `speed fraction = max(0, 1 − ((T − Tbest) ÷ √Tbest)^${exponentLabel}) = ${trimZeros(sf.toFixed(decimals), 3)}; × ${availStr} available${factorEq}${stopEq} ${
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
    ...(ap.time > 0 ? { pointsAvailable: ap.time } : {}),
    ...(rank ? { rank } : {}),
    docHref: '/scoring/gap#time-points',
    items,
  };
}

/**
 * Leading points, with the arithmetic that produced them.
 *
 * Before this the section printed a sentence and a number, in a page where
 * every other component substitutes its formula — and leading is both the
 * least intuitive component in GAP and the one pilots most often dispute.
 * The gate is the leading coefficient: without it (leading not scored, or a
 * payload cached before it was published) the section stays as it was rather
 * than asserting arithmetic it cannot show.
 *
 * The coefficient is an area under the pilot's distance-over-time curve, so
 * its absolute value means nothing to a reader — only the comparison does.
 * That is why the best-in-class figure is printed beside it and why the
 * sentence says "lower is better" rather than leaving the reader to infer a
 * direction from two bare numbers.
 */
export function buildLeadingSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
): ScoreExplanationSection {
  const ap = classContext.available_points;
  const items: ScoreExplanationItem[] = [
    {
      id: 'leading',
      text: 'Leading points reward flying out front during the speed section — the pilot with the best leading coefficient takes all available leading points, others fall off with the gap.',
      value: pts(entry.leading_points),
    },
  ];

  const lc = entry.leading_coefficient;
  const allLCs = classContext.pilots
    .map((p) => p.leading_coefficient)
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0);
  const minLC = allLCs.length > 0 ? Math.min(...allLCs) : null;

  if (typeof lc === 'number' && Number.isFinite(lc) && minLC !== null) {
    items.push({
      id: 'leading-coefficient',
      text: 'Your leading coefficient — the area under your distance-over-time curve, so lower means further ahead for longer',
      value: trimZeros(lc.toFixed(3), 1),
      detail:
        lc <= minLC
          ? 'The best in the class — no one spent more of the race out front, so this takes the full available leading points.'
          : `Best in class ${trimZeros(minLC.toFixed(3), 1)}.`,
    });
    if (lc > minLC) {
      // Mirrors calculateLeadingPoints exactly, including its degenerate
      // guard: a non-positive best coefficient has no defined normalisation
      // and the engine scores 0 rather than dividing by it.
      const factor =
        minLC > 0 ? Math.max(0, 1 - Math.cbrt(((lc - minLC) * (lc - minLC)) / minLC)) : 0;
      const { availStr, decimals, reconciles } = reconcileWithAvailable(
        ap.leading, 3, 6, entry.leading_points,
        (d, avail) => Number(factor.toFixed(d)) * avail,
      );
      items.push({
        id: 'leading-formula',
        text: 'Leading points fall off with the gap to the best coefficient',
        value: pts(entry.leading_points),
        detail: `leading factor = max(0, 1 − ((LC − LCbest)² ÷ LCbest)^1⁄3) = ${trimZeros(
          factor.toFixed(decimals),
          3,
        )}; × ${availStr} available ${
          reconciles
            ? `= ${fmtPoints(entry.leading_points)}`
            : `≈ ${fmtPoints(entry.leading_points)} — the figures are shown rounded; the points come from their full precision`
        }`,
      });
    }
  }

  items.push({
    id: 'leading-variant',
    text: leadingVariantSentence(params.leadingFormula),
    emphasis: 'muted',
  });

  // Standing on the section's input: the coefficient itself (lower is
  // better), never the points — a §12.1 reduction can reorder those.
  const rank =
    typeof lc === 'number' && Number.isFinite(lc) && lc > 0 && allLCs.length >= 2
      ? rankLabel(
          rankAmong(allLCs, lc, (a, b) => a < b),
          'best leading coefficient',
        )
      : undefined;

  return {
    id: 'leading',
    title: 'Leading points',
    points: entry.leading_points,
    ...(ap.leading > 0 ? { pointsAvailable: ap.leading } : {}),
    ...(rank ? { rank } : {}),
    docHref: '/scoring/gap#leading-points',
    items,
  };
}

/**
 * Arrival points, with the arithmetic that produced them.
 *
 * The §11.4 factor is a function of arrival POSITION at the end of the speed
 * section, which the scorer computed and then discarded — leaving arrival as
 * the one component the page could only assert. With `arrival_position` and
 * `ess_time_ms` published it substitutes like every other component.
 *
 * The factor is evaluated with `calculateArrivalPoints` itself rather than a
 * re-typed cubic, so the printed figure is provably the scorer's own function
 * and the spec's coefficients live in exactly one place.
 *
 * Two things matter more here than the formula:
 *
 *  - **The order is by wall-clock time at ESS, not by speed.** A pilot on an
 *    early start gate can cross ahead of a faster pilot on a later gate and
 *    take more arrival points for it. Nothing on the site said so, and it is
 *    the detail most likely to be disputed.
 *  - **What one place was worth on this day.** The marginal value of moving up
 *    one is exact, and varies enormously with position — near the front a
 *    place is worth a lot, at the back almost nothing. That turns a bare
 *    placing into something a pilot can weigh.
 */
export function buildArrivalSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  params: GAPParameters,
  fmt: (d: Date) => string = defaultFormatTime,
): ScoreExplanationSection {
  const ap = classContext.available_points;
  // Prefer the published field size (it is the divisor the scorer used); fall
  // back to counting, for payloads written before validity_inputs existed.
  const atEss =
    classContext.validity_inputs?.num_reached_ess ??
    classContext.pilots.filter((p) => p.reached_ess).length;
  const position = entry.arrival_position ?? null;
  const items: ScoreExplanationItem[] = [];

  items.push({
    id: 'arrival',
    text: 'Arrival points reward crossing the end of the speed section early relative to the other pilots who reached it.',
    value: pts(entry.arrival_points),
  });

  if (position !== null && position > 0 && atEss > 0) {
    // A tie is real: the order is resolved by array position when two pilots
    // share a timestamp, which is not a fact about the flying. Say so rather
    // than presenting an ordering the data does not support.
    const tied =
      entry.ess_time_ms != null &&
      classContext.pilots.filter((p) => p.ess_time_ms === entry.ess_time_ms).length > 1;
    items.push({
      id: 'arrival-position',
      text: `Reached the end of the speed section ${ordinal(position)} of ${atEss}`,
      value: entry.ess_time_ms != null ? fmt(new Date(entry.ess_time_ms)) : undefined,
      detail:
        'The arrival order is by the clock at the end of the speed section, not by speed — an earlier start gate can put a slower pilot ahead of a faster one here.' +
        (tied
          ? ' Another pilot reached it on the same second; a tie is separated arbitrarily.'
          : ''),
    });

    const factor = calculateArrivalPoints(position, atEss, 1);
    const { availStr, decimals, reconciles } = reconcileWithAvailable(
      ap.arrival, 3, 6, entry.arrival_points,
      (d, avail) => Number(factor.toFixed(d)) * avail,
    );
    // The §12.1 factor is stated by buildArrivalEssNotGoalItems below; when it
    // applies the printed product is the pre-reduction figure, so don't claim
    // an equality the published points won't satisfy.
    const reduced =
      params.scoring === 'HG' && entry.reached_ess && !entry.made_goal &&
      params.essNotGoalFactor < 1;
    items.push({
      id: 'arrival-formula',
      text: 'Arrival points fall off steeply with each place',
      value: pts(entry.arrival_points),
      detail:
        `arrival ratio = 1 − (${position} − 1) ÷ ${atEss} = ${trimZeros(
          (1 - (position - 1) / atEss).toFixed(3),
          2,
        )}; arrival factor = 0.2 + 0.037·r + 0.13·r² + 0.633·r³ = ${trimZeros(
          factor.toFixed(decimals),
          3,
        )}; × ${availStr} available ${
          reduced || !reconciles ? '≈' : '='
        } ${fmtPoints(entry.arrival_points)}`,
    });

    // What one place was worth here. The coefficients sum to 1, so first place
    // takes everything available and the 0.2 constant floors everyone else —
    // both worth stating, because "20% for last" is the shape of the curve.
    if (position === 1) {
      items.push({
        id: 'arrival-shape',
        text: 'First to the end of the speed section — the full available arrival points.',
        emphasis: 'muted',
      });
    } else {
      const onePlace =
        calculateArrivalPoints(position - 1, atEss, ap.arrival) -
        calculateArrivalPoints(position, atEss, ap.arrival);
      const last = calculateArrivalPoints(atEss, atEss, ap.arrival);
      items.push({
        id: 'arrival-shape',
        text: `One place earlier would have been worth ${fmtPoints(onePlace)} more points`,
        detail: `The curve is front-loaded: first place takes all ${fmtPoints(
          ap.arrival,
        )} available, and everyone else who reaches the end of the speed section keeps at least ${fmtPoints(
          last,
        )} of them.`,
        emphasis: 'muted',
      });
    }
  } else if (atEss > 0) {
    // No position published (an older cached payload) — state the half of the
    // ratio we can stand behind rather than inventing the other.
    items.push({
      id: 'arrival-field',
      text: `${atEss} pilot${atEss === 1 ? '' : 's'} reached the end of the speed section on this task; the points scale with where in that group you crossed it (FAI S7F §11.4).`,
      emphasis: 'muted',
    });
  }

  items.push(...buildArrivalEssNotGoalItems(entry, params));

  // The header's standing — the arrival POSITION is the section's whole
  // input, so it is the rank, restated scannably.
  const rank =
    position !== null && position > 0 && atEss >= 2
      ? `${position === 1 ? 'First' : ordinal(position)} of ${atEss} to the end of the speed section`
      : undefined;

  return {
    id: 'arrival',
    title: 'Arrival points',
    points: entry.arrival_points,
    ...(ap.arrival > 0 ? { pointsAvailable: ap.arrival } : {}),
    ...(rank ? { rank } : {}),
    docHref: '/scoring/gap#arrival-points',
    items,
  };
}

/**
 * Competition rank of `mine` among `values`: 1 + the number strictly better.
 * `tied` is true when another entry shares the exact value (`values` includes
 * this pilot's own, so a shared value counts twice).
 */
function rankAmong(
  values: number[],
  mine: number,
  better: (candidate: number, mine: number) => boolean,
): { position: number; of: number; tied: boolean } {
  let ahead = 0;
  let equal = 0;
  for (const v of values) {
    if (better(v, mine)) ahead++;
    else if (v === mine) equal++;
  }
  return { position: ahead + 1, of: values.length, tied: equal > 1 };
}

/** "3rd fastest of 12", "Fastest of 12", "Equal fastest of 12". */
function rankLabel(
  r: { position: number; of: number; tied: boolean },
  superlative: string,
): string {
  const place =
    r.position === 1 ? superlative : `${ordinal(r.position)} ${superlative}`;
  const label = `${r.tied ? 'equal ' : ''}${place} of ${r.of}`;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th". */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/**
 * The §12.1 "ESS but not goal" caveat for the arrival section: an HG pilot
 * who reaches ESS but lands before goal keeps only the competition's
 * essNotGoalFactor share of their arrival points (same factor as time).
 */
export function buildArrivalEssNotGoalItems(
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

export function buildTotalSection(
  entry: ScoreEntryInput,
  /** The day's points on offer (available_points.total), when the caller has
   * a class context — lets the header read "952.4 of 999.3 pts". */
  availableTotal?: number,
): ScoreExplanationSection {
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
    ...(availableTotal !== undefined && availableTotal > 0
      ? { pointsAvailable: availableTotal }
      : {}),
    docHref: '/scoring/gap#total-score',
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

/**
 * "Where the points went" — this pilot against the best score in the class,
 * component by component.
 *
 * The header says "ranked #9" and the page then never mentions it again, so
 * the reader's actual question — why am I 9th and not 3rd — goes unanswered
 * beside a full accounting of points they cannot compare to anything. Every
 * number here is already in the class context; nothing is recomputed.
 *
 * The comparison is against the class LEADER, not the best value per
 * component. A per-component best would assemble a pilot who does not exist
 * and whose "total" no one scored — the honest question is what separates
 * this pilot from the person who won the day.
 *
 * The leader (or a pilot tied at the top) has no gap to anyone, but they
 * still arrive with the same question in a different frame — full validity,
 * why not full points? — so they get the vs-the-day variant from
 * {@link buildPointsLeftSection} instead of nothing. Returns null only when
 * the payload carries no comparable pilots, or the leader swept the day.
 */
export function buildComparisonSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
): ScoreExplanationSection | null {
  // Only pilots the payload carries point components for — older cached
  // bodies narrow to the four validity fields and cannot be compared.
  const scored = classContext.pilots.filter(
    (p) => p.total_score !== undefined && !p.track_excluded,
  );
  if (scored.length === 0) return null;
  const leader = scored.reduce((best, p) =>
    (p.total_score ?? 0) > (best.total_score ?? 0) ? p : best,
  );
  const leaderTotal = leader.total_score ?? 0;
  const gap = leaderTotal - entry.total_score;
  // Nobody ahead — the question flips from "the winner has what I don't" to
  // "the day offered what I didn't take".
  if (gap <= 0.05) return buildPointsLeftSection(entry, classContext, scored);
  if (scored.length < 2) return null;

  const rows: Array<{ id: string; label: string; mine: number; theirs: number }> = [
    {
      id: 'distance',
      label: 'Distance',
      mine: entry.distance_points,
      theirs: leader.distance_points ?? 0,
    },
    {
      id: 'time',
      label: 'Time',
      mine: entry.time_points,
      theirs: leader.time_points ?? 0,
    },
  ];
  if (classContext.available_points.leading > 0) {
    rows.push({
      id: 'leading',
      label: 'Leading',
      mine: entry.leading_points,
      theirs: leader.leading_points ?? 0,
    });
  }
  if (classContext.available_points.arrival > 0) {
    rows.push({
      id: 'arrival',
      label: 'Arrival',
      mine: entry.arrival_points,
      theirs: leader.arrival_points ?? 0,
    });
  }

  const items: ScoreExplanationItem[] = rows.map((r) => {
    const diff = r.mine - r.theirs;
    return {
      id: `gap-${r.id}`,
      text: r.label,
      value:
        Math.abs(diff) < 0.05
          ? 'level'
          : `${diff > 0 ? '+' : '−'}${fmtPoints(Math.abs(diff))} pts`,
      detail: `you ${fmtPoints(r.mine)}, the leader ${fmtPoints(r.theirs)}`,
      emphasis: Math.abs(diff) < 0.05 ? 'muted' : undefined,
    };
  });

  // Name the component that cost the most, when one clearly dominates. This
  // is the sentence the reader came for, and it is a fact about the
  // arithmetic — not advice about how to fly.
  const losses = rows
    .map((r) => ({ label: r.label.toLowerCase(), lost: r.theirs - r.mine }))
    .filter((r) => r.lost > 0.05)
    .sort((a, b) => b.lost - a.lost);
  const dominant =
    losses.length > 0 && losses[0].lost >= 0.75 * gap ? losses[0] : null;

  items.push({
    id: 'gap-total',
    text: `Behind ${leader.pilot_name ?? 'the class leader'}`,
    value: `−${fmtPoints(gap)} pts`,
    detail: dominant
      ? losses.length === 1
        ? `All of the gap is ${dominant.label}.`
        : `Most of the gap — ${fmtPoints(dominant.lost)} of ${fmtPoints(gap)} points — is ${dominant.label}.`
      : `Spread across ${losses.length} components.`,
  });

  return {
    id: 'comparison',
    title: 'Where the points went',
    summary: `Your ${fmtPoints(entry.total_score)} against the ${fmtPoints(
      leaderTotal,
    )} that won the class.`,
    docHref: '/scoring/gap#scoring-components',
    items,
  };
}

/**
 * What separates this pilot's published points from the day's per-component
 * offer, penalties included — the "left on the day" ledger shared by the
 * leader's comparison section and the winner's headline note.
 */
function shortfallsAgainstOffer(
  entry: ScoreEntryInput,
  ap: ClassContextInput['available_points'],
): Array<{ label: string; lost: number }> {
  const rows = [
    { label: 'distance', lost: ap.distance - entry.distance_points },
    { label: 'time', lost: ap.time - entry.time_points },
    ...(ap.leading > 0
      ? [{ label: 'leading', lost: ap.leading - entry.leading_points }]
      : []),
    ...(ap.arrival > 0
      ? [{ label: 'arrival', lost: ap.arrival - entry.arrival_points }]
      : []),
    {
      label: 'penalties',
      lost: entry.penalty_points + (entry.jump_the_gun_penalty ?? 0),
    },
  ];
  return rows.filter((r) => r.lost > 0.05).sort((a, b) => b.lost - a.lost);
}

/**
 * The leader's version of "where the points went": nobody out-scored them,
 * so the comparison that answers their actual question — the day had full
 * validity, why didn't I get full points? — is against the day's own offer,
 * component by component. One pilot genuinely could take it all (in goal,
 * fastest, best leading coefficient, first to ESS), so the per-component
 * offer is a real ceiling here, not the composite fiction a per-component
 * best across different pilots would be for everyone else.
 *
 * Where another pilot took a component's full points, they are named — that
 * is the sentence the winner came for ("your speed was not the fastest").
 */
function buildPointsLeftSection(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
  /** The comparable pilots (total_score published, track not withheld). */
  scored: ClassPilotInput[],
): ScoreExplanationSection | null {
  const ap = classContext.available_points;
  const left = ap.total - entry.total_score;
  // A full sweep — nothing to explain.
  if (left <= 0.05) return null;

  // The pilot who took a component's full points, when one did and the
  // payload names them. Matched on the published points, not re-derived.
  const fullTaker = (
    points: (p: ClassPilotInput) => number | undefined,
    available: number,
  ): ClassPilotInput | undefined =>
    scored.find(
      (p) => p.pilot_name && Math.abs((points(p) ?? 0) - available) <= 0.05,
    );

  const items: ScoreExplanationItem[] = [];
  const row = (
    id: string,
    label: string,
    mine: number,
    offer: number,
    takerNote?: string,
  ) => {
    const short = offer - mine;
    const full = short <= 0.05;
    items.push({
      id: `left-${id}`,
      text: label,
      value: full ? 'full points' : `−${fmtPoints(short)} pts`,
      detail: `you ${fmtPoints(mine)} of ${fmtPoints(offer)} on offer${
        !full && takerNote ? takerNote : ''
      }`,
      emphasis: full ? 'muted' : undefined,
    });
  };

  row('distance', 'Distance', entry.distance_points, ap.distance);
  const fastest = fullTaker((p) => p.time_points, ap.time);
  row(
    'time',
    'Time',
    entry.time_points,
    ap.time,
    fastest
      ? ` — ${fastest.pilot_name} took the full time points${
          fastest.speed_section_time
            ? ` in ${duration(fastest.speed_section_time)}`
            : ''
        }`
      : undefined,
  );
  if (ap.leading > 0) {
    const bestLead = fullTaker((p) => p.leading_points, ap.leading);
    row(
      'leading',
      'Leading',
      entry.leading_points,
      ap.leading,
      bestLead ? ` — ${bestLead.pilot_name} took the full leading points` : undefined,
    );
  }
  if (ap.arrival > 0) {
    const firstEss = fullTaker((p) => p.arrival_points, ap.arrival);
    row(
      'arrival',
      'Arrival',
      entry.arrival_points,
      ap.arrival,
      firstEss
        ? ` — ${firstEss.pilot_name} was first to the end of the speed section`
        : undefined,
    );
  }
  const penalties = entry.penalty_points + (entry.jump_the_gun_penalty ?? 0);
  if (penalties > 0.05) {
    items.push({
      id: 'left-penalty',
      text: 'Penalties',
      value: `−${fmtPoints(penalties)} pts`,
      detail: 'See the penalty section above.',
      emphasis: 'warning',
    });
  }

  // Name what the shortfall mostly is, when one component clearly dominates —
  // the same 75% threshold as the behind-the-leader variant.
  const losses = shortfallsAgainstOffer(entry, ap);
  const dominant =
    losses.length > 0 && losses[0].lost >= 0.75 * left ? losses[0] : null;
  items.push({
    id: 'left-total',
    text: 'Left on the day',
    value: `−${fmtPoints(left)} pts`,
    detail: dominant
      ? losses.length === 1
        ? `All of it is ${dominant.label}.`
        : `Most of it — ${fmtPoints(dominant.lost)} of ${fmtPoints(left)} points — is ${dominant.label}.`
      : `Spread across ${losses.length} components.`,
  });

  return {
    id: 'comparison',
    title: 'The points left on the day',
    summary: `Nobody out-scored you — so this compares your ${fmtPoints(
      entry.total_score,
    )} against the ${fmtPoints(ap.total)} the day offered.`,
    docHref: '/scoring/gap#scoring-components',
    items,
  };
}

/**
 * The winner's bridging sentence, shown under the headline: the one question
 * the day's leader arrives with — full validity, why not full points? — gets
 * answered before any scrolling. Everyone else's version of the question is
 * the gap to the leader, which the comparison section leads with, so this
 * returns undefined for them.
 */
export function buildWinnerHeadlineNote(
  entry: ScoreEntryInput,
  classContext: ClassContextInput,
): string | undefined {
  const scored = classContext.pilots.filter(
    (p) => p.total_score !== undefined && !p.track_excluded,
  );
  if (scored.length === 0) return undefined;
  const leaderTotal = Math.max(...scored.map((p) => p.total_score ?? 0));
  if (leaderTotal - entry.total_score > 0.05) return undefined;
  const ap = classContext.available_points;
  const left = ap.total - entry.total_score;
  if (left <= 0.05) return undefined;
  const losses = shortfallsAgainstOffer(entry, ap);
  const dominant =
    losses.length > 0 && losses[0].lost >= 0.75 * left ? losses[0] : null;
  const mostly = dominant
    ? losses.length === 1
      ? ` — all of it ${dominant.label}`
      : ` — mostly ${dominant.label}`
    : '';
  let note = `Top of the class, but not a full sweep: of the ${fmtPoints(
    ap.total,
  )} points on offer, ${fmtPoints(left)} went untaken${mostly}.`;
  // When the shortfall is time, state the concrete fact behind it: how much
  // quicker the pilot who took the full time points was.
  if (dominant?.label === 'time' && entry.speed_section_time !== null) {
    const fastest = scored.find(
      (p) =>
        p.speed_section_time != null &&
        Math.abs((p.time_points ?? 0) - ap.time) <= 0.05,
    );
    const behind =
      fastest?.speed_section_time != null
        ? entry.speed_section_time - fastest.speed_section_time
        : 0;
    if (behind > 0) {
      note += ` The fastest pilot through the speed section was ${duration(behind)} quicker.`;
    }
  }
  return note;
}

export function buildPenaltySection(
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
export function leadingWeightDetail(params: GAPParameters): string | undefined {
  if (params.scoring !== 'PG') return undefined;
  if (params.leadingWeightFormula === 's7f2024') {
    const ratioPct = Math.round(params.leadingTimeRatio * 100);
    return `Leading weight follows the FAI S7F 2024 §10 formula: ${ratioPct}% of the non-distance weight (LeadingTimeRatio) goes to leading when someone makes goal, and all of it when nobody does.`;
  }
  if (params.leadingWeightFormula === 's7f2020') {
    return 'Weights follow the FAI S7F 2020–2022 §10 formula (PWC-derived): distance weight 0.838 when nobody makes goal, else 0.805 − 1.374·GR + 1.413·GR² − 0.484·GR³; leading weight fixed at 0.162; time takes the remainder.';
  }
  return 'Leading weight follows the GAP2020 formula (the GAP2016/2018 weights, AirScore legacy parity): 35% of the non-distance weight when someone makes goal, and 0.1 × best distance ÷ task distance when nobody does.';
}

/**
 * The flight-narrative section for a manual flight — no tracklog, so it states
 * the last turnpoint reached and the landing point, and attaches the routed
 * "distance to goal" line to the landing anchor (kind `best_progress`) exactly
 * as a landed-out track does, so the map shows the same evidence.
 */
export function buildManualFlightSection(
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
