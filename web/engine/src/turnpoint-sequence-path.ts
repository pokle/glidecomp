/**
 * Forward-path construction and best-progress measurement.
 *
 * Given the raw crossings, builds a candidate turnpoint-reaching sequence for
 * a start crossing and measures a landed-out pilot's furthest progress toward
 * goal. The resolver tries these per start crossing and keeps the best.
 */

import type { XCTask } from './xctsk-parser';
import { fixAltitude, type IGCFix } from './igc-parser';
import { ellipsoidDistance } from './geo';
import {
  computeTurnpointDirections,
  optimizeRemainingRoute,
  type TurnpointDirection,
} from './task-optimizer';
import { computeGoalLine, distanceToGoalLine } from './goal-line';
import type {
  CylinderCrossing,
  TurnpointReaching,
  BestProgress,
  NextTPMeasure,
} from './turnpoint-sequence-types';

/**
 * Build a forward path from an SSS crossing through subsequent turnpoints.
 *
 * Reaching a turnpoint is presence-based (FAI S7F §9 / FS semantics), on the
 * side of the boundary the turnpoint's direction requires: an ENTER cylinder
 * needs the pilot inside it at or after the previous reaching, an EXIT
 * cylinder (one the route arrives at from inside — see
 * {@link computeTurnpointDirections}) needs them outside it. For each TP
 * after SSS that means either the first qualifying boundary crossing
 * at/after the previous reaching time, or — when the pilot is already on
 * the required side at that moment — the previous reaching moment itself.
 *
 * @param startedInsideTP - Per task index: whether the track's FIRST fix lay
 *   inside that cylinder's detection edge (outer for ENTER cylinders, inner
 *   for EXIT). Only consulted for a cylinder with no crossing before the
 *   previous reaching (the pilot's inside/outside state never toggled, so it
 *   is the state at track start).
 * @param directions - Per task index: the required crossing direction
 *   ({@link computeTurnpointDirections}).
 */
interface BuildForwardPathParams {
  sssCrossing: CylinderCrossing;
  crossingsByTP: Map<number, CylinderCrossing[]>;
  sssIdx: number;
  essIdx: number;
  goalIdx: number;
  startedInsideTP: boolean[];
  directions: TurnpointDirection[];
  startSelectionReason?: TurnpointReaching['selectionReason'];
}

