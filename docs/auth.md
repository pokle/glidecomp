# Authentication Architecture

Google OAuth authentication for TaskScore using Better Auth, Hono, and Cloudflare D1.

## Architecture

```
Browser                    Cloudflare
┌─────────────┐           ┌──────────────────────┐
│ /login.html │──────────▶│ auth-api Worker       │
│ /onboarding │  /api/auth│ (Hono + Better Auth)  │
│ /u/{user}/  │◀──────────│        ↕              │
│ /analysis   │           │   D1 (taskscore-auth) │
└─────────────┘           └──────────────────────┘
```

- **Auth worker** at `taskscore.shonky.info/api/auth/*` (same origin, so cookies work)
- **Frontend pages** served by Cloudflare Pages (static)
- **`/u/*`** rewritten to `dashboard.html` via `_redirects` (200 rewrite, URL preserved)

## OAuth Flow

```
1. User clicks "Sign in with Google" on /login.html
2. Better Auth client calls signIn.social({ provider: "google" })
3. Browser redirects to Google consent screen
4. Google redirects back to /api/auth/callback/google
5. Better Auth creates/updates user + session in D1, sets session cookie
6. Browser redirects to /login.html (callbackURL)
7. login.ts detects session:
   - Has username? → redirect to /u/{username}/
   - No username?  → redirect to /onboarding.html
8. User picks a username on onboarding page
9. POST /api/auth/set-username → redirect to /u/{username}/
```

## Components

### Auth Worker (`web/workers/auth-api/`)

| File | Purpose |
|------|---------|
| `src/index.ts` | Hono app with CORS, `/me`, `/set-username`, and Better Auth catch-all |
| `src/auth.ts` | Better Auth config: Kysely D1 dialect, Google social provider, username field |
| `src/db/schema.sql` | D1 schema: `user`, `session`, `account`, `verification` tables |
| `wrangler.toml` | D1 binding, route config, env vars |

### Frontend Auth (`web/frontend/src/auth/`)

| File | Purpose |
|------|---------|
| `auth/client.ts` | Better Auth client SDK + helper functions (`signInWithGoogle`, `signOut`, `getCurrentUser`, `setUsername`) |

### Frontend Pages

| Page | File | Purpose |
|------|------|---------|
| Sign in | `login.html` + `login.ts` | Google sign-in button, redirects if already authenticated |
| Onboarding | `onboarding.html` + `onboarding.ts` | Username picker for new users |
| Dashboard | `dashboard.html` + `dashboard.ts` | Welcome page at `/u/{username}/`, links to analysis |

### API Endpoints

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/api/auth/me` | No | Returns `{ user }` or `{ user: null }` |
| POST | `/api/auth/set-username` | Yes | Sets username (3-20 chars, `[a-zA-Z0-9-]`) |
| ALL | `/api/auth/*` | — | Better Auth handles sign-in, callback, sign-out, session |

## Configuration

### Cloudflare Secrets (Production)

Secrets are scoped to the `auth-api` worker. The worker must be deployed first before secrets can be set.

```bash
# 1. Deploy the worker (creates it on Cloudflare)
cd web/workers/auth-api
bun run wrangler deploy

# 2. Set secrets (each prompts for the value interactively)
bun run wrangler secret put GOOGLE_CLIENT_ID
bun run wrangler secret put GOOGLE_CLIENT_SECRET
bun run wrangler secret put BETTER_AUTH_SECRET

# 3. Re-deploy to pick up the secrets
bun run wrangler deploy
```

| Secret | Description |
|--------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 client secret |
| `BETTER_AUTH_SECRET` | Random secret for signing sessions/tokens (generate with `openssl rand -base64 32`) |

### Environment Variables

Set in `wrangler.toml` (production) or `.dev.vars` (local dev override):

| Variable | Production Value | Dev Value |
|----------|-----------------|-----------|
| `BETTER_AUTH_URL` | `https://taskscore.shonky.info` | `http://localhost:3000` |

### Google Cloud Console

1. Create OAuth 2.0 credentials in Google Cloud Console
2. Set authorized redirect URIs:
   - Production: `https://taskscore.shonky.info/api/auth/callback/google`
   - Development: `http://localhost:3000/api/auth/callback/google`

### D1 Database

```bash
cd web/workers/auth-api

# Create database (only needed once)
bun run wrangler d1 create taskscore-auth
# Copy database_id into wrangler.toml

# Apply schema to remote (production)
bun run wrangler d1 execute taskscore-auth --remote --file=src/db/schema.sql

# Apply schema to local (development)
bun run wrangler d1 execute taskscore-auth --local --file=src/db/schema.sql
```

### Node.js Compatibility

The auth worker requires `nodejs_compat` in `wrangler.toml` because Better Auth uses `node:async_hooks`. This is already configured:

```toml
compatibility_flags = ["nodejs_compat"]
```

## Local Development

```bash
# Terminal 1: Auth worker on port 8788
bun run dev:auth

# Terminal 2: Frontend on port 3000 (proxies /api/auth → 8788)
bun run dev
```

The Vite dev server proxies `/api/auth` requests to the auth worker, so cookies work on the same origin.

### First-time local setup

1. Create `.dev.vars` in `web/workers/auth-api/`:

```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
BETTER_AUTH_SECRET=your-random-secret
BETTER_AUTH_URL=http://localhost:3000
```

2. Apply the D1 schema locally:

```bash
cd web/workers/auth-api
bun run wrangler d1 execute taskscore-auth --local --file=src/db/schema.sql
```

## Tech Stack

| Component | Library | Why |
|-----------|---------|-----|
| Auth | [Better Auth](https://www.better-auth.com/) | TypeScript-first, supports social providers, runs on edge |
| Web framework | [Hono](https://hono.dev/) | Lightweight, Cloudflare Workers native |
| Database | Cloudflare D1 | Serverless SQLite, no external DB needed |
| DB adapter | Kysely + kysely-d1 | Better Auth's built-in Kysely adapter with D1 dialect |
| Auth client | `better-auth/client` | Tree-shakeable client SDK for browser |

## Deployment

```bash
# Deploy auth worker
bun run deploy:auth

# Deploy frontend (includes auth pages)
bun run deploy
```
