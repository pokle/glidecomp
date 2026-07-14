# Email OTP sign-in — plan

*2026-07-14*

## Goal

Let users sign in with just their email address — they receive a one-time 6-digit
code (and a clickable link carrying the same code) — as an alternative to Google
OAuth. This answers the "username & password" feature request **without ever
storing a password or password hash**: the only secret is a short-lived,
hashed, single-use OTP, so there is no credential database worth stealing.

Non-goals (for this iteration): passkeys, additional social providers,
magic-link-only flow (link is a convenience wrapper around the code, not a
separate mechanism), password reset (there are no passwords).

## Decisions up front

| Decision | Choice | Why |
|---|---|---|
| OTP mechanism | Better Auth `emailOTP` plugin | First-party, uses the existing `verification` table, no schema change |
| Email sender | **Cloudflare Email Service** (Email Sending, public beta) via a native `send_email` Workers binding | We're on Workers Paid: 3,000 emails/mo included, $0.35/1k after; no external vendor, no API key/secret to manage |
| OTP storage | `storeOTP: "hashed"` | The D1 row is useless if leaked; the code is only in the user's inbox |
| OTP lifetime / attempts | 10 min (`expiresIn: 600`), `allowedAttempts: 3` | Long enough for slow airfield mail delivery, short enough that a leaked link goes stale fast |
| Session length | `expiresIn` 60 days, `updateAge` 1 day (rolling) | User asked ≥1 month; rolling refresh means active users never get logged out, idle sessions die after 60 days. Applies to Google sessions too (session config is global — one consistent policy) |
| Sign-up | allowed (`disableSignUp: false`) | OTP is a first-class registration path; onboarding (`/onboarding` username step) already catches new users regardless of provider |
| Passwords | `emailAndPassword` stays **disabled in production** (unchanged) | Dev-only exception: `dev-login` keeps using it behind `isLocalDev()` exactly as today |

## 1. Sender: Cloudflare Email Service

One-time dashboard setup (manual, not in code):

1. In the Cloudflare dashboard, enable Email Service and **verify
   `glidecomp.com` as a sender domain** (it adds DKIM/SPF DNS records —
   the zone is already on Cloudflare, so this is a few clicks). Sending from
   an unverified domain fails with `E_SENDER_NOT_VERIFIED`.
2. Sender address: `no-reply@glidecomp.com`.

Worker config (`web/workers/auth-api/wrangler.toml`):

```toml
[[send_email]]
name = "EMAIL"
```

This exposes `env.EMAIL.send({ to, from, subject, html, text })` — no API key,
no new secret. Add `EMAIL: SendEmail` to `AuthEnv`.

**Local dev:** `wrangler dev` simulates the binding locally (messages are
logged, not delivered), so `bun run dev` keeps working with zero setup and no
accidental real email. The e2e story (§7) doesn't depend on reading the email
at all.

**Cost guardrail:** OTP volume for GlideComp is tens/day with registration-day
spikes — far inside the 3,000/mo included. The per-IP/per-email rate limits in
§5 also cap the damage of a send-endpoint abuser at pennies.

## 2. Better Auth server config (`web/workers/auth-api/src/auth.ts`)

```ts
import { emailOTP } from "better-auth/plugins";

plugins: [
  emailOTP({
    otpLength: 6,
    expiresIn: 600,          // 10 minutes
    allowedAttempts: 3,      // then the code is dead; user requests a new one
    storeOTP: "hashed",
    async sendVerificationOTP({ email, otp, type }) {
      if (type !== "sign-in") return; // no email-verification / password flows
      await env.EMAIL.send(buildOtpEmail(email, otp));
    },
  }),
  // ...existing apiKey + oAuthProxy plugins unchanged
],
session: {
  expiresIn: 60 * 60 * 24 * 60, // 60 days
  updateAge: 60 * 60 * 24,      // roll forward at most once a day
},
```

Notes:

- The plugin's endpoints ride the existing Hono catch-all
  (`app.all("/api/auth/*")`) — no new routes in `index.ts`. CORS and the
  Retry-After-on-429 middleware already cover them.
- The plugin also registers forget-/reset-password and email-change endpoints;
  with `emailAndPassword` disabled in prod they are inert, and the
  `sendVerificationOTP` guard above means they can never send mail anyway.
- `createAuth(env)` is built per-request, so `sendVerificationOTP` closes over
  `env` naturally — `createAuth` already takes `env`, no restructuring needed.
- `buildOtpEmail` lives in a new `src/otp-email.ts` (pure function → unit
  testable, §6).

## 3. Interaction with the existing Google auth

Better Auth links accounts by **verified email**, which gives exactly the
behavior we want with no extra config:

