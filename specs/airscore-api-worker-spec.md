# AirScore API Worker Specification

## Overview

A Cloudflare Worker that acts as a caching proxy for the AirScore API, fetching task and track information and transforming it into a format compatible with the TaskScore analysis tool.

## Problem Statement

The TaskScore analysis tool needs to load competition tasks and pilot track data from AirScore. Direct browser requests to AirScore may face CORS restrictions and repeatedly hitting the AirScore API is inefficient. A Cloudflare Worker can:

1. Bypass CORS by making server-side requests
2. Cache responses to reduce load on AirScore
3. Transform AirScore's data format to match TaskScore's `XCTask` and track formats

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│                 │     │   AirScore Worker    │     │                 │
│  Analysis Tool  │────▶│  /api/airscore/*     │────▶│  AirScore API   │
│   (Frontend)    │◀────│                      │◀────│  xc.highcloud.  │
│                 │     │  ┌────────────────┐  │     │                 │
└─────────────────┘     │  │   KV Cache     │  │     └─────────────────┘
                        │  │   (1 hour TTL) │  │
                        │  └────────────────┘  │
                        └──────────────────────┘
```

## API Endpoints

### 1. Get Task with Results

```
GET /api/airscore/task?comPk={comPk}&tasPk={tasPk}
```

**Parameters:**
- `comPk` (required): Competition primary key
- `tasPk` (required): Task primary key

**Response:**
```typescript
interface AirScoreTaskResponse {
  task: XCTask;                    // Transformed task data
  competition: CompetitionInfo;    // Competition metadata
  pilots: PilotResult[];           // Pilot results with track links
  formula: FormulaInfo;            // Scoring formula details
  rawTask: AirScoreRawTask;        // Original AirScore task data
}

interface CompetitionInfo {
  name: string;
  class: string;           // "HG" | "PG"
  taskName: string;
  date: string;            // ISO date
  taskType: string;
  comment?: string;
}

interface PilotResult {
  rank: number;
  pilotId: string;         // AirScore pilot ID
  name: string;
  nationality: string;
  glider: string;
  gliderClass: string;
  startTime?: string;      // HH:MM:SS
  finishTime?: string;     // HH:MM:SS
  duration?: string;       // H:MM:SS
  distance: number;        // km flown
  speed: number;           // km/h
  score: number;           // total points
  trackId?: string;        // AirScore track ID for fetching IGC
}

interface FormulaInfo {
  name: string;            // e.g., "gap-2021"
  goalPenalty: number;
  nominalGoal: string;
  minimumDistance: string;
  nominalDistance: string;
  nominalTime: string;
  arrivalScoring: string;
  heightBonus: string;
}
```

### 2. Get Track (IGC File)

```
GET /api/airscore/track?trackId={trackId}&comPk={comPk}&tasPk={tasPk}
```

**Parameters:**
- `trackId` (required): AirScore track ID
- `comPk` (required): Competition primary key
- `tasPk` (required): Task primary key

**Response:**
- Content-Type: `application/octet-stream` (raw IGC file)
- Or JSON error response

## Data Transformation

### AirScore Waypoint to XCTask Turnpoint

The worker transforms AirScore waypoint types to XCTask format:

| AirScore `tawType` | XCTask `Turnpoint.type` | Notes |
|--------------------|-------------------------|-------|
| `start`            | (no type)               | First turnpoint, used for launch reference |
| `speed`            | `SSS`                   | Speed section start |
| `waypoint`         | (no type)               | Regular turnpoint |
| `endspeed`         | `ESS`                   | End of speed section |
| `goal`             | (no type)               | Goal cylinder (use GoalConfig) |

### Transformation Logic

```typescript
function transformAirScoreTask(airscoreData: AirScoreRawData): XCTask {
  const turnpoints: Turnpoint[] = airscoreData.task.waypoints.map(wp => ({
    type: mapWaypointType(wp.tawType),
    radius: parseFloat(wp.tawRadius),
    waypoint: {
      name: wp.rwpName,
      description: wp.rwpDescription,
      lat: parseFloat(wp.rwpLatDecimal),
      lon: parseFloat(wp.rwpLongDecimal),
      altSmoothed: parseFloat(wp.rwpAltitude) || undefined,
    }
  }));

  // Determine SSS configuration from waypoint with type "speed"
  const sssWaypoint = airscoreData.task.waypoints.find(wp => wp.tawType === 'speed');
  const sss: SSSConfig | undefined = sssWaypoint ? {
    type: airscoreData.task.task_type.includes('ELAPSED') ? 'ELAPSED-TIME' : 'RACE',
    direction: sssWaypoint.tawHow === 'exit' ? 'EXIT' : 'ENTER',
    timeGates: airscoreData.task.start ? [airscoreData.task.start] : undefined,
  } : undefined;

  // Goal configuration from final waypoint
  const goalWaypoint = airscoreData.task.waypoints.find(wp => wp.tawType === 'goal');
  const goal: GoalConfig | undefined = goalWaypoint ? {
    type: goalWaypoint.tawShape === 'line' ? 'LINE' : 'CYLINDER',
    deadline: airscoreData.task.end,
  } : undefined;

  return {
    taskType: airscoreData.task.task_type,
    version: 1,
    earthModel: 'WGS84',
    turnpoints,
    takeoff: {
      timeOpen: airscoreData.task.start,
      timeClose: airscoreData.task.end,
    },
    sss,
    goal,
  };
}

function mapWaypointType(tawType: string): 'TAKEOFF' | 'SSS' | 'ESS' | undefined {
  switch (tawType) {
    case 'speed': return 'SSS';
    case 'endspeed': return 'ESS';
    case 'takeoff': return 'TAKEOFF';
    default: return undefined;
  }
}
```

### Pilot Data Extraction

The AirScore `data` array contains HTML that needs parsing:

```typescript
function extractPilotResults(data: (string | number)[][]): PilotResult[] {
  return data.map(row => {
    // Row format: [rank, pilotId, nameLink, nationality, glider, class,
    //              startTime, finishTime, duration, penalty, distance,
    //              departure, leadout, arrival, speed, flown?, score]
    const [rank, pilotId, nameLink, nationality, glider, gliderClass,
           startTime, finishTime, duration, penalty, distance,
           departure, leadout, arrival, speed, _, score] = row;

    // Extract name and trackId from HTML link
    const linkMatch = String(nameLink).match(
      /<a href="tracklog_map\.html\?trackid=(\d+)[^"]*">([^<]+)<\/a>/
    );

    return {
      rank: parseInt(String(rank).replace(/<[^>]+>/g, '')),
      pilotId: String(pilotId),
      name: linkMatch ? linkMatch[2] : String(nameLink),
      nationality: String(nationality),
      glider: String(glider),
      gliderClass: String(gliderClass),
      startTime: startTime ? String(startTime) : undefined,
      finishTime: finishTime ? String(finishTime) : undefined,
      duration: duration ? String(duration) : undefined,
      distance: typeof distance === 'number' ? distance : parseFloat(String(distance)) || 0,
      speed: typeof speed === 'number' ? speed : parseFloat(String(speed)) || 0,
      score: typeof score === 'number' ? score : parseInt(String(score)) || 0,
      trackId: linkMatch ? linkMatch[1] : undefined,
    };
  });
}
```

## Caching Strategy

### Cache Keys

```
airscore:task:{comPk}:{tasPk}    → Task + results JSON
airscore:track:{trackId}         → IGC file content
```

### TTL Configuration

| Data Type | TTL | Rationale |
|-----------|-----|-----------|
| Task results | 1 hour | Competition results update during event |
| Track files | 24 hours | IGC files don't change once uploaded |

### Cache Implementation

Using Cloudflare KV for persistent caching:

```typescript
interface Env {
  AIRSCORE_CACHE: KVNamespace;
}

async function getCachedOrFetch<T>(
  kv: KVNamespace,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  // Try cache first
  const cached = await kv.get(key, 'json');
  if (cached) {
    return cached as T;
  }

  // Fetch fresh data
  const data = await fetcher();

  // Store in cache (don't await - fire and forget)
  kv.put(key, JSON.stringify(data), { expirationTtl: ttlSeconds });

  return data;
}
```

## Error Handling

### Error Response Format

```typescript
interface ErrorResponse {
  error: string;
  code: string;
  details?: string;
}
```

### Error Codes

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `MISSING_PARAMS` | 400 | Required parameters not provided |
| `INVALID_PARAMS` | 400 | Parameters have invalid format |
| `UPSTREAM_ERROR` | 502 | AirScore API returned an error |
| `UPSTREAM_TIMEOUT` | 504 | AirScore API request timed out |
| `NOT_FOUND` | 404 | Task or track not found |
| `RATE_LIMITED` | 429 | Too many requests |

### Rate Limiting

Implement basic rate limiting to protect both the worker and AirScore:

```typescript
const RATE_LIMIT = {
  requests: 60,      // Max requests
  window: 60,        // Per minute
};
```

Use Cloudflare's built-in rate limiting or implement with KV counters.

## Worker Implementation

### File Structure

```
workers/
  airscore-api/
    src/
      index.ts           # Main worker entry point
      handlers/
        task.ts          # GET /api/airscore/task handler
        track.ts         # GET /api/airscore/track handler
      transforms/
        task.ts          # AirScore → XCTask transformation
        pilots.ts        # Pilot data extraction
      cache.ts           # KV caching utilities
      types.ts           # TypeScript interfaces
    wrangler.toml        # Worker configuration
    package.json
    tsconfig.json
```

### wrangler.toml

```toml
name = "airscore-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[[kv_namespaces]]
binding = "AIRSCORE_CACHE"
id = "xxx"  # Create with: wrangler kv:namespace create AIRSCORE_CACHE

[vars]
AIRSCORE_BASE_URL = "https://xc.highcloud.net"
CACHE_TTL_TASK = "3600"      # 1 hour
CACHE_TTL_TRACK = "86400"    # 24 hours
```

### Main Entry Point

```typescript
// workers/airscore-api/src/index.ts
import { handleTaskRequest } from './handlers/task';
import { handleTrackRequest } from './handlers/track';

export interface Env {
  AIRSCORE_CACHE: KVNamespace;
  AIRSCORE_BASE_URL: string;
  CACHE_TTL_TASK: string;
  CACHE_TTL_TRACK: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS headers for browser requests
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    // Handle preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      let response: Response;

      if (url.pathname === '/api/airscore/task') {
        response = await handleTaskRequest(request, env, ctx);
      } else if (url.pathname === '/api/airscore/track') {
        response = await handleTrackRequest(request, env, ctx);
      } else {
        response = new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Add CORS headers to response
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(
        JSON.stringify({
          error: 'Internal server error',
          code: 'INTERNAL_ERROR',
        }),
        {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        }
      );
    }
  },
};
```

## Frontend Integration

### Usage in Analysis Tool

```typescript
// pages/src/analysis/airscore-client.ts

const AIRSCORE_API_BASE = '/api/airscore';  // Proxied through Pages

export interface AirScoreTaskData {
  task: XCTask;
  competition: CompetitionInfo;
  pilots: PilotResult[];
  formula: FormulaInfo;
}

export async function fetchAirScoreTask(
  comPk: number,
  tasPk: number
): Promise<AirScoreTaskData> {
  const response = await fetch(
    `${AIRSCORE_API_BASE}/task?comPk=${comPk}&tasPk=${tasPk}`
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to fetch task');
  }

  return response.json();
}

export async function fetchAirScoreTrack(
  trackId: string,
  comPk: number,
  tasPk: number
): Promise<string> {
  const response = await fetch(
    `${AIRSCORE_API_BASE}/track?trackId=${trackId}&comPk=${comPk}&tasPk=${tasPk}`
  );

  if (!response.ok) {
    throw new Error('Failed to fetch track');
  }

  return response.text();
}
```

### Command Menu Integration

Add AirScore import option to the command menu:

```typescript
// In command-menu.ts or similar
{
  id: 'import-airscore',
  name: 'Import from AirScore',
  description: 'Load task and tracks from AirScore competition',
  action: async () => {
    const comPk = await promptForInput('Competition ID (comPk)');
    const tasPk = await promptForInput('Task ID (tasPk)');

    const data = await fetchAirScoreTask(parseInt(comPk), parseInt(tasPk));

    // Store task
    await taskStorage.storeTask({
      id: `airscore-${comPk}-${tasPk}`,
      name: `${data.competition.name} - ${data.competition.taskName}`,
      task: data.task,
      rawJson: JSON.stringify(data),
      storedAt: Date.now(),
      lastAccessedAt: Date.now(),
    });

    // Load task into analysis view
    loadTask(data.task);
  }
}
```

## Deployment

### KV Namespace Setup

```bash
# Create production namespace
wrangler kv:namespace create AIRSCORE_CACHE

# Create preview namespace
wrangler kv:namespace create AIRSCORE_CACHE --preview
```

### Deploy

```bash
cd workers/airscore-api
npm install
npm run deploy
```

### Route Configuration

For integration with the main Pages site, configure a route in `wrangler.toml`:

```toml
routes = [
  { pattern = "taskscore.shonky.info/api/airscore/*", zone_name = "shonky.info" }
]
```

Or use Cloudflare Pages Functions to proxy to the worker.

## Testing

### Manual Testing

```bash
# Test task endpoint
curl "https://airscore-api.{account}.workers.dev/api/airscore/task?comPk=466&tasPk=2030"

# Test track endpoint
curl "https://airscore-api.{account}.workers.dev/api/airscore/track?trackId=43826&comPk=466&tasPk=2030"
```

### Unit Tests

```typescript
// workers/airscore-api/tests/transforms.test.ts
import { describe, it, expect } from 'vitest';
import { transformAirScoreTask, extractPilotResults } from '../src/transforms';

describe('transformAirScoreTask', () => {
  it('transforms waypoints to turnpoints correctly', () => {
    const airscoreData = { /* sample data */ };
    const result = transformAirScoreTask(airscoreData);

    expect(result.turnpoints).toHaveLength(9);
    expect(result.turnpoints[1].type).toBe('SSS');
    expect(result.turnpoints[7].type).toBe('ESS');
  });
});

