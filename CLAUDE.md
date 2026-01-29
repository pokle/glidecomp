# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TaskScore is a web application for analyzing hanggliding/paragliding competition track logs (IGC files). Pilots submit flights via email, and the system provides task analysis, scoring explanations, and thermal location tracking.

## Architecture

Client-heavy serverless architecture on Cloudflare:

```
Pilots (email IGC) → Email Worker → R2 (storage) + D1 (database)
                           ↓
Frontend (Pages) ←→ API Worker ←→ R2 + D1
```

**Key Components:**
- **Cloudflare Pages** - Static frontend with client-side IGC parsing
- **Email Worker** - Receives submissions at `submit@{domain}`, validates senders, stores IGC files
- **API Worker** - RESTful API for CRUD operations
- **R2** - Content-addressed IGC storage (`/igc/{sha256}.igc`) + email archives
- **D1** - SQLite for pilots, competitions, tasks, submissions

**Design Principles:**
- No flight data lost - store every valid IGC, sort out associations later
- Email as interface - no user accounts for pilots
- Client-side processing - IGC parsing happens in browser
- Free tier focused - designed for Cloudflare free limits

## Build & Development

**Commands:**
```bash
npm install          # Install dependencies
npm run dev          # Local development server (Pages)
npm run typecheck    # TypeScript type checking (root project)
npm run typecheck:all # Type check everything (Pages + Workers)
npm run test         # Run tests with vitest
npm run deploy       # Manual deploy to Cloudflare Pages
npm run deploy:worker # Manual deploy AirScore API Worker
npm run deploy:all   # Deploy Pages + all Workers
```

**CI/CD:**
- GitHub Actions runs on every push
- Runs `typecheck:all` → tests → deploy (Pages + Workers)
- `master` branch deploys to production
- Other branches deploy to preview environments
- Worker deployment requires KV namespace setup (see Workers Development)

**URLs:**
- Production: https://taskscore.shonky.info (also https://taskscore.pages.dev)
- Preview: https://{branch}.taskscore.pages.dev

**Required Secrets (GitHub Actions):**
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID
- `CLOUDFLARE_API_TOKEN` - API token with Pages write access

## Workers Development

Workers are located in `/workers/` with each worker in its own subdirectory.

### AirScore API Worker (`workers/airscore-api`)

Caching proxy for the AirScore API that transforms task/track data for the analysis tool.

**Local Development:**
```bash
cd workers/airscore-api
npm install                    # Install worker dependencies
npm run dev                    # Start local worker at http://localhost:8787
```

**Testing Locally:**
```bash
# Test task endpoint (fetches and transforms AirScore data)
curl "http://localhost:8787/api/airscore/task?comPk=466&tasPk=2030"

# Test track endpoint (fetches IGC file)
curl "http://localhost:8787/api/airscore/track?trackId=43826"

# Test health/info endpoint
curl "http://localhost:8787/"
```

**Deploy to Cloudflare:**
```bash
cd workers/airscore-api

# First time: Create KV namespace for caching
wrangler kv:namespace create AIRSCORE_CACHE
wrangler kv:namespace create AIRSCORE_CACHE --preview

# Update wrangler.toml with the namespace IDs from above commands

# Deploy
npm run deploy
```

**Testing on Cloudflare:**
```bash
# Replace {worker-url} with your deployed worker URL
curl "https://airscore-api.{account}.workers.dev/api/airscore/task?comPk=466&tasPk=2030"
```

**Type Checking:**
```bash
cd workers/airscore-api
npm run typecheck
```

**Clear Local Cache:**
```bash
cd workers/airscore-api
npm run clear-cache  # Removes .wrangler/state (local KV data)
```

### Running Pages + Workers Together

For full local development with both Pages and Workers:

```bash
# Terminal 1: Start the worker
cd workers/airscore-api && npm run dev

# Terminal 2: Start the Pages dev server
npm run dev
```

The frontend's AirScore client (`pages/src/analysis/airscore-client.ts`) automatically connects to `localhost:8787` in development mode.

