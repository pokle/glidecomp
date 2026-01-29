/**
 * Handler for GET /api/airscore/track endpoint
 *
 * Fetches IGC track files from AirScore and caches them.
 */

import type { Env, ErrorResponse } from '../types';
import { getCachedOrFetch, trackCacheKey } from '../cache';

/**
 * Fetch track IGC file from AirScore
 *
 * AirScore track URL format:
 * https://xc.highcloud.net/download_track.php?track_id={trackId}
 */
async function fetchTrackFromAirScore(
  baseUrl: string,
  trackId: string
): Promise<string> {
  const url = `${baseUrl}/download_tracks.php?traPk=${trackId}`;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'TaskScore-AirScoreAPI/1.0',
    },
  });

  if (!response.ok) {
    throw new Error(`AirScore API returned ${response.status}: ${response.statusText}`);
  }

  const content = await response.text();

  // Validate it looks like an IGC file
  if (!content.startsWith('A') && !content.includes('HFDTE')) {
    throw new Error('Response does not appear to be a valid IGC file');
  }

  return content;
}

/**
 * Create a JSON error response
 */
function errorResponse(error: string, code: string, status: number, details?: string): Response {
  const body: ErrorResponse = { error, code, details };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Handle GET /api/airscore/track request
 */
export async function handleTrackRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext
): Promise<Response> {
  const url = new URL(request.url);

  // Extract and validate parameters
  const trackId = url.searchParams.get('trackId');
  const comPk = url.searchParams.get('comPk');
  const tasPk = url.searchParams.get('tasPk');

  if (!trackId) {
    return errorResponse(
      'Missing required parameter',
      'MISSING_PARAMS',
      400,
      'trackId is required'
    );
  }

  // comPk and tasPk are optional but useful for logging/debugging
  if (comPk) {
    console.log(`Track request: trackId=${trackId}, comPk=${comPk}, tasPk=${tasPk}`);
  }

  // Validate trackId format (should be numeric)
  if (!/^\d+$/.test(trackId)) {
    return errorResponse(
      'Invalid trackId format',
      'INVALID_PARAMS',
      400,
      'trackId must be a numeric string'
    );
  }

  try {
    const cacheKey = trackCacheKey(trackId);
    const ttl = parseInt(env.CACHE_TTL_TRACK, 10) || 86400;

    const { data: igcContent, cached } = await getCachedOrFetch(
      env.AIRSCORE_CACHE,
      cacheKey,
      ttl,
      () => fetchTrackFromAirScore(env.AIRSCORE_BASE_URL, trackId)
    );

    return new Response(igcContent, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="track-${trackId}.igc"`,
        'X-Cache': cached ? 'HIT' : 'MISS',
        'Cache-Control': `public, max-age=${ttl}`,
      },
    });
  } catch (error) {
    console.error('Error fetching track:', error);

    if (error instanceof Error) {
      if (error.message.includes('AirScore API returned')) {
        return errorResponse(
          'Upstream API error',
          'UPSTREAM_ERROR',
          502,
          error.message
        );
      }
      if (error.message.includes('not appear to be a valid IGC')) {
        return errorResponse(
          'Invalid track data',
          'INVALID_TRACK',
          502,
          'AirScore returned data that is not a valid IGC file'
        );
      }
    }

    return errorResponse(
      'Failed to fetch track',
      'INTERNAL_ERROR',
      500,
      error instanceof Error ? error.message : 'Unknown error'
    );
  }
}
