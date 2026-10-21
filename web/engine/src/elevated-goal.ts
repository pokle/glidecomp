/**
 * Elevated Goal and control-zone altitude limits — the two features the FAI
 * S7F 2026 edition added to control zones (issue #600).
 *
 * **Elevated Goal** (§6.2.3.2, §9.2.3.2, §13.1). A goal line or cylinder that
 * sits `elevation` metres above the published goal waypoint altitude (300 m by
 * default, up to 1000 m). It implicitly also serves as the end of the speed
 * section. Every crossing validates goal whatever its altitude, but a pilot
 * who crosses below the elevation keeps only GoalAltitudeFactor (0.8–1) of
 * their time points.
 *
 * The task declares it with XCTrack's own `.xctsk` field `goal.finishAltitude`,
 * which XCTrack documents as the elevated-goal altitude in metres above the
 * goal turnpoint's altitude — exactly §13.1's *elevation*.
 *
 * **Altitude limits** (§6.2.1, §6.2.2, §9.2.1, §9.2.2). A turnpoint cylinder
 * may carry an upper and/or lower limit in metres AMSL; a crossing then counts
 * only when its altitude lies within the limits ± the 5 m absolute tolerance.
 * The `.xctsk` format has no field for them yet, so GlideComp stores them on
 * the turnpoint as `altitudeLimits` (see {@link AltitudeLimits}). A goal
 * cylinder cannot carry limits (§6.2.3) — the Elevated Goal is how goal
 * altitude is expressed — so they are ignored on the goal.
 */
import type { Turnpoint, XCTask } from './xctsk-parser';

/** §6.2.3.2: the default elevation above the goal waypoint (metres). */
export const DEFAULT_GOAL_ELEVATION = 300;

/** §6.2.3.2: the most the elevation "can be increased up to" (metres). */
export const MAX_GOAL_ELEVATION = 1000;

/** §9.1: the absolute tolerance, here applied to altitude limits (§9.2.1). */
export const ALTITUDE_LIMIT_TOLERANCE = 5;

/** §13.1: the GoalAltitudeFactor at or below the goal waypoint altitude. */
export const MIN_GOAL_ALTITUDE_FACTOR = 0.8;

/** A task's Elevated Goal, resolved to the two numbers §13.1 needs. */
export interface ElevatedGoal {
  /** The published goal waypoint altitude (m AMSL) — §13.1's goal.altitude. */
  goalAltitude: number;
  /**
   * Metres above `goalAltitude` a crossing must be to keep full time points —
   * §13.1's *elevation*. The task's declared value, capped at
   * {@link MAX_GOAL_ELEVATION}.
   */
  elevation: number;
  /** What the task file declared, when the cap changed it. */
  declaredElevation?: number;
}

/**
 * The task's Elevated Goal, or null when it has none.
 *
 * Elevated only when the task declares a positive `goal.finishAltitude` AND the
 * goal waypoint has a known altitude: the elevation is measured above that
 * altitude, so without it there is nothing to measure against and the goal is
 * scored as an ordinary ground goal. (A known altitude of 0 — a beach goal —
 * is a real altitude, not a missing one.)
 */
export function resolveElevatedGoal(task: XCTask): ElevatedGoal | null {
  const declared = task.goal?.finishAltitude;
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) {
    return null;
  }
  const goal = task.turnpoints[task.turnpoints.length - 1];
  const alt = goal?.waypoint.altSmoothed;
  if (typeof alt !== 'number' || !Number.isFinite(alt)) return null;
  const elevation = Math.min(declared, MAX_GOAL_ELEVATION);
  return {
    goalAltitude: alt,
    elevation,
    ...(elevation !== declared ? { declaredElevation: declared } : {}),
  };
}

/**
 * The fraction by which an elevated goal crossing ABOVE the goal waypoint
 * reaches toward the full elevation: §13.1's AR, clamped to [0, 1].
 */
export function goalAltitudeRatio(crossingAltitude: number, eg: ElevatedGoal): number {
  const ar = (crossingAltitude - eg.goalAltitude) / eg.elevation;
  return Math.min(1, Math.max(0, ar));
}

/**
 * §13.1 GoalAltitudeFactor for a goal crossing at `crossingAltitude`:
 * 0.8 at or below the goal waypoint altitude, 1 at or above the elevation,
 * and between them the cubic 0.8 + 0.6·AR − 0.6·AR² + 0.2·AR³.
 */
export function goalAltitudeFactor(crossingAltitude: number, eg: ElevatedGoal): number {
  if (crossingAltitude <= eg.goalAltitude) return MIN_GOAL_ALTITUDE_FACTOR;
  if (crossingAltitude >= eg.goalAltitude + eg.elevation) return 1;
  const ar = goalAltitudeRatio(crossingAltitude, eg);
  return 0.8 + 0.6 * ar - 0.6 * ar * ar + 0.2 * ar * ar * ar;
}

// ---------------------------------------------------------------------------
// Altitude limits
// ---------------------------------------------------------------------------

/**
 * Optional altitude limits on a turnpoint cylinder (§6.2.1), metres AMSL.
 * Either may be absent: an absent upper limit is ∞, an absent lower limit is
 * 0 — but only once the other is set. A turnpoint with neither has no limits.
 */
export interface AltitudeLimits {
  lower?: number;
  upper?: number;
}

/**
 * The limits a turnpoint's crossings are validated against, or null when it
 * has none. The goal never has any (§6.2.3: "a goal cylinder … without the
 * option to set altitude limits"), whatever the task file says.
 */
export function effectiveAltitudeLimits(
  task: XCTask,
  taskIndex: number,
): { lower: number; upper: number } | null {
  if (taskIndex === task.turnpoints.length - 1) return null;
  return limitsOf(task.turnpoints[taskIndex]);
}

function limitsOf(tp: Turnpoint | undefined): { lower: number; upper: number } | null {
  const l = tp?.altitudeLimits;
  if (!l) return null;
  const hasLower = typeof l.lower === 'number' && Number.isFinite(l.lower);
  const hasUpper = typeof l.upper === 'number' && Number.isFinite(l.upper);
  if (!hasLower && !hasUpper) return null;
  return {
    lower: hasLower ? l.lower! : 0,
    upper: hasUpper ? l.upper! : Infinity,
  };
}

/**
 * Whether a crossing at `altitude` counts against the limits (§9.2.1): the
 * altitude must lie within [lower − 5 m, upper + 5 m].
 */
export function withinAltitudeLimits(
  altitude: number,
  limits: { lower: number; upper: number },
): boolean {
  return (
    altitude >= limits.lower - ALTITUDE_LIMIT_TOLERANCE &&
    altitude <= limits.upper + ALTITUDE_LIMIT_TOLERANCE
  );
}