- **Existing Google user signs in with OTP:** the OTP proves ownership of the
  same (Google-verified) email → signs into the *same* user. One account, two
  ways in. No duplicate `user` row, no orphaned pilot identity.
- **OTP-first user later clicks "Continue with Google":** Google reports the
  email as verified → the Google `account` row links to the existing user.
- We do **not** add `trustedProviders` overrides or disable implicit linking —
  the defaults (link only when the provider verifies the email) are the safe
  setting.

Edge case worth documenting in code: if an *unverified* account with the same
email exists, Better Auth's OTP sign-in revokes its sessions and clears any
password before signing in (email ownership wins). We have no unverified
accounts in prod (Google-only until now), so this is theoretical, but the
comment should say so.

`/api/auth/me`, `getCurrentUser()`, onboarding, and the admin allowlists all
key off the user/session, not the provider — untouched.

## 4. Email content

One email, `subject: "Your GlideComp sign-in code: 123456"` (code in the
subject so it's visible in notification previews). Body (text + simple HTML,
no images, no tracking):

```
Your GlideComp sign-in code is:

    123456

Or click to sign in directly:
https://glidecomp.com/signin#otp=123456&email=pilot%40example.com

This code expires in 10 minutes and can be used once.
If you didn't request it, you can ignore this email — no one can
sign in without this code.
```

- **The link carries the code in the URL fragment (`#`), not the query
  string** — fragments are never sent to the server, so the code stays out of
  Cloudflare access logs and Pages Function logs. The SPA reads
  `location.hash`, immediately strips it via `history.replaceState`, and
  verifies.
- The link must point at the **production origin** (`BETTER_AUTH_URL`), same
  rule as the oAuthProxy. Branch previews still work: request the code on a
  preview, type it manually there (the emailed *link* lands on prod — that's
  fine and matches how the Google flow treats previews).
- HTML version: same content styled minimally inline (large monospace code,
  one button-styled link). Both `text` and `html` are set — deliverability
  and screen-reader friendly.

## 5. Rate limiting

Three independent layers, all needed:

1. **Per-OTP attempts** — `allowedAttempts: 3` (plugin). Kills online
   brute-force of a specific code: 3 tries against 10⁶ codes, then the code is
   void.
