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
 *
 * On Hono, like every other Worker here. It used to hand-roll its routing and
 * its responses — a URL switch plus four helpers for CORS, preflight, 404 and
 * 405 — which is a lot of surface for a proxy with two endpoints, and it was
 * the one Worker whose conventions a reader had to learn separately.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { handleTaskRequest } from './handlers/task';
import { handleTrackRequest } from './handlers/track';
import { getCacheStats, clearCache } from './cache';
import type { Env } from './types';

const app = new Hono<{ Bindings: Env }>();

/**
 * Wide-open CORS, deliberately and unlike the other Workers.
 *
 * This proxy is anonymous by construction: it carries no cookie, reads no
 * session, and serves only public AirScore competition results. There is no
 * caller identity for an allowlist to protect, so `credentials` stays off and
 * the origin is unrestricted — the reason the shared allowlist in
 * @glidecomp/worker-kit/cors does NOT apply here.
 */
app.use('/api/airscore/*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'] }));

// Surface uncaught handler errors as JSON — mirrors the other Workers, so any
// 500 in CI traces or `wrangler tail` points at the real cause. The stack is
// logged server-side; only the message goes to the client.
app.onError((err, c) => {
  console.error('[airscore-api] unhandled error', err);
  return c.json({ error: 'Internal server error', code: 'INTERNAL_ERROR' }, 500);
});

app.notFound((c) =>
  c.json(
    {
      error: 'Not found',
      code: 'NOT_FOUND',
      endpoints: [
        'GET /api/airscore/task?comPk={comPk}&tasPk={tasPk}',
        'GET /api/airscore/track?trackId={trackId}',
      ],
    },
    404
  )
);

// Cache admin, called only via service binding from competition-api's
// superadmin-gated /api/admin/cache routes — not on the public
// `/api/airscore/*` route pattern, so unreachable from the internet.
app.get('/internal/cache/stats', async (c) =>
  c.json(await getCacheStats(c.env.AIRSCORE_CACHE))
);
app.post('/internal/cache/clear', async (c) =>
  c.json({ cleared: await clearCache(c.env.AIRSCORE_CACHE) })
);

// The two proxied endpoints. The handlers already speak Request/Response, and
// what they do — validate the query, hit the cache, transform — is the part
// worth keeping untouched.
app.get('/api/airscore/task', (c) =>
  handleTaskRequest(c.req.raw, c.env)
);
app.get('/api/airscore/track', (c) =>
  handleTrackRequest(c.req.raw, c.env)
);

// Health check / info endpoint
const info = (c: { json: (v: unknown) => Response }) =>
  c.json({
    name: 'AirScore API Worker',
    version: '1.0.0',
    endpoints: [
      'GET /api/airscore/task?comPk={comPk}&tasPk={tasPk}',
      'GET /api/airscore/track?trackId={trackId}',
    ],
  });
app.get('/', info);
app.get('/api/airscore', info);

export default app;
