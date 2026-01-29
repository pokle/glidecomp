# AirScore API Worker Specification

## Overview

A Cloudflare Worker that acts as a caching proxy for the AirScore API, fetching task and track information and transforming it into a format compatible with the TaskScore analysis tool.

**Implementation:** `workers/airscore-api/`

## Problem Statement

The TaskScore analysis tool needs to load competition tasks and pilot track data from AirScore. Direct browser requests face these challenges:

1. **CORS restrictions** - Browser security prevents direct cross-origin requests to AirScore
2. **API efficiency** - Repeatedly fetching the same data wastes bandwidth and loads AirScore unnecessarily
3. **Data format mismatch** - AirScore returns data in its own format; TaskScore uses XCTask format

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

1. **Existing parser support** - TaskScore already handles XCTask from XContest
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

### Error Responses

All errors return JSON:
```typescript
{ error: string; code: string; details?: string }
```

| Code | HTTP Status | Cause |
|------|-------------|-------|
| `MISSING_PARAMS` | 400 | Required parameter not provided |
| `INVALID_PARAMS` | 400 | Parameter format invalid |
| `UPSTREAM_ERROR` | 502 | AirScore API returned error |
| `INVALID_TRACK` | 502 | Track data not valid IGC |
| `NOT_FOUND` | 404 | Unknown endpoint |
| `INTERNAL_ERROR` | 500 | Unexpected error |

## Frontend Integration

The frontend client (`pages/src/analysis/airscore-client.ts`) automatically detects environment:
- **localhost** → `http://localhost:8787` (local worker)
- **production** → `/api/airscore` (proxied through Pages)

## Deployment

### Prerequisites

1. Create KV namespaces:
   ```bash
   wrangler kv:namespace create AIRSCORE_CACHE
   wrangler kv:namespace create AIRSCORE_CACHE --preview
   ```

2. Update `wrangler.toml` with namespace IDs

### Deploy Command

```bash
cd workers/airscore-api
npm run deploy
```

### Production Routing

Options for routing `taskscore.shonky.info/api/airscore/*` to the worker:

1. **Worker routes** - Configure in `wrangler.toml`
2. **Pages Functions** - Proxy from Pages to Worker
3. **Separate subdomain** - `api.taskscore.shonky.info`

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
| `workers/airscore-api/src/index.ts` | Entry point, routing, CORS |
| `workers/airscore-api/src/types.ts` | TypeScript interfaces |
| `workers/airscore-api/src/cache.ts` | KV caching utilities |
| `workers/airscore-api/src/handlers/task.ts` | Task endpoint handler |
| `workers/airscore-api/src/handlers/track.ts` | Track endpoint handler |
| `workers/airscore-api/src/transforms/task.ts` | AirScore → XCTask transformation |
| `workers/airscore-api/src/transforms/pilots.ts` | HTML parsing for pilot data |
| `pages/src/analysis/airscore-client.ts` | Frontend API client |
