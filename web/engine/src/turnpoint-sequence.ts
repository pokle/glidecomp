/**
 * Turnpoint Sequence Resolution
 *
 * Implements the CIVL GAP turnpoint sequence algorithm: given a competition
 * task and a GPS tracklog, finds the valid sequence of turnpoint crossings
 * that represents the pilot's scored flight.
 *
 * The algorithm is designed for transparency — all raw crossings, selection
 * reasons, and distance breakdowns are returned so the scoring decision can
 * be explained to pilots in the UI.
 *
 * @see /docs/event-detection/turnpoint-sequence-algorithms-research.md
 * @see FAI Sporting Code Section 7F (CIVL GAP)
 */

import type { XCTask } from './xctsk-parser';
import type { IGCFix } from './igc-parser';
import { andoyerDistance, isInsideCylinder } from './geo';
import { getSSSIndex, getEffectiveSSSIndex, getESSIndex, getEffectiveESSIndex, getGoalIndex } from './xctsk-parser';
import { calculateOptimizedTaskLine, computeTurnpointDirections, type TurnpointDirection } from './task-optimizer';
import {
  computeGoalLine,
  distanceToGoalLine,
  goalLineCrossingFraction,
  goalSemicircleBoundaryFraction,
  isForwardGoalCrossing,
  isInGoalSemicircle,
  type GoalLine,
} from './goal-line';
import { resolveStartGates, gateIndexForCrossing } from './time-gates';

/**
 * Default cylinder tolerance as a fraction of the radius. 0.5% is the Cat 2
 * maximum (FAI S7F §8.1); Cat 1 uses 0.1%. Kept as the default for club
 * scoring — a task can override it via {@link XCTask.cylinderTolerance}.
 */
export const DEFAULT_CYLINDER_TOLERANCE = 0.005;

/**
 * Absolute minimum cylinder tolerance in metres (FAI S7F §8.1). The tolerance
 * band is at least ±5 m, so small cylinders (where the percentage is tiny —
 * 0.5% of a 400 m turnpoint is only 2 m) still get the full spec allowance.
 */
export const MIN_CYLINDER_TOLERANCE_M = 5;

/**
 * Outer edge of a cylinder's tolerance band (§8.1): the radius at which an
 * entry cylinder is credited. Shared by crossing detection and the
 * presence-based reaching check so both use the same notion of "inside".
 */
function outerDetectionRadius(radius: number, tolerance: number): number {
  return Math.max(radius * (1 + tolerance), radius + MIN_CYLINDER_TOLERANCE_M);
}

/**
 * Inner edge of a cylinder's tolerance band (§8.1): the radius at which an
 * EXIT cylinder is credited — the pilot leaving is credited a touch early
 * rather than a touch late. Applies to the EXIT start and to inferred exit
 * turnpoints (see {@link computeTurnpointDirections}).
 */
function innerDetectionRadius(radius: number, tolerance: number): number {
  return Math.max(0, Math.min(radius * (1 - tolerance), radius - MIN_CYLINDER_TOLERANCE_M));
}

// ---------------------------------------------------------------------------
// Raw crossing detection
// ---------------------------------------------------------------------------

/**
 * A single boundary crossing of a turnpoint cylinder.
 *
 * Recorded when consecutive tracklog fixes lie on opposite sides of a
 * cylinder boundary. Crossings are tracked per task position (index into
 * XCTask.turnpoints[]), NOT per waypoint — the same waypoint appearing
 * at two task positions produces independent crossings.
 *
 * For a task with a goal LINE (S7F §6.3.1), crossings of the goal task
 * position use the same shape: the boundary is the goal line + its control
 * semicircle instead of a circle, `distanceToCenter` is measured to the
 * goal waypoint (the line's midpoint), and 'enter'/'exit' mean crossing
 * into/out of the region beyond the line.
 */
export interface CylinderCrossing {
  /** Index into XCTask.turnpoints[] (task position, not waypoint identity) */
  taskIndex: number;

  /** Index of the fix AFTER the boundary transition in the IGCFix[] array */
  fixIndex: number;

  /** Interpolated time at the cylinder boundary */
  time: Date;

  /** Interpolated latitude at the cylinder boundary */
  latitude: number;

  /** Interpolated longitude at the cylinder boundary */
  longitude: number;

  /** Whether the pilot crossed inward (enter) or outward (exit) */
  direction: 'enter' | 'exit';

  /** Interpolated GNSS altitude at the cylinder boundary (meters) */
  altitude: number;

  /** Distance from the crossing point to the cylinder center (meters) */
  distanceToCenter: number;

  /**
   * True when the crossing counts only because of the cylinder tolerance band
   * (FAI S7F §8.1): the track came within the tolerance of the cylinder edge
   * but never physically crossed the nominal radius during this band episode.
   * Lets the UI explain a near-miss that was credited by tolerance.
   */
  toleranceCredited: boolean;

  /**
   * Goal-LINE tasks only: true when this goal crossing was detected on the
   * control semicircle's arc rather than on the goal line itself — a fix in
   * the semicircle behind the line counts as goal (S7F §6.3.1), which
   * rescues a line crossing that fell between two fixes or a tracklog gap
   * at the line. Lets the UI explain why goal was credited without a line
   * crossing. Absent for cylinder turnpoints and for line crossings.
   */
  goalSemicircleCredited?: boolean;
}

// ---------------------------------------------------------------------------
// Resolved sequence
// ---------------------------------------------------------------------------

/**
 * A scored turnpoint reaching — one entry in the resolved sequence.
 *
 * "Reaching" is the CIVL GAP term for when a turnpoint is officially
 * achieved for scoring purposes. The algorithm selects one reaching from
 * potentially many raw crossings per task position.
 */
export interface TurnpointReaching {
  /** Index into XCTask.turnpoints[] */
  taskIndex: number;

  /** Fix index in the IGCFix[] array */
  fixIndex: number;

  /** Reaching time (interpolated crossing time) */
  time: Date;

  /** Latitude at the crossing point */
  latitude: number;

  /** Longitude at the crossing point */
  longitude: number;

  /** Interpolated GNSS altitude at the crossing point (meters) */
  altitude: number;

