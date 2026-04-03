// Worker environment bindings
export interface Env {
  AIRSCORE_CACHE: KVNamespace;
  AIRSCORE_BASE_URL: string;
  CACHE_TTL_TASK: string;
  CACHE_TTL_TRACK: string;
}

// ============================================================================
// AirScore API Response Types (raw data from upstream)
// ============================================================================

export interface AirScoreWaypoint {
  tawPk: string;
  tasPk: string;
  rwpPk: string;
  tawNumber: string;
  tawTime: string;
  tawType: 'start' | 'speed' | 'waypoint' | 'endspeed' | 'goal';
  tawHow: 'entry' | 'exit';
  tawShape: 'circle' | 'line';
  tawAngle: string | null;
  tawRadius: string;
  ssrLatDecimal: string;
  ssrLongDecimal: string;
  ssrNumber: string;
  ssrCumulativeDist: string;
  regPk: string;
  rwpName: string;
  rwpLatDecimal: string;
  rwpLongDecimal: string;
  rwpAltitude: string;
  rwpDescription: string;
}

export interface AirScoreTask {
  comp_name: string;
  comp_class: string;
  task_name: string;
  date: string;
  task_type: string;
  class: string;
  start: string;
  end: string;
  stopped: boolean;
  wp_dist: number;
  task_dist: number;
  quality: string;
  dist_quality: string;
  time_quality: string;
  launch_quality: string;
  stop_quality: string;
  comment: string;
  offset: number;
  hbess: string;
  waypoints: AirScoreWaypoint[];
  safety: number;
  conditions: number;
}

export interface AirScoreFormula {
  formula: string;
  goal_penalty: string;
  nominal_goal: string;
  minimum_distance: string;
  nominal_distance: string;
  nominal_time: string;
  arrival_scoring: string;
  departure: string;
  stop_glide_bonus: string;
  start_weight: string;
  arrival_weight: string;
  speed_weight: string;
  scale_to_validity: string;
  error_margin: number;
  arrival: string;
  height_bonus: string;
}

interface AirScoreMetrics {
  'day quality': string;
  dist_quality: string;
  time_quality: string;
  launch_quality: string;
  pilot_safety: number;
  pilot_quality: number;
}

// The data array contains mixed types - HTML strings and numbers
export type AirScoreDataRow = (string | number | null)[];

export interface AirScoreRawResponse {
  task: AirScoreTask;
  formula: AirScoreFormula;
  metrics: AirScoreMetrics;
  data: AirScoreDataRow[];
}

// ============================================================================
// Transformed Types (compatible with GlideComp analysis tool)
// ============================================================================

export interface Waypoint {
  name: string;
  description?: string;
  lat: number;
  lon: number;
  altSmoothed?: number;
}

export type TurnpointType = 'TAKEOFF' | 'SSS' | 'ESS';

export interface Turnpoint {
  type?: TurnpointType;
  radius: number;
  waypoint: Waypoint;
}

export interface SSSConfig {
  type: 'RACE' | 'ELAPSED-TIME';
  direction: 'ENTER' | 'EXIT';
  timeGates?: string[];
}

export interface GoalConfig {
  type: 'CYLINDER' | 'LINE';
  deadline?: string;
}

export interface XCTask {
  taskType: string;
  version: number;
  earthModel?: 'WGS84' | 'FAI_SPHERE';
  turnpoints: Turnpoint[];
  takeoff?: {
    timeOpen?: string;
    timeClose?: string;
  };
  sss?: SSSConfig;
  goal?: GoalConfig;
}

// ============================================================================
// API Response Types
// ============================================================================

export interface CompetitionInfo {
  name: string;
  class: string;
  taskName: string;
  date: string;
  taskType: string;
  taskDistance: number;
  waypointDistance: number;
  comment?: string;
  quality: number;
  stopped: boolean;
}

export interface PilotResult {
  rank: number;
  pilotId: string;
  name: string;
  nationality: string;
  glider: string;
  gliderClass: string;
  startTime?: string;
  finishTime?: string;
  duration?: string;
  distance: number;
  speed: number;
  score: number;
  trackId?: string;
}

export interface FormulaInfo {
  name: string;
  goalPenalty: number;
  nominalGoal: string;
  minimumDistance: string;
  nominalDistance: string;
  nominalTime: string;
  arrivalScoring: string;
  heightBonus: string;
}

export interface AirScoreTaskResponse {
  task: XCTask;
  competition: CompetitionInfo;
  pilots: PilotResult[];
  formula: FormulaInfo;
  rawTask: AirScoreTask;
}

export interface ErrorResponse {
  error: string;
  code: string;
  details?: string;
}

/**
 * Create a JSON error response.
 */
export function errorResponse(error: string, code: string, status: number, details?: string): Response {
  const body: ErrorResponse = { error, code, details };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
