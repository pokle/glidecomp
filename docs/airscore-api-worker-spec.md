# AirScore API Worker Specification

## Overview

A Cloudflare Worker that acts as a caching proxy for the AirScore API, fetching task and track information and transforming it into a format compatible with the GlideComp analysis tool.

**Implementation:** `web/workers/airscore-api/`

## Problem Statement

The GlideComp analysis tool needs to load competition tasks and pilot track data from AirScore. Direct browser requests face these challenges:

1. **CORS restrictions** - Browser security prevents direct cross-origin requests to AirScore
2. **API efficiency** - Repeatedly fetching the same data wastes bandwidth and loads AirScore unnecessarily
3. **Data format mismatch** - AirScore returns data in its own format; GlideComp uses XCTask format

## Design Decisions

### Why a Cloudflare Worker?

| Alternative | Rejected Because |
|-------------|------------------|
| Direct browser fetch | CORS blocked |
| Cloudflare Pages Function | Workers have better KV integration and can be deployed independently |
| Backend proxy server | Adds infrastructure complexity; Cloudflare Workers are serverless |
| Client-side CORS proxy | Security concerns, unreliable third-party services |

### Why KV for Caching?

| Alternative | Rejected Because |
|-------------|------------------|
| Cache API | Limited to 512MB, no cross-request persistence guarantees |
| Durable Objects | Overkill for simple key-value caching |
| External Redis | Adds latency and cost |
| No caching | Unnecessary load on AirScore, slower responses |

**KV Advantages:**
- Simple key-value interface
- Built-in TTL expiration
- Global distribution
- Free tier sufficient for this use case

### Caching Strategy

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| Task results | 1 hour | Competition results update during events; stale data acceptable for analysis |
| Track files | 24 hours | IGC files are immutable once uploaded |

**Cache Key Format:**
- Tasks: `airscore:task:{comPk}:{tasPk}`
- Tracks: `airscore:track:{trackId}`

### Data Transformation Approach

AirScore returns data optimized for its web UI (HTML in data fields, nested structures). We transform to XCTask format because:

1. **Existing parser support** - GlideComp already handles XCTask from XContest
2. **Clean separation** - Raw AirScore data preserved in `rawTask` for debugging
3. **Type safety** - XCTask has well-defined TypeScript interfaces

#### Waypoint Type Mapping

| AirScore `tawType` | XCTask `Turnpoint.type` | Notes |
|--------------------|-------------------------|-------|
| `start` | (none) | Launch/start reference point |
| `speed` | `SSS` | Speed section start - where timing begins |
| `waypoint` | (none) | Regular turnpoint |
| `endspeed` | `ESS` | End of speed section |
| `goal` | (none) | Goal cylinder (configured via `GoalConfig`) |

#### SSS Direction

AirScore uses `tawHow` field:
- `exit` → `direction: 'EXIT'` (leave cylinder to start)
- `entry` → `direction: 'ENTER'` (enter cylinder to start)

#### Task Type Mapping

AirScore `task_type` contains keywords:
- Contains `ELAPSED` → `sss.type: 'ELAPSED-TIME'`
- Otherwise → `sss.type: 'RACE'`

### Pilot Data Extraction

AirScore embeds HTML in the results array for its DataTables UI:

```
Row[2]: '<a href="tracklog_map.html?trackid=43826&comPk=466&tasPk=2030">Rory Duncan</a>'
Row[0]: '<b>1</b>'
```

We parse this to extract:
- Pilot name (link text)
- Track ID (URL parameter) - enables fetching the pilot's IGC file

## API Contract

### GET /api/airscore/task

Fetches task definition and pilot results.

**Parameters:**
| Name | Required | Description |
|------|----------|-------------|
| `comPk` | Yes | Competition primary key (from AirScore URL) |
| `tasPk` | Yes | Task primary key (from AirScore URL) |

**Response:** `AirScoreTaskResponse` containing:
- `task` - XCTask format for the analysis tool
- `competition` - Metadata (name, date, class, etc.)
- `pilots` - Results array with track IDs
- `formula` - Scoring formula details
- `rawTask` - Original AirScore data (for debugging)

**Headers:**
- `X-Cache: HIT|MISS` - Indicates cache status

### GET /api/airscore/track

Fetches raw IGC track file.

**Parameters:**
| Name | Required | Description |
|------|----------|-------------|
| `trackId` | Yes | Track ID (from pilot results) |
| `comPk` | No | Competition PK (for logging) |
| `tasPk` | No | Task PK (for logging) |

