// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * AirScore API Worker
 *
 * A caching proxy for the AirScore API that transforms task and track data
 * into a format compatible with the GlideComp analysis tool.
 *
 * Endpoints:
 * - GET /api/airscore/task?comPk={comPk}&tasPk={tasPk}
 * - GET /api/airscore/track?trackId={trackId}
 */

import { handleTaskRequest } from './handlers/task';
import { handleTrackRequest } from './handlers/track';
import type { Env } from './types';

// CORS headers for browser requests
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

/**
 * Add CORS headers to a response
 */
function addCorsHeaders(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

/**
 * Handle preflight OPTIONS request
 */
function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}

/**
 * Handle 404 Not Found
 */
function handleNotFound(): Response {
  return new Response(
    JSON.stringify({
      error: 'Not found',
      code: 'NOT_FOUND',
      endpoints: [
        'GET /api/airscore/task?comPk={comPk}&tasPk={tasPk}',
        'GET /api/airscore/track?trackId={trackId}',
      ],
    }),
    {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

/**
 * Handle 405 Method Not Allowed
 */
function handleMethodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      error: 'Method not allowed',
      code: 'METHOD_NOT_ALLOWED',
    }),
    {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    // Only allow GET requests
    if (request.method !== 'GET') {
      return addCorsHeaders(handleMethodNotAllowed());
    }

    try {
      let response: Response;

      // Route to appropriate handler
      if (url.pathname === '/api/airscore/task') {
        response = await handleTaskRequest(request, env, ctx);
      } else if (url.pathname === '/api/airscore/track') {
        response = await handleTrackRequest(request, env, ctx);
      } else if (url.pathname === '/' || url.pathname === '/api/airscore') {
        // Health check / info endpoint
        response = new Response(
          JSON.stringify({
            name: 'AirScore API Worker',
            version: '1.0.0',
            endpoints: [
              'GET /api/airscore/task?comPk={comPk}&tasPk={tasPk}',
              'GET /api/airscore/track?trackId={trackId}',
            ],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      } else {
        response = handleNotFound();
      }

      return addCorsHeaders(response);
    } catch (error) {
      console.error('Unhandled worker error:', error);

      return addCorsHeaders(
        new Response(
          JSON.stringify({
            error: 'Internal server error',
            code: 'INTERNAL_ERROR',
          }),
          {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );
    }
  },
};
