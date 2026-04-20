# GlideComp Security Review

> **Purpose:** Living memory log for security audits. Each review should append a new dated section and mark prior findings as `Fixed` / `Open` / `Accepted`, preserving history so we can spot regressions.

---

## Review Log

| Date       | Reviewer | Scope                            | Status       |
|------------|----------|----------------------------------|--------------|
| 2026-04-20 | Claude   | Full repo (auth, comp, MCP, FE)  | Initial      |
| 2026-04-20 | Claude   | SEC-01 remediation               | Fixed inline |

---

## 2026-04-20 — Initial Security Review

### Methodology

Static analysis of:
- Auth worker (`web/workers/auth-api/src/`)
- Competition API worker (`web/workers/competition-api/src/`)
- AirScore proxy worker (`web/workers/airscore-api/src/`)
- MCP worker (`web/workers/mcp-api/src/`)
- Pages Functions proxy layer (`functions/api/`)
- Frontend SPA (`web/frontend/src/`, focused on data flow from untrusted files → DOM)
- Engine package (`web/engine/src/`, focused on parsers)
- Infrastructure: `wrangler.toml`, `Dockerfile.dev`, `docker-compose.yml`, `_redirects`

Reviewer did **not** attempt dynamic testing (fuzzing, live CSRF PoC, dependency CVE scan). Those are noted under "Scope gaps" below.

### Executive summary

Overall posture is solid: all DB access uses parameterized queries, authorization middleware is consistently applied to mutating routes, and the `audit()` helper is wired into every route that writes to comp state. The two issues that matter most are **(1) reflective CORS with `credentials: true`** on both the auth and competition workers (CSRF-class exposure via cross-site fetch), and **(2) the absence of a `_headers` file on Cloudflare Pages** so there is no CSP / `X-Frame-Options` / HSTS / `Referrer-Policy` defence-in-depth layer. Everything else is Medium or below.

---

### Findings

Severity scale: **Critical** (exploitable now, user data at risk) → **High** → **Medium** → **Low** → **Info**.

---

#### SEC-01 — Reflective CORS with credentials on auth + competition workers — **High** — ~~Open~~ **Fixed (2026-04-20, this PR)**

> **Resolution:** both workers now use an explicit allowlist (`glidecomp.com`, `*.glidecomp.pages.dev`, `localhost`) instead of reflecting the caller's `Origin`. Disallowed origins receive an empty `Access-Control-Allow-Origin` so the browser blocks the response. See `web/workers/auth-api/src/index.ts:10-31` and `web/workers/competition-api/src/index.ts:19-40`. Verification (run on deploy): `curl -I -H "Origin: https://evil.example" https://glidecomp.com/api/auth/me` should return no `Access-Control-Allow-Origin` header.


**Files**
- `web/workers/auth-api/src/index.ts:10-18`
- `web/workers/competition-api/src/index.ts:20-28`

Both workers use:
```ts
cors({ origin: (origin) => origin ?? "", credentials: true, ... })
```
This echoes the caller's `Origin` header back in `Access-Control-Allow-Origin` while also sending `Access-Control-Allow-Credentials: true`. The effect is: **any website the victim visits can issue authenticated fetch requests to `/api/auth/*` and `/api/comp/*`** and read the responses.

Better Auth does set `trustedOrigins: ["https://glidecomp.com", "https://*.glidecomp.pages.dev"]` (`web/workers/auth-api/src/auth.ts:34`), which protects Better Auth's own catch-all handler from CSRF. But the custom Hono routes — `/api/auth/set-username`, `/api/auth/delete-account`, and everything under `/api/comp/*` — sit in front of that protection. If session cookies are `SameSite=Lax` (Better Auth default), simple cross-site `GET` requests carry credentials, and many `POST`/`PATCH` endpoints read JSON bodies that can be delivered via top-level navigation or same-site iframes hosted on a subdomain you don't control.

**Downgrade note:** the agent's initial report called this Critical. It is downgraded to **High** because (a) Better Auth's `SameSite=Lax` default blocks the most obvious cross-site POSTs, and (b) the frontend is same-origin so legitimate use never needs arbitrary origins. Still: the reflective CORS is functioning as an opt-out of browser protections and should be replaced.

**Remediation**
```ts
const ALLOWED = new Set(["https://glidecomp.com"]);
// plus preview deploys matching *.glidecomp.pages.dev and localhost in dev
origin: (origin) => (origin && isAllowed(origin) ? origin : ""),
```
Also verify Better Auth is configured to emit `SameSite=Strict` or `Lax` on the session cookie (check cookie attributes on a live `/api/auth/*` response once deployed).

---

#### SEC-02 — No security response headers on Pages deployment — **Medium**