export function buildForwardPath(params: BuildForwardPathParams): TurnpointReaching[] {
  const {
    sssCrossing,
    crossingsByTP,
    sssIdx,
    essIdx,
    goalIdx,
    startedInsideTP,
    directions,
    startSelectionReason = 'last_before_next',
  } = params;
  const sequence: TurnpointReaching[] = [];

  // Add SSS reaching
  sequence.push({
    taskIndex: sssCrossing.taskIndex,
    fixIndex: sssCrossing.fixIndex,
    time: sssCrossing.time,
    latitude: sssCrossing.latitude,
    longitude: sssCrossing.longitude,
    altitude: sssCrossing.altitude,
    selectionReason: startSelectionReason,
    candidateCount: crossingsByTP.get(sssIdx)?.length ?? 0,
    toleranceCredited: sssCrossing.toleranceCredited,
  });

  let prevReachingTime = sssCrossing.time.getTime();

  // For each subsequent task position
  for (let tpIdx = sssIdx + 1; tpIdx <= goalIdx; tpIdx++) {
    const tpCrossings = crossingsByTP.get(tpIdx) ?? [];
    const isESS = tpIdx === essIdx;
    const isExit = directions[tpIdx] === 'exit';

    // Presence-based reaching: if the pilot is already on the required side
    // of this cylinder's boundary at the moment the previous turnpoint is
    // reached, the turnpoint is reached at that same moment — no boundary
    // crossing required. For an ENTER cylinder the required side is inside:
    // the nested-cylinder case (e.g. a small final TP inside a big ESS/goal
    // ring), where the only crossing of the big cylinder happens BEFORE the
    // nested TP is tagged, and a pilot who then flies to goal without ever
    // exiting would otherwise be scored landed-out. For an EXIT cylinder the
    // required side is outside: a pilot who tagged the previous turnpoint
    // beyond this cylinder's boundary has already satisfied it. Crossings
    // toggle the pilot's inside/outside state, so the state at the previous
    // reaching is given by the last crossing strictly before it — or, when
    // no crossing precedes it, by where the track began. A crossing exactly
    // AT the previous reaching time is left to the crossing search below, so
    // the identical co-located ESS/goal cylinder keeps its 'first_crossing'
    // reaching from the shared boundary crossing.
    let lastCrossingBefore: CylinderCrossing | null = null;
    for (const crossing of tpCrossings) {
      if (crossing.time.getTime() >= prevReachingTime) break;
      lastCrossingBefore = crossing;
    }
    const insideAtPrevReaching = lastCrossingBefore
      ? lastCrossingBefore.direction === 'enter'
      : startedInsideTP[tpIdx];
    const satisfiedAtPrevReaching = isExit
      ? !insideAtPrevReaching
      : insideAtPrevReaching;

    if (satisfiedAtPrevReaching) {
      const prev = sequence[sequence.length - 1];
      sequence.push({
        taskIndex: tpIdx,
        fixIndex: prev.fixIndex,
        time: prev.time,
        latitude: prev.latitude,
        longitude: prev.longitude,
        altitude: prev.altitude,
        selectionReason: isExit ? 'already_outside' : 'already_inside',
        candidateCount: tpCrossings.length,
        toleranceCredited: lastCrossingBefore?.toleranceCredited ?? false,
        ...(lastCrossingBefore?.goalSemicircleCredited
          ? { goalSemicircleCredited: true }
          : {}),
      });
      continue; // reached at the same moment — prevReachingTime unchanged
    }

    // Find first qualifying crossing at or after the previous reaching time.
    // For an EXIT cylinder only outward crossings qualify — the pilot is
    // inside and must leave; an ENTER cylinder accepts the first crossing
    // (the pilot is outside, so it is necessarily inward).
    //
    // The comparison is >= (not >) so a turnpoint co-located with the
    // previous one is credited from the same physical boundary crossing.
    // The common case is the speed section ending at goal: ESS and goal are
    // the *same* cylinder (same centre and radius), so a single entry emits
    // two crossings — one per task index — carrying the identical
    // interpolated timestamp. A strict > would drop the goal crossing and
    // report a pilot who reached ESS as "landed out". A genuinely tighter
    // co-located cylinder still produces a strictly-later crossing (you
    // reach the wider ring first), so >= never over-credits: it only
    // rescues the identical-cylinder case.
    let validCrossing: CylinderCrossing | null = null;
    for (const crossing of tpCrossings) {
      if (crossing.time.getTime() >= prevReachingTime && (!isExit || crossing.direction === 'exit')) {
        validCrossing = crossing;
        break;
      }
    }

    if (!validCrossing) {
      break; // Pilot didn't reach this TP
    }

    sequence.push({
      taskIndex: validCrossing.taskIndex,
      fixIndex: validCrossing.fixIndex,
      time: validCrossing.time,
      latitude: validCrossing.latitude,
      longitude: validCrossing.longitude,
      altitude: validCrossing.altitude,
      selectionReason: isESS ? 'first_crossing' : 'first_after_previous',
      candidateCount: tpCrossings.length,
      toleranceCredited: validCrossing.toleranceCredited,
      ...(validCrossing.goalSemicircleCredited
        ? { goalSemicircleCredited: true }
        : {}),
    });

    prevReachingTime = validCrossing.time.getTime();
  }

  return sequence;
}

/**
 * Build the list of remaining turnpoints and inter-TP leg distances
 * from the last reached task index to goal.
 */
export function buildRemainingPath(
  task: XCTask,
  lastReachedIndex: number,
  segmentDistances: number[],
): { remainingTPs: Array<{ lat: number; lon: number; radius: number }>; remainingLegDistances: number[] } {
  const remainingTPs: Array<{ lat: number; lon: number; radius: number }> = [];
  for (let i = lastReachedIndex + 1; i < task.turnpoints.length; i++) {
    const tp = task.turnpoints[i];
    remainingTPs.push({ lat: tp.waypoint.lat, lon: tp.waypoint.lon, radius: tp.radius });
  }

  // Leg distances between consecutive remaining TPs
  // segmentDistances[i] = optimized distance from task TP[i] to TP[i+1]
  // We need distances from TP[lastReachedIndex+1] to TP[lastReachedIndex+2], etc.
  const remainingLegDistances: number[] = [];
  for (let i = lastReachedIndex + 1; i < task.turnpoints.length - 1; i++) {
    remainingLegDistances.push(segmentDistances[i]);
  }

  return { remainingTPs, remainingLegDistances };
}

