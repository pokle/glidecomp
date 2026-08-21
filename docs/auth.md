# Authentication Architecture

Authentication for GlideComp using Better Auth, Hono, and Cloudflare D1. Two
sign-in methods run in production: **Google OAuth** and **passwordless email
OTP** (a 6-digit code emailed to the address you type). Email+password exists
only in local dev, to back the `dev-login` endpoint the e2e suite uses.

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
- **`/u/*`** (and the other main-UI routes) rewritten to `/` — the React SPA entry — via `_redirects` (200 rewrite, URL preserved)

## OAuth Flow

```
1. User clicks "Login with Google" on index or dashboard
2. Better Auth client calls signIn.social({ provider: "google" })
3. Browser redirects to Google consent screen
4. Google redirects back to /api/auth/callback/google
5. Better Auth creates/updates user + session in D1, sets session cookie.
   On user *creation* a databaseHooks.user.create.before hook (src/auth.ts)
   auto-derives a unique username from the display name (falling back to the
   email local-part, then "pilot") — see src/username.ts. So new users always
   have a username; there is no manual pick-a-username step.
6. Browser redirects to /comp (callbackURL) which loads the React SPA competitions page
7. The SPA shows competitions straight away (username already set).
```

## The onboarding gate

`needsOnboarding(user)` in `web/frontend/src/auth/client.ts` is the ONE
definition, asked by the Shell, the dashboard, the analysis page and the
onboarding page itself. An account is onboarded once it has **both** a username
and a display name:

- **No username** — a legacy pre-derivation account. Google sign-ups have had
  one derived since #349.
- **No name** — an email-OTP sign-up. Better Auth's email-otp route has no name
  to work from and creates the account with `name: ""`; the derive hook still
  runs, but with an empty name slug it falls through to the email local-part.
  Onboarding is the only place that ever asks for a display name, so gating on
  the username alone left every email account nameless, wearing a handle guessed
  off their address.

Onboarding prefills the derived username (re-submitting your own is a no-op, not
a "taken" rejection) and sends username + name together to POST
`/api/auth/set-username`, which writes both in one statement — half of the pair
would bounce the user straight back in.

### Two display names, one write path

`"user".name` is the ACCOUNT's name — what /api/auth/me answers, and so what
the account menu, the static Astro chrome (via the `glidecomp:account`
localStorage hint) and the audit log's `actor_name` all show. `pilot.name` is
the PILOT PROFILE's, seeded from the account at first sign-in and shown in
scores tables, on the roster and on the report card.

They are separate columns, and only competition-api's PATCH `/api/comp/pilot`
writes the second. That handler therefore writes the FIRST as well, by calling
POST `/api/auth/set-name` over the service binding before it touches its own
rows — forwarding the caller's own credential, so auth-api resolves the session
and renames that account and no other. The account write goes first because it
is the hop that can fail on its own; a failure returns 503 with nothing saved,
rather than a profile renamed and an account left behind.

The hop is skipped when the submitted name already equals the account's, so
Settings resubmitting every field on every save costs nothing — and a save by
an account that drifted apart before this existed quietly puts the two back in
step.

