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

Only `type: "sign-in"` codes are ever minted: `src/index.ts` refuses any
other `type` before Better Auth sees the request, and the plugin's
password-reset, email-change, verify-email and check-code endpoints are not
served at all (`src/endpoints.ts`, below). In local dev nothing is emailed —
the code is logged and readable via `GET /api/auth/dev-last-otp`.

**Rate limits** — four layers, with every constant in `src/rate-limit.ts` as
the single source of truth (the API-key limit in the same file is quoted by
`docs/api.md` and pinned by `e2e/api-doc.spec.ts`, so the doc can't drift from
what the worker enforces):

| Layer | Limit | Where |
|-------|-------|-------|
| Per-code attempts | 3 | `allowedAttempts` in the `emailOTP` plugin |
| Per-IP sends | 3 / 60 s | Better Auth `customRules`, D1-backed (`rateLimit` table, migration 0017) |
| Per-IP verifies | 5 / 60 s | as above |
| Per-email sends | 5 / 15 min | `otpSendAllowed()` in `src/index.ts`, before Better Auth mints a code; charged by `registerOtpEmailSend()` in the send hook. Past the cap the answer is still `{"success":true}`, so it can't become an inbox-existence oracle |
| Per-email wrong codes | 10 / hour | `otpVerifyAllowed()` before Better Auth checks a code, `registerOtpVerifyFailure()` after it refuses one. Past the cap that address gets `429`, whoever asks |

The two per-email layers are the ones that bound a *distributed* guesser, and
they sit in front of Better Auth for a reason (SEC-56): the plugin mints and
stores a fresh code — three fresh attempts — before it calls the send hook, so
a throttle inside the hook withheld only the email, and the per-IP layers count
per client address (per /64 for IPv6), which a guesser can source by the tens
of thousands. Together they hold a guesser to about ten tries an hour against a
million possible codes.

**Served endpoints.** The Better Auth catch-all forwards only the endpoints the
app uses (`src/endpoints.ts`: Google sign-in and its callback, the two
email-OTP endpoints, the session, `/jwks`, API-key create/list/delete); every
other path under `/api/auth/` is a 404 (SEC-55). A feature that needs another
Better Auth endpoint adds it to that list.

IP keying uses `cf-connecting-ip` (not the spoofable `x-forwarded-for`);
`x-test-client-ip` is honoured **only** when `isLocalDev()`, so e2e runs get
their own buckets.

### Sessions

60-day rolling sessions, refreshed at most daily (`session.expiresIn` /
`updateAge` in `src/auth.ts`). Active users stay signed in indefinitely; idle
sessions expire after 60 days. This applies to Google and email-OTP sign-ins
alike.