**Evidence:** no `_headers` file in `web/frontend/public/` (confirmed with `find . -name _headers`). `web/frontend/public/_redirects` exists but only for SPA routing.

The site therefore ships with no `Content-Security-Policy`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, or `Strict-Transport-Security` headers (HSTS is set by Cloudflare at the zone level only if enabled in the dashboard — verify). Given prior XSS findings in the 2026-03-04 audit (BUG-01 fixed via escape helpers), a CSP would provide a meaningful second layer.

**Remediation:** add `web/frontend/public/_headers`:
```
/*
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: geolocation=(), microphone=(), camera=()
  Content-Security-Policy: default-src 'self'; img-src 'self' data: https://*.tile.openstreetmap.org https://api.mapbox.com; connect-src 'self' https://api.mapbox.com; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'
```
Start with `Content-Security-Policy-Report-Only` to measure breakage before enforcing.

---

#### SEC-03 — Admin email addresses returned in public comp detail — **Medium**

**File:** `web/workers/competition-api/src/routes/comp.ts:243-250` and response at `:303`

```sql
SELECT u.email, u.name FROM comp_admin ca JOIN "user" u ON ca.user_id = u.id ...
```
returned as `admins: admins.results` on the public, unauthenticated comp-detail endpoint for non-test competitions. This publishes organisers' email addresses to the open web, enabling scraping for phishing/spam campaigns targeting comp directors. Admin names are useful for transparency; emails are not.

**Remediation:** return `{ name, username }` only. If emails are ever needed, require the caller to be authenticated (or an admin themselves) and gate the field on that.

---

#### SEC-04 — IGC upload accepts 5 MB blobs without content-type or shape checks — **Medium**

**Files**
- `web/workers/competition-api/src/routes/igc.ts:20` (`MAX_IGC_SIZE = 5 * 1024 * 1024`)
- IGC body consumed and handed to `parseIGC` without verifying `Content-Type` or that the payload looks like IGC text

Combined with the CSRF exposure in SEC-01 and the fact that open competitions allow uploads without being a listed pilot, an attacker can push up to 5 MB of arbitrary bytes per request into R2 and drive parser CPU. IGC files are plain text and rarely exceed a few hundred KB; 5 MB is 10–50× typical.

**Remediation**
- Reject if body is not `text/plain` or `application/octet-stream`.
- Lower size cap to ~1 MB (a 10 h flight at 1 Hz is ~800 KB uncompressed).
- Reject early if the first non-whitespace bytes aren't `A` (IGC manufacturer record) or `HFDTE` — matches the fixed pattern in `airscore-api/src/handlers/track.ts` (see BUG-06 in 2026-03-04 audit).

---

#### SEC-05 — `innerHTML` remains the default rendering primitive in the analysis panel — **Medium**

**File:** `web/frontend/src/analysis/analysis-panel.ts` (multiple `el.innerHTML = \`...\`` sites around lines 242-255, 286, 620, 660, 718, 985, 1033)

Prior audit (BUG-01) fixed concrete XSS in specific spots by applying `escapeHtml()`. The broader pattern is still fragile: any new field plumbed into a template literal inherits whichever escaping the author remembers to add. `sanitizeText()` at parse time is a belt-and-braces mitigation but is not a substitute for escaping at render time — it strips control chars, it does not HTML-encode.

**Remediation (defensive, not urgent):** migrate incrementally to DOM construction (`createElement` + `textContent`) or a tagged-template helper that escapes interpolations by default. At minimum, add a lint rule forbidding `innerHTML =` with template literals that contain `${...}` of non-constant values.

---

#### SEC-06 — No explicit JSON body-size cap at the HTTP layer — **Low**

**Evidence:** Zod validators cap individual string fields (`MAX_TEXT = 128`) but `gap_params` is free-form JSON and `pilot_classes` is an array of strings. Hono has no `bodyLimit` middleware registered in either worker.

Cloudflare Workers apply a global body limit (100 MB), so this is not unbounded, but it would be cheap to add `bodyLimit({ maxSize: 256 * 1024 })` globally and override upward only for the IGC route.

---

#### SEC-07 — Dev-only endpoints gated by `BETTER_AUTH_URL` hostname — **Info (verify on deploy)**

**File:** `web/workers/auth-api/src/auth.ts:7-13` + `src/index.ts:122-154`

`isLocalDev` returns true when `BETTER_AUTH_URL` hostname is `localhost`. The dev-login endpoint and email/password auth are enabled when that is the case. This is correct **if and only if** `BETTER_AUTH_URL` in the production `wrangler.toml` / Cloudflare secret points at `https://glidecomp.com`. Worth re-checking every deploy that:
- `BETTER_AUTH_URL` is not accidentally `http://localhost` in prod vars.
- `emailAndPassword.enabled` stays gated to local dev (the `?:` at `auth.ts:56-58` handles this).
- `minPasswordLength: 1` (auth.ts:57) never leaks to prod.

