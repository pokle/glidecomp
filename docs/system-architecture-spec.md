# System Architecture Specification

## Overview

TaskScore is a client-heavy web application for analyzing hang gliding and paragliding competition track logs (IGC files) against defined tasks. The architecture prioritizes simplicity, minimal operational overhead, and generous free-tier usage.

## Current Architecture

TaskScore is currently a **storage-free, client-side application** hosted on Cloudflare Pages. Users load IGC track files and XCTask task files directly in the browser via drag-and-drop or file picker. Browser local storage (IndexedDB) provides optional persistence.

```
┌─────────────────────────────────────┐
│         Cloudflare Pages            │
│   Static frontend application       │
│                                     │
│   - Load IGC files (drag & drop)    │
│   - Load task files (.xctsk)        │
│   - Client-side IGC analysis        │
│   - Map visualization               │
│   - Browser local storage           │
└─────────────────────────────────────┘
       ▲
       │
   User loads files
   via browser
```

### Cloudflare Pages (Frontend)

Static web application hosting the user interface.

**Features:**
- Load IGC track files and XCTask task files via drag-and-drop or file picker
- View competition tasks and turn points on a map
- Analyze IGC files against tasks (client-side processing)
- View flight analysis results (events, distances, scores)
- Store loaded tracks and tasks in browser local storage (IndexedDB)

### AirScore Caching Proxy (Worker)

The only current Worker is a caching proxy for AirScore API requests (`web/workers/`).

## Design Principles

1. **Client-Heavy Processing** - IGC parsing and analysis runs entirely in the browser, reducing backend complexity and costs

2. **Storage-Free** - No server-side storage; all data lives in the user's browser

3. **Progressive Enhancement** - Start with static site, add Workers incrementally as needed

4. **Single Vendor** - All infrastructure on Cloudflare for operational simplicity

5. **Generous Free Tier** - Architecture designed to operate within free tier limits

## Infrastructure Costs

Currently minimal — only Cloudflare Pages (free tier).

| Component | Free Tier Allowance | Current Usage |
|-----------|---------------------|---------------|
| Pages | Unlimited bandwidth | Static assets |

---

## Future Roadmap

The following components are planned but **not yet implemented**.

### Planned Architecture

```
                                 ┌─────────────────────────────────┐
                                 │        Cloudflare Pages         │
                                 │   - Public: view flights/tasks  │
                                 │   - Admin: manage competitions  │
                                 └────────────────┬────────────────┘
                                                  │
       ┌──────────────────────────────────────────┼───────────────┐
       │                                          │               │
       ▼                                          ▼               ▼
┌─────────────────┐    ┌─────────────────┐   ┌─────────┐   ┌─────────┐
│  Email Worker   │    │   API Worker    │   │   R2    │   │   D1    │
│                 │───▶│                 │──▶│ Storage │   │   DB    │
│ - Receive email │    │ - CRUD tasks    │   │ (IGCs)  │   │         │
│ - Check sender  │    │ - List flights  │   └─────────┘   │ - Pilots│
│ - Parse IGC     │    │ - Admin auth    │                 │ - Tasks │
│ - Store to R2   │    └─────────────────┘                 │ - Comps │
└─────────────────┘                                        └─────────┘
       ▲
       │
   pilot@email
   sends IGC
```

### Email Worker (Future)

Will receive and process pilot track log submissions via email.

**Planned Responsibilities:**
- Receive incoming emails at `submit@{domain}`
- Archive raw email to R2 (audit trail)
- Validate sender against authorized pilot list (D1 lookup)
- Parse email attachments using MIME parser (e.g., `postal-mime`)
- Validate attachment is a valid IGC file
- Store IGC file in R2 with appropriate metadata
- Record submission in D1 database
- Send confirmation reply to pilot
- Forward errors/failures to admin inbox for review

**Planned Email Processing Flow:**
1. Pilot emails IGC attachment to submission address
2. Email Worker receives the message
3. **Archive raw email to R2** (always, before any processing)
4. Extract sender email from headers
5. Parse MIME content to extract attachments
6. Validate IGC file format
7. **Compute SHA-256 hash** of IGC file content
8. **Check if hash exists** in `igc_files` table
9. **Always store IGC file** - if new, store at `/igc/{hash}.igc` in R2 and insert into `igc_files`
10. **Look up sender email** in `pilot_emails` table
11. **Always create submission record** with sender email, IGC hash, and pilot_id (if found)
12. If pilot found: check `pilot_competitions` for active competitions
13. If entered in competition: link submission to competition, status = `entered`, send success confirmation
14. If pilot found but not in competition: status = `matched`, notify pilot flight is stored
15. If pilot not found: status = `unmatched`, **forward to admin inbox**, notify sender their flight is stored but not yet linked to a pilot
16. Log metadata to D1 (links to raw email archive)

**Email Archival Strategy:**

Cloudflare Email Workers do not store emails after processing - they are discarded once the Worker completes. To maintain an audit trail and allow manual review:

1. **Always archive raw email to R2** - Store the complete `.eml` file before any processing, ensuring nothing is lost even if processing fails
2. **Forward failures to admin inbox** - Unauthorized senders, invalid attachments, and processing errors are forwarded to the admin's email for human review
3. **Log metadata to D1** - Each submission record links to its raw email archive for later retrieval