  /**
   * Why this crossing was selected over other candidates.
   * Designed to be explainable to pilots:
   * - 'last_before_next': SSS rule — last crossing before continuing to next TP
   * - 'first_after_previous': Standard rule — first crossing after previous TP reached
   * - 'first_crossing': ESS rule — always first crossing, no re-tries
   * - 'already_inside': Presence rule — the pilot was already inside this
   *   ENTER cylinder when the previous turnpoint was reached (nested or
   *   overlapping cylinders), so it is credited at that same moment with no
   *   crossing
   * - 'already_outside': Presence rule for an EXIT cylinder — the pilot was
   *   already outside it when the previous turnpoint was reached (they tagged
   *   the previous turnpoint beyond this cylinder's boundary), so it is
   *   credited at that same moment with no crossing
   * - 'track_start': No-SSS fallback only — the track began outside the first
   *   turnpoint's cylinder with no crossing, so the first fix anchors the start
   */
  selectionReason: 'last_before_next' | 'first_after_previous' | 'first_crossing' | 'already_inside' | 'already_outside' | 'track_start';

  /**
   * How many candidate crossings existed for this task position.
   * Helps the UI explain: "3 crossings detected, this one was selected because..."
   */
  candidateCount: number;

  /**
   * True when this reaching was credited by the cylinder tolerance band
   * (FAI S7F §8.1) rather than a physical crossing of the nominal radius.
   * Copied from the underlying {@link CylinderCrossing}. Absent for the
   * no-crossing 'track_start' anchor.
   */
  toleranceCredited?: boolean;

  /**
   * Goal-LINE tasks only: this goal reaching was credited by a fix in the
   * control semicircle behind the line, not a line crossing. Copied from
   * the underlying {@link CylinderCrossing} — see it for the rule.
   */
  goalSemicircleCredited?: boolean;
}

// ---------------------------------------------------------------------------
// Distance and progress
// ---------------------------------------------------------------------------

/**
 * Furthest progress past the last reached turnpoint.
 * Used for distance scoring when the pilot doesn't make goal.
 *
 * Per CIVL GAP: flown distance = task distance − shortest remaining
 * distance to goal. This records the tracklog point where that remaining
 * distance was minimized.
 */
export interface BestProgress {
  /** Fix index where minimum remaining distance occurs */
  fixIndex: number;

  /** Time at the best progress point */
  time: Date;

  /** Latitude at the best progress point */
  latitude: number;

  /** Longitude at the best progress point */
  longitude: number;

  /** Shortest remaining distance to goal from this point (meters) */
  distanceToGoal: number;
}

/**
 * Per-leg distance breakdown for transparency.
 * One entry per task leg (between consecutive turnpoints in the task).
 */
export interface LegDistance {
  /** Task index of the leg start turnpoint */
  fromTaskIndex: number;

  /** Task index of the leg end turnpoint */
  toTaskIndex: number;

  /** Optimized leg distance in meters (shortest path touching cylinder edges) */
  distance: number;

  /** Whether the pilot completed this leg (reached the toTaskIndex turnpoint) */
  completed: boolean;
}

// ---------------------------------------------------------------------------
// Start gates
// ---------------------------------------------------------------------------

/**
 * The start gate that defined a pilot's official start time in a gated
 * race to goal (FAI S7F §8.3.1): the last gate at or before the pilot's
 * start-cylinder crossing. Early starters (§12.2) are anchored to the
 * first gate.
 */
export interface StartGateTaken {
  /** The gate time — the pilot's official start time. */
  time: Date;
  /** Index into the task's sorted gate list (0 = first gate). */
  index: number;
  /** How many gates the task defines. */
  gateCount: number;
}

/**
 * An early start ("jumping the gun", FAI S7F §12.2): the pilot's scored
 * start-cylinder crossing happened before the first start gate opened.
 * How this reshapes the score is sport-specific and decided by the scorer
 * (PG: scored launch→SSS only; HG: penalty or minimum distance) — the
 * sequence result just reports the facts.
 */
export interface EarlyStart {
  /** The scored (last) start-cylinder crossing. */
  crossingTime: Date;
  /** When the first start gate opened. */
  firstGateTime: Date;
  /** How many seconds before the first gate the pilot started. */
  secondsEarly: number;
}

// ---------------------------------------------------------------------------
// Complete result
// ---------------------------------------------------------------------------

/**
 * Complete result of turnpoint sequence resolution for one flight.
 *
 * Designed for transparency — contains all data needed to explain
 * the scoring decision to the pilot in the UI: raw crossings, resolved
 * sequence with selection reasons, distance breakdown per leg, and
 * speed section timing.
 */
export interface TurnpointSequenceResult {
  /** All raw cylinder crossings detected across all task positions, sorted by time */
  crossings: CylinderCrossing[];

  /**
   * Resolved sequence of turnpoint reachings in task order.
   * Only includes turnpoints that were actually reached.
   * Each entry includes selectionReason explaining why that crossing was chosen.
   */
  sequence: TurnpointReaching[];

  /** The scored start (SSS reaching), or null if pilot never started */
  sssReaching: TurnpointReaching | null;

  /** The ESS reaching, or null if ESS not reached */
  essReaching: TurnpointReaching | null;

  /** True if the pilot completed the entire task (reached goal) */
  madeGoal: boolean;

  /** Index of last reached TP in XCTask.turnpoints[], -1 if none reached */
  lastTurnpointReached: number;

  /** Best progress past last reached TP; null if made goal or never started */
  bestProgress: BestProgress | null;

  // --- Distance scoring ---

  /**
   * Total optimized task distance in meters (from the first turnpoint to
   * goal via cylinder edges). When the first turnpoint is a TAKEOFF, the
   * launch→SSS leg is included; pass a task trimmed to the SSS to exclude
   * it (see taskForDistanceOrigin in gap-scoring).
   */
  taskDistance: number;

  /**
   * Scored flown distance in meters.
   * - Goal pilots: taskDistance
   * - Non-goal: taskDistance - bestProgress.distanceToGoal
   * - No start: 0
   */
  flownDistance: number;

  /**
   * Per-leg distance breakdown. One entry per consecutive turnpoint pair.
   * Shows optimized distance and whether the pilot completed each leg.
   */
  legs: LegDistance[];

  // --- Speed scoring ---

  /**
   * Speed section time in seconds. Null if SSS or ESS not reached.
   *
   * In a gated race to goal (RACE type with start gates) the clock runs
   * from the start gate taken (see {@link startGate}) to the ESS reaching
   * (FAI S7F §8.7) — not from the pilot's actual crossing. For elapsed-time
   * tasks and races without usable gates it is ESS reaching time minus SSS
   * reaching time.
   */
  speedSectionTime: number | null;

  /**
   * Present for gated races when the pilot started: the gate that defined
   * their official start time (§8.3.1) — the last gate at or before their
   * crossing, or the first gate for early starters. Absent for elapsed-time
   * tasks, races without gates, and pilots who never started.
   */
  startGate?: StartGateTaken;