/**
 * How close to the true minimum the 'exact' best-progress search is
 * guaranteed to land (metres). Published competition distances carry 10 m
 * resolution and the tag-point approximation this search replaced erred by
 * 60–400 m, so 5 m is far inside both; a non-zero tolerance is what lets
 * the search skip a thermal's worth of near-identical fixes instead of
 * optimising every one of them.
 */
const BEST_PROGRESS_TOLERANCE_M = 5;

/**
 * Compute best progress for a non-goal pilot.
 *
 * Scans all fixes after the last reaching time and finds the one with the
 * minimum remaining distance to goal. What "remaining distance" means
 * depends on the mode:
 *
 * - `'exact'` — the §9.3 measurement: "for every remaining track point,
 *   the shortest distance to goal is calculated using the method described
 *   in section 6.4.1" — a fresh shortest-path optimisation of the route
 *   {point(fix), un-reached control zones…, goal}
 *   ({@link optimizeRemainingRoute}), NOT the distance to a tag point
 *   frozen by the launch-anchored task line. Used for the sequence that
 *   actually scores.
 *
 * - `'approx'` — the cheap single-pass tag/edge measure (the pre-§9.3
 *   behaviour): fix→next-turnpoint by {@link NextTPMeasure}, plus the task
 *   line's frozen legs. Used by the resolver's candidate-start RANKING
 *   loop, where each of many candidate sequences needs a comparable
 *   distance and a few-hundred-metre approximation cannot realistically
 *   reorder candidates whose distances differ by whole turnpoints.
 *
 * The exact mode is a small branch-and-bound, not a per-fix sweep: the
 * approx measure seeds the incumbent; a per-fix LOWER bound — the larger
 * of (edge distance to the next zone + the sum of centre-to-centre-minus-
 * radii minimums between remaining zones) and the straight edge distance
 * to goal, no path can beat either — prunes; evaluated fixes prune their
 * neighbours by the Lipschitz property (remaining distance between two
 * positions can differ by at most their separation). Fixes are evaluated
 * in ascending-bound order until no bound can improve the incumbent by
 * more than {@link BEST_PROGRESS_TOLERANCE_M}.
 *
 * @param task - The scoring task (already trimmed for the distance origin).
 * @param lastReachedIndex - Index of the last turnpoint reached.
 * @param remainingTPs - Turnpoints from lastReached+1 to goal (inclusive),
 *   each with lat/lon/radius (used by the heuristic and the bound).
 * @param remainingLegDistances - Optimized distances between consecutive
 *   remaining TPs (heuristic only).
 * @param nextMeasure - The cheap fix→next-turnpoint measure used by the
 *   approx mode and the seeding heuristic (see {@link NextTPMeasure}).
 * @param deadlineMs - The task deadline (FAI S7F §12.1): best distance is
 *   measured up until the pilot landed or the deadline, whichever comes
 *   first — fixes after it are not scanned. Null when the task has none.
 *   For a stopped task the caller folds the scored-window end (§13.4.4)
 *   into this same clip.
 * @param altitudeBonus - Stopped tasks only (S7F 2026 §13.4.6): credit the
 *   pilot's position at the task stop time — the LAST scanned fix, since
 *   the caller folds the scored-window end into `deadlineMs` — a bonus
 *   distance of glideRatio × (GNSS altitude − goalAltitude), clamped to the
 *   geometric remaining distance there, and pick the best EFFECTIVE
 *   remaining distance ("if the Bonus Distance exceeds the pilot's best
 *   distance up to Task Stop Time, it is used"). Earlier fixes never carry
 *   a bonus — the 2026 edition computes it only for the position at stop,
 *   "disregarding any better distances achieved previously". Null when no
 *   bonus applies (task not stopped, or the pilot landed before the stop).
 */