Each D1 session read also sets a 5-minute `session_data` cookie cache, which
other workers verify without calling auth-api — see
[Cross-worker auth verification](#cross-worker-auth-verification).

The Better Auth instance is built once per isolate (`createAuth()` memoises it
per `env`). The two hooks that hand work to `waitUntil` read the request's
ExecutionContext from async local storage (`runWithExecutionCtx()`), not from
the constructor.

### The schema, and who checks it

The `user`, `session`, `account`, `verification`, `apikey`, `rateLimit` and
`jwks` tables are Better Auth's, but they are **ours to migrate**: they are
hand-written in `web/db/migrations/` and applied by wrangler. Better Auth's
CLI (`auth migrate` / `auth generate`) is never run against this database.

Since **1.7.3**, Better Auth also validates that schema itself — comparing the
live tables against the ones its configuration writes, before every
`auth.api.*` call and every request through `auth.handler`. **That check
cannot run on D1.** It reads the table list through Kysely's SQLite
introspector, which queries `sqlite_master`; D1 refuses that with `not
authorized: SQLITE_AUTH`. Left enabled, the check throws on the first query of
every request and nobody can sign in at all — and because only a *clean*
verdict is cached, the failure repeats on every request forever. So
`advanced.database.validateSchema` is `false` in `src/auth.ts`.

This was in no changelog. Reported upstream at
[better-auth#11346](https://github.com/better-auth/better-auth/issues/11346)
and **fixed in 1.7.6** by
[#11366](https://github.com/better-auth/better-auth/pull/11366), which tries
dialect introspection first and falls back to one `PRAGMA table_info` per
configured table when the catalogue read is refused. The check would
therefore run on D1 now.

**The config line stays `false` regardless**, and that is a decision rather
than an oversight: the drift it exists to catch is already asserted at test
time by `test/schema.test.ts` (below), so enabling it buys no new information
and costs a live auth path that can only ever fail closed. Turning it on is
its own change, with its own blast radius, not a tidy-up to ride in on a
dependency bump.

`test/schema.test.ts` does the same job in a way D1 permits: it reads the
expectation from `getAuthTables(auth.options)` — the very function the
library's own check uses, over the real config, so the plugin list and
`additionalFields` cannot drift out of a hand-copied list — and reads the live
side with `PRAGMA table_info`, which D1 does allow. **When a Better Auth
upgrade adds a column or a table, that test is what fails**, and the fix is a
new migration in `web/db/migrations/`.

## Components

### Auth Worker (`web/workers/auth-api/`)

| File | Purpose |
|------|---------|
| `src/index.ts` | Hono app with CORS, `/me`, `/set-username`, `/set-name`, `/delete-account`, the dev-only endpoints, the per-email OTP guards, and the Better Auth catch-all |
| `src/endpoints.ts` | The Better Auth endpoints the catch-all serves; everything else under `/api/auth/` is a 404 |
| `src/auth.ts` | Better Auth config: Kysely D1 dialect, Google social provider, `emailOTP` + `apiKey` + `jwt` plugins, session cookie cache, rate limits, 60-day rolling sessions, username field, auto-derive-username create hook, pilot bootstrap on sign-in |
| `src/otp-email.ts` | Builds the sign-in OTP email (subject/HTML/text) for the Cloudflare Email Sending binding |
| `src/rate-limit.ts` | Single source of truth for the API-key and email-OTP limits; the per-email send throttle and wrong-code budget over the `rateLimit` table |
| `src/pilot-bootstrap.ts` | On every sign-in, ensures the account's `pilot` row exists and claims email-matching unlinked pre-registrations |
| `src/username.ts` | Slugify + derive a unique, format-valid username at sign-up |
| `src/routes/preferences.ts` | `GET`/`PUT /api/auth/preferences` (per-user UI preferences) |
| `web/db/migrations/` | D1 schema (shared with competition-api — see `migrations_dir` in `wrangler.toml`): `user`, `session`, `account`, `verification`, `apikey`, `rateLimit`, `jwks`, … |
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
| POST | `/api/auth/set-username` | Yes (no API key) | Sets username (3-20 chars, `[a-zA-Z0-9-]`) and, when `name` is sent, the account's display name (1-128 chars) — both in one write |
| POST | `/api/auth/set-name` | Yes (no API key) | Sets the account's display name (1-128 chars, trimmed; blank refused). Called by competition-api over the service binding whenever `PATCH /api/comp/pilot` renames a profile, so the two names cannot drift |
| GET | `/api/auth/preferences` | Yes | Read the caller's UI preferences (`src/routes/preferences.ts`) |
| PUT | `/api/auth/preferences` | Yes | Update them |
| POST | `/api/auth/delete-account` | Yes (no API key) | Purges every R2 object under `u/{userId}/`, then deletes the `user` row (cascades to sessions, accounts, preferences, user tracks/tasks/annotations — see [database.md](database.md)) |
| POST | `/api/auth/dev-login` | No | **Local dev only** (404s unless `isLocalDev()`). Signs up-or-in an email+password identity so e2e specs don't need Google |
| GET | `/api/auth/dev-last-otp` | No | **Local dev only.** Returns the last sign-in OTP issued for an email, so local/e2e flows can complete OTP sign-in without a mailbox |
| GET | `/api/auth/jwks` | No | Public keys that verify the `session_data` cookie cache (Better Auth's `jwt` plugin) |
| GET | `/api/auth/token` | — | **Always 404.** The `jwt` plugin's bearer-token endpoint, deliberately not served |
| ALL | `/api/auth/*` | — | Better Auth handles OAuth sign-in/callback, email-OTP send + verify, sign-out, session, and API-key management (no API key) |

**API keys.** The Better Auth [`apiKey`](https://www.better-auth.com/docs/plugins/api-key)
plugin issues `glc_`-prefixed keys (created under Settings → API keys). A key
carries the permissions of the account that made it, is accepted almost
anywhere a session cookie is (`enableSessionForAPIKeys`), and is rate-limited
to the `API_KEY_RATE_LIMIT` in `src/rate-limit.ts`. See [api.md](api.md).

The exception is managing the account itself (SEC-57). A request carrying an
`x-api-key` header gets `403 {"code":"BROWSER_SESSION_REQUIRED"}` from
`/api-key/*`, `/delete-account`, `/set-username` and `/set-name`, before any
of them runs — so `PATCH /api/comp/pilot` cannot rename the account with a key
either. Otherwise one leaked key could mint a second that outlived revoking
the first, revoke its owner's other keys, or delete the account. The list is
`requiresBrowserSession()` in `src/endpoints.ts`; the header is
`API_KEY_HEADER` in `src/auth.ts`, which the plugin is configured with too, so
the guard and the plugin cannot disagree about what makes a key session.

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

Other callers — competition-api's auth middleware and the SSR Pages Function
(`functions/comp/[[path]].ts`) — need to know who a request is from. They
answer it in two tiers.

### 1. The session cookie cache, checked with a public key (the common case)

auth-api runs Better Auth with `session.cookieCache` on the `"jwt"` strategy
(`maxAge` 5 minutes), and the `jwt` plugin with `sessionCookieCache: true`.
Every time auth-api reads a session from D1 it also sets a
`better-auth.session_data` cookie: a JWT of the session and user, signed with
an **Ed25519 private key** from the `jwks` table (migration 0034; the private
half stored encrypted with `BETTER_AUTH_SECRET`). The public half is published
at `GET /api/auth/jwks`.

`verifySessionCookie()` in `@glidecomp/worker-kit/session-cookie` checks that
cookie with the public key alone: the `typ`, the audience, the algorithm
pinned to the published key's, the expiry, and that the cached session
belongs to the `session_token` cookie beside it. The key set is fetched over
the service binding once per isolate per hour (early only for an unknown
`kid`). No hop, no D1 read — and the caller holds nothing that can sign a
session, so a bug there cannot leak a way to forge one.

- **A miss is "ask auth-api", never "signed out".** Only a verified user is an
  answer; anything else falls through to tier 2.
- **API keys always take tier 2** (`x-api-key` / `Authorization`): they carry
  no cookie, and auth-api owns their rate limit.
- **Only Better Auth's own cookies are forwarded** (`authCookieHeader()`). A
  visitor with only analytics cookies is anonymous: no hop, and the SSR page
  stays publicly cacheable. The filter keys off `AUTH_COOKIE_PREFIX` in the
  worker kit, which auth-api also passes as `advanced.cookiePrefix`. Change
  the prefix there and nowhere else: a prefix the filter did not know would
  strip every session cookie before the `/me` fallback saw it, and sign
  everyone out.
- **The trade-off:** a revoked session, or a sign-out on another device, keeps
  working for up to 5 minutes. `delete-account` reads D1 (not the cache) and
  signs out, which expires both cookies — but only on the device that asked.
  Another device's cache cookie still verifies at competition-api for up to
  5 minutes after the account is gone, so a write made in that window can
  name a user id that no longer exists.
- **Anything that writes `"user"` directly must re-issue the cookie**, or the
  old values are served until it expires. `set-username` and `set-name` call
  `refreshSessionCache()`; competition-api's `PATCH /api/comp/pilot` passes
  set-name's `Set-Cookie` back to the browser.
- **The cookie reaches the browser only on a response the browser gets.** So
  `/api/auth/me` passes Better Auth's `Set-Cookie` headers through
  (`returnHeaders`), and the SSR Function forwards those from its own `/me`
  fallback onto the page. A call over a service binding from competition-api
  cannot refresh it.
- **Rotating `BETTER_AUTH_SECRET` also means clearing the `jwks` table**
  (`DELETE FROM jwks`). The private keys there are encrypted with the old
  secret, so auth-api could no longer sign a cache cookie, and every session
  read would fail. With the table empty, auth-api mints a new key on first use.
  Every browser's cache cookie then fails to verify once and falls back to /me
  for a single request. Nobody is signed out; the secret rotation itself is
  what invalidates sessions.
- The jwt plugin's other product — a JS-readable JWT on `get-session` and at
  `/api/auth/token` — is switched off (`disableSettingJwtHeader`, and index.ts
  404s `/token`).

### 2. The `/api/auth/me` hop (the authority)

Forward the caller's credential over the `AUTH_API` service binding:

```toml
[[services]]
binding = "AUTH_API"
service = "auth-api"
```

```ts
const res = await env.AUTH_API.fetch(new Request("https://auth/api/auth/me", {
  headers: forwardAuthHeaders(request.headers),
}));
const { user } = await res.json();
```

`/me` itself answers from the cookie cache when it is fresh, and from D1
(two sequential queries) otherwise. See `resolveUser()` in
`web/workers/competition-api/src/middleware/auth.ts` for the retry rules
(issue #481: a 5xx is not "signed out").

Sharing `BETTER_AUTH_SECRET` with another worker (Better Auth's default
`compact` or `jwt` strategies, or reading the session table directly) was
considered and rejected: whoever holds the secret can mint a session for
anyone.

## Deployment

```bash
# Deploy auth worker
bun run deploy:auth

# Deploy frontend (includes auth pages)
bun run deploy
```
