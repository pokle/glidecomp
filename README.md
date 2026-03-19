# TaskScore

Helps you analyse hanggliding / paragliding competition tasks.

For pilots and scorers, it provides:

- Detailed analysis of flight performance
  - Explains scores
  - Task segments encountered
  - Re-flies
- Thermals encountered during the task:
- Where pilots found their first thermal (left or right of the launch hill?)
- Was the valley working for the task?
- Aggregate statistics for the entire task, such as information about how many bombed out, reached goal, landed out etc.

Tasks can be loaded from XContest, or other sources such as a QR code.

Maps can be annotated with information that is used during analysis. For example, if you mark segments near the launch hill (e.g. left spine, front bowl), then analysis will be able to tell if the first thermal was found in one of those segments (e.g. most pilots found their first thermal in the front bowl).

Example of flight analysis:

- 12:30pm launched in tp ELLIOT
- 12:35pm found first thermal in the front bowl
- 1:05pm exited start tp ELLIOT at 7000ft from behind the hill.
- 1:10pm re-entered start tp ELLIOT
- 1:15pm exited start tp ELLIOT
- 1:20pm low save
- 1:30pm tagged tp TOWONG
- 1:40pm landed in bombout paddock, 7km from NCORGL (30 bombout points)

In the last example, it's useful to know the distance to the next waypoint in the task set.

## Web Development

### Prerequisites

- [Bun](https://bun.sh/) (also requires Node.js 20+)
- A [MapBox](https://www.mapbox.com/) access token (for the map)

### Setup

```bash
bun install

# Copy .env.example and add your MapBox token
cp .env.example .env
# Edit .env and set VITE_MAPBOX_TOKEN=your_token_here
```

### Running locally

Start the frontend and auth worker together (http://localhost:3000 + http://localhost:8788):

```bash
bun run dev
```

This starts both the Vite dev server and the auth API worker. The auth worker requires a `.dev.vars` file in `web/workers/auth-api/` — see [docs/auth.md](docs/auth.md) for setup.

To start only the frontend (without auth):

```bash
bun run dev:frontend
```

To use AirScore features, also start the AirScore API worker (http://localhost:8787) in a separate terminal:

```bash
bun run --filter airscore-api dev
```

The frontend automatically detects the local worker. If you'd rather skip the worker and use the production API instead:

```bash
VITE_AIRSCORE_URL=https://taskscore.shonky.info/api/airscore bun run dev
```

### Tests and type checking

```bash
bun run test             # Run tests
bun run typecheck        # Type check root project
bun run typecheck:all    # Type check everything (frontend + engine + workers)
```

### Chrome MCP server set up

Read https://developer.chrome.com/blog/chrome-devtools-mcp-debug-your-browser-session

### Deployment

- Push to `master` → deploys to production
- Push to other branches → deploys to preview URL

```bash
bun run deploy           # Manual deploy to Cloudflare Pages
bun run deploy:worker    # Manual deploy AirScore API Worker
bun run deploy:all       # Deploy Pages + all Workers
```

**URLs:**
- Production: https://taskscore.shonky.info
- Previews: https://{branch}.taskscore.pages.dev

### CLI Scripts

**detect-events** - Detect flight events from an IGC file, outputting CSV:

```bash
bun run detect-events -- <flight.igc> [task.xctsk]

# Example with sample data
bun run detect-events -- \
  web/frontend/public/data/tracks/2025-01-05-Tushar-Corryong.igc \
  web/frontend/public/data/tasks/buje.xctsk
```

**get-xcontest-task** - Download a task from XContest by code:

```bash
bun run get-xcontest-task -- face
bun run get-xcontest-task -- --file task.json
```

**score-task** - Score multiple pilots against a task using CIVL GAP (FAI Sporting Code Section 7F):

```bash
bun run score-task <task.xctsk> <igc-file-or-folder>... [options]

# Options:
#   --scoring <PG|HG>         Sport type (default: PG)
#   --nominal-distance <m>    Nominal distance in meters (default: 70% of task distance)
#   --nominal-goal <ratio>    Nominal goal ratio 0-1 (default: 0.2)
#   --nominal-time <s>        Nominal time in seconds (default: 5400)
#   --min-distance <m>        Minimum distance in meters (default: 5000)
#   --no-leading              Disable leading (departure) points
#   --no-arrival              Disable arrival points
#   --json                    Output as JSON

# Example: score Corryong Cup 2026 Task 1 (HG, no leading/arrival)
bun run score-task \
  web/engine/tests/fixtures/corryong-cup-2026-t1/task.xctsk \
  web/engine/tests/fixtures/corryong-cup-2026-t1/ \
  --scoring HG --no-leading --no-arrival \
  --nominal-distance 35000 --nominal-goal 0.3
```

Example output:

```
=== Task Scoring Results (CIVL GAP) ===

Task distance:    73.9 km
Pilots:           32 flying / 32 present
In goal:          12 (37.5%)
Best time:        1:37:43

Task Validity:    100.0%
Available Points: 1000 (dist: 486, time: 514, lead: 0, arr: 0)

   #  Pilot                            Dist        Time   Dist Pts   Time Pts   Lead Pts    Arr Pts    Total
------------------------------------------------------------------------------------------------------------
   1  Jon Durand                    73.9 km     1:37:43      485.6      514.4        0.0        0.0     1000
   2  Rohan Holtkamp                73.9 km     1:46:05      485.6      386.9        0.0        0.0      872
   3  Peter  Burkitt                73.9 km     1:49:00      485.6      358.8        0.0        0.0      844
  ...
  13  Rich Reinauer                 72.0 km           -      473.1        0.0        0.0        0.0      473
  ...
  29  Rennick Kerr                   5.0 km           -       32.9        0.0        0.0        0.0       33
```

## Project Structure

```
web/
  frontend/              - Cloudflare Pages frontend (Vite + TypeScript)
  engine/                - Shared analysis library (IGC parsing, event detection, GAP scoring)
    cli/                 - CLI utilities (detect-events, get-xcontest-task, score-task)
  workers/
    auth-api/            - Authentication API (Cloudflare Worker + D1)
    airscore-api/        - AirScore caching proxy (Cloudflare Worker)
  scripts/               - Operational scripts (secrets, test emails)
docs/                    - Feature and architecture specifications
```
