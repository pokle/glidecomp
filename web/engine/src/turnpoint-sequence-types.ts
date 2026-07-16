/**
 * Turnpoint-sequence data types.
 *
 * The transparency vocabulary produced by the sequence resolver — crossings,
 * reachings, best-progress, gates, deadlines — plus the cylinder-tolerance
 * constants and their JSON round-trip variants. Shared by the crossing
 * detector, the path builder, and the resolver.
 */

import type { GoalLine } from './goal-line';

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
// Task deadline and launch window
// ---------------------------------------------------------------------------

/**
 * The task deadline as applied to this flight (FAI S7F §8.3.c, §8.6.1,
 * §11.1): crossings after the deadline don't count toward the sequence, and
 * a landed-out pilot's best distance is measured only up to it. Present on
 * the result whenever the task defines an enforceable deadline, so the
 * score explanation can state the cutoff and point at any ignored
 * crossings (which remain in {@link TurnpointSequenceResult.crossings}).
 */
export interface TaskDeadlineInfo {
  /** The absolute task deadline, resolved onto the flight's day. */
  time: Date;

  /**
   * Boundary crossings recorded after the deadline — still listed in
   * `crossings` for transparency, but excluded from sequence resolution.
   */
  crossingsAfter: number;

  /**
   * True when the tracklog continues past the deadline. Distance and
   * crossings from that part of the track earn nothing (§11.1); the flag
   * lets the explanation say so without re-scanning the fixes.
   */
  trackContinuesPastDeadline: boolean;
}

/**
 * The launch window's open time as applied to this flight (FAI S7F §8.6.1,
 * from the task's `takeoff.timeOpen`). A start-cylinder crossing before the
 * window opens proves the pilot was airborne before launching was allowed,
 * so such crossings cannot validate a start. Present whenever the task
 * defines an enforceable window open time.
 */
export interface LaunchWindowInfo {
  /** When the launch window opened, resolved onto the flight's day. */
  openTime: Date;

  /**
   * Start-cylinder crossings before the window opened, excluded from start
   * validation (they remain in `crossings` for transparency).
   */
  droppedStartCrossings: number;
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

  /**
   * Present when the task defines an enforceable goal deadline (§8.3.c):
   * crossings after it were excluded from the sequence and best-progress
   * distance was measured only up to it. See {@link TaskDeadlineInfo}.
   */
  deadline?: TaskDeadlineInfo;

  /**
   * Present when the task defines an enforceable launch-window open time
   * (§8.6.1): start crossings before it cannot validate a start. See
   * {@link LaunchWindowInfo}.
   */
  launchWindow?: LaunchWindowInfo;
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
export type NextTPMeasure =
  | { kind: 'tag'; point: { lat: number; lon: number } }
  | { kind: 'edge' }
  | { kind: 'exit-boundary' }
  | { kind: 'goal-line'; line: GoalLine };

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

/** {@link TaskDeadlineInfo} as it arrives over JSON — `time` serialized. */
export type TaskDeadlineInfoJSON = Omit<TaskDeadlineInfo, 'time'> & {
  time: string | number;
};

/** {@link LaunchWindowInfo} as it arrives over JSON — `openTime` serialized. */
export type LaunchWindowInfoJSON = Omit<LaunchWindowInfo, 'openTime'> & {
  openTime: string | number;
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
    | 'startGate' | 'earlyStart' | 'deadline' | 'launchWindow'
  > {
  crossings: CylinderCrossingJSON[];
  sequence: TurnpointReachingJSON[];
  sssReaching: TurnpointReachingJSON | null;
  essReaching: TurnpointReachingJSON | null;
  bestProgress: BestProgressJSON | null;
  startGate?: StartGateTakenJSON;
  earlyStart?: EarlyStartJSON;
  deadline?: TaskDeadlineInfoJSON;
  launchWindow?: LaunchWindowInfoJSON;
}