describe('extractPilotResults', () => {
  it('parses HTML links from pilot data', () => {
    const data = [
      ['<b>1</b>', '199463', '<a href="tracklog_map.html?trackid=43826">Rory Duncan</a>',
       'AUS', 'Airborne REV 13.5', 'C', '15:00:00', '16:52:18', '1:52:18', '',
       80.47, 0, 0, 140.6, 859.4, '', 1000]
    ];

    const results = extractPilotResults(data);

    expect(results[0].name).toBe('Rory Duncan');
    expect(results[0].trackId).toBe('43826');
    expect(results[0].score).toBe(1000);
  });
});
```

## Files to Create

1. `workers/airscore-api/package.json`
2. `workers/airscore-api/tsconfig.json`
3. `workers/airscore-api/wrangler.toml`
4. `workers/airscore-api/src/index.ts`
5. `workers/airscore-api/src/types.ts`
6. `workers/airscore-api/src/cache.ts`
7. `workers/airscore-api/src/handlers/task.ts`
8. `workers/airscore-api/src/handlers/track.ts`
9. `workers/airscore-api/src/transforms/task.ts`
10. `workers/airscore-api/src/transforms/pilots.ts`
11. `pages/src/analysis/airscore-client.ts` (frontend integration)

## Verification Steps

1. [ ] Worker deploys successfully
2. [ ] Task endpoint returns valid JSON
3. [ ] Transformed XCTask loads in analysis view
4. [ ] Track endpoint returns valid IGC data
5. [ ] Caching works (second request faster, no upstream call)
6. [ ] CORS headers allow browser requests
7. [ ] Error responses include helpful messages
8. [ ] Pilot names and track IDs correctly extracted from HTML

## Future Enhancements

1. **Competition Discovery**: Add endpoint to list available competitions
2. **Pilot Search**: Search for a pilot's results across competitions
3. **Bulk Track Download**: Download all tracks for a task as a zip
4. **Webhook Notifications**: Notify when new results are available
5. **Live Results**: Support real-time updates during active competitions