  /**
   * Present when the pilot's scored start crossing was before the first
   * start gate (§12.2 "jumping the gun"). The sequence and distances are
   * still resolved from the actual flight; the sport-specific consequences
   * (PG launch→SSS distance, HG penalty) are applied by the scorer.
   */
  earlyStart?: EarlyStart;

  /**
   * How the start was anchored when the task defines no SSS-typed turnpoint
   * (a common task-setting mistake that would otherwise zero every score):
   * - 'first_turnpoint' — crossings of the first turnpoint (usually the
   *   TAKEOFF) acted as the start
   * - 'track_start' — the track began outside the first turnpoint's cylinder
   *   with no crossing (e.g. the logger started after launch), so the first
   *   fix anchored the sequence
   * Absent when the task has an explicit SSS turnpoint.
   */
  startFallback?: 'first_turnpoint' | 'track_start';

  /**
   * Set when the task defines no ESS-typed turnpoint (the other half of the
   * mis-set-task trap): the speed section is taken to end at goal — the last
   * turnpoint — per the usual race-to-goal convention, so speed-section
   * times, time points, and arrival order still exist. Absent when the task
   * has an explicit ESS turnpoint.
   */
  essFallback?: 'last_turnpoint';
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Detect all cylinder boundary crossings in the tracklog.
 *
 * Scans consecutive fix pairs and records every transition across a
 * turnpoint cylinder boundary. Each crossing is tracked per task position
 * index, not per waypoint identity. Crossings are interpolated between
 * the two fixes that straddle the boundary.
 *
 * Exported separately so the UI can visualize all crossings on the map
 * independently of the sequence resolution.
 *
 * @param task - The competition task definition
 * @param fixes - The pilot's GPS tracklog
 * @param directions - Optional precomputed per-turnpoint directions
 *   ({@link computeTurnpointDirections}) to avoid recomputing the optimized
 *   route; computed from the task when omitted
 * @returns All crossings sorted by time
 */
export function detectCylinderCrossings(
  task: XCTask,
  fixes: IGCFix[],
  directions?: TurnpointDirection[]
): CylinderCrossing[] {
  if (fixes.length < 2) return [];

  const crossings: CylinderCrossing[] = [];

  // CIVL GAP cylinder tolerance (FAI S7F §8.1): a band of a percentage plus a
  // 5 m absolute minimum, applied when deciding whether a pilot reached a
  // cylinder, to absorb distance-measurement differences between flight
  // recorders and scoring programs. Default 0.5% (Cat 2 maximum).
  const tolerance = task.cylinderTolerance ?? DEFAULT_CYLINDER_TOLERANCE;

  // EXIT cylinders are the one place the *inner* edge of the band matters: a
  // pilot leaving an EXIT start is credited once they cross the inner radius
  // outward (§8.2/§8.3), and an inferred exit turnpoint (a cylinder the route
  // reaches from inside — see computeTurnpointDirections) is credited at the
  // same edge. Every entry cylinder is credited at the outer edge.
  const dirs = directions ?? computeTurnpointDirections(task);

  // Goal line (S7F §6.3.1): when the task's goal is a LINE, the goal task
  // position is detected against the line + control semicircle instead of a
  // cylinder. Null means cylinder goal — the loop below handles it as before.
  const goalLine = computeGoalLine(task);
  const goalIdx = getGoalIndex(task);

  const DEG = Math.PI / 180;

  for (let tpIdx = 0; tpIdx < task.turnpoints.length; tpIdx++) {
    if (goalLine && tpIdx === goalIdx) {
      detectGoalLineCrossings(goalLine, fixes, tpIdx, crossings);
      continue;
    }
    const tp = task.turnpoints[tpIdx];
    const centerLat = tp.waypoint.lat;
    const centerLon = tp.waypoint.lon;
    // Tolerance band (§8.1): outerRadius = max(r×(1+tol), r+5),
    // innerRadius = min(r×(1−tol), r−5). Entry cylinders detect against the
    // outer edge; EXIT cylinders (the EXIT start and inferred exit
    // turnpoints) detect against the inner edge so the pilot is credited
    // with leaving a touch early rather than a touch late.
    const outerRadius = outerDetectionRadius(tp.radius, tolerance);
    const innerRadius = innerDetectionRadius(tp.radius, tolerance);
    const detectRadius = dirs[tpIdx] === 'exit' ? innerRadius : outerRadius;
    // Bounding box uses the outer radius (always ≥ detectRadius) to stay
    // conservative regardless of which edge we detect against.
    const radius = outerRadius;

    // Conservative lat/lon bounding box around the cylinder. Any point inside
    // the cylinder is guaranteed to fall inside this box, so a fix outside the
    // box is definitely outside the cylinder and can skip the (much costlier)
    // ellipsoidal distance call. The denominators under-estimate metres-per-
    // degree and a 1% margin is added, so the box strictly contains the
    // cylinder — this is a pure speed-up with no effect on which fixes are
    // classified inside/outside. (Assumes tasks don't span the ±180° meridian,
    // the same assumption the linear crossing interpolation below already makes.)
    const latDelta = (radius / 110540) * 1.01;
    const cosLat = Math.cos((Math.abs(centerLat) + latDelta) * DEG);
    const lonDelta = (radius / (111000 * Math.max(cosLat, 1e-6))) * 1.01;

    const isInside = (lat: number, lon: number): boolean => {
      const dLat = lat - centerLat;
      if (dLat > latDelta || dLat < -latDelta) return false;
      const dLon = lon - centerLon;
      if (dLon > lonDelta || dLon < -lonDelta) return false;
      return andoyerDistance(lat, lon, centerLat, centerLon) <= detectRadius;
    };

    const distToCenter = (fix: IGCFix): number =>
      andoyerDistance(fix.latitude, fix.longitude, centerLat, centerLon);

    // Does the straight segment d0→d1 (distances to center) pass through the
    // nominal radius in this crossing's radial direction? Entering means the
    // distance falls through the radius; exiting means it rises through it.
    const nominalRadius = tp.radius;
    const crossesNominal = (d0: number, d1: number, direction: 'enter' | 'exit'): boolean =>
      direction === 'enter'
        ? d0 > nominalRadius && d1 <= nominalRadius
        : d0 < nominalRadius && d1 >= nominalRadius;

    let prevInside = isInside(fixes[0].latitude, fixes[0].longitude);
    // First fix index of the current same-side run of the detection-edge
    // state machine. Bounds the backward scan below: fixes
    // [lastFlipFixIdx .. fixIdx-1] are all on the prevInside side.
    let lastFlipFixIdx = 0;

    for (let fixIdx = 1; fixIdx < fixes.length; fixIdx++) {
      const currInside = isInside(fixes[fixIdx].latitude, fixes[fixIdx].longitude);

      if (prevInside !== currInside) {
        const prevFix = fixes[fixIdx - 1];
        const currFix = fixes[fixIdx];
        const direction: 'enter' | 'exit' = currInside ? 'enter' : 'exit';

        // Interpolate crossing point between the two fixes
        const prevDist = distToCenter(prevFix);
        const currDist = distToCenter(currFix);

        // Interpolate to the nominal radius (without tolerance)
        const tRaw = (prevDist - nominalRadius) / (prevDist - currDist);

        // The detection edge (outer band edge, or inner for an EXIT start)
        // differs from the nominal radius, so the pair that crosses the
        // detection edge doesn't necessarily straddle the nominal radius —
        // the pilot may cross it a few fixes earlier or later while inside
        // the tolerance band. Anchor the crossing to the fix pair that
        // physically straddles the nominal radius:
        //  - tRaw in [0,1]: this pair — the common single-step case.
        //  - tRaw > 1: the nominal radius lies further along the flight
        //    path; scan forward while the detection-edge state holds.
        //  - tRaw < 0: it was crossed earlier in this band episode; scan
        //    backward to the previous state flip.
        // Only when no pair in the band episode straddles the nominal
        // radius did the pilot merely reach the tolerance band — a
        // tolerance-credited near-miss (§8.1) anchored at the clamped edge.
        let anchorPrev = prevFix;
        let anchorCurr = currFix;
        let anchorFixIndex = fixIdx;
        let t = Math.max(0, Math.min(1, tRaw));
        let toleranceCredited = tRaw < 0 || tRaw > 1;

        if (tRaw > 1) {
          let d0 = currDist;
          for (let j = fixIdx; j + 1 < fixes.length; j++) {
            // Stop at the next detection-edge flip — that boundary belongs
            // to the next crossing.
            if ((d0 <= detectRadius) !== currInside) break;
            const d1 = distToCenter(fixes[j + 1]);
            if (crossesNominal(d0, d1, direction)) {
              anchorPrev = fixes[j];
              anchorCurr = fixes[j + 1];
              anchorFixIndex = j + 1;
              t = (d0 - nominalRadius) / (d0 - d1);
              toleranceCredited = false;
              break;
            }
            d0 = d1;
          }
        } else if (tRaw < 0) {
          let d1 = prevDist;
          for (let j = fixIdx - 1; j > lastFlipFixIdx; j--) {
            const d0 = distToCenter(fixes[j - 1]);
            if (crossesNominal(d0, d1, direction)) {
              anchorPrev = fixes[j - 1];
              anchorCurr = fixes[j];
              anchorFixIndex = j;
              t = (d0 - nominalRadius) / (d0 - d1);
              toleranceCredited = false;
              break;
            }
            d1 = d0;
          }
        }

        const crossingLat = anchorPrev.latitude + t * (anchorCurr.latitude - anchorPrev.latitude);
        const crossingLon = anchorPrev.longitude + t * (anchorCurr.longitude - anchorPrev.longitude);
        const crossingAlt = anchorPrev.gnssAltitude + t * (anchorCurr.gnssAltitude - anchorPrev.gnssAltitude);

        const prevTime = anchorPrev.time.getTime();
        const currTime = anchorCurr.time.getTime();
        const crossingTime = new Date(prevTime + t * (currTime - prevTime));

        const distanceToCenter = andoyerDistance(
          crossingLat, crossingLon, centerLat, centerLon
        );

        crossings.push({
          taskIndex: tpIdx,
          fixIndex: anchorFixIndex,
          time: crossingTime,
          latitude: crossingLat,
          longitude: crossingLon,
          altitude: crossingAlt,
          direction,
          distanceToCenter,
          toleranceCredited,
        });

        lastFlipFixIdx = fixIdx;
      }

      prevInside = currInside;
    }
  }

  // Sort all crossings by time
  crossings.sort((a, b) => a.time.getTime() - b.time.getTime());

  return crossings;
}

/**
 * Detect goal-line crossings (S7F §6.3.1) for the goal task position and
 * append them to `out`.
 *
 * The pilot is "inside" goal when in the control semicircle behind the line
 * ({@link isInGoalSemicircle}); a track segment that intersects the line
 * itself is a crossing even when neither fix lands in the semicircle (a
 * fast crossing near an endpoint can leave no fix inside). To keep the
 * enter/exit alternation consistent with the semicircle state — which the
 * presence-based reaching logic relies on — such a through-crossing emits an
 * 'enter' and an 'exit' at the same interpolated instant.
 *
 * No tolerance band applies: the §8.1 band is defined for cylinders; the
 * goal line is exact geometry (its semicircle already absorbs the
 * fast-crossing case), so `toleranceCredited` is always false here.
 */
function detectGoalLineCrossings(
  goalLine: GoalLine,
  fixes: IGCFix[],
  taskIndex: number,
  out: CylinderCrossing[]
): void {
  if (fixes.length < 2) return;

  const centerLat = goalLine.center.lat;
  const centerLon = goalLine.center.lon;

  // Conservative bounding box around the line + semicircle (everything lies
  // within halfWidth of the centre). A fix pair whose own bbox doesn't
  // overlap it can't produce a crossing — skips the frame math for the vast
  // majority of the track. Same margin scheme as the cylinder loop.
  const DEG = Math.PI / 180;
  const reach = goalLine.halfWidth;
  const latDelta = (reach / 110540) * 1.01;
  const cosLat = Math.cos((Math.abs(centerLat) + latDelta) * DEG);
  const lonDelta = (reach / (111000 * Math.max(cosLat, 1e-6))) * 1.01;

  const push = (
    anchorPrev: IGCFix,
    anchorCurr: IGCFix,
    fixIndex: number,
    t: number,
    direction: 'enter' | 'exit',
    viaSemicircleArc = false
  ): void => {
    const lat = anchorPrev.latitude + t * (anchorCurr.latitude - anchorPrev.latitude);
    const lon = anchorPrev.longitude + t * (anchorCurr.longitude - anchorPrev.longitude);
    const alt = anchorPrev.gnssAltitude + t * (anchorCurr.gnssAltitude - anchorPrev.gnssAltitude);
    const prevTime = anchorPrev.time.getTime();
    out.push({
      taskIndex,
      fixIndex,
      time: new Date(prevTime + t * (anchorCurr.time.getTime() - prevTime)),
      latitude: lat,
      longitude: lon,
      altitude: alt,
      direction,
      distanceToCenter: andoyerDistance(lat, lon, centerLat, centerLon),
      toleranceCredited: false,
      ...(viaSemicircleArc ? { goalSemicircleCredited: true } : {}),
    });
  };

  let prevInside = isInGoalSemicircle(goalLine, fixes[0].latitude, fixes[0].longitude);

  for (let fixIdx = 1; fixIdx < fixes.length; fixIdx++) {
    const p0 = fixes[fixIdx - 1];
    const p1 = fixes[fixIdx];

    // Bbox rejection: segment bbox vs goal-region bbox.
    const minLat = Math.min(p0.latitude, p1.latitude);
    const maxLat = Math.max(p0.latitude, p1.latitude);
    const minLon = Math.min(p0.longitude, p1.longitude);
    const maxLon = Math.max(p0.longitude, p1.longitude);
    if (
      minLat > centerLat + latDelta || maxLat < centerLat - latDelta ||
      minLon > centerLon + lonDelta || maxLon < centerLon - lonDelta
    ) {
      // Both endpoints (and the whole segment) are outside the region, so
      // the pilot is outside the semicircle at p1 too.
      prevInside = false;
      continue;
    }

    const from = { lat: p0.latitude, lon: p0.longitude };
    const to = { lat: p1.latitude, lon: p1.longitude };
    const currInside = isInGoalSemicircle(goalLine, to.lat, to.lon);
    const lineT = goalLineCrossingFraction(goalLine, from, to);

    if (lineT !== null) {
      if (prevInside !== currInside) {
        // Crossing the line into (or back out of) the semicircle.
        push(p0, p1, fixIdx, lineT, currInside ? 'enter' : 'exit');
      } else {
        // Crossed the line but neither fix is in the semicircle (e.g. a fast
        // pass near an endpoint): an instantaneous enter+exit pair keeps the
        // crossing on record without corrupting the inside/outside state.
        const direction = isForwardGoalCrossing(goalLine, from, to);
        push(p0, p1, fixIdx, lineT, direction ? 'enter' : 'exit');
        push(p0, p1, fixIdx, lineT, direction ? 'exit' : 'enter');
      }
    } else if (prevInside !== currInside) {
      // Entered or left through the semicircle's arc (no line intersection).
      const t = goalSemicircleBoundaryFraction(goalLine, from, to);
      push(p0, p1, fixIdx, t, currInside ? 'enter' : 'exit', true);
    }

    prevInside = currInside;
  }
}

/**
 * Build a forward path from an SSS crossing through subsequent turnpoints.
 *
 * Reaching a turnpoint is presence-based (FAI S7F §8 / FS semantics), on the
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
function buildForwardPath(
  sssCrossing: CylinderCrossing,
  crossingsByTP: Map<number, CylinderCrossing[]>,
  sssIdx: number,
  essIdx: number,
  goalIdx: number,
  startedInsideTP: boolean[],
  directions: TurnpointDirection[],
  startSelectionReason: TurnpointReaching['selectionReason'] = 'last_before_next',
): TurnpointReaching[] {
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
function buildRemainingPath(
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
 * How the distance from a fix to the next un-reached turnpoint is measured
 * by {@link computeBestProgress}:
 * - 'tag': to the optimizer's tag point on the cylinder — keeps the
 *   remaining route continuous with the onward optimized legs (and matches
 *   AirScore's flown distances closely). The default for an intermediate
 *   ENTER turnpoint.
 * - 'edge': to the cylinder's nearest boundary point from outside. Used for
 *   a cylinder goal (no onward leg — the pilot only needs to reach it) and
 *   for the ENTER turnpoint right after a reached EXIT cylinder: the
 *   pilot's outbound bearing through the exit was their own choice, and on
 *   a rotationally symmetric task the tag bearing is arbitrary, so pinning
 *   the return to the tag would under-credit any pilot who flew a
 *   different bearing.
 * - 'exit-boundary': to the cylinder's nearest boundary point from inside
 *   (radius − distance-to-centre) — the next un-reached turnpoint is an
 *   EXIT cylinder the pilot has yet to leave.
 * - 'goal-line': to the nearest point on a LINE goal (S7F §6.3.1).
 */
type NextTPMeasure =
  | { kind: 'tag'; point: { lat: number; lon: number } }
  | { kind: 'edge' }
  | { kind: 'exit-boundary' }
  | { kind: 'goal-line'; line: GoalLine };

/**
 * Compute best progress for a non-goal pilot.
 * Scans all fixes after the last reaching time to find the point
 * with minimum remaining distance to goal.
 *
 * Per CIVL GAP, remaining distance is the shortest path from the pilot's
 * position through any un-reached intermediate turnpoints to goal — not
 * a straight line to goal.
 *
 * @param remainingTPs - Turnpoints from lastReached+1 to goal (inclusive),
 *   each with lat/lon/radius. When the next unreached TP is goal itself,
 *   this is a single-element array and degenerates to straight-line.
 * @param remainingLegDistances - Optimized distances between consecutive
 *   remaining TPs (length = remainingTPs.length - 1).
 * @param nextMeasure - How to measure the fix→next-turnpoint distance
 *   (see {@link NextTPMeasure}).
 */
function computeBestProgress(
  fixes: IGCFix[],
  lastReachingTime: number,
  remainingTPs: Array<{ lat: number; lon: number; radius: number }>,
  remainingLegDistances: number[],
  nextMeasure: NextTPMeasure,
): BestProgress | null {
  // Sum of optimized leg distances between remaining TPs (TP[1]→TP[2]→...→Goal)
  let interTPDistance = 0;
  for (const d of remainingLegDistances) {
    interTPDistance += d;
  }

  const nextTP = remainingTPs[0];
  let bestFix: { index: number; distToGoal: number } | null = null;

  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    if (fix.time.getTime() <= lastReachingTime) continue;

    // Distance to the next un-reached turnpoint — see NextTPMeasure for
    // which measurement applies and why. Measuring to a tag point avoids
    // the small over-credit of reaching the nearest edge then jumping to
    // the optimal tag; the edge measurements handle the cases where the
    // tag point is the wrong reference (goal, exit cylinders, and the
    // return leg after one).
    const distToNextTP =
      nextMeasure.kind === 'tag'
        ? andoyerDistance(fix.latitude, fix.longitude, nextMeasure.point.lat, nextMeasure.point.lon)
        : nextMeasure.kind === 'exit-boundary'
          ? Math.max(0, nextTP.radius - andoyerDistance(fix.latitude, fix.longitude, nextTP.lat, nextTP.lon))
          : nextMeasure.kind === 'goal-line'
            ? distanceToGoalLine(nextMeasure.line, fix.latitude, fix.longitude)
            : Math.max(0, andoyerDistance(fix.latitude, fix.longitude, nextTP.lat, nextTP.lon) - nextTP.radius);
    // Total remaining = distance to next TP + optimized path from there to goal
    const distToGoal = distToNextTP + interTPDistance;

    if (!bestFix || distToGoal < bestFix.distToGoal) {
      bestFix = { index: i, distToGoal };
    }
  }

