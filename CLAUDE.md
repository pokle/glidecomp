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
npm run typecheck    # TypeScript type checking
npm run test         # Run tests with vitest
npm run deploy       # Manual deploy to Cloudflare Pages
```

**CI/CD:**
- GitHub Actions runs on every push
- Runs typecheck → tests → deploy
- `master` branch deploys to production
- Other branches deploy to preview environments

**URLs:**
- Production: https://taskscore.shonky.info (also https://taskscore.pages.dev)
- Preview: https://{branch}.taskscore.pages.dev

**Required Secrets (GitHub Actions):**
- `CLOUDFLARE_ACCOUNT_ID` - Cloudflare account ID
- `CLOUDFLARE_API_TOKEN` - API token with Pages write access

## Project Structure

```
/pages/           - Cloudflare Pages frontend
  /public/        - Static assets (HTML, CSS, etc.)
  /src/           - TypeScript source
/workers/         - Cloudflare Workers (Email, API)
/tests/           - Test files
/specs/           - Feature and architecture specifications
/explorations/    - Experimental code (NOT for production use)
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
- Mobile: Collapsible sidebar that slides in from left, overlays map
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
import { haversineDistance, calculateBearing, destinationPoint, getBoundingBox, isInsideCylinder } from './geo';
```

**Available functions in `pages/src/analysis/geo.ts`:**
- `haversineDistance(lat1, lon1, lat2, lon2)` - Distance between two points in meters
- `calculateBearing(lat1, lon1, lat2, lon2)` - Bearing in degrees (-180 to 180)
- `calculateBearingRadians(lat1, lon1, lat2, lon2)` - Bearing in radians
- `destinationPoint(lat, lon, distanceMeters, bearingRadians)` - Point at distance/bearing from origin
- `getBoundingBox(fixes)` - Bounding box for array of lat/lon points
- `isInsideCylinder(lat, lon, centerLat, centerLon, radius)` - Point-in-cylinder test

**NEVER** implement inline haversine, bearing, or other geo math - always use the centralized `geo.ts` module which wraps Turf.js.