Until this existed (issue #539), the account name was written only at sign-up
and by onboarding: editing your display name in Settings moved the profile and
left the account holding the sign-up name for good, so an organiser who
corrected their name still signed every later entry of a competition's public
transparency record with the old one. `audit_log.actor_name` is denormalised on
purpose and is NOT backfilled — a rename changes what gets written next, not
what was recorded then.

## Email OTP Flow

Pilots who have no Google account (or don't want to use it) sign in with a
one-time code. This is the Better Auth [`emailOTP`](https://www.better-auth.com/docs/plugins/email-otp)
plugin, configured in `src/auth.ts` — 6-digit codes, `expiresIn: 600` (10
minutes), 3 attempts per code, and `storeOTP: "hashed"` so the D1 row is
useless if leaked. Full design and rationale: [2026-07-14-email-otp-signin-plan.md](./2026-07-14-email-otp-signin-plan.md).

```
1. User types their email on the sign-in page
2. POST /api/auth/email-otp/send-verification-otp (Better Auth handler)
3. The worker's sendVerificationOTP hook builds the message with
   src/otp-email.ts and sends it via the Cloudflare Email Sending binding
   (`[[send_email]] name = "EMAIL"` in wrangler.toml), off the response's
   latency path with ctx.waitUntil
4. User enters the 6 digits → POST /api/auth/sign-in/email-otp
5. Better Auth creates/updates the user + session exactly as the OAuth flow
   does — same auto-derived username hook, same session cookie
6. A brand-new account has no display name (nothing in this flow asks for
   one), so the SPA sends it to /onboarding — see the onboarding gate above
```

Only `type: "sign-in"` codes are ever sent; the plugin's password-reset and
email-change endpoints are inert because `emailAndPassword` is disabled outside
local dev. In local dev nothing is emailed at all — the code is logged and
readable via `GET /api/auth/dev-last-otp`.

**Rate limits** — three layers, with every constant in `src/rate-limit.ts` as
the single source of truth (the API-key limit in the same file is quoted by
`docs/api.md` and pinned by `e2e/api-doc.spec.ts`, so the doc can't drift from
what the worker enforces):

| Layer | Limit | Where |
|-------|-------|-------|
| Per-code attempts | 3 | `allowedAttempts` in the `emailOTP` plugin |
| Per-IP sends | 3 / 60 s | Better Auth `customRules`, D1-backed (`rateLimit` table, migration 0017) |
| Per-IP verifies | 5 / 60 s | as above |
| Per-email sends | 5 / 15 min | `registerOtpEmailSend()` — silently drops past the cap, so it can't become an inbox-existence oracle |

IP keying uses `cf-connecting-ip` (not the spoofable `x-forwarded-for`);
`x-test-client-ip` is honoured **only** when `isLocalDev()`, so e2e runs get
their own buckets.

### Sessions

60-day rolling sessions, refreshed at most daily (`session.expiresIn` /
`updateAge` in `src/auth.ts`). Active users stay signed in indefinitely; idle
sessions expire after 60 days. This applies to Google and email-OTP sign-ins
alike.

## Components

### Auth Worker (`web/workers/auth-api/`)

| File | Purpose |
|------|---------|
| `src/index.ts` | Hono app with CORS, `/me`, `/set-username`, `/set-name`, `/delete-account`, the dev-only endpoints, and the Better Auth catch-all |
| `src/auth.ts` | Better Auth config: Kysely D1 dialect, Google social provider, `emailOTP` + `apiKey` plugins, rate limits, 60-day rolling sessions, username field, auto-derive-username create hook, pilot bootstrap on sign-in |
| `src/otp-email.ts` | Builds the sign-in OTP email (subject/HTML/text) for the Cloudflare Email Sending binding |
| `src/rate-limit.ts` | Single source of truth for the API-key and email-OTP limits; per-email send throttle over the `rateLimit` table |
| `src/pilot-bootstrap.ts` | On every sign-in, ensures the account's `pilot` row exists and claims email-matching unlinked pre-registrations |
| `src/username.ts` | Slugify + derive a unique, format-valid username at sign-up |
| `src/routes/preferences.ts` | `GET`/`PUT /api/auth/preferences` (per-user UI preferences) |
| `web/db/migrations/` | D1 schema (shared with competition-api — see `migrations_dir` in `wrangler.toml`): `user`, `session`, `account`, `verification`, `apikey`, `rateLimit`, … |
| `wrangler.toml` | D1 binding + `migrations_dir`, R2 binding, `send_email` binding, route config, env vars |

### Frontend Auth (`web/frontend/src/auth/`)

| File | Purpose |
|------|---------|
| `auth/client.ts` | Better Auth client SDK + helper functions (`signInWithGoogle`, `signOut`, `getCurrentUser`, `setUsername`, `needsOnboarding`) |

### Frontend Pages

| Page | File | Purpose |
|------|------|---------|
| Onboarding | `react/pages/Onboarding.tsx` (route `/onboarding`) | Display name + username (prefilled) + optional CIVL/SAFA IDs. Reached by anyone `needsOnboarding()` flags — every email-OTP sign-up, and legacy accounts with a null username |
| Dashboard | `react/pages/Dashboard.tsx` (route `/u/{username}`) | My Flights page, redirects anonymous visitors to Google sign-in |

### API Endpoints

| Method | Path | Auth Required | Description |
|--------|------|---------------|-------------|
| GET | `/api/auth/me` | No | Returns `{ user }` or `{ user: null }`. Accepts a session cookie **or** an `x-api-key` |
| POST | `/api/auth/set-username` | Yes | Sets username (3-20 chars, `[a-zA-Z0-9-]`) and, when `name` is sent, the account's display name (1-128 chars) — both in one write |
| POST | `/api/auth/set-name` | Yes | Sets the account's display name (1-128 chars, trimmed; blank refused). Called by competition-api over the service binding whenever `PATCH /api/comp/pilot` renames a profile, so the two names cannot drift |
| GET | `/api/auth/preferences` | Yes | Read the caller's UI preferences (`src/routes/preferences.ts`) |
| PUT | `/api/auth/preferences` | Yes | Update them |
| POST | `/api/auth/delete-account` | Yes | Purges every R2 object under `u/{userId}/`, then deletes the `user` row (cascades to sessions, accounts, preferences, user tracks/tasks/annotations — see [database.md](database.md)) |
| POST | `/api/auth/dev-login` | No | **Local dev only** (404s unless `isLocalDev()`). Signs up-or-in an email+password identity so e2e specs don't need Google |
| GET | `/api/auth/dev-last-otp` | No | **Local dev only.** Returns the last sign-in OTP issued for an email, so local/e2e flows can complete OTP sign-in without a mailbox |
| ALL | `/api/auth/*` | — | Better Auth handles OAuth sign-in/callback, email-OTP send + verify, sign-out, session, and API-key management |

**API keys.** The Better Auth [`apiKey`](https://www.better-auth.com/docs/plugins/api-key)
plugin issues `glc_`-prefixed keys (created under Settings → API keys). A key
carries the permissions of the account that made it, is accepted anywhere a
session cookie is (`enableSessionForAPIKeys`), and is rate-limited to the
`API_KEY_RATE_LIMIT` in `src/rate-limit.ts`. See [api.md](api.md).

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

The schema is not a single file — it is the numbered migrations in
`web/db/migrations/`, shared with competition-api (`migrations_dir =
"../../db/migrations"` in `wrangler.toml`). Apply them, don't execute a schema
dump.

```bash
# Create database (only needed once)
bunx wrangler d1 create taskscore-auth
# Copy database_id into web/workers/auth-api/wrangler.toml

# Apply migrations to remote (production) — CI does this on every master deploy
bunx wrangler --config web/workers/auth-api/wrangler.toml \
  d1 migrations apply taskscore-auth --remote

# Apply migrations to local dev state (what `bun run dev` uses)
bun run db:migrate
```

### Node.js Compatibility

The auth worker requires `nodejs_compat` in `wrangler.toml` because Better Auth uses `node:async_hooks`. This is already configured:

```toml
compatibility_flags = ["nodejs_compat"]
```

## Local Development

```bash
# Everything — Vite on :3000 plus all the Workers on :8790
bun run dev

# Or just the Workers (auth-api among them), e.g. in their own terminal
bun run dev:workers
```

The auth worker has no port of its own: every Worker runs in one `wrangler dev`
session behind the `dev-router` Worker on :8790, which dispatches `/api/auth/*`
to auth-api over a service binding (see `web/scripts/dev-workers.sh` for why).
The Vite dev server proxies `/api` there, so cookies work on the same origin.

### First-time local setup

1. Create `.dev.vars` in `web/workers/auth-api/`:

```
GOOGLE_CLIENT_ID=your-client-id
GOOGLE_CLIENT_SECRET=your-client-secret
BETTER_AUTH_SECRET=your-random-secret
BETTER_AUTH_URL=http://localhost:3000
```

2. Apply the D1 migrations locally:

```bash
bun run db:migrate
```

(`bun run dev:workers` runs this for you before starting wrangler, so this step
is only needed if you're driving the database on its own.)

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

The unified `deploy.yml` workflow runs on every branch, but for non-master branches it only deploys Cloudflare Pages — the Worker deploy steps (auth-api, airscore-api, competition-api) are gated on `github.ref_name == 'master'`. Workers are therefore only deployed from `master`. This prevents branches from overwriting production workers with untested code.

## Cross-worker auth verification

Other workers (e.g. competition-api) need to verify authentication status for incoming requests. There are three approaches, in order of complexity:

### Option A: Service binding to auth-api (current approach)

Add a service binding in the worker's `wrangler.toml` and forward the session cookie to `/api/auth/me`:

```toml
[[services]]
binding = "AUTH_API"
service = "auth-api"
```

```ts
const res = await env.AUTH_API.fetch(new Request("https://auth/api/auth/me", {
  headers: { cookie: request.headers.get("cookie") || "" }
}));
const { user } = await res.json();
if (!user) return new Response("Unauthorized", { status: 401 });
```

- No shared secrets or new dependencies
- All auth logic stays centralised in auth-api
- ~5-10ms subrequest per authed call (hits D1 each time)
- Pages already uses this pattern (see `functions/api/auth/[[path]].ts`)

### Option B: Shared D1 binding (verify session directly)

Give the worker its own D1 binding to `taskscore-auth` plus `BETTER_AUTH_SECRET`. Parse the signed `better-auth.session_token` cookie, unsign it, and query the session table directly.

- No inter-worker subrequest
- Duplicates auth logic and must exactly match Better Auth's cookie signing (HMAC-SHA256 via `better-call`)
- Breaks if Better Auth changes its cookie format

### Option C: Cookie caching with JWT (stateless)

Enable Better Auth's cookie caching with JWT strategy in auth-api, then verify the signed `better-auth.session_data` cookie in the calling worker without any DB or network call:

```ts
// In auth-api config:
session: { cookieCache: { enabled: true, maxAge: 5 * 60, strategy: "jwt" } }

// In competition-api:
import { getCookieCache } from "better-auth/cookies";
const session = await getCookieCache(request, { secret: env.BETTER_AUTH_SECRET, strategy: "jwt" });
```

- Zero latency — truly stateless verification
- Requires `better-auth` as a dependency and sharing `BETTER_AUTH_SECRET`
- Revoked sessions remain valid until `maxAge` expires (e.g. 5 min window)

## Deployment

```bash
# Deploy auth worker
bun run deploy:auth

# Deploy frontend (includes auth pages)
bun run deploy
```
