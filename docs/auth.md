# Authentication Architecture

Google OAuth authentication for GlideComp using Better Auth, Hono, and Cloudflare D1.

## Architecture

```
Browser                    Cloudflare
┌─────────────┐           ┌──────────────────────────────────────────┐
│ /u/{user}/  │──────────▶│ Pages Function (functions/api/auth/)     │
│ /onboarding │  /api/auth│       │ service binding                  │
│ /u/{user}/  │◀──────────│       ▼                                  │
│ /analysis   │           │ auth-api Worker (Hono + Better Auth)     │
└─────────────┘           │       ↕                                  │
                          │ D1 (taskscore-auth)                      │
                          └──────────────────────────────────────────┘
```

- **Pages Function** at `/api/auth/*` proxies requests to the auth-api worker via a [service binding](https://developers.cloudflare.com/pages/functions/bindings/#service-bindings) (see `functions/api/auth/[[path]].ts` and root `wrangler.toml`)
- **Auth worker** handles all auth logic (Hono + Better Auth + D1)
- **Frontend pages** served by Cloudflare Pages (static)
- **`/u/*`** rewritten to `dashboard.html` via `_redirects` (200 rewrite, URL preserved)

## OAuth Flow

```
1. User clicks "Login with Google" on index or dashboard
2. Better Auth client calls signIn.social({ provider: "google" })
3. Browser redirects to Google consent screen
4. Google redirects back to /api/auth/callback/google
5. Better Auth creates/updates user + session in D1, sets session cookie
6. Browser redirects to /u/me/ (callbackURL) which loads dashboard.html
7. dashboard.ts detects session:
   - Has username? → show dashboard
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
| Onboarding | `onboarding.html` + `onboarding.ts` | Username picker for new users |
| Dashboard | `dashboard.html` + `dashboard.ts` | Welcome page at `/u/{username}/`, shows Google sign-in if not authenticated |

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
| `BETTER_AUTH_URL` | `https://glidecomp.com` | `http://localhost:3000` |

### Google Cloud Console

1. Create OAuth 2.0 credentials in Google Cloud Console
2. Set authorized redirect URIs:
   - Production: `https://glidecomp.com/api/auth/callback/google`
   - Development: `http://localhost:3000/api/auth/callback/google`
   - **No entry needed for preview deployments** — handled by the oAuthProxy plugin (see below)

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

## Branch Preview Deployments

Auth works on preview deployments (e.g. `https://<hash>.glidecomp.pages.dev`) via two mechanisms:

### 1. Service Binding (routing)

Preview deployments can't use the production worker route (`glidecomp.com/api/auth/*`). Instead, a **Pages Function** at `functions/api/auth/[[path]].ts` proxies all `/api/auth/*` requests to the auth-api worker via a Cloudflare service binding. This works on every deployment — production and preview — because service bindings are internal Cloudflare routing, not domain-based.

The binding is configured in the root `wrangler.toml`:

```toml
[[services]]
binding = "AUTH_API"
service = "auth-api"
```

### 2. oAuthProxy Plugin (OAuth callbacks)

Google OAuth only has `glidecomp.com` registered as a redirect URI. When signing in from a preview deployment, the [oAuthProxy plugin](https://www.better-auth.com/docs/plugins/oauth-proxy) handles the flow:

1. Preview server initiates OAuth, but the callback goes to **production** (`glidecomp.com`)
2. Production exchanges the auth code for tokens and fetches user info
3. Production **encrypts** the profile and redirects back to the preview origin
4. Preview server decrypts, creates user/session locally, and sets the session cookie

This is configured in `web/workers/auth-api/src/auth.ts`:

```typescript
plugins: [
  oAuthProxy({
    productionURL: "https://glidecomp.com",
  }),
],
trustedOrigins: ["https://*.glidecomp.pages.dev"],
```

**Requirements:**
- All environments must share the same `BETTER_AUTH_SECRET` (the encryption key)
- Preview origins must be in `trustedOrigins` (wildcards supported)
- On production (`baseURL === productionURL`), the proxy is automatically disabled

### Branch deploys do NOT deploy workers

The `branch-deploy.yml` workflow only deploys Cloudflare Pages — it does **not** deploy the auth-api or airscore-api workers. Workers are only deployed from `master` via `deploy.yml`. This prevents branches from overwriting production workers with untested code.

## Deployment

```bash
# Deploy auth worker
bun run deploy:auth

# Deploy frontend (includes auth pages)
bun run deploy
```