## Project Structure

```
/pages/                    - Cloudflare Pages frontend
  /public/                 - Static assets (HTML, CSS, etc.)
  /src/                    - TypeScript source
    /analysis/             - IGC analysis tool modules
      airscore-client.ts   - Client for AirScore API worker
/workers/                  - Cloudflare Workers
  /airscore-api/           - AirScore caching proxy (implemented)
    /src/                  - Worker source code
    wrangler.toml          - Worker configuration
/tests/                    - Test files
/specs/                    - Feature and architecture specifications
/explorations/             - Experimental code (NOT for production use)
```

## Key Data Model

- **Pilot** - Canonical identity (can have multiple emails)
- **Submission** - States: `unmatched` → `matched` → `entered`
- **IGC files** - Deduplicated by SHA-256 content hash

## Documentation Requirements

- All features documented as specifications at `specs/{feature}-spec.md`
- See `specs/system-architecture-spec.md` for detailed architecture

## Frontend UI

**Tailwind CSS + Basecoat:**
- Styling uses [Tailwind CSS](https://tailwindcss.com/) for utility-first CSS
- UI components use [Basecoat](https://basecoatui.com/) - a lightweight component library built on Tailwind
- Tailwind is configured via `@tailwindcss/vite` plugin in `vite.config.ts`
- Main stylesheet at `pages/src/styles.css` imports Tailwind, Basecoat, and MapBox GL CSS

**Setup:**
```css
/* pages/src/styles.css */
@import "tailwindcss";
@import "basecoat-css";
@import "mapbox-gl/dist/mapbox-gl.css";
```

**Common Basecoat components:**
- `btn`, `btn-primary`, `btn-secondary`, `btn-ghost` - Buttons
- `input` - Form inputs
- `alert` - Status messages
- `command`, `command-dialog` - Command menu (Cmd+K style)
- `badge` - Status badges

**Layout Pattern:**
- Analysis page uses a responsive sidebar + map layout
- Desktop: Fixed-width sidebar (320px) + full-width map
- Mobile: Collapsible sidebar that slides in from right, overlays map
- Header with hamburger menu (mobile) and command menu (gear icon)

**Map Provider:**
- MapBox GL JS exclusively (removed Leaflet, Google Maps, MapLibre)
- Configured via `VITE_MAPBOX_TOKEN` environment variable

## Coding Preferences

- MUST read library/tool documentation before use (Context7 tool, web docs)
- Decisions MUST be explainable - return explanations for scoring decisions, audit logs, and unit testing
- Place experimental code in `/explorations/` - never use in production
- Use Basecoat components for UI elements - prefer built-in components over custom implementations
- Before creating custom UI components, check https://basecoatui.com/docs/components for an appropriate Basecoat component
- Use Tailwind utility classes for styling - avoid custom CSS when Tailwind provides equivalent functionality

## Geographic Calculations

**Always use Turf.js via `geo.ts`** for any geographic/geometric calculations:

```typescript
import { haversineDistance, calculateBearing, destinationPoint, getBoundingBox, isInsideCylinder, getCirclePoints } from './geo';
```

**Available functions in `pages/src/analysis/geo.ts`:**
- `haversineDistance(lat1, lon1, lat2, lon2)` - Distance between two points in meters
- `calculateBearing(lat1, lon1, lat2, lon2)` - Bearing in degrees (-180 to 180)
- `calculateBearingRadians(lat1, lon1, lat2, lon2)` - Bearing in radians
- `destinationPoint(lat, lon, distanceMeters, bearingRadians)` - Point at distance/bearing from origin
- `getBoundingBox(fixes)` - Bounding box for array of lat/lon points
- `isInsideCylinder(lat, lon, centerLat, centerLon, radius)` - Point-in-cylinder test
- `getCirclePoints(centerLat, centerLon, radiusMeters, numPoints?)` - Generate circle polygon points for map rendering

**NEVER** implement inline haversine, bearing, or other geo math - always use the centralized `geo.ts` module which wraps Turf.js.