  if (!bestFix) return null;

  const fix = fixes[bestFix.index];
  return {
    fixIndex: bestFix.index,
    time: fix.time,
    latitude: fix.latitude,
    longitude: fix.longitude,
    distanceToGoal: bestFix.distToGoal,
  };
}

/**
 * Resolve the turnpoint sequence for a flight against a competition task.
 *
 * Algorithm (per CIVL GAP / Section 7F):
 * 1. Detect all cylinder crossings per task position
 * 2. For gated races: drop SSS crossings before the first start gate
 *    (§8.3 — a start can't validate before the gate opens); when every
 *    crossing is pre-gate, resolve from them anyway and report earlyStart
 * 3. For SSS: use last valid crossing before continuing to next TP
 * 4. For other TPs (ESS and goal included): use first valid crossing after
 *    previous TP reached — outward for an EXIT cylinder (one the route
 *    arrives at from inside, see computeTurnpointDirections) — or, when the
 *    pilot is already on the required side of the boundary at the previous
 *    reaching (nested/overlapping cylinders), credit it at that same moment
 *    (presence-based reaching, §8)
 * 5. For ESS: always first crossing (no re-tries)
 * 6. For multi-gate/elapsed-time: iterate SSS crossings, keep best path
 *    (most TPs reached, then most flown distance, then latest SSS)
 * 7. Snap the start time to the last gate ≤ crossing (§8.3.1) and time the
 *    speed section from the gate (§8.7)
 * 8. Compute optimized leg distances and flown distance
 *
 * @param task - The competition task definition
 * @param fixes - The pilot's GPS tracklog
 * @returns Complete sequence result with scoring data and explanations
 */
