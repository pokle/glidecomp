# System Architecture Specification

## Overview

TaskScore is a client-heavy web application for analyzing hang gliding and paragliding competition track logs (IGC files) against defined tasks. The architecture prioritizes simplicity, minimal operational overhead, and generous free-tier usage.

## Architecture Diagram

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

## Components

### Cloudflare Pages (Frontend)

Static web application hosting the user interface.

**Public Features:**
- View competition tasks and turn points on a map
- Browse submitted flight track logs
- Analyze IGC files against tasks (client-side processing)
- View flight analysis results (events, distances, scores)

**Admin Features:**
- Create and manage competitions
- Define tasks with turn points and parameters
- Manage authorized pilot email list
- View submission statistics

### Email Worker

Receives and processes pilot track log submissions via email.

**Responsibilities:**
- Receive incoming emails at `submit@{domain}`
- Validate sender against authorized pilot list (D1 lookup)
- Parse email attachments using MIME parser (e.g., `postal-mime`)
- Validate attachment is a valid IGC file
- Store IGC file in R2 with appropriate metadata
- Record submission in D1 database
- Optionally send confirmation reply to pilot

**Email Processing Flow:**
1. Pilot emails IGC attachment to submission address
2. Email Worker receives the message
3. Extract sender email from headers
4. Query D1 to check if sender is authorized for any active competition
5. If unauthorized, reject (optionally notify sender)
6. Parse MIME content to extract attachments
7. Validate IGC file format
8. Generate unique filename and store in R2
9. Insert submission record in D1
10. Send confirmation email (optional)

### API Worker

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

### R2 Storage

Object storage for IGC track log files.

**Structure:**
```
/competitions/{competition_id}/flights/{submission_id}.igc
```

**Access:**
- Public read access for viewing/downloading flight logs
- Write access only via Email Worker and API Worker

### D1 Database

SQLite database for relational data.

**Tables:**
- `competitions` - Competition definitions
- `tasks` - Task definitions with turn points
- `pilots` - Authorized pilots with email addresses
- `flights` - Flight submissions with metadata

## Authentication Strategy

### Pilots (No Authentication Required)

Pilots are authorized via email whitelist, not traditional authentication.

- Admin adds pilot email addresses to competition
- Email Worker validates sender address against whitelist
- No login, passwords, or tokens for pilots
- Simple and friction-free for competition participants

### Admin Authentication

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

## Infrastructure Costs

All components operate within Cloudflare's free tier for typical competition usage.

| Component | Free Tier Allowance | Typical Usage |
|-----------|---------------------|---------------|
| Pages | Unlimited bandwidth | Static assets |
| Email Routing | Free | Receiving submissions |
| Workers | 100,000 requests/day | API + Email processing |
| R2 | 10 GB storage, 10M reads/month | IGC files (~100KB each) |
| D1 | 5 GB storage, 5M reads/day | Metadata queries |
| Access | 50 users | Admin auth (optional) |

## Design Principles

1. **Client-Heavy Processing** - IGC parsing and analysis runs in the browser, reducing backend complexity and costs

2. **Email as Interface** - Pilots submit via email, eliminating the need for user accounts and login flows

3. **Progressive Enhancement** - Start with static site, add Workers incrementally as needed

4. **Single Vendor** - All infrastructure on Cloudflare for operational simplicity

5. **Generous Free Tier** - Architecture designed to operate within free tier limits for small to medium competitions

## Future Considerations

- **Live Tracking** - Integration with live tracking services during competition
- **Scoring Engine** - Server-side scoring for official results
- **Multi-Tenant** - Support for multiple competition organizers
- **XContest Integration** - Import tasks directly from XContest
