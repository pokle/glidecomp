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

**Shoelace Web Components:**
- All UI components use [Shoelace](https://shoelace.style/) web components
- Load via CDN in HTML files:
  ```html
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.20.1/cdn/themes/dark.css" />
  <script type="module" src="https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.20.1/cdn/shoelace-autoloader.js"></script>
  ```
- Use dark theme: add `class="sl-theme-dark"` to `<html>` element
- Use Shoelace design tokens for styling (`--sl-color-*`, `--sl-spacing-*`, `--sl-font-*`)
- Common components: `sl-button`, `sl-input`, `sl-dropdown`, `sl-menu`, `sl-switch`, `sl-alert`, `sl-drawer`

**Design Pattern:**
- VicEmergency-style layout for analysis page: central map + side panel for events
- View mode toggle (List / Map / Both) controls layout
- Responsive: desktop shows side panel, mobile uses drawer

## Coding Preferences

- MUST read library/tool documentation before use (Context7 tool, web docs)
- Decisions MUST be explainable - return explanations for scoring decisions, audit logs, and unit testing
- Place experimental code in `/explorations/` - never use in production
- Use Shoelace components for all UI elements - avoid custom CSS when Shoelace provides equivalent functionality