No fix needed if deployment configs are correct; flag for re-verification.

---

#### SEC-08 — Rate-limit headers not surfaced to clients — **Low**

**File:** `web/workers/auth-api/src/auth.ts:41-45`

API-key rate limit is `60 req / 60 s`. Exceeding it returns `429` but without `Retry-After` or `X-RateLimit-*` headers, so MCP clients have to back off blindly.

**Remediation:** rely on whatever Better Auth's apiKey plugin already emits (read the response and document), and if nothing is emitted, wrap the route to add `Retry-After: 60` on 429s.

---

#### SEC-09 — `Math.random()` used in non-security contexts (not exploitable) — **Info**

Noted in the 2026-03-04 audit as BUG-29 (non-deterministic tests). No cryptographic use of `Math.random()` was found in source. Keeping the note here so future reviewers don't have to re-check.

---

### Positive findings (preserve these patterns)

- **Parameterised SQL throughout** — every query uses `.bind(...)` (spot-checked `routes/comp.ts`, `routes/task.ts`, `routes/igc.ts`, `routes/pilot-status.ts`). No string concatenation into SQL found.
- **Authorisation middleware is consistently applied** — `requireAuth` + `requireCompAdmin` appear on every mutating route; pilot-scoped routes use `authorizeStatusMutation()` to ensure the caller is either the comp admin or the affected pilot.
- **Audit logging** — `audit()` helper is called from every mutating handler per CLAUDE.md policy. Descriptions use `describeChange()` to include old/new values. Audit payloads do not contain secrets or full emails.
- **R2 object keys are computed server-side** from `comp_pilot_id`, not user input — no path-traversal surface.
- **Better Auth service-binding between MCP worker and auth worker** via `X-Glidecomp-Internal-User` header — internal header is only reachable via Cloudflare service binding, not via the public internet. Good pattern.
- **IGC header fields are sanitised at parse time** (`sanitizeText()` in `web/engine/src/igc-parser.ts`) — mitigates the class of XSS that BUG-01 exploited.
- **API keys are prefixed (`glc_`)** making them detectable in logs / secret scanners and distinguishable from session tokens.

---

### Scope gaps (not reviewed this round)

Flag these for the next review so we don't keep skipping them:

1. **Dependency CVE scan.** Neither `npm audit` / `bun audit` nor a Snyk-equivalent was run. Check `package.json` + `bun.lock` against known advisories, including the Basecoat fork described in `docs/basecoat-fork.md`.
2. **Cookie attribute verification on live deploy.** Claim: Better Auth sets `HttpOnly`/`Secure`/`SameSite=Lax`. Verify by curl-ing `/api/auth/sign-in/...` on production and reading `Set-Cookie`.
3. **Dynamic CSRF PoC.** The SEC-01 analysis is static. Once CORS is tightened, confirm by running an attacker-origin page that attempts `POST /api/auth/set-username` and verifies the browser blocks it.
4. **MCP worker auth surface.** I inspected the service-binding pattern but did not walk every MCP tool to confirm each one enforces the injected user. List `web/workers/mcp-api/src/` tools and verify per-tool auth next round.
5. **wrangler.toml binding audit.** I did not enumerate every KV/R2/D1 binding across all four workers to check for accidental cross-environment bindings (e.g., prod worker pointing at dev D1).
6. **IGC / XCTask parser fuzzing.** `parseIGC` and `parseXCTask` handle untrusted files but have not been fuzzed. Candidate for a property-based test round.
7. **Frontend supply chain.** `web/frontend/public/` includes bundled Google Fonts metadata and a service worker (`sw.js`) — neither was read this round.
8. **Cloudflare zone settings.** HSTS, TLS min version, WAF rules, bot management are zone-level and live outside the repo; ask an operator to snapshot current settings into a doc.

---

### Historical findings index

Prior audits documented bugs B-01..B-34 in `docs/audit-2026-03-04.md`. Most XSS/security-adjacent items were fixed:
- `BUG-01` (XSS via unescaped HTML from IGC/XCTask) — **Fixed** (escapeHtml helpers applied). Structural concern remains under SEC-05.
- `BUG-06` (inverted IGC validation in airscore worker) — **Fixed**.
- `BUG-26` (wildcard CORS on airscore worker) — still worth re-checking under this review's SEC-01 lens; the airscore worker is a read-only proxy so exposure is lower, but open-proxy abuse of AirScore is still possible.
- `BUG-27` (negative IDs in airscore task handler) — re-check.

When re-running this review, start by diffing current `HEAD` against commit referenced above and re-evaluating SEC-01..SEC-09 specifically.