### API Worker (Future)

RESTful API for frontend operations and admin functions.

**Public Endpoints:**
- `GET /competitions` - List competitions
- `GET /competitions/:id/tasks` - Get tasks for a competition
- `GET /competitions/:id/flights` - List submitted flights
- `GET /flights/:id` - Get flight details and IGC file URL

**Admin Endpoints (authenticated):**
- `POST /competitions` - Create competition
- `PUT /competitions/:id` - Update competition
- `POST /competitions/:id/tasks` - Create task
- `POST /competitions/:id/pilots` - Add authorized pilots
- `DELETE /pilots/:id` - Remove pilot authorization

### R2 Storage (Future)

Object storage for IGC track log files and email archives.

**Structure:**
```
/igc/{sha256}.igc          # Content-addressed IGC storage
/emails/{timestamp}-{from}.eml
```

**Access:**
- Public read access for viewing/downloading flight logs
- Private access for email archives (admin only)
- Write access only via Email Worker and API Worker

**IGC Deduplication:**

IGC files are stored using content-addressing (SHA-256 checksum as filename):

1. On submission, compute SHA-256 hash of IGC file content
2. Check if `/igc/{hash}.igc` already exists in R2
3. If exists, skip upload (file already stored)
4. If new, store file at `/igc/{hash}.igc`
5. Flight submission record references the hash

Benefits:
- Re-submissions don't create duplicates
- Same flight submitted to multiple competitions shares one file
- Hash serves as unique identifier and integrity check
- Storage costs minimized

### D1 Database (Future)

SQLite database for relational data.

**Tables:**
- `competitions` - Competition definitions
- `tasks` - Task definitions with turn points
- `pilots` - Pilot records (name, ID, etc.) - the canonical identity
- `pilot_emails` - Email addresses linked to pilots (many-to-one)
- `pilot_competitions` - Pilots registered for competitions (many-to-many)
- `igc_files` - IGC file registry (hash, original filename, upload date, size)
- `submissions` - Flight submissions storing: sender email, IGC hash, pilot_id (nullable), competition_id (nullable)

**Key Concept: Pilot is the Identity**

- A pilot can have multiple email addresses (e.g., personal, work, old address)
- Email addresses can be added or changed over time
- IGC files are ultimately associated with the pilot, not the email
- The sender email is always recorded for audit, but the pilot linkage is what matters

**Submission States:**
- `unmatched` - IGC stored, sender email not recognized
- `matched` - IGC linked to a pilot (via email lookup)
- `entered` - IGC linked to pilot AND a specific competition

**Email-to-Pilot Resolution:**

When a submission arrives:
1. Look up sender email in `pilot_emails`
2. If found → link submission to that pilot
3. If not found → submission remains `unmatched`, awaiting admin action

**Late Registration / Email Addition Flow:**

When admin adds an email address to a pilot:
1. Insert into `pilot_emails`
2. Query `submissions` for any `unmatched` entries from that email
3. Update those submissions to link to the pilot
4. If pilot is registered for competitions, check if submissions should be entered
5. Notify pilot of any newly linked flights

### Authentication (Future)

#### Pilots (No Authentication Required)

Pilots will be authorized via email whitelist, not traditional authentication.

- Admin adds pilot email addresses to competition
- Email Worker validates sender address against whitelist
- No login, passwords, or tokens for pilots
- Simple and friction-free for competition participants

#### Admin Authentication

Single admin user (competition organizer) with secure access to management features.

**Options (in order of recommendation):**

1. **Cloudflare Access** (Recommended)
   - Zero Trust authentication
   - Lock admin routes behind identity provider (Google, GitHub, etc.)
   - Free for up to 50 users
   - No code changes required for auth logic

2. **Simple Bearer Token**
   - Secret token stored in Worker environment variables
   - Pass token in `Authorization` header
   - Suitable for single admin user

3. **Magic Link**
   - Admin requests login link via email
   - Time-limited token sent to admin email
   - Click link to establish session

### Planned Infrastructure Costs

All planned components would operate within Cloudflare's free tier for typical competition usage.

| Component | Free Tier Allowance | Typical Usage |
|-----------|---------------------|---------------|
| Pages | Unlimited bandwidth | Static assets |
| Email Routing | Free | Receiving submissions |
| Workers | 100,000 requests/day | API + Email processing |
| R2 | 10 GB storage, 10M reads/month | IGC files (~100KB) + email archives |
| D1 | 5 GB storage, 5M reads/day | Metadata queries |
| Access | 50 users | Admin auth (optional) |

### Design Principles for Future Backend

1. **No Flight Data Lost** - Every valid IGC file is stored, regardless of pilot registration status. Administrative issues (late registration, typos in email) must never cause flight data to be discarded. Sorting out associations can happen later.

2. **Email as Interface** - Pilots submit via email, eliminating the need for user accounts and login flows

### Other Future Considerations

- **Live Tracking** - Integration with live tracking services during competition
- **Scoring Engine** - The CIVL GAP scoring engine (`web/engine/src/gap-scoring.ts`) currently runs client-side and via CLI; future work may add server-side scoring for official results
- **Multi-Tenant** - Support for multiple competition organizers
- **XContest Integration** - Import tasks directly from XContest