interface BestProgressParams {
  task: XCTask;
  lastReachedIndex: number;
  fixes: IGCFix[];
  lastReachingTime: number;
  remainingTPs: Array<{ lat: number; lon: number; radius: number }>;
  remainingLegDistances: number[];
  nextMeasure: NextTPMeasure;
  deadlineMs: number | null;
  altitudeBonus?: { glideRatio: number; goalAltitude: number } | null;
}

export function computeBestProgress(
  params: BestProgressParams,
  mode: 'approx' | 'exact' = 'exact',
): BestProgress | null {
  const {
    task,
    lastReachedIndex,
    fixes,
    lastReachingTime,
    remainingTPs,
    remainingLegDistances,
    nextMeasure,
    deadlineMs,
    altitudeBonus = null,
  } = params;
  // Sum of optimised leg distances between remaining TPs (heuristic term).
  let interTPDistance = 0;
  for (const d of remainingLegDistances) {
    interTPDistance += d;
  }
  // Lower-bound term: no path visiting the remaining zones in order can
  // have an inter-zone leg shorter than centre distance minus both radii.
  let minInterZone = 0;
  for (let i = 0; i + 1 < remainingTPs.length; i++) {
    const a = remainingTPs[i];
    const b = remainingTPs[i + 1];
    minInterZone += Math.max(
      0,
      ellipsoidDistance(a.lat, a.lon, b.lat, b.lon) - a.radius - b.radius,
    );
  }
  // Straight-to-goal lower bound pieces (exact mode): the goal zone's
  // centre/radius, or its LINE geometry.
  const goalTP = remainingTPs[remainingTPs.length - 1];
  const goalLine =
    nextMeasure.kind === 'goal-line' ? nextMeasure.line : computeGoalLine(task);

  const nextTP = remainingTPs[0];

  // §13.4.6 (2026): the altitude bonus belongs ONLY to the pilot's position
  // at the task stop time — the last eligible fix, since the caller folds
  // the scored-window end into deadlineMs. Find that index first so the
  // per-fix cap can be zero everywhere else.
  let lastEligibleIndex = -1;
  if (altitudeBonus) {
    for (let i = 0; i < fixes.length; i++) {
      const t = fixes[i].time.getTime();
      if (t < lastReachingTime) continue;
      if (deadlineMs !== null && t > deadlineMs) break;
      lastEligibleIndex = i;
    }
  }
  const capFor = (fix: IGCFix, index: number): number =>
    altitudeBonus && index === lastEligibleIndex
      ? altitudeBonus.glideRatio * Math.max(0, fixAltitude(fix) - altitudeBonus.goalAltitude)
      : 0;

  // Pass 1 — cheap scan: the approx value for every eligible fix (the
  // whole answer in approx mode; the incumbent seed in exact mode), plus
  // the lower bound used for pruning.
  interface Candidate { index: number; lb: number }
  const candidates: Candidate[] = [];
  let seed: { index: number; value: number; bonus: number } | null = null;
  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    // Strictly BEFORE the reaching is excluded; a fix exactly AT the
    // reaching moment is the pilot's position when the turnpoint was
    // completed, and measuring the remaining task from there is valid. The
    // distinction only bites when a crossing interpolates exactly onto a
    // fix — e.g. a fix landing precisely on a cylinder's nominal radius.
    if (fix.time.getTime() < lastReachingTime) continue;
    // §12.1: flying after the task deadline earns no further distance.
    // (For a stopped task the caller folds the §13.4.4 window end in here.)
    if (deadlineMs !== null && fix.time.getTime() > deadlineMs) break;

    const dCentre = ellipsoidDistance(fix.latitude, fix.longitude, nextTP.lat, nextTP.lon);
    const heuristicNext =
      nextMeasure.kind === 'tag'
        ? ellipsoidDistance(fix.latitude, fix.longitude, nextMeasure.point.lat, nextMeasure.point.lon)
        : nextMeasure.kind === 'exit-boundary'
          ? Math.max(0, nextTP.radius - dCentre)
          : nextMeasure.kind === 'goal-line'
            ? distanceToGoalLine(nextMeasure.line, fix.latitude, fix.longitude)
            : Math.max(0, dCentre - nextTP.radius);
    const cap = capFor(fix, i);
    const geometric = heuristicNext + interTPDistance;
    const bonus = Math.min(geometric, cap);
    const heuristic = geometric - bonus;
    if (!seed || heuristic < seed.value) seed = { index: i, value: heuristic, bonus };

    if (mode === 'exact') {
      const lbNext =
        nextMeasure.kind === 'exit-boundary'
          ? Math.max(0, nextTP.radius - dCentre)
          : nextMeasure.kind === 'goal-line'
            ? distanceToGoalLine(nextMeasure.line, fix.latitude, fix.longitude)
            : Math.max(0, dCentre - nextTP.radius);
      const lbGoal = goalLine
        ? distanceToGoalLine(goalLine, fix.latitude, fix.longitude)
        : Math.max(
            0,
            ellipsoidDistance(fix.latitude, fix.longitude, goalTP.lat, goalTP.lon) - goalTP.radius,
          );
      const lb = Math.max(0, Math.max(lbNext + minInterZone, lbGoal) - cap);
      candidates.push({ index: i, lb });
    }
  }
  if (!seed) return null;

  if (mode === 'approx') {
    const fix = fixes[seed.index];
    return {
      fixIndex: seed.index,
      time: fix.time,
      latitude: fix.latitude,
      longitude: fix.longitude,
      distanceToGoal: seed.value,
      ...(altitudeBonus
        ? { altitudeBonus: seed.bonus, altitude: fixAltitude(fix) }
        : {}),
    };
  }

  // Exact effective remaining distance at one fix.
  const exactAt = (i: number): {
    eff: number; geom: number; bonus: number; line: { lat: number; lon: number }[];
  } => {
    const fix = fixes[i];
    const route = optimizeRemainingRoute(task, lastReachedIndex, {
      lat: fix.latitude,
      lon: fix.longitude,
    });
    // remainingTPs is non-empty here, so a route always exists.
    const geometric = route ? route.distance : 0;
    const bonus = altitudeBonus ? Math.min(geometric, capFor(fix, i)) : 0;
    return { eff: geometric - bonus, geom: geometric, bonus, line: route ? route.line : [] };
  };

  // Pass 2 — seed the incumbent with the approx argmin, then evaluate
  // candidates in ascending lower-bound order until no remaining bound can
  // improve the incumbent by more than the tolerance. Each evaluated fix
  // also prunes later ones by the Lipschitz property: the GEOMETRIC
  // remaining distance between two positions differs by at most their
  // separation, so eff(fix) ≥ geom(evaluated) − separation − cap(fix).
  // Ties go to the earliest fix, matching the previous scan.
  const TOL = BEST_PROGRESS_TOLERANCE_M;
  let best = { index: seed.index, ...exactAt(seed.index) };
  const evaluated: Array<{ lat: number; lon: number; geom: number }> = [
    { lat: fixes[seed.index].latitude, lon: fixes[seed.index].longitude, geom: best.geom },
  ];
  candidates.sort((a, b) => a.lb - b.lb);
  for (const c of candidates) {
    if (c.lb >= best.eff - TOL) break;
    if (c.index === seed.index) continue;
    const fix = fixes[c.index];
    const capHere = capFor(fix, c.index);
    let ruledOut = false;
    for (const e of evaluated) {
      const sep = ellipsoidDistance(e.lat, e.lon, fix.latitude, fix.longitude);
      if (e.geom - sep - capHere >= best.eff - TOL) {
        ruledOut = true;
        break;
      }
    }
    if (ruledOut) continue;
    const e = exactAt(c.index);
    evaluated.push({ lat: fix.latitude, lon: fix.longitude, geom: e.geom });
    if (e.eff < best.eff - 1e-6 || (Math.abs(e.eff - best.eff) <= 1e-6 && c.index < best.index)) {
      best = { index: c.index, ...e };
    }
  }

  const fix = fixes[best.index];
  return {
    fixIndex: best.index,
    time: fix.time,
    latitude: fix.latitude,
    longitude: fix.longitude,
    distanceToGoal: best.eff,
    ...(best.line.length >= 2 ? { remainingRoute: best.line } : {}),
    ...(altitudeBonus
      ? { altitudeBonus: best.bonus, altitude: fixAltitude(fix) }
      : {}),
  };
}