export function resolveTurnpointSequence(
  task: XCTask,
  fixes: IGCFix[]
): TurnpointSequenceResult {
  // Optimized task line (one tag point per turnpoint), computed once. The
  // tag points feed best-progress so a pilot's remaining distance to goal
  // is measured to each cylinder's optimal tag — consistent with the leg
  // distances — rather than its nearest edge. It also determines each
  // turnpoint's crossing direction: a cylinder containing the previous tag
  // point is an EXIT cylinder, reached by flying out of it.
  const optimizedLine = calculateOptimizedTaskLine(task);
  const directions = computeTurnpointDirections(task, optimizedLine);
  const allCrossings = detectCylinderCrossings(task, fixes, directions);
  const segmentDistances: number[] = [];
  for (let i = 1; i < optimizedLine.length; i++) {
    segmentDistances.push(andoyerDistance(
      optimizedLine[i - 1].lat, optimizedLine[i - 1].lon,
      optimizedLine[i].lat, optimizedLine[i].lon,
    ));
  }
  const taskDistance = segmentDistances.reduce((sum, d) => sum + d, 0);
  // Tasks are supposed to mark one turnpoint as SSS, but hand-built tasks
  // often omit it. Without a start anchor every pilot would score zero, so
  // when the SSS is missing the first turnpoint (usually the take-off) acts
  // as the start — see getEffectiveSSSIndex.
  const explicitSSSIdx = getSSSIndex(task);
  const sssIdx = getEffectiveSSSIndex(task);
  const sssIsFallback = explicitSSSIdx < 0 && sssIdx >= 0;
  // Same idea for the ESS: when missing, the speed section ends at goal —
  // otherwise time/arrival/leading points exist that no pilot can earn and
  // every goal pilot ties on distance alone. See getEffectiveESSIndex.
  const explicitESSIdx = getESSIndex(task);
  const essIdx = getEffectiveESSIndex(task);
  const essIsFallback = explicitESSIdx < 0 && essIdx >= 0;
  const goalIdx = getGoalIndex(task);
  // Non-null when the task ends at a goal LINE (S7F §6.3.1): reaching and
  // remaining-distance for the goal position use line geometry.
  const goalLine = computeGoalLine(task);

  // Build legs with default completed = false
  const legs: LegDistance[] = segmentDistances.map((dist, i) => ({
    fromTaskIndex: i,
    toTaskIndex: i + 1,
    distance: dist,
    completed: false,
  }));

  // Where the track began relative to each cylinder's detection edge.
  // Feeds the presence-based reaching check in buildForwardPath for the
  // cylinder-never-crossed case (e.g. a goal cylinder so large the whole
  // flight stays inside it). The edge matches crossing detection: outer for
  // ENTER cylinders, inner for EXIT cylinders — so the state machine and
  // the track-start state always agree on which side of the band a fix is.
  const tolerance = task.cylinderTolerance ?? DEFAULT_CYLINDER_TOLERANCE;
  const startedInsideTP = task.turnpoints.map((tp, tpIdx) => {
    if (fixes.length === 0) return false;
    // A LINE goal has no interior; "inside" is the control semicircle.
    if (goalLine && tpIdx === goalIdx) {
      return isInGoalSemicircle(goalLine, fixes[0].latitude, fixes[0].longitude);
    }
    const edge = directions[tpIdx] === 'exit'
      ? innerDetectionRadius(tp.radius, tolerance)
      : outerDetectionRadius(tp.radius, tolerance);
    return andoyerDistance(
      fixes[0].latitude, fixes[0].longitude,
      tp.waypoint.lat, tp.waypoint.lon,
    ) <= edge;
  });

  // Group crossings by taskIndex
  const crossingsByTP = new Map<number, CylinderCrossing[]>();
  for (const crossing of allCrossings) {
    const arr = crossingsByTP.get(crossing.taskIndex);
    if (arr) {
      arr.push(crossing);
    } else {
      crossingsByTP.set(crossing.taskIndex, [crossing]);
    }
  }

  // Filter SSS crossings by the required direction (e.g. EXIT for paragliding races).
  // If no SSS config or direction is unspecified, accept all crossings for backward compat.
  // The direction rule describes the explicit SSS cylinder; in fallback mode the
  // anchor is the first turnpoint (not a configured start), so no filter applies.
  const requiredDirection = sssIsFallback
    ? undefined
    : task.sss?.direction?.toLowerCase() as 'enter' | 'exit' | undefined;
  const allSSSCrossings = sssIdx >= 0 ? (crossingsByTP.get(sssIdx) ?? []) : [];
  let sssCrossings = requiredDirection
    ? allSSSCrossings.filter(c => c.direction === requiredDirection)
    : allSSSCrossings;

  // Start gates (RACE tasks, §6.3.3/§8.3): crossings before the first gate
  // cannot validate a start — filter them out so the best-path iteration
  // only considers gate-legal starts. When EVERY crossing is pre-gate the
  // pilot "jumped the gun" (§12.2): the sequence is still resolved from
  // those crossings (HG scores the complete flight with a penalty; the
  // PG launch→SSS clamp happens in the scorer) and earlyStart reports the
  // facts. Gates describe the configured start cylinder, so — like the
  // direction rule above — they don't apply in fallback-start mode.
  // The reference instant (any SSS crossing, else the first fix) only
  // places the gates' time-of-day on the right calendar day.
  const gateReferenceMs = sssCrossings.length > 0
    ? sssCrossings[0].time.getTime()
    : (fixes.length > 0 ? fixes[0].time.getTime() : null);
  const gates = !sssIsFallback && gateReferenceMs !== null
    ? resolveStartGates(task, gateReferenceMs)
    : null;
  if (gates && sssCrossings.length > 0) {
    const legal = sssCrossings.filter(c => c.time.getTime() >= gates[0]);
    if (legal.length > 0) sssCrossings = legal;
  }

  // Fallback start with no crossings: if the track began outside the first
  // turnpoint's cylinder (e.g. the logger started after launch) there is no
  // boundary to cross, so the first fix anchors the sequence — mirroring
  // open-distance scoring's take-off origin. A track that began inside and
  // never crossed out means the pilot never left launch: no start.
  let startSelectionReason: TurnpointReaching['selectionReason'] = 'last_before_next';
  if (sssIsFallback && sssCrossings.length === 0 && fixes.length > 0) {
    const startTP = task.turnpoints[sssIdx];
    const first = fixes[0];
    const startedInside = isInsideCylinder(
      first.latitude, first.longitude,
      startTP.waypoint.lat, startTP.waypoint.lon, startTP.radius,
    );
    if (!startedInside) {
      sssCrossings = [{
        taskIndex: sssIdx,
        fixIndex: 0,
        time: first.time,
        latitude: first.latitude,
        longitude: first.longitude,
        altitude: first.gnssAltitude,
        direction: 'exit',
        distanceToCenter: andoyerDistance(
          first.latitude, first.longitude,
          startTP.waypoint.lat, startTP.waypoint.lon,
        ),
        toleranceCredited: false,
      }];
      startSelectionReason = 'track_start';
    }
  }

  const startFallback = sssIsFallback
    ? (startSelectionReason === 'track_start' ? 'track_start' as const : 'first_turnpoint' as const)
    : undefined;

  if (sssCrossings.length === 0) {
    return {
      crossings: allCrossings,
      sequence: [],
      sssReaching: null,
      essReaching: null,
      madeGoal: false,
      lastTurnpointReached: -1,
      bestProgress: null,
      taskDistance,
      flownDistance: 0,
      legs,
      speedSectionTime: null,
      ...(startFallback ? { startFallback } : {}),
      ...(essIsFallback ? { essFallback: 'last_turnpoint' as const } : {}),
    };
  }

  // How best-progress measures the fix→next-turnpoint distance for a pilot
  // whose last reached turnpoint is lastReachedIdx — see NextTPMeasure.
  // The nearest-edge rule after an exit cylinder applies only to INFERRED
  // exit turnpoints, not the declared-EXIT start: after a normal exit start
  // the onward route is asymmetric and well-determined, and measuring to
  // the tag point there is what matches AirScore's flown distances.
  const nextMeasureFor = (lastReachedIdx: number): NextTPMeasure => {
    const nextIdx = lastReachedIdx + 1;
    if (directions[nextIdx] === 'exit') return { kind: 'exit-boundary' };
    if (nextIdx >= goalIdx) {
      return goalLine ? { kind: 'goal-line', line: goalLine } : { kind: 'edge' };
    }
    if (directions[lastReachedIdx] === 'exit' && lastReachedIdx !== sssIdx) {
      return { kind: 'edge' };
    }
    return { kind: 'tag', point: optimizedLine[nextIdx] };
  };

  // Iterate SSS crossings backwards, try each, keep best path
  let bestSequence: TurnpointReaching[] | null = null;
  let bestTPs = 0;
  let bestFlownDist = 0;
  let bestSSSTime = 0;

  for (let i = sssCrossings.length - 1; i >= 0; i--) {
    const sssCrossing = sssCrossings[i];
    const candidateSequence = buildForwardPath(
      sssCrossing, crossingsByTP, sssIdx, essIdx, goalIdx, startedInsideTP, directions, startSelectionReason
    );

    const tpsReached = candidateSequence.length;
    const madeGoal = tpsReached > 0 &&
      candidateSequence[tpsReached - 1].taskIndex === goalIdx;

    let candidateFlownDist: number;
    if (madeGoal) {
      candidateFlownDist = taskDistance;
    } else if (tpsReached > 0) {
      const lastReaching = candidateSequence[tpsReached - 1];
      const { remainingTPs, remainingLegDistances } =
        buildRemainingPath(task, lastReaching.taskIndex, segmentDistances);
      const progress = computeBestProgress(
        fixes, lastReaching.time.getTime(), remainingTPs, remainingLegDistances,
        nextMeasureFor(lastReaching.taskIndex)
      );
      candidateFlownDist = progress
        ? taskDistance - progress.distanceToGoal
        : 0;
    } else {
      candidateFlownDist = 0;
    }

    const candidateSSSTime = sssCrossing.time.getTime();

    // Compare: most TPs → most distance → latest SSS
    const isBetter =
      tpsReached > bestTPs ||
      (tpsReached === bestTPs && candidateFlownDist > bestFlownDist) ||
      (tpsReached === bestTPs && candidateFlownDist === bestFlownDist && candidateSSSTime > bestSSSTime);

    if (!bestSequence || isBetter) {
      bestSequence = candidateSequence;
      bestTPs = tpsReached;
      bestFlownDist = candidateFlownDist;
      bestSSSTime = candidateSSSTime;
    }
  }

  const sequence = bestSequence!;
  const reachedTaskIndices = new Set(sequence.map(r => r.taskIndex));

  // Mark completed legs
  for (const leg of legs) {
    leg.completed = reachedTaskIndices.has(leg.toTaskIndex);
  }

  // Extract SSS and ESS reachings
  const sssReaching = sequence.find(r => r.taskIndex === sssIdx) ?? null;
  const essReaching = sequence.find(r => r.taskIndex === essIdx) ?? null;

  const madeGoal = sequence.length > 0 &&
    sequence[sequence.length - 1].taskIndex === goalIdx;

  const lastTurnpointReached = sequence.length > 0
    ? sequence[sequence.length - 1].taskIndex
    : -1;

  // Compute bestProgress for non-goal pilots
  let bestProgress: BestProgress | null = null;
  let flownDistance = 0;

  if (madeGoal) {
    flownDistance = taskDistance;
  } else if (sequence.length > 0) {
    const lastReaching = sequence[sequence.length - 1];
    const { remainingTPs, remainingLegDistances } =
      buildRemainingPath(task, lastReaching.taskIndex, segmentDistances);
    bestProgress = computeBestProgress(
      fixes, lastReaching.time.getTime(), remainingTPs, remainingLegDistances,
      nextMeasureFor(lastReaching.taskIndex)
    );
    flownDistance = bestProgress
      ? taskDistance - bestProgress.distanceToGoal
      : 0;
  }

  // Start-gate snapping (§8.3.1): the pilot's official start time is the
  // last gate at or before their crossing; a crossing after the last gate
  // takes the last gate; an early starter is anchored to the first gate.
  let startGate: StartGateTaken | undefined;
  let earlyStart: EarlyStart | undefined;
  if (gates && sssReaching) {
    const crossingMs = sssReaching.time.getTime();
    const gateIdx = gateIndexForCrossing(gates, crossingMs);
    if (gateIdx < 0) {
      earlyStart = {
        crossingTime: sssReaching.time,
        firstGateTime: new Date(gates[0]),
        secondsEarly: (gates[0] - crossingMs) / 1000,
      };
      startGate = { time: new Date(gates[0]), index: 0, gateCount: gates.length };
    } else {
      startGate = { time: new Date(gates[gateIdx]), index: gateIdx, gateCount: gates.length };
    }
  }

  // Speed section time: from the start gate taken when the race has gates
  // (§8.7), otherwise from the pilot's actual crossing (elapsed time).
  let speedSectionTime: number | null = null;
  if (sssReaching && essReaching) {
    const startMs = startGate ? startGate.time.getTime() : sssReaching.time.getTime();
    speedSectionTime = (essReaching.time.getTime() - startMs) / 1000;
  }

  return {
    crossings: allCrossings,
    sequence,
    sssReaching,
    essReaching,
    madeGoal,
    lastTurnpointReached,
    bestProgress,
    taskDistance,
    flownDistance,
    legs,
    speedSectionTime,
    ...(startGate ? { startGate } : {}),
    ...(earlyStart ? { earlyStart } : {}),
    ...(startFallback ? { startFallback } : {}),
    ...(essIsFallback ? { essFallback: 'last_turnpoint' as const } : {}),
  };
}