2. **Better Auth request rate limiting, backed by D1** — the built-in limiter
   defaults to in-memory storage, which is useless in workerd (each isolate has
   its own memory and they're recycled constantly). Configure:

   ```ts
   rateLimit: {
     enabled: true,               // (production default, but be explicit)
     storage: "database",
     customRules: {
       "/email-otp/send-verification-otp": { window: 60, max: 3 },
       "/sign-in/email-otp":               { window: 60, max: 5 },
     },
   },
   ```

   Requires the `rateLimit` table → new migration
   `web/db/migrations/0017_rate_limit.sql` (`id`, `key`, `count`,
   `lastRequest` — Better Auth's standard schema). Keyed by IP.
3. **Per-email send throttle** — IP limits don't stop a distributed abuser
   from bombarding one victim's inbox. In `sendVerificationOTP`, before
   sending, check/insert a per-email counter (an atomic upsert on the same
   rateLimit table with key `otp-email:<email>`): max 5 sends per address per
   15 minutes (5, not 3: with the UI's 60s resend cooldown a legitimately
   struggling user can hit 3 in minutes); silently drop beyond that (don't
   error — no inbox-existence oracle).

Rate limits are keyed on `cf-connecting-ip` (the Better Auth default,
`x-forwarded-for`, has a client-supplied first entry behind Cloudflare). In
local dev there is no real client IP — everything would share one fallback
bucket and e2e runs would 429 each other — so when `isLocalDev()` the worker
additionally trusts an `x-test-client-ip` header, letting each test isolate
its own bucket at the real production limits.

The existing `index.ts` middleware already guarantees every 429 leaves with a
`Retry-After` header. `docs/api.md` / `e2e/api-doc.spec.ts` only pin the
API-key limit, so no doc-test churn — but add the new limits to a constant in
`rate-limit.ts` alongside `API_KEY_RATE_LIMIT` (same single-source-of-truth
pattern).

Anti-enumeration: the send endpoint must respond identically whether or not
the email has an account (Better Auth's OTP send does — it sends a code either
way since sign-up is allowed, which is itself the non-oracle behavior).

## 6. UI

### Options considered

| Option | Verdict |
|---|---|
| **A. Dedicated `/signin` page** (Google button + email form) | **Recommended.** The emailed link needs a landing route anyway; every current "Sign in" call site becomes a simple navigation; room for the two-step (email → code) flow on mobile |
| B. Sign-in dialog opened from the header button | Less navigation, but the emailed link still needs a standalone route, so we'd build the page *and* the dialog; dialogs over arbitrary scroll states complicate focus/a11y for no real win |
| C. Inline form in the header | Cramped, hostile on mobile, no room for the code step |

### `/signin` page (SPA route, renders outside the auth-guarded shell chrome)

- Card layout: **"Continue with Google"** button (primary, unchanged
  behavior) → divider ("or") → email input + **"Email me a code"**.
- Step 2 (after send): 6-box code input — add the shadcn **`input-otp`**
  component (`bunx shadcn@latest add input-otp`) per the components-first
  rule — with `autocomplete="one-time-code"` and `inputmode="numeric"` so
  iOS/Android autofill from the email/SMS-style notification works. Beneath:
  "Code sent to *pilot@example.com*", a resend button (disabled 60 s,
  respecting the send rate limit), and "use a different email".
- Auto-submit when 6 digits are entered; on `TOO_MANY_ATTEMPTS`/expiry, clear
  and offer resend.
- **Emailed-link landing:** on mount, parse `location.hash` for
  `otp` + `email`, strip the hash, prefill and verify immediately (show the
  code step with a spinner state, so a failed/expired link degrades into the
  normal manual-entry UI with an error toast, never a dead end).
- Client: `authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" })`
  then `authClient.signIn.emailOtp({ email, otp })` — add the `emailOTPClient`
  plugin to `src/auth/client.ts`.
- After sign-in: `window.location.href = "/comp"` (same landing as the Google
  `callbackURL`); the Shell's existing effect routes username-less users to
  `/onboarding`.
- `?next=` param (optional, this iteration if cheap): pages that currently
  trigger OAuth from a context (e.g. "Sign in to submit your track") can
  return the user where they started.

### Call-site changes

`signInWithGoogle()` in `src/react/lib/user.tsx` is called from Shell,
Dashboard, Settings, CompDetail, Competitions. Rename/replace with
`goToSignIn()` that (a) keeps the existing preview-role escape hatch (a
superadmin previewing signed-out gets restored, not navigated), then
(b) navigates to `/signin`. The Google *button on the sign-in page* calls the
existing `authClient.signIn.social` directly. `signInAsDev` and the dev
button are untouched.

### A11y & SSR

- Per `docs/accessibility-standard.md`: labeled inputs, `aria-live="polite"`
  status for "code sent"/error messages, focus moves to the code input on
  step change, resend button has an accessible countdown. Part of "done".
- `/signin` is **not** one of the five SSR routes and must stay that way (an
  auth page has no SEO value; keep it out of `functions/comp` scope — it's
  already outside `/comp*`). Normal SPA `_redirects` handling. No module-scope
  `window` usage in anything new that shared code imports.

## 7. Testing

- **Unit (auth-api, vitest-pool-workers):** `buildOtpEmail` (code + link
  present in text and html, email correctly URL-encoded in the fragment, prod
  origin used); per-email throttle logic; auth.ts config smoke (plugin
  registered, session `expiresIn` = 60 d).
- **E2E:** in local dev the OTP never leaves the machine, so add a dev-only
  helper mirroring `dev-login`'s gating: `GET /api/auth/dev-last-otp?email=…`
  (404 unless `isLocalDev()`) that reads the latest OTP row from the
  `verification` table. The spec: request code on `/signin` → fetch it from
  the helper → type it → assert signed-in shell, then repeat via the
  `#otp=…&email=…` deep link. Also assert the send endpoint 429s on the 4th
  rapid request (and carries Retry-After).
  - Hashed OTPs can't be read back — have the helper capture via a dev-only
    `sendVerificationOTP` branch instead (in `isLocalDev`, stash
    `{email, otp}` in a module-level map and log it; prod path untouched).
- **Manual/preview:** deploy branch → verify real email arrives (needs the
  domain verified first), link works, code works, Google→OTP and OTP→Google
  land on the same account (check `account` rows), session cookie `Max-Age`
  ≈ 60 d.

## 8. Out of scope / follow-ups

- Passkeys layered on top (OTP becomes the recovery path).
- Apple/Facebook providers.
- Switching `dev-login` off `emailAndPassword` (works fine, dev-only).
- Audit log & score staleness: sign-in is not a scoring input — no `audit()`
  or `bumpAndRevalidateScores()` obligations here.

## Implementation order

1. Migration `0017_rate_limit.sql`; wrangler `send_email` binding + `AuthEnv`.
2. `otp-email.ts` + auth.ts changes (plugin, session, rateLimit) + per-email
   throttle + dev OTP helper. Unit tests.
3. Dashboard: verify sender domain (manual, can proceed in parallel).
4. `/signin` page + client plugin + call-site swap + `input-otp` component.
5. E2E spec; a11y checklist pass; preview-deploy manual test with real email.
