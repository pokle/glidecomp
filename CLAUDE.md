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

## Frontend Styling

The frontend uses **Tailwind CSS v4** with **DaisyUI** components. Use these instead of writing custom CSS.

**Key files:**
- `/pages/src/app.css` - Tailwind + DaisyUI imports, global styles
- `/pages/src/analysis/analysis.css` - Analysis-specific custom styles only

**Component examples:**
```html
<!-- Buttons -->
<button class="btn btn-primary">Primary</button>
<button class="btn btn-ghost">Ghost</button>

<!-- Inputs with button -->
<div class="join">
  <input class="input input-bordered join-item" placeholder="Search...">
  <button class="btn btn-primary join-item">Go</button>
</div>

<!-- Cards -->
<div class="card bg-base-200">
  <div class="card-body">
    <h2 class="card-title">Title</h2>
    <p>Content</p>
  </div>
</div>

<!-- Checkboxes/Toggles -->
<label class="label cursor-pointer gap-2">
  <input type="checkbox" class="checkbox checkbox-sm">
  <span class="label-text">Option</span>
</label>
```

**Theme:** Uses DaisyUI's `dark` theme (`data-theme="dark"` on `<html>`).

## Coding Preferences

- MUST read library/tool documentation before use (Context7 tool, web docs)
- Decisions MUST be explainable - return explanations for scoring decisions, audit logs, and unit testing
- Place experimental code in `/explorations/` - never use in production
- Use Tailwind/DaisyUI classes instead of custom CSS for UI components