// ---------------------------------------------------------------------------
// JSON wire form
// ---------------------------------------------------------------------------

/** {@link CylinderCrossing} as it arrives over JSON — `time` serialized. */
export type CylinderCrossingJSON = Omit<CylinderCrossing, 'time'> & {
  time: string | number;
};

/** {@link TurnpointReaching} as it arrives over JSON — `time` serialized. */
export type TurnpointReachingJSON = Omit<TurnpointReaching, 'time'> & {
  time: string | number;
};

/** {@link BestProgress} as it arrives over JSON — `time` serialized. */
export type BestProgressJSON = Omit<BestProgress, 'time'> & {
  time: string | number;
};

/** {@link StartGateTaken} as it arrives over JSON — `time` serialized. */
export type StartGateTakenJSON = Omit<StartGateTaken, 'time'> & {
  time: string | number;
};

/** {@link EarlyStart} as it arrives over JSON — `Date`s serialized. */
export type EarlyStartJSON = Omit<EarlyStart, 'crossingTime' | 'firstGateTime'> & {
  crossingTime: string | number;
  firstGateTime: string | number;
};

/**
 * {@link TurnpointSequenceResult} as it arrives over JSON. `Date` fields
 * serialize to ISO strings (JSON.stringify's default) or epoch milliseconds;
 * {@link reviveTurnpointSequenceResult} turns either back into `Date`s.
 * This is the wire format of the competition API's per-pilot analysis
 * endpoint, which feeds the score-details explanation.
 */
