/**
 * Handler for GET /api/airscore/task endpoint
 */

import { errorResponse, type Env, type AirScoreRawResponse, type AirScoreTaskResponse } from '../types';
import { getCachedOrFetch, taskCacheKey } from '../cache';
import { transformAirScoreTask, extractCompetitionInfo, extractFormulaInfo } from '../transforms/task';
import { extractPilotResults } from '../transforms/pilots';

/**
 * Fetch task data from AirScore API
 */
async function fetchFromAirScore(
  baseUrl: string,
  comPk: number,
  tasPk: number
): Promise<AirScoreRawResponse> {
  const timestamp = Date.now();
  const url = `${baseUrl}/get_task_result.php?comPk=${comPk}&tasPk=${tasPk}&_=${timestamp}`;

  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'TaskScore-AirScoreAPI/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`AirScore API returned ${response.status}: ${response.statusText}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  // Validate response structure
  if (!data.task || !data.formula || !data.data) {
    throw new Error('Invalid response structure from AirScore API');
  }

  return data as unknown as AirScoreRawResponse;
}

/**
 * Transform AirScore response to our API format
 */
function transformResponse(raw: AirScoreRawResponse): AirScoreTaskResponse {
  return {
    task: transformAirScoreTask(raw.task),
    competition: extractCompetitionInfo(raw.task),
    pilots: extractPilotResults(raw.data),
    formula: extractFormulaInfo(raw.formula),
    rawTask: raw.task,
  };
}

/**
 * Handle GET /api/airscore/task request
 */
export async function handleTaskRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // Extract and validate parameters
  const comPkParam = url.searchParams.get('comPk');
  const tasPkParam = url.searchParams.get('tasPk');

  if (!comPkParam || !tasPkParam) {
    return errorResponse(
      'Missing required parameters',
      'MISSING_PARAMS',
      400,
      'Both comPk and tasPk are required'
    );
  }

  const comPk = parseInt(comPkParam, 10);
  const tasPk = parseInt(tasPkParam, 10);

  if (isNaN(comPk) || isNaN(tasPk)) {
    return errorResponse(
      'Invalid parameter format',
      'INVALID_PARAMS',
      400,
      'comPk and tasPk must be integers'
    );
  }

  try {
    const cacheKey = taskCacheKey(comPk, tasPk);
    const ttl = parseInt(env.CACHE_TTL_TASK, 10) || 3600;

    const { data: rawData, cached } = await getCachedOrFetch(
      env.AIRSCORE_CACHE,
      cacheKey,
      ttl,
      () => fetchFromAirScore(env.AIRSCORE_BASE_URL, comPk, tasPk)
    );

    const transformed = transformResponse(rawData);

    return new Response(JSON.stringify(transformed), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Cache': cached ? 'HIT' : 'MISS',
        'Cache-Control': `public, max-age=${ttl}`,
      },
    });
  } catch (error) {
    console.error('Error fetching task:', error);

    if (error instanceof Error) {
      if (error.message.includes('AirScore API returned')) {
        return errorResponse(
          'Upstream API error',
          'UPSTREAM_ERROR',
          502,
          error.message
        );
      }
    }

    return errorResponse(
      'Failed to fetch task data',
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error'
    );
  }
}
