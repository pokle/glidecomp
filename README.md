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

Start the frontend dev server (http://localhost:3000):

```bash
bun run dev
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
bun run detect-events -- <flight.igc> [task.xctask]

# Example with sample data
bun run detect-events -- \
  web/frontend/public/data/tracks/2025-01-05-Tushar-Corryong.igc \
  web/frontend/public/data/tasks/buje.xctask
```

**get-xcontest-task** - Download a task from XContest by code:

```bash
bun run get-xcontest-task -- face
bun run get-xcontest-task -- --file task.json
```

## Project Structure

```
web/
  frontend/              - Cloudflare Pages frontend (Vite + TypeScript)
  engine/                - Shared analysis library (IGC parsing, event detection)
    cli/                 - CLI utilities (detect-events, get-xcontest-task)
  workers/
    airscore-api/        - AirScore caching proxy (Cloudflare Worker)
  scripts/               - Operational scripts (secrets, test emails)
docs/                    - Feature and architecture specifications
explorations/            - Experimental code (not for production use)
```
