/**
 * Client for the AirScore API Worker
 *
 * Provides functions to fetch task and track data from AirScore
 * via the caching proxy worker.
 */

import type { XCTask } from '@taskscore/analysis';

// ============================================================================
// Types matching the worker's response format
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
  rawTask: unknown;
}

export interface AirScoreError {
  error: string;
  code: string;
  details?: string;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Base URL for the AirScore API worker.
 * Uses VITE_AIRSCORE_URL env var if set (e.g. production URL during local dev).
 * Otherwise, in development (localhost), this points to the local worker.
 * In production, this is proxied through the Pages site.
 */
function getAirScoreApiBase(): string {
  const envUrl = import.meta.env.VITE_AIRSCORE_URL;
  if (envUrl) {
    return envUrl;
  }
  // Check if running on localhost (dev) or production
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return 'http://localhost:8787/api/airscore';
  }
  return '/api/airscore';
}

const AIRSCORE_API_BASE = getAirScoreApiBase();

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch task data from AirScore
 *
 * @param comPk - Competition primary key
 * @param tasPk - Task primary key
 * @returns Task data with competition info, pilot results, and XCTask
 * @throws Error if the request fails
 *
 * @example
 * const data = await fetchAirScoreTask(466, 2030);
 * console.log(data.competition.name); // "Corryong Cup 2026 Open"
 * console.log(data.pilots.length); // Number of pilots
 */
export async function fetchAirScoreTask(
  comPk: number,
  tasPk: number
): Promise<AirScoreTaskResponse> {
  const url = `${AIRSCORE_API_BASE}/task?comPk=${comPk}&tasPk=${tasPk}`;

  const response = await fetch(url);

  if (!response.ok) {
    let errorData: AirScoreError;
    try {
      errorData = await response.json();
    } catch {
      throw new Error(`Failed to fetch task: ${response.status} ${response.statusText}`);
    }
    throw new Error(errorData.error || 'Failed to fetch task');
  }

  return response.json();
}

/**
 * Fetch IGC track file from AirScore
 *
 * @param trackId - AirScore track ID
 * @param comPk - Competition primary key (optional, for logging)
 * @param tasPk - Task primary key (optional, for logging)
 * @returns Raw IGC file content as string
 * @throws Error if the request fails
 *
 * @example
 * const igcContent = await fetchAirScoreTrack('43826', 466, 2030);
 * // Parse with IGC parser
 * const igcFile = parseIGC(igcContent);
 */
export async function fetchAirScoreTrack(
  trackId: string,
  comPk?: number,
  tasPk?: number
): Promise<string> {
  let url = `${AIRSCORE_API_BASE}/track?trackId=${trackId}`;
  if (comPk !== undefined) {
    url += `&comPk=${comPk}`;
  }
  if (tasPk !== undefined) {
    url += `&tasPk=${tasPk}`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    let errorData: AirScoreError;
    try {
      errorData = await response.json();
    } catch {
      throw new Error(`Failed to fetch track: ${response.status} ${response.statusText}`);
    }
    throw new Error(errorData.error || 'Failed to fetch track');
  }

  return response.text();
}

/**
 * Check if the AirScore API worker is available
 *
 * @returns true if the worker is reachable and responding
 */
export async function checkAirScoreApiHealth(): Promise<boolean> {
  try {
    const response = await fetch(AIRSCORE_API_BASE, {
      method: 'GET',
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Get the cache status from the last response headers
 *
 * @param response - The fetch response object
 * @returns 'HIT' if served from cache, 'MISS' if fetched fresh
 */
export function getCacheStatus(response: Response): 'HIT' | 'MISS' | undefined {
  const cacheHeader = response.headers.get('X-Cache');
  if (cacheHeader === 'HIT' || cacheHeader === 'MISS') {
    return cacheHeader;
  }
  return undefined;
}
