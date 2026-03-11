/**
 * Transform AirScore task data to XCTask format
 */

import { sanitizeText } from '@taskscore/engine';
import type {
  AirScoreTask,
  AirScoreWaypoint,
  XCTask,
  Turnpoint,
  TurnpointType,
  Waypoint,
  SSSConfig,
  GoalConfig,
  CompetitionInfo,
  FormulaInfo,
  AirScoreFormula,
} from '../types';

/**
 * Map AirScore waypoint type to XCTask turnpoint type
 */
function mapWaypointType(tawType: string): TurnpointType {
  switch (tawType) {
    case 'speed':
      return 'SSS';
    case 'endspeed':
      return 'ESS';
    case 'takeoff':
      return 'TAKEOFF';
    case 'goal':
      return 'GOAL';
    default:
      return 'TURNPOINT';
  }
}

/**
 * Transform a single AirScore waypoint to XCTask turnpoint format
 */
function transformWaypoint(wp: AirScoreWaypoint): Turnpoint {
  const waypoint: Waypoint = {
    name: sanitizeText(wp.rwpName),
    description: wp.rwpDescription ? sanitizeText(wp.rwpDescription) : undefined,
    lat: parseFloat(wp.rwpLatDecimal),
    lon: parseFloat(wp.rwpLongDecimal),
  };

  const altitude = parseFloat(wp.rwpAltitude);
  if (!isNaN(altitude) && altitude !== 0) {
    waypoint.altSmoothed = altitude;
  }

  return {
    type: mapWaypointType(wp.tawType),
    radius: parseFloat(wp.tawRadius),
    waypoint,
  };
}

/**
 * Extract SSS (Speed Section Start) configuration from waypoints
 */
function extractSSSConfig(
  waypoints: AirScoreWaypoint[],
  taskType: string,
  startTime?: string
): SSSConfig | undefined {
  const sssWaypoint = waypoints.find((wp) => wp.tawType === 'speed');

  if (!sssWaypoint) {
    return undefined;
  }

  return {
    type: taskType.toUpperCase().includes('ELAPSED') ? 'ELAPSED-TIME' : 'RACE',
    direction: sssWaypoint.tawHow === 'exit' ? 'EXIT' : 'ENTER',
    timeGates: startTime ? [startTime] : undefined,
  };
}

/**
 * Extract goal configuration from waypoints
 */
function extractGoalConfig(
  waypoints: AirScoreWaypoint[],
  deadline?: string
): GoalConfig | undefined {
  const goalWaypoint = waypoints.find((wp) => wp.tawType === 'goal');

  if (!goalWaypoint) {
    return undefined;
  }

  return {
    type: goalWaypoint.tawShape === 'line' ? 'LINE' : 'CYLINDER',
    deadline: deadline || undefined,
  };
}

/**
 * Transform AirScore task data to XCTask format
 */
export function transformAirScoreTask(task: AirScoreTask): XCTask {
  const turnpoints = task.waypoints.map(transformWaypoint);

  const sss = extractSSSConfig(task.waypoints, task.task_type, task.start);
  const goal = extractGoalConfig(task.waypoints, task.end);

  return {
    taskType: task.task_type,
    version: 1,
    earthModel: 'WGS84',
    turnpoints,
    takeoff: {
      timeOpen: task.start || undefined,
      timeClose: task.end || undefined,
    },
    sss,
    goal,
  };
}

/**
 * Extract competition info from AirScore task data
 */
export function extractCompetitionInfo(task: AirScoreTask): CompetitionInfo {
  return {
    name: sanitizeText(task.comp_name),
    class: task.comp_class,
    taskName: sanitizeText(task.task_name),
    date: task.date,
    taskType: task.task_type,
    taskDistance: task.task_dist,
    waypointDistance: task.wp_dist,
    comment: task.comment ? sanitizeText(task.comment) : undefined,
    quality: parseFloat(task.quality),
    stopped: task.stopped,
  };
}

/**
 * Extract formula info from AirScore formula data
 */
export function extractFormulaInfo(formula: AirScoreFormula): FormulaInfo {
  return {
    name: formula.formula,
    goalPenalty: parseFloat(formula.goal_penalty),
    nominalGoal: formula.nominal_goal,
    minimumDistance: formula.minimum_distance,
    nominalDistance: formula.nominal_distance,
    nominalTime: formula.nominal_time,
    arrivalScoring: formula.arrival_scoring,
    heightBonus: formula.height_bonus,
  };
}