**Response:** Raw IGC file content
- Content-Type: `application/octet-stream`
- Content-Disposition: `attachment; filename="track-{trackId}.igc"`

### GET /

Health check endpoint returning worker info and available endpoints.

### GET /internal/cache/stats · POST /internal/cache/clear

Cache administration: item counts, and a full flush of the KV namespace. Both
sit **outside** the `/api/airscore/*` route pattern, so they are unreachable
from the internet — competition-api calls them over its service binding, behind
the super-admin-gated `/api/admin/cache` endpoints that back the admin cache
page.

### Error Responses

All errors return JSON:
```typescript
{ error: string; code: string; details?: string }
```

| Code | HTTP Status | Cause |
|------|-------------|-------|
| `MISSING_PARAMS` | 400 | Required parameter not provided |
| `INVALID_PARAMS` | 400 | Parameter format invalid |
| `METHOD_NOT_ALLOWED` | 405 | Anything but `GET` (or the `OPTIONS` preflight, and the internal cache-clear `POST`) |
| `UPSTREAM_ERROR` | 502 | AirScore API returned error |
| `INVALID_TRACK` | 502 | Track data not valid IGC |
| `NOT_FOUND` | 404 | Unknown endpoint |
| `INTERNAL_ERROR` | 500 | Unexpected error |

## Frontend Integration

The frontend client (`web/frontend/src/analysis/airscore-client.ts`) does no
environment detection — the base URL is `import.meta.env.VITE_AIRSCORE_URL ||
'/api/airscore'`, i.e. same-origin unless you override it. Nothing addresses
the worker's own port any more: in local dev all the Workers share one wrangler
session and Vite proxies `/api` to the `dev-router` Worker, which dispatches
over a service binding.

**Known gap.** Unlike auth-api and competition-api, this worker has **no**
Pages Function proxy — there is no `functions/api/airscore/` directory and no
`AIRSCORE_API` binding in the root `wrangler.toml`. The same-origin path is
therefore served only where the zone route below applies, and 404s anywhere it
doesn't: `*.glidecomp.pages.dev` branch previews and `bun run
preview:container`. Adding the proxy file fixes both at once.

## Deployment

### Prerequisites

1. Create KV namespaces:
   ```bash
   bunx wrangler kv namespace create AIRSCORE_CACHE
   bunx wrangler kv namespace create AIRSCORE_CACHE --preview
   ```

2. Update `wrangler.toml` with namespace IDs

### Deploy Command

```bash
cd web/workers/airscore-api
bun run deploy
```

### Production Routing

Decided and live: a **Worker route** on the `glidecomp.com` zone, declared in
`web/workers/airscore-api/wrangler.toml`.

```toml
[[routes]]
pattern = "glidecomp.com/api/airscore/*"
zone_name = "glidecomp.com"
```

The two alternatives once considered are not in use — there is no Pages
Function proxy (see the known gap under Frontend Integration) and no
`api.glidecomp.com` subdomain. Deploys happen from `master` only; the branch
Pages deploys don't touch Workers.

## Security Considerations

- **CORS** - Allows all origins (`*`) since this is read-only public data
- **Rate limiting** - Not yet implemented; rely on Cloudflare's default protections
- **No authentication** - Public competition data, no sensitive information

## Limitations

1. **No competition discovery** - User must know comPk/tasPk values
2. **No real-time updates** - Cached data may be up to 1 hour stale
3. **Single AirScore instance** - Hardcoded to xc.highcloud.net

## Future Enhancements

1. **Competition discovery endpoint** - List available competitions
2. **Pilot search** - Find a pilot's results across competitions
3. **Bulk track download** - Download all tracks for a task as zip
4. **Configurable AirScore URL** - Support other AirScore instances
5. **Webhook notifications** - Alert when new results are available

## Files

| File | Purpose |
|------|---------|
| `web/workers/airscore-api/src/index.ts` | Entry point, routing, CORS |
| `web/workers/airscore-api/src/types.ts` | TypeScript interfaces |
| `web/workers/airscore-api/src/cache.ts` | KV caching utilities |
| `web/workers/airscore-api/src/handlers/task.ts` | Task endpoint handler |
| `web/workers/airscore-api/src/handlers/track.ts` | Track endpoint handler |
| `web/workers/airscore-api/src/handlers/track.test.ts` | Tests for the track handler |
| `web/workers/airscore-api/src/transforms/task.ts` | AirScore → XCTask transformation |
| `web/workers/airscore-api/src/transforms/pilots.ts` | HTML parsing for pilot data |
| `web/frontend/src/analysis/airscore-client.ts` | Frontend API client |
