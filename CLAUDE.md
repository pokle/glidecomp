# CLAUDE.md

## Project Overview

TaskScore is a web application for analyzing hanggliding/paragliding competition track logs (IGC files). It provides task analysis, scoring explanations, glide and thermal analysis.

## Architecture

Client-side application hosted on Cloudflare Pages. Currently **storage-free** — users load IGC track files and XCTask task files directly in the browser, with optional browser local storage for persistence.

```
Frontend (Cloudflare Pages) ← user loads IGC + task files via drag-and-drop or file picker
```

**Design Principles:**
- Client-side processing - IGC parsing and analysis happens entirely in the browser
- No server-side storage - all data lives in the user's browser (localStorage/IndexedDB)
- Free tier focused - designed for Cloudflare free limits

**Future Roadmap:**
- Email-based IGC submission (Email Worker → R2 storage + D1 database)
- Server-side API Worker for competition/task management
- Pilot accounts and competition organization

## Build & Development

If `node_modules/` is missing or a dependency can't be resolved, run `bun install` before proceeding. Build commands are in `package.json` scripts. Key ones: `bun run dev`, `bun run test`, `bun run typecheck:all`.

**Production:** https://taskscore.shonky.info

## Coding Rules

- Decisions MUST be explainable - return explanations for scoring decisions and support unit testing
- Use [Basecoat](https://basecoatui.com/) components for UI - check https://basecoatui.com/docs/components before creating custom components
- Use Tailwind utility classes for styling - avoid custom CSS when Tailwind provides equivalent functionality
- **Never** implement inline geo math (distance, bearing, etc.) - always use `web/engine/src/geo.ts` which provides WGS84 ellipsoid formulas (Andoyer-Lambert distance, Vincenty direct destination) and Turf.js for bearing/bbox
- **Single source of truth for map visuals/interactions**: [`docs/mapbox-interactions-spec.md`](docs/mapbox-interactions-spec.md) - all map providers must match this spec
