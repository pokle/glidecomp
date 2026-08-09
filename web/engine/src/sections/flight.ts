/**
 * The flight-narrative section: what the tracklog shows, in task order.
 *
 * Composed from five phase builders — start crossings (including re-entries
 * and which one scored), turnpoint reachings, the task deadline, a task stop,
 * and goal or best progress — plus the manual-flight variant an official
 * records for a pilot with no tracklog (FAI S7F §8.4).
 */

import type { XCTask } from '../xctsk-parser';
import { getEffectiveSSSIndex, getEffectiveESSIndex, getGoalIndex } from '../xctsk-parser';
import type { TurnpointSequenceResult } from '../turnpoint-sequence';
import type { ManualFlightGeometry } from '../manual-flight';
import { calculateOptimizedTaskLine, computeTurnpointDirections, type TurnpointDirection } from '../task-optimizer';
import { computeGoalLine } from '../goal-line';
import type {
  ScoreExplanationItem,
  ScoreExplanationSection,
  ScoreEntryInput,
} from '../score-explanation-types';
import { km, duration } from '../score-explanation-format';
import { reachingAnchor, turnpointLabel, turnpointName } from './shared';

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
 * The goal-line version of {@link TOLERANCE_NOTE}: a line carries the same
 * percentage tolerance as a cylinder (FAI S7F §8.2), and at goal what that
 * buys is length — a crossing that lands just past an endpoint still counts.
 */
const LINE_TOLERANCE_NOTE =
  'Credited by the line tolerance band (FAI S7F §8.2) — the track crossed just past the end of the goal line, within the tolerance it carries. A line gets the same percentage as a cylinder, and at least 5 m.';

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
      const lineDesc = `the ${Math.round(goalLine.halfWidth * 2)} m goal line, perpendicular to the final leg (S7F §6.2.3.1)`;
      const goalNote = reaching.goalSemicircleCredited
        ? `Recorded in the control semicircle behind ${lineDesc} — a fix in the semicircle counts as goal even when the line crossing itself falls between tracklog fixes.`
        : reaching.selectionReason === 'already_inside'
          ? `Goal is ${lineDesc}.`
          : `Crossed ${lineDesc}, in the direction of the last leg.`;
      detail = `${goalNote}${detail ? ` ${detail}` : ''}`;
    }
    if (reaching.toleranceCredited) {
      // A goal line's band is §8.2's, and it means something different from a
      // cylinder's — say which one credited the pilot.
      detail = `${detail ? `${detail} ` : ''}${goalLine ? LINE_TOLERANCE_NOTE : TOLERANCE_NOTE}`;
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
  // Stopped task (FAI S7F §13.4): narrate how the stop shaped this flight —
  // the scored window's end, the complete-flight exemption for pilots
  // at/after ESS (§13.4.5), and any crossings dropped by the clip.
  const stop = result.stopInfo;
  if (!stop) return out;
  const windowDiffers =
    stop.windowEnd.getTime() !== stop.stopTime.getTime();
  out.push({
    id: 'task-stopped',
    // §13.4.5 (2026): every pilot is scored only up to the stop — including
    // pilots already past ESS.
    text: windowDiffers
      ? 'The task was stopped. With multiple start gates every pilot is scored for the time window the last-started pilot had (FAI S7F §13.4.4) — this flight scored up to the window end shown.'
      : 'The task was stopped — the flight is scored only up to the task stop time (FAI S7F §13.4).',
    value: fmt(stop.windowEnd),
    emphasis: stop.crossingsAfterStop > 0 ? 'warning' : 'muted',
    detail: windowDiffers
      ? `Task stop time ${fmt(stop.stopTime)}; this pilot's scored window ends ${fmt(stop.windowEnd)}.`
      : undefined,
  });
  if (stop.essBeforeStop && result.essReaching && !entry.made_goal) {
    out.push({
      id: 'stop-ess-between',
      text: 'Past the end of the speed section but short of goal when the task was stopped — scored for the distance and speed-section time flown up to the stop (FAI S7F §13.4.5).',
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
    // task — the fix whose §8.6.1 remaining route (shortest path through the
    // un-reached turnpoints to goal) is shortest, not the point nearest goal
    // in a straight line. Name the next turnpoint so the map marker makes
    // sense.
    const nextIdx = result.lastTurnpointReached + 1;
    const nextIsGoal = nextIdx === getGoalIndex(task);
    const goalIsLine = nextIsGoal && computeGoalLine(task) !== null;
    const nextIsExit = !nextIsGoal && directions[nextIdx] === 'exit';
    const nextName = turnpointName(task, nextIdx);
    const nextDesc = `${turnpointLabel(task, nextIdx)}${nextName ? ` (${nextName})` : ''}`;
    // The remaining routed line: the §8.6.1 measured route carried on the
    // result (first element = the best-progress point). Payloads cached
    // before the field existed fall back to the task line's tag points —
    // an approximation of the measured route, but still a truthful "on
    // through the remaining turnpoints" picture.
    const path: Array<{ latitude: number; longitude: number }> =
      result.bestProgress.remainingRoute?.map((p) => ({
        latitude: p.lat,
        longitude: p.lon,
      })) ?? [
        {
          latitude: result.bestProgress.latitude,
          longitude: result.bestProgress.longitude,
        },
        ...calculateOptimizedTaskLine(task)
          .slice(nextIdx)
          .map((p) => ({ latitude: p.lat, longitude: p.lon })),
      ];
    out.push({
      id: 'best-progress',
      text: `Landed out — best distance made good along the task, ${km(result.bestProgress.distanceToGoal)} short of goal`,
      value: fmt(result.bestProgress.time),
      detail: nextIsGoal
        ? `The marked point is where the flight had the least distance still to fly to ${goalIsLine ? 'the goal line' : 'goal'}${nextName ? ` (${nextName})` : ''}. Scored distance is measured along the task to this point: ${km(entry.flown_distance)}.`
        : nextIsExit
          ? `The next turnpoint, ${nextDesc}, is an exit cylinder — it counts only when the pilot flies OUT of its ${km(task.turnpoints[nextIdx]?.radius ?? 0)} boundary, and this flight never did. The marked point is where the flight had the least distance still to fly — measured as the shortest route from that point out to the boundary and on through the remaining turnpoints to goal — so the scored distance is ${km(entry.flown_distance)}.`
          : `The marked point is where the flight had the least distance still to fly — measured as the shortest route from that point through the remaining turnpoints (next: ${nextDesc}) to goal, not as a straight line to goal — so the scored distance is ${km(entry.flown_distance)}.`,
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
