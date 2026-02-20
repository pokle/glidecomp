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

  /** Distance from the crossing point to the cylinder center (meters) */
  distanceToCenter: number;
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

  /**
   * Why this crossing was selected over other candidates.
   * Designed to be explainable to pilots:
   * - 'last_before_next': SSS rule — last crossing before continuing to next TP
   * - 'first_after_previous': Standard rule — first crossing after previous TP reached
   * - 'first_crossing': ESS rule — always first crossing, no re-tries
   */
  selectionReason: 'last_before_next' | 'first_after_previous' | 'first_crossing';

  /**
   * How many candidate crossings existed for this task position.
   * Helps the UI explain: "3 crossings detected, this one was selected because..."
   */
  candidateCount: number;
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

  /** Total optimized task distance in meters (SSS to goal via cylinder edges) */
  taskDistance: number;

  /**
   * Scored flown distance in meters.
   * - Goal pilots: taskDistance
   * - Non-goal: sum of completed leg distances + progress past last TP
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
   * Speed section time in seconds (SSS reaching time to ESS reaching time).
   * Null if SSS or ESS not reached.
   */
  speedSectionTime: number | null;
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
 * @returns All crossings sorted by time
 */
export function detectCylinderCrossings(
  task: XCTask,
  fixes: IGCFix[]
): CylinderCrossing[] {
  // TODO: implement
  void task;
  void fixes;
  return [];
}

/**
 * Resolve the turnpoint sequence for a flight against a competition task.
 *
 * Algorithm (per CIVL GAP / Section 7F):
 * 1. Detect all cylinder crossings per task position
 * 2. For SSS: use last valid crossing before continuing to next TP
 * 3. For other TPs: use first valid crossing after previous TP reached
 * 4. For ESS: always first crossing (no re-tries)
 * 5. For multi-gate/elapsed-time: iterate SSS crossings, keep best path
 *    (most TPs reached, then most flown distance, then latest SSS)
 * 6. Compute optimized leg distances and flown distance
 *
 * @param task - The competition task definition
 * @param fixes - The pilot's GPS tracklog
 * @returns Complete sequence result with scoring data and explanations
 */
export function resolveTurnpointSequence(
  task: XCTask,
  fixes: IGCFix[]
): TurnpointSequenceResult {
  // TODO: implement
  void task;
  void fixes;
  return {
    crossings: [],
    sequence: [],
    sssReaching: null,
    essReaching: null,
    madeGoal: false,
    lastTurnpointReached: -1,
    bestProgress: null,
    taskDistance: 0,
    flownDistance: 0,
    legs: [],
    speedSectionTime: null,
  };
}