export interface TurnpointSequenceResultJSON
  extends Omit<
    TurnpointSequenceResult,
    'crossings' | 'sequence' | 'sssReaching' | 'essReaching' | 'bestProgress'
    | 'startGate' | 'earlyStart'
  > {
  crossings: CylinderCrossingJSON[];
  sequence: TurnpointReachingJSON[];
  sssReaching: TurnpointReachingJSON | null;
  essReaching: TurnpointReachingJSON | null;
  bestProgress: BestProgressJSON | null;
  startGate?: StartGateTakenJSON;
  earlyStart?: EarlyStartJSON;
}

/** Revive a JSON-round-tripped {@link TurnpointSequenceResult}. */
export function reviveTurnpointSequenceResult(
  raw: TurnpointSequenceResultJSON,
): TurnpointSequenceResult {
  const revive = <T extends { time: string | number }>(
    v: T,
  ): Omit<T, 'time'> & { time: Date } => ({ ...v, time: new Date(v.time) });
  const { startGate, earlyStart, ...rest } = raw;
  return {
    ...rest,
    crossings: raw.crossings.map(revive),
    sequence: raw.sequence.map(revive),
    sssReaching: raw.sssReaching ? revive(raw.sssReaching) : null,
    essReaching: raw.essReaching ? revive(raw.essReaching) : null,
    bestProgress: raw.bestProgress ? revive(raw.bestProgress) : null,
    ...(startGate ? { startGate: revive(startGate) } : {}),
    ...(earlyStart
      ? {
          earlyStart: {
            ...earlyStart,
            crossingTime: new Date(earlyStart.crossingTime),
            firstGateTime: new Date(earlyStart.firstGateTime),
          },
        }
      : {}),
  };
}
