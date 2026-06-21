# GlideComp Security Review

> **Purpose:** Living memory log for security audits. Each review should append a new dated section and mark prior findings as `Fixed` / `Open` / `Accepted`, preserving history so we can spot regressions.

---

## Review Log

| Date       | Reviewer | Scope                            | Status       |
|------------|----------|----------------------------------|--------------|
| 2026-04-20 | Claude   | Full repo (auth, comp, MCP, FE)  | Initial      |
| 2026-04-20 | Claude   | SEC-01 remediation               | Fixed inline |
| 2026-05-04 | Claude   | Re-review + new findings (SEC-10..14) | SEC-10, SEC-11, SEC-12, SEC-14 fixed inline (this PR) |
| 2026-05-11 | Claude   | Re-review + new finding SEC-15        | SEC-15 fixed inline (this PR) |
| 2026-05-18 | Claude   | Re-review (user-files + preferences) + new finding SEC-16 | SEC-16 fixed inline (this PR) |
| 2026-05-25 | Claude   | Re-review (no new app code) + new finding SEC-17; closed SEC-02 | SEC-17 + SEC-02 fixed inline (this PR) |
| 2026-06-01 | Claude   | Re-review (deps + engine bug-fix + auth-api tests); closed SEC-13; SEC-03 reclassified Accepted (by design) | SEC-13 fixed inline (this PR); SEC-03 accepted |
| 2026-06-08 | Claude   | Re-review (only deps landed); closed SEC-04 inline | SEC-04 fixed inline (this PR) |
| 2026-06-11 | Claude   | Re-review (iOS map fix only); new finding SEC-18 (deps); closed SEC-08 inline | SEC-18 + SEC-08 fixed inline (this PR) |
| 2026-06-12 | Claude   | Re-review (no new app code beyond prior review's own PR); closed SEC-06 inline | SEC-06 fixed inline (this PR) |
| 2026-06-20 | Claude   | Re-review (previously-unreviewed UX commit #178 + deps); new finding SEC-19 (dirty `bun audit`, 11 advisories) | SEC-19 fixed inline (this PR) |
| 2026-06-21 | Claude   | Re-review (no new app code); closed scope-gap #3 (parser fuzzing) → new finding SEC-20 (parser robustness) | SEC-20 fixed inline (this PR) |
| 2026-06-21 (II) | Claude | Re-review (no new app code); extended fuzzing to scope-gap #3's leftover paths (XCTSKZ deflate + v2 polyline) → new finding SEC-21 (deflate-path TypeError + unhandled rejection) | SEC-21 fixed inline (this PR) |

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

---

## 2026-05-04 — Re-review

### Methodology

- Diffed `master` vs the prior review commit. Only two commits landed since 2026-04-20: `560ccbd` and `067ebcd` (the security-review doc itself). So most of the surface is unchanged — but the IGC upload now expects gzip-compressed bodies (a flow detail I missed last round) and I re-walked the MCP ↔ competition-api authentication path, which surfaced a new critical issue.
- Re-checked every prior SEC-0x finding against current code (line-by-line, not just commit log).
- Walked the public reachability of every worker by reading each `wrangler.toml` for `[[routes]]` blocks and each Pages Function under `functions/api/`.
- Ran `bun audit` (clean — 0 advisories at HEAD `560ccbd`).
- Did **not** re-run dynamic CSRF PoC, parser fuzzing, or live cookie-attribute checks (still in scope-gaps below).

### Executive summary

`bun audit` is clean and SEC-01 (the previous round's High) remains correctly fixed. **However**, the deeper read of the MCP ↔ competition-api wiring uncovered a **Critical authentication-bypass** (SEC-10): the comp-api auth middleware blindly trusts an `X-Glidecomp-Internal-User` header on **every** request, and the comp-api worker is bound directly to the public route `glidecomp.com/api/comp/*` (`web/workers/competition-api/wrangler.toml` lines beginning with `[[routes]]`). Anyone on the internet can set that header to impersonate any GlideComp user. This needs a fix before the next deploy. The other new findings are an unbounded-decompression vector on the IGC upload path (SEC-11), a `_headers` regression (SEC-02 still open), and the same admin-email leak (SEC-03 still open).

### Status of prior findings

| ID      | Title                                                                | Status @ 2026-05-04 | Notes                                                                 |
|---------|----------------------------------------------------------------------|--------------------|------------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                       | **Fixed**          | Allowlist confirmed at `web/workers/auth-api/src/index.ts:12-31` and `web/workers/competition-api/src/index.ts:22-42`. Empty origin returned for disallowed callers. |
| SEC-02  | No security response headers (`_headers`)                            | **Open**           | `find web/frontend/public -name _headers` still empty.                 |
| SEC-03  | Admin emails returned on public comp detail                          | **Open**           | `web/workers/competition-api/src/routes/comp.ts:243-250, 303` unchanged — public response still includes `u.email`. |
| SEC-04  | IGC upload size/shape                                                | **Open (evolved)** | Still 5 MB cap, no `Content-Type` check. The route now expects gzip — see SEC-11 for the new spin on this. |
| SEC-05  | `innerHTML` is the default render primitive                          | **Open**           | 116 `innerHTML =` sites under `web/frontend/src/`. Spot-checked recent additions (`scores.ts`, `comp-detail.ts:1316-1349`) — `escapeHtml()` is applied to user-controlled text but the pattern is still per-author discipline. |
| SEC-06  | No JSON body-size cap                                                | **Open**           | No `bodyLimit` middleware registered. `xctsk: z.record(z.unknown())` (`validators.ts:170`) still allows unbounded JSON. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname               | **Verified safe**  | `web/workers/auth-api/wrangler.toml` sets `BETTER_AUTH_URL = "https://glidecomp.com"`. `isLocalDev` (`auth.ts:7-13`) only matches `localhost`. Re-flag for verification on every deploy. |
| SEC-08  | Rate-limit headers not surfaced                                      | **Open**           | Unchanged.                                                             |
| SEC-09  | `Math.random()` non-security use                                     | **Closed (Info)**  | No new uses found; mark as informational and stop re-checking unless a regression appears. |

### New findings

---

#### SEC-10 — Authentication bypass via trusted `X-Glidecomp-Internal-User` header on publicly-reachable competition-api — **Critical** — ~~Open~~ **Fixed (2026-05-04, this PR)**

> **Resolution:** the comp-api auth middleware no longer reads any "trust me, I am user X" header. It only resolves identity via auth-api by forwarding inbound credentials — `cookie` for browsers, `x-api-key` for MCP/programmatic callers. The MCP worker stops forging a user header and instead passes the caller's API key through as `x-api-key`; auth-api's `enableSessionForAPIKeys` resolves it to the same `{ user }` shape. `INTERNAL_USER_HEADER` and the trust check are deleted (`web/workers/competition-api/src/middleware/auth.ts` and `web/workers/mcp-api/src/util.ts`). Regression tests cover the bypass attempt and the cookie-still-works sanity check (`web/workers/competition-api/test/auth-bypass.test.ts`).

**Files**
- `web/workers/competition-api/src/middleware/auth.ts:8-37` — defines and trusts the header
- `web/workers/competition-api/wrangler.toml` (the `[[routes]]` blocks at the bottom) — binds the worker to the public hostname
- `web/workers/mcp-api/src/util.ts:31-101` — the only legitimate setter

The comp-api auth middleware:

```ts
const internalUser = headers.get(INTERNAL_USER_HEADER);
if (internalUser) {
  try {
    return JSON.parse(internalUser) as AuthUser;
  } catch { return null; }
}
// fall through to cookie session via auth-api
```

The comment in `web/workers/mcp-api/src/util.ts:30-34` claims "Service bindings are internal-only (not reachable from the internet), so this is safe." That is true of the **MCP worker**, but it is **not** true of the **competition-api worker**: `wrangler.toml` binds the comp-api directly to the public route:

```toml
[[routes]]
pattern = "glidecomp.com/api/comp/*"
zone_name = "glidecomp.com"
```

So a request `POST https://glidecomp.com/api/comp` with header
`X-Glidecomp-Internal-User: {"id":"<victim-user-id>","name":"x","email":"x@x.com"}`
hits the worker directly, the auth middleware reads the header, and treats the request as authenticated as `<victim-user-id>`. No cookie, no Bearer token, no service binding — just a plaintext header an attacker controls.

**Impact**

- Account impersonation across every comp-api endpoint that uses `requireAuth` (everything in `routes/comp.ts`, `task.ts`, `igc.ts`, `pilot.ts`, `pilot-status.ts`).
- `requireCompAdmin` only blocks the attacker if they don't know a victim user-ID. User-IDs are emitted in audit-log payloads and admin lists, and are guessable Better-Auth-style cuid/uuid strings — but even an *unprivileged* user-ID lets the attacker (a) create up to the 50-comp cap as that user, (b) burn the user's API-key rate limit, (c) author audit-log entries attributed to that user, (d) pilot-self-mark on any open-upload comp.
- Combined with the predictable user-ID leak via `audit_log.actor_user_id` (currently *not* echoed by `routes/audit.ts:97-108`, but it is by `routes/comp.ts` admin lists which return name+email — though not user_id directly), the path to admin impersonation is shorter than ideal.
- Not flagged by `bun audit`, not flagged by Better Auth — this is a homegrown trust boundary error.

**Remediation (pick one)**

1. **Strip the header at the edge.** In `web/workers/competition-api/src/index.ts`, before any route runs, delete the header from `c.req.raw.headers` (use `Headers.delete`) — then re-add it only for genuinely service-bound traffic via a shared-secret check. This is the smallest diff but requires the MCP worker to also send the secret.
2. **Replace the header with HMAC.** Have the MCP worker sign `{user, timestamp}` with `BETTER_AUTH_SECRET` (or a new shared secret bound to both workers), and verify the signature in the middleware. Reject any request whose signature is missing or invalid.
3. **Stop forging sessions.** Have the MCP worker call comp-api with a real Better-Auth API-key Authorization header and have comp-api's middleware resolve it via the auth-api the same way it resolves cookies. Slowest to implement but eliminates the whole class of issue.

Option (2) is the smallest diff that closes the bypass. Add a regression test that asserts an external `X-Glidecomp-Internal-User` header is **not** trusted (mock the SELF fetch in `competition-api/test/helpers.ts`).

**How I confirmed**
- Read all three `wrangler.toml` files for `[[routes]]` patterns. Only the comp-api and auth-api workers have public routes (airscore-api also does, but it has no auth surface). Pages Function `functions/api/comp/[[path]].ts` proxies the original `Request` (headers and all) via `context.env.COMPETITION_API.fetch(context.request)`, so even traffic that goes through Pages still carries the attacker-controlled header.
- Cloudflare does not strip arbitrary client headers. Only a small allowlist of `cf-*` headers is managed by the platform.
- Searched the entire codebase for header-stripping logic: `grep -rn "X-Glidecomp-Internal-User"` returns only the setter (`util.ts`) and the trust point (`middleware/auth.ts`). No middleware deletes it on inbound traffic.

---

#### SEC-11 — IGC upload accepts gzip-compressed body without decompressed-size cap (zip-bomb) — **High** — ~~Open~~ **Fixed (2026-05-04, this PR)**

> **Resolution:** new helper `validateAndDecompressIgc()` in `web/workers/competition-api/src/igc-validation.ts` enforces three independent caps in cheapest-to-check order: (1) compressed size cap of 1 MiB (down from 5 MiB), (2) gzip magic check (`0x1f 0x8b`), (3) streaming decompressed cap of 2 MiB enforced by a counting `TransformStream` that errors the pipeline the moment the cap is exceeded — never buffers more than the cap. Both upload routes (`web/workers/competition-api/src/routes/igc.ts` self-upload and on-behalf) call the helper before touching R2, so non-gzip blobs and bombs are rejected with 400 instead of being stored. Six new helper tests in `web/workers/competition-api/test/igc-validation.test.ts` cover empty / oversize-compressed / non-gzip / corrupt-gzip / decompressed-too-large / boundary-at-cap. The bomb test confirms the size protection works end-to-end (compressed body < 1 MiB but decompressed would be > 2 MiB → rejected with the typed `decompressed_too_large` error).

**Files**
- `web/workers/competition-api/src/routes/igc.ts:160-238` (self-upload path)
- `web/workers/competition-api/src/routes/igc.ts:443-495` (upload-on-behalf path)

Since the IGC route was rewritten to expect gzip-compressed bodies, the 5 MB `MAX_IGC_SIZE` check applies to the **compressed** byte length:

```ts
const body = await c.req.arrayBuffer();
if (body.byteLength > MAX_IGC_SIZE) { ... }    // 5 MB compressed
...
const decompressedStream = new Response(body).body!.pipeThrough(new DecompressionStream("gzip"));
const igcText = new TextDecoder().decode(await new Response(decompressedStream).arrayBuffer());
```

A 5 MB blob of repeating zeros gzips to ~5 KB; the inverse — a ~5 MB highly-compressible gzip — decompresses to **gigabytes**. That entire decompressed buffer is then materialised in memory and handed to `parseIGC`. Cloudflare Workers cap memory at 128 MB and are CPU-budgeted; a single attacker request can trip OOM / CPU-limit and fail the request, and a small number of concurrent requests can degrade the worker.

This subsumes the original SEC-04 ("no content-type or shape check") with a more concrete failure mode. The shape check noted in SEC-04 is still missing too: arbitrary 5 MB blobs are uploaded into R2 even if the body fails to gzip-decompress (the try/catch swallows the parse error and stores the raw blob anyway).

**Remediation**

- After decompression, enforce a decompressed-size cap (e.g. 2 MB). Either read the stream in chunks and abort past the cap, or buffer with a counter — both are straightforward with `ReadableStream`. Don't `arrayBuffer()` the unbounded stream.
- Reject `body.byteLength === 0` *and* require the first two bytes to be the gzip magic `0x1f 0x8b` before decompressing. This kills both the gzip-bomb and the "store random bytes in R2" abuse.
- Confirm that what was decompressed actually starts with `A` (manufacturer record) before passing to `parseIGC` — same pattern already used in `airscore-api/src/handlers/track.ts:14-16` (`isValidIgcContent`).
- Lower `MAX_IGC_SIZE` to ~512 KB compressed; real IGC files are very compressible.

Combined with SEC-10, this is currently exploitable without authentication if an attacker forges the internal header.

---

#### SEC-12 — `xctsk` task body has no shape, depth, or size cap — **Medium** — ~~Open~~ **Fixed (2026-05-04, this PR)**

> **Resolution:** the `xctsk` field on create-task and update-task is now validated by a strict Zod schema (`xctskSchema` in `web/workers/competition-api/src/validators.ts`) that mirrors the engine's `XCTask` interface. Limits chosen to be 16–100× generous against the largest real-world sample (verified: all 7 samples in `web/frontend/public/data/tasks/` and `web/samples/comps/` validate): max 50 turnpoints, max 100 timeGates, name/description ≤ 64 chars, lat/lon range-checked, radius 1–50000 m, taskType ≤ 32 chars. `.strict()` rejects unknown keys (so spec extensions don't silently bloat D1 with attacker-controlled junk). Backstop: a top-level refine asserts `JSON.stringify(value).length ≤ 32 KB` — structurally unreachable through current per-field limits but catches future spec extensions that bypass them. Nine new tests in `web/workers/competition-api/test/xctsk-validation.test.ts` cover happy path, the all-maxed-fields sanity case, and every rejection path (oversize array, oversize string, out-of-range coord/radius, invalid enum, deep-nesting via unknown key).

**File:** `web/workers/competition-api/src/validators.ts:170, 180` — `xctsk: z.record(z.unknown()).nullable().optional()`

`xctsk` accepts arbitrary JSON of any shape, depth, or size, then `JSON.stringify`s it into D1. Cloudflare's 100 MB request cap is the only ceiling. A few concrete consequences:

- Admins can store arbitrary blobs in D1 by uploading them as `xctsk`; D1 row size and storage cost grow.
- `summarizeXctskChange` and `describeTaskSummary` (`web/workers/competition-api/src/xctsk-summary.ts`) walk the JSON. Pathological shapes (deep nesting, huge arrays) could spike CPU.
- The frontend `JSON.parse`s the value and renders task waypoints — same content-shape concern downstream.

Authentication-required (admin-only), so severity stays Medium. Pair the fix with the global `bodyLimit` middleware in SEC-06 and add a Zod schema that mirrors the documented XCTSK structure (waypoints, taskType, etc.) instead of `z.record(z.unknown())`.

---

#### SEC-13 — Service worker stores share-target uploads under unsanitised filenames — **Low** — Open

**File:** `web/frontend/public/sw.js:42-65`

```js
for (const file of files) {
  const response = new Response(file, { headers: { ..., 'X-File-Name': file.name } });
  await cache.put(`/shared-file/${file.name}`, response);
}
```

`file.name` comes from another app on the device via the Web Share Target API. The name is interpolated directly into the cache-key URL and into a response header. Cache keys must parse as valid Request URLs; bizarre names (containing `?`, `#`, `..`, encoded NULs, etc.) will either silently fail to round-trip or land in unexpected cache entries. Same for `X-File-Name` — control characters in the value would break header parsing on the consumer.

Not exploitable across origins (the share target only fires for files the user explicitly shares from another app on their own device), so severity is Low. Worth fixing for robustness:
- `encodeURIComponent(file.name)` for the cache-key path component.
- Strip CR/LF and other control chars before using in `X-File-Name`, or drop the header and rely on the cache key.

---

#### SEC-14 — Service-binding trust comment misleads readers — **Info** — ~~Open~~ **Fixed (2026-05-04, this PR)**

The misleading comment was deleted as part of the SEC-10 fix when `web/workers/mcp-api/src/util.ts` was rewritten to forward the inbound API key instead of forging a user identity header. The new comment explicitly calls out "Do NOT forge identity headers here — that's what SEC-10 was about."

---

### Re-checked but no change

- **SQL injection.** Spot-checked the new `routes/audit.ts` (`audit.ts:71-89` builds `clauses.join(" AND ")` from a fixed list, never from user input), `routes/pilot-status.ts`, and `routes/pilot.ts`. All bind parameters. No new SQL concerns.
- **Sqids decoding.** `decodeId` returns `null` on invalid input and the route handlers null-check it via `sqidsMiddleware`. Negative or zero IDs would be rejected at parse time.
- **Better Auth secrets.** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` are referenced as `env` fields, not hard-coded. `wrangler.toml` only has the URL.
- **API key prefix.** Still `glc_` (auth.ts:39) — keep this.

### Scope gaps still not done

Carried forward from 2026-04-20:

1. Dynamic CSRF PoC against the now-allowlisted CORS (low-effort follow-up).
2. Cookie attribute verification on a live deploy.
3. **Per-tool MCP auth audit.** I read `mcp-api/src/index.ts` and `tools/competitions.ts` — every tool delegates to `compApi(env, user, ...)` which forwards the user via `X-Glidecomp-Internal-User`. Once SEC-10 is fixed, re-walk to confirm all tools propagate the user (no tool short-circuits to admin).
4. wrangler.toml binding cross-environment audit — partially done this round (routes only); KV/R2/D1 binding ID review still pending.
5. IGC / XCTask parser fuzzing.
6. Cloudflare zone settings snapshot.

New gaps from this round:

7. Confirm the comp-api worker doesn't also accept the legacy `Cookie: test-user=...` header in production. The `cookie` is forwarded to `auth-api` for resolution; if `auth-api` honours it in prod, we have a second test-only backdoor. Quick check: `grep -rn "test-user" web/workers/auth-api/src/` returned nothing — looks safe — but worth verifying that the test middleware isn't shipped.
8. Frontend `web/frontend/public/sw.js` — full security walk (started under SEC-13, not finished).

### Where to start the next review

1. No remaining Critical / High / Medium-exploitable items. Open work is SEC-02 (security headers `_headers` file), SEC-03 (admin emails on public endpoint), SEC-05 (innerHTML pattern), SEC-06 (no global JSON body cap), SEC-08 (rate-limit headers), SEC-13 (share-target filename sanitisation) — all Medium or below.
2. `git log` since `560ccbd` to spot any new mutating endpoints; for each, verify (a) authn middleware, (b) authz middleware, (c) audit() call, (d) Zod validator with bounded fields.
3. `bun audit` and a fresh diff of `docs/dependency-review-log.md`.
4. Re-run the whole prior-findings table; update Status column.
5. Confirm the SEC-10 fix held: send `X-Glidecomp-Internal-User` to a deployed comp-api endpoint and check it gets 401 (regression test only covers the in-process miniflare path).

---

## 2026-05-11 — Re-review

### Methodology

- Read `docs/security-review.md` end-to-end first, including the prior round's "Scope gaps" and "Where to start" pointers. Carried those into this round's scope.
- Diffed `master` vs the prior review's landing commit `cb9cc7c` (`git log cb9cc7c..HEAD`). Six commits landed: `3174b47` and `890d3de` (dep upgrades — 9 advisories fixed), `36e17d8` (this `/security-review-repo` command itself), `6464783` and `c3f9263` (D1 migration consolidation + dev-server fixes), `1f45c6e` (delete a no-op `docker-entrypoint.sh`). No new mutating endpoints were added; the only worker-source changes are the SEC-10/11/12 fixes already documented and a leaflet popup `innerHTML→createElement` cleanup (`web/frontend/src/analysis/leaflet-provider.ts:774-783`).
- Ran `bun audit` at HEAD — **0 vulnerabilities**.
- Re-walked every prior `SEC-NN` finding line-by-line against current code (not just commit log).
- Closed prior scope gap "Per-tool MCP auth audit" by enumerating every `compApi(env, apiKey, …)` / `compApiRaw(env, apiKey, …)` callsite under `web/workers/mcp-api/src/tools/*.ts`. Every tool threads the inbound API key unconditionally — no tool short-circuits to admin or to a hard-coded user.
- Closed prior scope gap "wrangler.toml binding cross-environment audit (KV/R2/D1)" by reading every `wrangler.toml`. All bindings point to single canonical production IDs; auth-api and competition-api share the **same** D1 (`taskscore-auth`, id `aa8b644f-368e-493a-8b49-1af0d756aff4`) which is intentional (Better Auth's user table is the same table comp-admin foreign-keys into). No cross-env confusion.
- Closed prior scope gap "sw.js full walk" — SEC-13 still Open with the same root cause; no new issues in the rest of the service worker (no caching, no message handlers, just `/share-target`).
- Did **not** re-run dynamic CSRF PoC, parser fuzzing, or live cookie-attribute checks — still in scope-gaps below.

### Executive summary

`bun audit` is clean. The SEC-10 / SEC-11 / SEC-12 fixes from the previous round hold: the comp-api auth middleware still resolves identity only via auth-api (no `X-Glidecomp-Internal-User` read), the IGC upload still goes through `validateAndDecompressIgc` with both caps, and `xctsk` is still constrained by the strict Zod schema. **However**, walking the read-side endpoints surfaced a new **High** finding: `GET /api/comp/:comp_id/pilot` is publicly readable (it uses `optionalAuth`) and was returning the full pilot row to anonymous callers — including admin-entered `email`, the linked Better Auth account email (`linked_email`), and `driver_contact` (emergency-contact phone). **Fixed inline in this PR** by gating those three PII fields on `comp_admin` membership, plus four new regression tests covering anonymous, authenticated-non-admin, comp-admin, and a `linked_email`-leak path. Public callers still see names, classes, teams, glider, and national-body IDs — the fields that already appear on every comp's public results page.

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-05-11 | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Re-verified `web/workers/auth-api/src/index.ts:12-32` and `web/workers/competition-api/src/index.ts:22-42` — allowlist unchanged, empty origin returned for disallowed callers. |
| SEC-02  | No security response headers (`_headers`)                              | **Open**            | `find web/frontend/public -name _headers` still empty.               |
| SEC-03  | Admin emails returned on public comp detail                            | **Open**            | `web/workers/competition-api/src/routes/comp.ts:243-250, 303` unchanged. |
| SEC-04  | IGC upload size/shape                                                  | **Open (sub-issue)** | Subsumed by SEC-11's helper for size + gzip-magic. The remaining gap is the recommended manufacturer-record (`A…`) check — `validateAndDecompressIgc` does not verify the decompressed first byte, so up to 2 MiB of non-IGC text can still be stored in R2 per registered pilot per task. Auth-gated and bounded; tracking as Low. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | 116 `innerHTML =` sites under `web/frontend/src/` — same count as prior round. One new site converted to DOM construction (`web/frontend/src/analysis/leaflet-provider.ts:774-783`, popup event description). All other interpolations of user data go through `sanitizeText()` (HTML-encodes per `web/engine/src/sanitize.ts:7-15`) or `escapeHtml()`. |
| SEC-06  | No JSON body-size cap                                                  | **Open**            | No `bodyLimit` middleware registered. Hono 4.12.18 (now in tree) fixes the chunked-body bypass — adopting `bodyLimit({ maxSize: 256 * 1024 })` is now safe whenever it's prioritised. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged. Re-flag for verification on every deploy.                 |
| SEC-08  | Rate-limit headers not surfaced                                        | **Open**            | Unchanged.                                                           |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `web/workers/competition-api/src/middleware/auth.ts:15-32` unchanged from the fix; `web/workers/mcp-api/src/util.ts:16-52` forwards `x-api-key` only. Regression test `web/workers/competition-api/test/auth-bypass.test.ts` still passes. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `web/workers/competition-api/src/igc-validation.ts:43-110` unchanged; route still calls `validateAndDecompressIgc` (`routes/igc.ts:170`, `:449`). All `igc-validation.test.ts` tests pass. |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `web/workers/competition-api/src/validators.ts:228-248` unchanged. Tests in `xctsk-validation.test.ts` pass. |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | **Open**            | `web/frontend/public/sw.js:54-62` unchanged.                         |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix; comment in `util.ts:13` now warns against forging identity headers. |

### New findings

---

#### SEC-15 — Unauthenticated PII (email + linked Better Auth email + driver_contact) returned by public pilot list — **High** — ~~Open~~ **Fixed (2026-05-11, this PR)**

> **Resolution:** `GET /api/comp/:comp_id/pilot` is still publicly readable for non-test comps (names, classes, teams, glider, and national-body IDs are intentionally public), but the PII fields — admin-entered `email`, Better-Auth-linked `linked_email`, and `driver_contact` (emergency-contact phone) — are now redacted to `null` for any caller who is not a `comp_admin` of that comp. The new helper `serializeCompPilotPublic` in `web/workers/competition-api/src/routes/pilot.ts` wraps `serializeCompPilot` and zeros out the three sensitive fields; the GET handler resolves `isAdmin` once via the existing `comp_admin` join and dispatches between the two serialisers. Four new regression tests in `web/workers/competition-api/test/pilot-crud.test.ts` cover: anonymous caller (redacted, including a seeded `linked_email` path that exercises the worst-case JOIN-leak), authenticated-non-admin caller (redacted), comp-admin caller (full data — regression sanity), and admin GET keeping all PII fields populated. All 229 competition-api tests pass.

**Files**
- `web/workers/competition-api/src/routes/pilot.ts:348-401` — GET handler (pre-fix used `serializeCompPilot` for everyone)
- `web/workers/competition-api/src/routes/pilot.ts:88-111` — pre-existing `serializeCompPilot` returns full PII
- `web/frontend/src/comp/pilots-section.ts:118-133, 178-189` — frontend renders public table + a tooltip that revealed `linked_email` even for anonymous viewers

**Evidence (pre-fix)**

The route declared `optionalAuth`, then test-comp-gated only on the `comp.test` flag:

```ts
// ── GET /api/comp/:comp_id/pilot ── List registered pilots for a comp
.get(
  "/api/comp/:comp_id/pilot",
  optionalAuth,
  sqidsMiddleware,
  async (c) => {
    ...
    if (comp.test) { /* admin-only */ }
    // FALL THROUGH: anonymous callers receive every field
    const pilots = await c.env.DB.prepare(
      `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, u.email AS linked_email …`)
      .bind(compId).all<…>();
    return c.json({
      pilots: pilots.results.map((p) => serializeCompPilot(alphabet, p)),
    });
  }
)
```

`serializeCompPilot` returned `email`, `linked_email`, and `driver_contact` verbatim. The frontend's `nameCell()` set `icon.title = \`Linked to ${linked_email}\`` for the link badge, surfacing the Better Auth account email to anonymous viewers on hover; the public table also column-rendered `driver_contact`. The CSV export (admin-only by UI) and the edit-as-text dialog round-trip every field, which is why the field was on the wire to start with.

**Impact**

- Unauthenticated read of personal email addresses for every registered pilot in every non-test comp. Trivial to enumerate (sqids are short; comp IDs are not secrets).
- Unauthenticated read of `linked_email` — the Better Auth account email — for pilots who have linked their accounts. This binds platform identity to comp identity in a way the pilot didn't consent to.
- Unauthenticated read of `driver_contact`, which carries phone numbers / WhatsApp handles of emergency contacts (free-form `MAX_TEXT=128` string).
- Phishing risk: a pilot directory by-name with emails is exactly what a targeted phishing campaign against a competition would want.
- Not flagged by `bun audit` (it's a logic flaw, not a CVE).

**Severity rationale**

Higher than SEC-03 (admin emails on public comp detail, Medium) because the population is much larger (every registered pilot, not just admins) and the data is broader (phone numbers and a second-channel email join). Not Critical because authentication itself is intact — names and rankings are public by design and the leak doesn't grant any write surface — but PII leakage of an entire user base unauthenticated is High in any threat model.

**Fix**

```ts
// pilot.ts: gate PII on comp_admin membership; keep public visibility of
// names/IDs/classes for transparency.
const isAdmin = user
  ? !!(await c.env.DB.prepare(
      "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
    ).bind(compId, user.id).first())
  : false;
if (comp.test && !isAdmin) return c.json({ error: "Not found" }, 404);
…
const serialize = isAdmin ? serializeCompPilot : serializeCompPilotPublic;
return c.json({ pilots: pilots.results.map((p) => serialize(alphabet, p)) });
```

`serializeCompPilotPublic` calls `serializeCompPilot` and then nulls out `email`, `linked_email`, and `driver_contact`. Keeping the key set identical means the frontend `CompPilot` interface (`web/frontend/src/comp/pilots-section.ts:23-41`) needs no changes; `linked_email`-dependent tooltip falls back to its existing null-handling branch.

**Regression tests** (new, in `pilot-crud.test.ts`):
1. **Anonymous caller** sees `email = linked_email = driver_contact = null` but `name`, `civl_id`, `linked` populated. Seeds a `pilot` row with `user-3` so the `LEFT JOIN "user"` populates `linked_email` server-side and we can verify the public path zeroes it.
2. **Admin caller** sees `email` and `driver_contact` populated (regression sanity — fix must not break admin flows).
3. **Authenticated-non-admin caller** (`user-2`) sees the same redacted view as anonymous — admin status is not granted by being signed in, only by `comp_admin` row.
4. *(Implicit)* The existing "returns full records" test for the admin caller still passes.

---

### Re-checked but no change

- **Parameterised SQL.** Spot-checked every prepare-and-bind site touched in this round (`pilot.ts`, `comp.ts`, `audit.ts`). No string concatenation into SQL.
- **`audit()` call coverage.** Every mutating route in `web/workers/competition-api/src/routes/*.ts` calls `audit()` per CLAUDE.md; descriptions use `describeChange()` or include subject names. No new mutating routes since prior round, so no new audit gaps.
- **MCP per-tool auth propagation.** Every tool under `web/workers/mcp-api/src/tools/*.ts` forwards `apiKey` via `compApi(env, apiKey, …)` or `compApiRaw(env, apiKey, …)`. None forge identity, none short-circuit to admin.
- **wrangler.toml bindings.** All four workers point at single canonical production resource IDs. Auth-api and competition-api intentionally share D1 (`taskscore-auth`); MCP worker uses service bindings to both. No preview-vs-prod confusion.
- **Audit log response.** `web/workers/competition-api/src/routes/audit.ts:96-112` still returns `actor_name` (not `actor_user_id`) — no user-ID leak from the public audit endpoint, despite the row in D1 storing it.
- **Sqids decoding.** `decodeId` rejects malformed input and `sqidsMiddleware` 404s on null. No new routes bypass the middleware.
- **Better Auth secrets.** All referenced as env, none hard-coded.

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the now-allowlisted CORS (low-effort follow-up).
2. Cookie attribute verification on a live deploy.
3. IGC / XCTask parser fuzzing.
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just miniflare regression test).
6. Confirm the comp-api worker doesn't accept the legacy `Cookie: test-user=…` header in production. The cookie is forwarded to `auth-api`; `grep` shows no `test-user` reference in `auth-api/src` but worth verifying that no test-middleware gets shipped.

New gap from this round:

7. **Other `optionalAuth` endpoints.** SEC-15 surfaced because the pilot list joins user emails. Audit every other `optionalAuth` route (`comp.ts:145`, `:210`; `task.ts:125`; `igc.ts:605`, `:704`; `audit.ts:28`; `pilot-status.ts:121`; `score.ts:24`, `:95`) for similar joins to the `user` table or PII columns. Spot-checks this round were clean (audit returns only `actor_name`, scores have no email columns), but a systematic pass would close the class.

### Where to start the next review

1. Commit reviewed up to: HEAD = `1f45c6e` (parent of this review's PR). Diff against that next round.
2. Run the **scope gap #7** systematic pass: for every `optionalAuth` route under `web/workers/competition-api/src/routes/`, list the SELECT columns and confirm no PII is returned to unauthenticated callers. Same class of bug as SEC-15.
3. Re-run the prior-findings table; SEC-02, SEC-03, SEC-05, SEC-06, SEC-08, SEC-13 are all Open and small-diff candidates if the round has spare scope budget — none are urgent.
4. `bun audit` + fresh diff of `docs/dependency-review-log.md`.
5. Walk any new mutating endpoints (authn / authz / `audit()` / Zod) — none added this round.
6. Confirm the SEC-15 fix is live: `curl -s https://glidecomp.com/api/comp/<some-public-comp>/pilot | jq '.pilots[0] | {email, linked_email, driver_contact}'` should be all-null.

---

## 2026-05-18 — Re-review

### Methodology

- Read `docs/security-review.md` end-to-end first, carrying the prior round's "Scope gaps" and "Where to start" pointers into this round's scope.
- Diffed `master` vs the prior review's landing commit `f9fbcf9` (`git log f9fbcf9..HEAD`). Three commits landed since: `3689fac` (sync user preferences to cloud storage — adds `routes/preferences.ts` on auth-api plus a sync layer in the frontend), `cb35e70` (gitignore-only), and `03760b4` (move user-uploaded files from browser IndexedDB to R2/D1 — adds `routes/user-files.ts` on competition-api, R2 binding on auth-api for cascading delete, and frontend `analysis/storage.ts` rewrite). Diff stat: 4582 insertions across 49 files, with `routes/user-files.ts` (+778 LOC) and `routes/preferences.ts` (+141 LOC) the new mutating surface.
- Audited every new mutating endpoint (eight on `/api/user/*`, three on `/api/u/:username/*` public-by-link reads, two on `/api/auth/preferences`) for (a) authn middleware, (b) authz scoping, (c) Zod / regex validation with bounded fields, (d) parameterised SQL, (e) `audit()` requirement. None of the new endpoints touch competition state, so per CLAUDE.md the `audit()` requirement doesn't apply (the per-user delete trail is intentionally not exposed).
- Closed the prior round's only remaining systematic scope gap (#7) by walking every `optionalAuth` route under `web/workers/competition-api/src/routes/` — `comp.ts:145, 210`, `task.ts:125`, `igc.ts:605, 704`, `audit.ts:28`, `score.ts:24, 95`, `pilot-status.ts:121`, `pilot.ts:386`, `user-files.ts:694, 729, 751` — listing the SELECT columns each returns. SEC-15 was the only finding; the audit endpoint emits `actor_name` not `actor_user_id`, scores emit only `pilot_name` + `comp_pilot_id`, igc list emits `uploaded_by_name` but not `uploaded_by_user_id`, and the user-files public reads return file bytes only (no email/phone columns selected). Documented under "Re-checked but no change" so the next round doesn't have to re-walk.
- Ran `bun audit` at HEAD — flagged 1 high: `kysely >=0.26.0 <0.28.17` (JSON-path traversal injection via `JSONPathBuilder.key()` / `.at()`, [GHSA-pv5w-4p9q-p3v2](https://github.com/advisories/GHSA-pv5w-4p9q-p3v2)). See SEC-16.
- Re-walked every prior `SEC-NN` finding line-by-line against current code.
- Did **not** re-run dynamic CSRF PoC, live cookie-attribute checks, IGC/XCTask parser fuzzing, or a Cloudflare zone-settings snapshot — still in scope-gaps below.

### Executive summary

`bun audit` flagged a single **High** transitive dependency: `kysely@0.28.16` is pulled in by `better-auth`'s internal dependency tree (our direct `kysely` is already at the fixed `0.28.17`). The vulnerable code path — `JSONPathBuilder.key()` / `.at()` with user-controlled path legs — is **not reachable** from our code (better-auth's kysely-adapter uses table CRUD, not JSON-path operators), so the practical risk is Low; but the advisory is High and the noisy `bun audit` line risks masking a real finding in future rounds. **Fixed inline in this PR** via a `package.json` `overrides` bump to `"kysely": "^0.28.17"`. `bun audit` is now clean, all 251 competition-api / 21 mcp-api / engine tests still pass. No new findings against the user-files or preferences surface — both endpoints enforce authn (`requireAuth` resolving via the SEC-10 service-binding pattern), bounded validation (Zod + regex for filenames/codes/sha256), parameterised SQL, and the existing IGC size caps (`validateAndDecompressIgc`) on the new `/api/user/tracks` upload. The frontend renderers for the new endpoints route every interpolated user-controlled string through `sanitizeText()` and use sha256-hex / `[a-z0-9_-]+` task codes for attribute interpolation, both of which are HTML-safe.

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-05-18 | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Re-verified `web/workers/auth-api/src/index.ts:12-32` and `web/workers/competition-api/src/index.ts:23-44`. Allowlist unchanged. The new `/api/user/*` and `/api/u/*` route mounts (`competition-api/src/index.ts:46-48`) share `corsConfig` so the allowlist applies to the new surface too. |
| SEC-02  | No security response headers (`_headers`)                              | **Open**            | `find web/frontend/public -name _headers` still empty.               |
| SEC-03  | Admin emails returned on public comp detail                            | **Open**            | `web/workers/competition-api/src/routes/comp.ts:244-250, 303` unchanged. |
| SEC-04  | IGC upload size/shape                                                  | **Open (sub-issue)** | Subsumed by SEC-11 helper. Manufacturer-record (`A…`) check still not enforced; up to 2 MiB of non-IGC text can sit in R2 per registered pilot per task, and now also per-user under `u/{user_id}/track/{sha256}.igc.gz`. Auth-gated, bounded; staying Low. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | The new `web/frontend/src/dashboard.ts:49-67, 79-97` adds two new `innerHTML =` template-literal sites for the user files dashboard. Both interpolate `track.id` / `task.id` (validated to sha256-hex / `[a-z0-9_-]+` server-side) into attribute positions, and route all human-text fields (`track.name`, `track.filename`, `task.name`, `task.id` for display) through `sanitizeText()`. No new XSS, but the inventory of `innerHTML` template-literal sites is growing. |
| SEC-06  | No JSON body-size cap                                                  | **Open**            | Still no `bodyLimit` middleware. New `/api/user/tracks` calls `c.req.arrayBuffer()` before delegating to `validateAndDecompressIgc` (`web/workers/competition-api/src/routes/user-files.ts:247-250`); a 100 MB attacker body therefore allocates 100 MB transient memory before the helper's 1 MiB compressed cap rejects it. Cloudflare Workers cap memory at 128 MB, so concurrent abusive uploads could trip OOM on a single worker isolate. Low severity in isolation; bundles cleanly with SEC-06's eventual `bodyLimit` fix. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged — `BETTER_AUTH_URL = "https://glidecomp.com"` in `web/workers/auth-api/wrangler.toml:17`. |
| SEC-08  | Rate-limit headers not surfaced                                        | **Open**            | Unchanged.                                                           |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `web/workers/competition-api/src/middleware/auth.ts:15-32` unchanged: forwards only inbound `cookie` / `x-api-key` to auth-api. The new user-files routes use the same `requireAuth` / `optionalAuth` middleware, so no SEC-10-class header trust was reintroduced. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `web/workers/competition-api/src/igc-validation.ts:43-110` unchanged. The new `/api/user/tracks` route reuses the helper (`routes/user-files.ts:250`), so the same 1 MiB compressed + 2 MiB streaming-decompressed caps apply to per-user uploads. |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `web/workers/competition-api/src/validators.ts:228-248` unchanged. The new `/api/user/tasks` route reuses the same schema (`routes/user-files.ts:65-70`), so per-user task uploads inherit the cap. |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | **Open**            | `web/frontend/public/sw.js:54-62` unchanged.                         |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix.                                            |
| SEC-15  | Unauthenticated PII on public pilot list                               | **Fixed**           | `web/workers/competition-api/src/routes/pilot.ts:114-130, 386-419` unchanged. `serializeCompPilotPublic` still zeros `email`, `linked_email`, `driver_contact` for non-admins; admin path still returns full PII. The optionalAuth audit (scope gap #7) confirmed this was the only PII leak in the class. |

### New findings

---

#### SEC-16 — Transitive `kysely@0.28.16` carries CVE GHSA-pv5w-4p9q-p3v2 (JSON-path traversal) — **High (advisory) / Low (reachability)** — ~~Open~~ **Fixed (2026-05-18, this PR)**

> **Resolution:** added `"kysely": "^0.28.17"` to the `overrides` block in the root `package.json` so every transitive resolution snaps to the fixed version. After `bun install`, the lockfile contains a single `kysely@0.28.17` entry (the previous tree had both `auth-api/kysely@0.28.17` and `better-auth/kysely@0.28.16`). `bun audit` reports zero vulnerabilities. All 251 competition-api + 21 mcp-api + engine tests still pass.

**Files**
- `package.json` (overrides block) — fix applied here
- `bun.lock` lines around the two `kysely@*` entries before the fix (post-fix: single entry)
- `web/workers/auth-api/src/auth.ts:4-5, 24-25` — only direct kysely consumer in our code; uses `new Kysely({ dialect: new D1Dialect(...) })` and hands the instance to better-auth; never calls `JSONPathBuilder.key()` / `.at()`.

**Advisory**
- [GHSA-pv5w-4p9q-p3v2](https://github.com/advisories/GHSA-pv5w-4p9q-p3v2) — Kysely: JSON-path traversal injection via unsanitized path-leg metacharacters in `JSONPathBuilder.key()` / `.at()`. CVSS 7.5 (network, low complexity, no privileges, confidentiality impact: High). Vulnerable: `>=0.26.0 <0.28.17`. Fix: `0.28.17`.

**Evidence (pre-fix)**

```
$ bun audit
kysely  >=0.26.0 <0.28.17
  workspace:auth-api › kysely
  workspace:@glidecomp/frontend › better-auth
  workspace:auth-api › kysely-d1
  workspace:auth-api › @better-auth/api-key
  high: Kysely: JSON-path traversal injection via unsanitized path-leg metacharacters in `JSONPathBuilder.key()` / `.at()`
1 vulnerabilities (1 high)
```

The lockfile contained two pinned versions:

```
"kysely": ["kysely@0.28.17", ...                  // direct dep (safe)
"better-auth/kysely": ["kysely@0.28.16", ...      // transitive (vulnerable)
```

`better-auth` resolved its own copy at `0.28.16` because its peerDependency range was `^0.28.14`. Our direct `kysely@^0.28.17` did not deduplicate it.

**Reachability analysis**

The vulnerability is in `JSONPathBuilder.key()` / `.at()` — Kysely's JSON-path query builders. These are used when an application writes queries like `db.selectFrom('user').select(eb => eb.ref('profile', '->').key(userInput).as('city'))`. The attack requires an attacker-controlled path leg flowing into `.key()` / `.at()`.

- Our direct use of Kysely in `web/workers/auth-api/src/auth.ts:24-25` is `new Kysely({ dialect: new D1Dialect({ database: env.glidecomp_auth }) })`. The instance is handed to better-auth; we don't issue any queries with it.
- `better-auth` 1.6.9's kysely-adapter (`node_modules/.bun/@better-auth+kysely-adapter@1.6.9+*/node_modules/@better-auth/kysely-adapter/dist/`) — `grep -rn "JSONPath\|jsonPath\|\.key\|\.at("` returns zero matches. The adapter performs table CRUD only (insert/update/delete/select against the Better Auth schema). User-controlled JSON-column paths never enter the pipeline.

So the practical exposure is Low: nothing in our application code or our dependency graph calls the vulnerable APIs with user-controlled input. The advisory severity is **High** per the public CVSS, but a real-world exploit against this codebase would require a future change in better-auth to start using JSON-path operators.

**Severity rationale**

Documenting as **High (advisory) / Low (reachability)** to keep `bun audit` clean (which is the main signal we use for dependency hygiene) without overclaiming risk. Closing it inline via overrides costs nothing.

**Fix**

```diff
 "overrides": {
   "defu": "^6.1.7",
   "fast-uri": "^3.1.2",
   "hono": "^4.12.18",
   "ip-address": "^10.2.0",
+  "kysely": "^0.28.17",
   "postcss": "^8.5.13",
   "protocol-buffers-schema": "^3.6.1"
 },
```

The override snaps every transitive `kysely` resolution to `^0.28.17`. Post-`bun install` the lockfile has a single `kysely@0.28.17` entry. `bun audit` reports zero vulnerabilities.

**Regression test**

The existing auth-api test suite (`bun run --filter auth-api test`) exercises Better Auth sign-up / sign-in / API key issuance flows end-to-end against a miniflare-backed D1; these all run through the same Kysely instance and pass on the upgraded version. No new test was added — `bun audit` itself is the regression detector and is already part of `/security-review-repo`'s checklist (step 8).

---

### Re-checked but no change

- **SEC-15 class — PII on `optionalAuth` routes.** Walked every `optionalAuth` site and confirmed the SELECT columns are PII-free for unauthenticated callers:
  - `comp.ts:145` (GET `/api/comp`) — `comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, open_igc_upload, pilot_statuses` ∪ admin's own comps (no email/phone/user-id fields).
  - `comp.ts:210` (GET `/api/comp/:comp_id`) — same fields plus `admins: { email, name }` from `comp_admin JOIN "user"`. SEC-03 still tracks the admin-email portion; nothing else newly leaks.
  - `task.ts:125` (GET `/api/comp/:comp_id/task/:task_id`) — `task_id, comp_id, name, task_date, creation_date, xctsk, pilot_classes, track_count`. No user join.
  - `igc.ts:605` (GET task-track list) — selects `uploaded_by_user_id` but never echoes it; response carries `uploaded_by_name` and the boolean `uploaded_on_behalf` only.
  - `igc.ts:704` (download IGC) — streams bytes plus `Content-Disposition` filename; no user-table join.
  - `audit.ts:28` (audit log) — `actor_name, subject_type, subject_id, subject_name, description`; explicitly drops `actor_user_id`. Unchanged from prior round.
  - `score.ts:24, 95` — `pilot_name, comp_pilot_id, total_score, rank`. No PII.
  - `pilot-status.ts:121` — `pilot_name, set_by_name, status_key, note`. No PII.
  - `pilot.ts:386` — `serializeCompPilotPublic` zeros the three PII fields for non-admins (SEC-15 fix).
  - `user-files.ts:694, 729, 751` — public-by-link reads of own-uploaded data; the only user-table join is `resolveUserIdByUsername` which returns `id` server-side and never includes it in the response (404 vs success is the only signal).
- **Authn / authz on the new mutating surface.** Every `/api/user/*` route uses `requireAuth`; ownership is enforced by `WHERE user_id = ?` in every read/update/delete. Annotation routes additionally verify track ownership with a separate `SELECT 1 FROM user_track WHERE user_id = ? AND track_id = ?` before any annotation read/write (`user-files.ts:594-598, 626-631`). No path-traversal: R2 keys are computed from `user.id` (server-side, never client input) and a sha256 of the IGC content, formatted as `u/{user_id}/track/{sha256}.igc.gz`.
- **Input validation on the new surface.** Hand-walked: `task_code` matches `/^[a-z0-9][a-z0-9_-]{0,63}$/`, `stroke_id` matches `/^[A-Za-z0-9_-]{1,64}$/`, `track_id` matches `/^[0-9a-f]{64}$/`, `username` matches `/^[a-zA-Z0-9][a-zA-Z0-9-]{1,18}[a-zA-Z0-9]$/`, filename header capped at 255 chars then ASCII-sanitised before going into `Content-Disposition`. Annotation Zod schema bounds points to ≤2000 [lon,lat] tuples and clamps lon/lat to valid ranges; the serialised JSON is then capped at 64 KB before insert. Task uploads go through `xctskSchema` (the SEC-12 schema). IGC uploads go through `validateAndDecompressIgc` (the SEC-11 helper).
- **Parameterised SQL.** All new prepare+bind sites in `user-files.ts` and `preferences.ts` use `.bind(...)` exclusively; no string concatenation into SQL. The preferences route's `CASE WHEN ? = 1 THEN excluded.X ELSE X END` pattern (`preferences.ts:120-127`) is also fully parameterised — the `?` placeholders take bound integers.
- **Header injection on Content-Disposition.** `asciiHeaderSafe` (`user-files.ts:54-57`) strips everything outside `\x20-\x7E` (printable ASCII), so CR/LF/control chars cannot reach the header value. The `filename*=UTF-8''<encoded>` part uses `encodeURIComponent` for the Unicode value. Tested mentally with a filename of `"; X-Injected: bad\r\n"` — survives only as `bad` after stripping.
- **Cascading delete.** `auth-api`'s `/api/auth/delete-account` (`auth-api/src/index.ts:138-150`) now also wipes every R2 object under `u/{user_id}/` *before* dropping the user row, in batches of 1000 with the truncation cursor. D1 cascades take care of the metadata. The R2 binding was added to `auth-api/wrangler.toml:12-14` for this. Listed-and-bulk-deleted via `R2.list({ prefix }).then(R2.delete(keys[]))`; both APIs accept the same scoped prefix, so a compromised auth-api couldn't escalate to deleting outside `u/{user_id}/`.
- **`audit()` coverage on new endpoints.** Per CLAUDE.md, `audit()` is required for mutations that "affect a competition's scores". The new `/api/user/*` and `/api/auth/preferences` endpoints are per-user state, not competition state, so the requirement doesn't fire. No regression: every existing mutating route under `routes/comp.ts`, `task.ts`, `igc.ts`, `pilot.ts`, `pilot-status.ts` still calls `audit()`.
- **MCP per-tool auth propagation.** Re-verified that every tool under `web/workers/mcp-api/src/tools/*.ts` forwards `apiKey` via `compApi(env, apiKey, …)` / `compApiRaw(env, apiKey, …)`. None forge identity. (Same conclusion as 2026-05-11 round; carried forward.)
- **wrangler.toml bindings.** `competition-api`'s `[[routes]]` now also binds `/api/user/*` and `/api/u/*` (lines 47-57) — both go through the same `requireAuth` / `optionalAuth` resolver, no SEC-10-class internal-header trust. `auth-api` gained a `[[r2_buckets]] binding = "R2"` for cascading delete; the binding shares the `glidecomp` bucket with competition-api by design. No preview-vs-prod cross-wiring.
- **Better Auth secrets.** Still referenced as env, none hard-coded.

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the now-allowlisted CORS.
2. Cookie attribute verification on a live deploy.
3. IGC / XCTask parser fuzzing.
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just miniflare regression test).
6. Confirm the comp-api worker doesn't accept the legacy `Cookie: test-user=…` header in production.

New gap from this round:

7. **Idempotency / TOCTOU on `/api/user/tracks` and `/api/user/tasks` quota checks.** The quota check (`SELECT COUNT(*)`) and the INSERT are non-atomic — two concurrent uploads from the same user can both pass the count check at 499 and end up with 501 stored rows. Severity Low: quotas are advisory and the overshoot is bounded by request concurrency. Worth a follow-up to use `INSERT … RETURNING` + post-insert count, or a SAVEPOINT, if quota correctness ever becomes a billing/security concern. Also: rapid duplicate uploads of the same `(user_id, track_id)` race the existence check and hit a PRIMARY KEY violation on the second INSERT, surfacing as a 500 (via the catch-all in `competition-api/src/index.ts:55-59`); migrating both code paths to `INSERT … ON CONFLICT DO UPDATE` would make them safe under concurrency. Filing as scope-gap rather than SEC-NN because there's no security exposure — it's a UX bug class.

### Where to start the next review

1. Commit reviewed up to: HEAD = `03760b4` (parent of this review's PR). Diff against that next round.
2. `bun audit` should be clean after this PR — if a new vuln pops up, walk the dependency tree first to determine reachability before triaging severity.
3. Re-run the prior-findings table; SEC-02, SEC-03, SEC-05, SEC-06, SEC-08, SEC-13 are still Open. Of these, SEC-02 (`_headers` file) and SEC-06 (`bodyLimit` middleware) are the highest-leverage small-diff wins.
4. Walk any new mutating endpoints (authn / authz / `audit()` / Zod) — focus on whether the per-user model is being extended (e.g. shared task books, public profile pages with PII) since that's the trajectory of recent changes.
5. Re-verify R2-object cleanup on account delete still walks the entire `u/{user_id}/` prefix and doesn't miss new prefixes (e.g. if future features add `u/{user_id}/avatar/...`, the delete-account handler is the source of truth and must be updated).
6. Spot-check the dashboard's two new `innerHTML =` template literals (`web/frontend/src/dashboard.ts:49, 79`) for any interpolated fields that bypass `sanitizeText()`. Both currently look clean.
7. **New for this round:** confirm the kysely override held — `grep "kysely@" bun.lock` should return a single 0.28.17 entry. If better-auth bumps its kysely peer range above 0.28.x in a future release, drop the override.

---

## 2026-05-25 — Re-review

### Methodology

- Read `docs/security-review.md` end-to-end first, carrying the prior round's "Scope gaps" and "Where to start" pointers into this round's scope.
- Diffed `master` vs the prior review's landing commit `03760b4` (`git log 03760b4..HEAD`). **The only commit since is `067c7ed` — the prior review's own PR** (SEC-16 kysely override + the 2026-05-18 doc section). Diff touches just `docs/security-review.md`, `package.json` (the kysely override line), and `bun.lock`. **No new application code landed since the last round** — every `*.ts` under `web/`, every `wrangler.toml`, `functions/`, `sw.js`, and `_redirects` is byte-identical to the 2026-05-18 review. There are therefore no new mutating endpoints, routes, or bindings to audit this round.
- Re-walked every prior `SEC-NN` finding against current code. Because the application source is unchanged, each prior round's line-by-line verification still holds verbatim; this round spot-checked the fix sites to confirm nothing was reverted (`grep` for the SEC-10 trust header → only test/comment references; `validateAndDecompressIgc` caps + gzip-magic present; `xctskSchema` still used instead of `z.record(z.unknown())`; `serializeCompPilotPublic` still zeros the three PII fields; CORS allowlist unchanged on both public workers).
- Ran `bun audit` at HEAD — flagged **2 new moderate** transitive advisories that were not present last round (`qs` via the MCP SDK's express dependency, `ws` via dev/test tooling). See SEC-17. Both fixed inline via `package.json` `overrides`; `bun audit` is now clean again.
- Used the otherwise-quiet round to close the longest-standing Open finding, **SEC-02** (no security response headers), by adding `web/frontend/public/_headers`. See the SEC-02 status row for the staged-rollout rationale.
- Ran `bun run typecheck:all` (clean), `bun run test:all` (green: 251 competition-api + 21 mcp-api + engine/airscore/root suites), and `bun audit` (clean).
- Did **not** re-run dynamic CSRF PoC, live cookie-attribute checks, IGC/XCTask parser fuzzing, or a Cloudflare zone-settings snapshot — still in scope-gaps below. The new `_headers` CSP has **not** been verified against the live Pages deploy (it ships Report-Only precisely so it can't break the site before that verification).

### Executive summary

No new application code landed since 2026-05-18 — the only commit is the prior review's own PR — so there was no fresh attack surface to audit, and re-verification confirmed the SEC-01 / SEC-10 / SEC-11 / SEC-12 / SEC-15 / SEC-16 fixes all hold byte-for-byte. The one new item is **SEC-17**: `bun audit` surfaced two new **moderate** transitive advisories — `qs` (`>=6.11.1 <=6.15.1`, DoS in `qs.stringify`) pulled in via `@modelcontextprotocol/sdk → express`, and `ws` (`>=8.0.0 <8.20.1`, uninitialized-memory disclosure) pulled in via dev/test tooling (`jsdom`, `miniflare`, `wrangler`). Neither is reachable in production (the express HTTP transport is unused on Workers — our `qs` in `mcp-api/src/tools/audit.ts:42` is a local `URLSearchParams` variable, not the library; `ws` never ships to the Workers runtime or the static frontend). **Both fixed inline** via `overrides` bumps to `qs@^6.15.2` / `ws@^8.20.1`; `bun audit` is clean again and all suites pass. With the round otherwise quiet, I also **closed SEC-02** by adding the `web/frontend/public/_headers` file — enforcing `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy`, plus a `Content-Security-Policy-Report-Only` (staged, not enforced, to avoid breaking the live map/fonts before a live-deploy CSP-report pass). No Critical or High findings this round.

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-05-25 | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Re-verified `web/workers/auth-api/src/index.ts:13-33` and `web/workers/competition-api/src/index.ts:23-44`. Allowlist (`glidecomp.com` + `*.glidecomp.pages.dev` + `localhost`) unchanged; empty origin returned for disallowed callers. |
| SEC-02  | No security response headers (`_headers`)                              | ~~Open~~ **Fixed (2026-05-25, this PR)** | Added `web/frontend/public/_headers`. `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), microphone=(), camera=()` are **enforced**. CSP ships as `Content-Security-Policy-Report-Only` (default-src 'self' with allowances for the OSM/OpenTopoMap/ArcGIS tile hosts, Mapbox api/events, Google Fonts, and `blob:` worker/img for Mapbox GL) — Report-Only so it cannot break the live site before a CSP-report pass on the Pages deploy. Flipping to enforce is the new scope-gap #8. |
| SEC-03  | Admin emails returned on public comp detail                            | **Open**            | `web/workers/competition-api/src/routes/comp.ts:243-250, 303` unchanged — public response still includes `u.email`. |
| SEC-04  | IGC upload size/shape                                                  | **Open (sub-issue)** | Subsumed by SEC-11 helper. Manufacturer-record (`A…`) check on the decompressed first byte still not enforced; up to 2 MiB of non-IGC text can sit in R2 per registered pilot per task / per user. Auth-gated, bounded; staying Low. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | 116 `innerHTML =` sites under `web/frontend/src/` — identical count to the 2026-05-18 round (frontend source unchanged). All interpolations of user data still route through `sanitizeText()` / `escapeHtml()`. |
| SEC-06  | No JSON body-size cap                                                  | **Open**            | Still no `bodyLimit` middleware (`grep -rn bodyLimit web/workers/*/src/` → none). Hono 4.12.18 is in tree, so `bodyLimit({ maxSize: 256*1024 })` with a per-route override for IGC remains the documented fix. Deferred (not closed this round) because a wrong cap would break IGC/user-track uploads and a security-review PR shouldn't risk that without local upload testing. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged — `BETTER_AUTH_URL = "https://glidecomp.com"` in `web/workers/auth-api/wrangler.toml`. `isLocalDev` matches `localhost` only. Re-flag for verification on every deploy. |
| SEC-08  | Rate-limit headers not surfaced                                        | **Open**            | Unchanged (`grep -rn "Retry-After\|X-RateLimit" web/workers/auth-api/src/` → none). |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `web/workers/competition-api/src/middleware/auth.ts:15-32` unchanged: forwards only inbound `cookie` / `x-api-key` to auth-api. `grep -rn "X-Glidecomp-Internal-User\|INTERNAL_USER_HEADER" web/workers/` returns only test/comment references in `competition-api/test/auth-bypass.test.ts` and `mcp-api/test/`; no `src` trust path. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `web/workers/competition-api/src/igc-validation.ts:22-79` unchanged (1 MiB compressed + gzip-magic + 2 MiB streaming-decompressed caps). Three callsites (`routes/igc.ts:170, :449`, `routes/user-files.ts:250`). The negative-path tests still pass (the `TypeError: Decompression failed.` log lines during `test:comp` are the corrupt-gzip rejection assertions firing). |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `web/workers/competition-api/src/validators.ts:228` unchanged; used by `createTaskSchema`/`updateTaskSchema` (`:254, :264`) and the user-task route. |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | **Open**            | `web/frontend/public/sw.js:58, 61` unchanged.                        |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix.                                            |
| SEC-15  | Unauthenticated PII on public pilot list                               | **Fixed**           | `web/workers/competition-api/src/routes/pilot.ts:123-130` (`serializeCompPilotPublic` zeros `linked_email` + `driver_contact`) and the `:386` GET handler unchanged. |
| SEC-16  | Transitive `kysely@0.28.16` JSON-path traversal                        | **Fixed**           | Override held: `grep "kysely@" bun.lock` → single `kysely@0.28.17` entry. `bun audit` clean for kysely. |

### New findings

---

#### SEC-17 — Two new moderate transitive advisories: `qs` (DoS) via MCP SDK→express, `ws` (memory disclosure) via dev/test tooling — **Moderate (advisory) / negligible (reachability)** — ~~Open~~ **Fixed (2026-05-25, this PR)**

> **Resolution:** added `"qs": "^6.15.2"` and `"ws": "^8.20.1"` to the `overrides` block in the root `package.json`. After `bun install` the lockfile has a single `qs@6.15.2` and a single `ws@8.21.0` entry (down from the vulnerable `qs@6.15.1` and `ws@8.18.0`). `bun audit` reports zero vulnerabilities. `bun run typecheck:all`, the 251 competition-api tests, the 21 mcp-api tests, and the engine/airscore/root suites all still pass — confirming the `ws` bump didn't break the miniflare-backed test runners (vitest-pool-workers pins `ws@8.18.0` internally; the override forces it to `8.21.0`, an API-compatible minor bump within `8.x`).

**Files**
- `package.json` (overrides block) — fix applied here.
- `bun.lock` — pre-fix had `qs@6.15.1` and `ws@8.18.0`; post-fix a single `qs@6.15.2` and `ws@8.21.0`.
- `web/workers/mcp-api/src/tools/audit.ts:42` — the only `qs` token in our source is `const qs = params.toString()` (a `URLSearchParams`, **not** the `qs` library).

**Advisories**
- [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) — `qs`: remotely-triggerable DoS — `qs.stringify` crashes with a `TypeError` on `null`/`undefined` entries in comma-format arrays when `encodeValuesOnly` is set. Vulnerable: `>=6.11.1 <=6.15.1`. Fix: `6.15.2`. Severity: Moderate.
- [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) — `ws`: uninitialized-memory disclosure in WebSocket frame handling. Vulnerable: `>=8.0.0 <8.20.1`. Fix: `8.20.1`. Severity: Moderate.

**Evidence (pre-fix)**
```
$ bun audit
qs  >=6.11.1 <=6.15.1
  workspace:mcp-api › @modelcontextprotocol/sdk
  moderate: qs has a remotely triggerable DoS …
ws  >=8.0.0 <8.20.1
  workspace:@glidecomp/frontend › jsdom
  workspace:auth-api › @cloudflare/vitest-pool-workers
  workspace:@glidecomp/frontend › wrangler
  moderate: ws: Uninitialized memory disclosure …
2 vulnerabilities (2 moderate)
```

**Reachability analysis**
- **`qs`** is pulled in transitively by `@modelcontextprotocol/sdk → express → {body-parser, express} → qs`. The express-based HTTP/SSE transport from the MCP SDK is **not used** on Cloudflare Workers — `mcp-api` serves MCP over the Workers-native `agents` + Hono stack (`web/workers/mcp-api/src/index.ts`), and `grep` for `express`/transport imports in `mcp-api/src` returns nothing but the local `qs` variable in `audit.ts`. The vulnerable API is `qs.stringify(..., { arrayFormat: 'comma', encodeValuesOnly: true })` on outbound serialization with null entries — a code path nothing in our tree exercises. Production reachability: none.
- **`ws`** appears only via dev/test/build tooling: `jsdom` (frontend unit tests), `miniflare` (the worker test runtime behind `@cloudflare/vitest-pool-workers`), and `wrangler` (local dev / deploy). None of these ship to the Cloudflare Workers runtime or into the static Pages bundle, and the disclosure requires an attacker-facing `ws` server. Production reachability: none.

**Severity rationale**
Documenting as **Moderate (advisory) / negligible (reachability)** — same posture as SEC-16. The point of fixing inline is to keep `bun audit` clean so a noisy line never masks a genuinely-reachable finding in a future round; the override costs nothing and the test suite confirms no breakage.

**Regression test**
`bun audit` itself (step 8 of `/security-review-repo`) is the regression detector, plus the full worker test suites that run through the upgraded `ws` on miniflare. No bespoke test added — there is no in-app code path to assert against.

---

### Re-checked but no change

Because the application source is byte-identical to the 2026-05-18 round, the prior round's detailed walks still hold. Spot-confirmed this round:

- **Authn / authz.** `requireAuth` resolves identity only by forwarding inbound `cookie` / `x-api-key` to auth-api (`middleware/auth.ts`); no header-trust backdoor. `requireCompAdmin` gates on a `comp_admin` row. No new mutating routes.
- **Worker route surfaces.** `[[routes]]` across all four workers unchanged: airscore (`/api/airscore/*`), comp (`/api/comp`, `/api/comp/*`, `/api/user`, `/api/user/*`, `/api/u/*`), mcp (`/mcp`, `/mcp/*`), auth (`/api/auth/*`). No new public surface.
- **CORS.** Allowlist (`glidecomp.com`, `*.glidecomp.pages.dev`, `localhost`) on both auth-api and competition-api; disallowed origins get an empty `Access-Control-Allow-Origin`. Unchanged.
- **Parameterised SQL.** All spot-checked sites bind parameters; no string concatenation into SQL.
- **`audit()` coverage.** No new mutating routes, so no new audit gaps; existing comp/task/igc/pilot/pilot-status routes still call `audit()`.
- **MCP per-tool auth propagation.** Every tool forwards `apiKey` via `compApi`/`compApiRaw`; none forge identity. Unchanged.
- **wrangler.toml bindings.** Single canonical production resource IDs; auth-api + competition-api intentionally share D1; auth-api shares the `glidecomp` R2 bucket for cascading delete. No preview-vs-prod cross-wiring.
- **`optionalAuth` PII (SEC-15 class).** No new `optionalAuth` routes added; the prior systematic walk (comp/task/igc/audit/score/pilot-status/pilot/user-files) still applies. `serializeCompPilotPublic` still redacts the three PII fields for non-admins.
- **Secrets.** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET` referenced as env only; no hard-coded keys in source or any `wrangler.toml`. API-key prefix still `glc_`.

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the allowlisted CORS.
2. Cookie attribute verification on a live deploy.
3. IGC / XCTask parser fuzzing.
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just the miniflare regression test).
6. Confirm the comp-api worker doesn't accept a legacy `Cookie: test-user=…` header in production.
7. TOCTOU / idempotency on `/api/user/tracks` + `/api/user/tasks` quota checks (UX bug class, no security exposure — from the 2026-05-18 round).

New gap from this round:

8. **Flip the CSP from Report-Only to enforced.** SEC-02 shipped the framing/sniffing/referrer/permissions headers enforced but the CSP as `Content-Security-Policy-Report-Only` to avoid breaking the live map/fonts. Next step requires a live Pages deploy: wire a `report-uri`/`report-to` collector (or read the browser console on a preview deploy), confirm zero violations across the analysis map (Leaflet OSM/OpenTopoMap/ArcGIS + Mapbox GL), the theme editor's Google-Fonts loader, and the share-target flow, then rename the header to `Content-Security-Policy`. Tighten `style-src 'unsafe-inline'` if the inline-style usage can be moved to classes/nonces.

### Where to start the next review

1. Commit reviewed up to: HEAD = `067c7ed` (parent of this review's PR). Diff against that next round.
2. `bun audit` should be clean after this PR — if a new advisory pops up, walk the dependency tree for reachability before triaging severity (the `qs`/`ws` pattern this round: both flagged Moderate but neither reachable in production).
3. **Verify the new `_headers` file on a live/preview Pages deploy** (scope-gap #8): confirm the four enforced headers are present (`curl -I https://glidecomp.com/`) and that the Report-Only CSP fires zero violations before flipping it to enforced.
4. Re-run the prior-findings table; SEC-03 (admin emails), SEC-05 (innerHTML), SEC-06 (bodyLimit), SEC-08 (rate-limit headers), SEC-13 (sw.js filename), SEC-04 (manufacturer-record check) remain Open — all Medium or below. SEC-06 (`bodyLimit`) is the next-highest-leverage small-diff win but needs local upload testing.
5. Walk any new mutating endpoints (authn / authz / `audit()` / Zod) — none existed this round; recent trajectory is the per-user files/preferences surface, so watch for shared/public-profile features that could re-introduce a SEC-15-class PII leak.
6. Confirm the `qs` / `ws` overrides held — `grep -E "qs@|ws@" bun.lock` should show single `qs@6.15.2` and `ws@8.2x` entries. Drop an override if its upstream dependency starts requiring a newer major.

---

## 2026-06-01 — Re-review

### Methodology

- Read `docs/security-review.md` end-to-end first, carrying the prior round's "Scope gaps" and "Where to start" pointers into this round's scope.
- Diffed `master` vs the prior review's landing commit `067c7ed` (`git log 067c7ed..HEAD`). Five commits landed since: `99f39ce` (auth-api vitest harness + initial test files — no source changes, only `web/workers/auth-api/test/*.test.ts` and a `vitest.config.ts` `testTimeout` bump), `650e707` (engine fix: takeoff slice bug on duplicate GPS timestamps — `event-detector.ts` reads `takeoffIndex` from the event's own `details.fixIndex` instead of looking it up by timestamp; `gap-scoring.ts` swaps `Math.max/min` spread for `maxBy/minBy` helpers), `6debf4f` (dep upgrade 2026-05-24 — 7 security fixes, wrangler 4.94.0), `fde480c` (dep upgrade 2026-05-31 — wrangler 4.95.0, hono 4.12.23, mapbox-gl 3.24.0), and `4e38f8e` (the prior review's PR itself). **No new application source code** under `web/workers/*/src/` or `web/frontend/src/` since the 2026-05-25 round; `git diff 067c7ed..HEAD -- 'web/workers/**/src/**/*.ts' 'web/frontend/src/**/*.ts'` returns only the engine bug-fix files. No new `[[routes]]` blocks, no new `wrangler.toml` bindings, no new mutating endpoints.
- Re-walked every prior `SEC-NN` finding line-by-line against current code (not just commit log). The fix sites (`middleware/auth.ts`, `igc-validation.ts`, `xctskSchema`, `serializeCompPilotPublic`, CORS allowlist) are byte-identical to the prior round.
- Ran `bun audit` at HEAD — **0 vulnerabilities**. The kysely / qs / ws overrides from prior rounds all held (`grep -E "kysely@|qs@|ws@" bun.lock` → single `kysely@0.28.17`, `qs@6.15.2`, `ws@8.21.0`).
- Reviewed the engine bug-fix for security implications. The takeoff-slice change is a correctness fix (a `findIndex(f.time === takeoff.time)` could land on a duplicate-timestamped earlier fix and leak pre-takeoff data into thermal/glide analysis), not a security issue. The fix replaces lookup-by-timestamp with the index already stored on the takeoff event, eliminating the ambiguity. The `Math.max(...)/min(...)` → `maxBy/minBy` swap in `gap-scoring.ts` removes a long-standing stack-depth risk for large pilot fields (spreading >~100k numbers into `Math.max` can RangeError on some JS engines), so this is a small defensive improvement on the scoring path.
- Reviewed the new auth-api test files (`test/cors.test.ts`, `test/is-local-dev.test.ts`, `test/routes.test.ts`) — all test files exercise existing source code; they don't add new attack surface. The `cors.test.ts` adds a SEC-01 regression test on the auth worker that mirrors the existing competition-api test, which is a structural improvement.
- Used the otherwise-quiet round to close **SEC-13** (service-worker share-target filename sanitisation — Low, open since 2026-05-04) inline, and to reclassify **SEC-03** (admin emails on public comp detail) from **Open** to **Accepted (by design)** at the product owner's direction — comp organisers' emails are intentionally visible to all pilots and to the public on the comp page. See the status rows below.
- Ran `bun run typecheck:all` (clean), `bun run test:all` (green: 412 engine/airscore/root + 52 auth-api + 253 competition-api + 21 mcp-api), and `bun audit` (clean).
- Did **not** re-run dynamic CSRF PoC, live cookie-attribute checks, IGC/XCTask parser fuzzing, a Cloudflare zone-settings snapshot, or a CSP-Report-Only live-deploy walkthrough — still in scope-gaps below.

### Executive summary

No new application source code landed since the 2026-05-25 round; the only changes are dep upgrades (covered by `bun audit` — clean at HEAD), a single engine correctness fix for the takeoff-slice bug (no security implication), and a new auth-api vitest harness that adds regression tests for SEC-01 and SEC-07 on the auth worker. With no fresh attack surface, this round closes **SEC-13** (service-worker share-target filename sanitisation — Low, open since 2026-05-04) inline by stripping control chars from `X-File-Name` and URL-encoding the cache key, and reclassifies **SEC-03** from **Open** to **Accepted (by design)** — the product owner has confirmed that comp organisers' email addresses are intentionally visible to all pilots in the comp and to the public on the comp page, so the prior rounds' "Open" classification was incorrect. The 2026-04-20 SEC-03 write-up still stands as the threat model record (phishing/scraping is a real risk), but it is now an accepted product-design trade-off rather than something to fix. No Critical or High findings this round; SEC-04 (IGC manufacturer-record check), SEC-05 (innerHTML pattern), SEC-06 (`bodyLimit` middleware), SEC-08 (rate-limit headers), and the scope-gap #8 (flip CSP from Report-Only to enforce) remain Open and small-diff candidates for future rounds.

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-06-01 | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Re-verified `web/workers/auth-api/src/index.ts:13-33` and `web/workers/competition-api/src/index.ts:23-44`. Allowlist (`glidecomp.com` + `*.glidecomp.pages.dev` + `localhost`) unchanged. New `web/workers/auth-api/test/cors.test.ts` adds a regression test that mirrors the competition-api one — preflight from `https://evil.example`, `https://glidecomp.com.evil.example`, etc. now asserts empty `access-control-allow-origin`. |
| SEC-02  | No security response headers (`_headers`)                              | **Fixed (2026-05-25)** | Headers in `web/frontend/public/_headers` unchanged; still ships with the CSP as `Content-Security-Policy-Report-Only`. Flip-to-enforce remains scope-gap #8. |
| SEC-03  | Admin emails returned on public comp detail                            | ~~Open~~ **Accepted (by design, 2026-06-01)** | Confirmed with the product owner that comp organisers' email addresses are intentionally visible on the public `GET /api/comp/:comp_id` response — pilots in the comp (and the wider public on the comp page) are expected to be able to contact the organiser without signing in. The 2026-04-20 threat-model note (phishing / scraping risk) still applies and stays documented as the trade-off, but the prior rounds' "Open" classification was incorrect: there is nothing to fix here. Future reviewers should not re-open this finding without a product-design change. `web/workers/competition-api/src/routes/comp.ts:243-250, 303` continues to return `{ email, name }` for every caller. |
| SEC-04  | IGC upload size/shape                                                  | **Open (sub-issue)** | Subsumed by SEC-11 helper. Manufacturer-record (`A…`) check on the decompressed first byte still not enforced; up to 2 MiB of non-IGC text can sit in R2 per registered pilot per task / per user. Auth-gated, bounded; staying Low. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | `grep -rn "innerHTML =" web/frontend/src \| wc -l` → 116 sites (identical to prior rounds — no frontend source changes). All interpolations of user data still route through `sanitizeText()` / `escapeHtml()`. |
| SEC-06  | No JSON body-size cap                                                  | **Open**            | Still no `bodyLimit` middleware (`grep -rn bodyLimit web/workers/*/src/` → none). Hono is now at `4.12.23` (override), so `bodyLimit({ maxSize: 256*1024 })` with a per-route override for IGC remains the documented fix. Deferred (not closed this round) because a wrong cap would break IGC/user-track uploads and a security-review PR shouldn't risk that without local upload testing. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged. New `web/workers/auth-api/test/is-local-dev.test.ts` adds explicit positive- and negative-case tests for `isLocalDev` (including a suffix attack `https://localhost.evil.example` and a non-URL string), pinning the production-vs-dev gate against regression. |
| SEC-08  | Rate-limit headers not surfaced                                        | **Open**            | Unchanged (`grep -rn "Retry-After\|X-RateLimit" web/workers/auth-api/src/` → none). The new auth-api test suite has a `test.todo("rate limit: 61st request inside 60s window returns 429")` placeholder (`web/workers/auth-api/test/routes.test.ts:78`), so the fix would naturally be paired with that test fill-in. |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `web/workers/competition-api/src/middleware/auth.ts:15-32` byte-identical to the fix; forwards only inbound `cookie` / `x-api-key` to auth-api. `grep -rn "X-Glidecomp-Internal-User\|INTERNAL_USER_HEADER" web/workers/` returns only test/comment references in `competition-api/test/auth-bypass.test.ts` and `mcp-api/test/`. The `auth-bypass.test.ts` regression test passes. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `web/workers/competition-api/src/igc-validation.ts:22-110` unchanged (1 MiB compressed + gzip-magic + 2 MiB streaming-decompressed caps). Three callsites unchanged (`routes/igc.ts:170, :449`, `routes/user-files.ts:250`). The negative-path "TypeError: Decompression failed." log lines during `test:comp` are the corrupt-gzip rejection assertions firing as expected. |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `web/workers/competition-api/src/validators.ts:228` unchanged; used by `createTaskSchema` / `updateTaskSchema` and the user-task route. |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | ~~Open~~ **Fixed (2026-06-01, this PR)** | `web/frontend/public/sw.js:53-68` now strips control characters (`/[\x00-\x1f\x7f]/g`) from `file.name` before using it in `X-File-Name`, falls back to `'shared-file'` for empty/missing names, and URL-encodes the cache-key path component so names containing `?`, `#`, `..`, etc. round-trip safely. Consumer in `web/frontend/src/analysis/main.ts:1998-2008` updated to `decodeURIComponent` the pathname fallback (the `X-File-Name` header remains the primary source, so the cache-key change is transparent to the user). |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix.                                            |
| SEC-15  | Unauthenticated PII on public pilot list                               | **Fixed**           | `web/workers/competition-api/src/routes/pilot.ts:389-420` unchanged. `serializeCompPilotPublic` still redacts the three PII fields for non-admins; admin path still returns full PII. |
| SEC-16  | Transitive `kysely@0.28.16` JSON-path traversal                        | **Fixed**           | Override held: `grep "kysely@" bun.lock` → single `kysely@0.28.17` entry. `bun audit` clean for kysely. |
| SEC-17  | `qs` (DoS) via MCP SDK→express; `ws` (memory disclosure) via dev tooling | **Fixed**         | Overrides held: `grep -E "qs@\|ws@" bun.lock` → single `qs@6.15.2` and single `ws@8.21.0` (the `ws@8.20.1` minimum was bumped naturally by the dep refresh; still within the `^8.20.1` override range). `bun audit` clean. |

### New findings

No new `SEC-NN` findings this round.

`bun audit` is clean; the diff since 2026-05-25 contains no new mutating routes, no new bindings, no new public surfaces. The engine bug-fix in `event-detector.ts` is a correctness fix (would have caused incorrect glide/thermal stats on duplicate-timestamp tracks) with no security implication. The new auth-api vitest harness exercises existing source — it doesn't add any callable surface that wasn't already there.

### Re-checked but no change

Because every `*.ts` under `web/workers/*/src/` and `web/frontend/src/` is byte-identical to the 2026-05-25 round (with the exception of the targeted SEC-13 fix applied in this PR), the prior round's detailed walks still hold. Spot-confirmed this round:

- **Authn / authz.** `requireAuth` resolves identity only by forwarding inbound `cookie` / `x-api-key` to auth-api (`middleware/auth.ts:15-32`); no header-trust backdoor. `requireCompAdmin` gates on a `comp_admin` row (`middleware/auth.ts:72-95`). No new mutating routes added.
- **Worker route surfaces.** `[[routes]]` across all four workers unchanged from the 2026-05-25 walk: airscore (`/api/airscore/*`), comp (`/api/comp`, `/api/comp/*`, `/api/user`, `/api/user/*`, `/api/u/*`), mcp (`/mcp`, `/mcp/*`), auth (`/api/auth/*`). No new public surface.
- **CORS.** Allowlist (`glidecomp.com`, `*.glidecomp.pages.dev`, `localhost`) on both auth-api and competition-api; disallowed origins get an empty `Access-Control-Allow-Origin`. The new auth-api `cors.test.ts` adds a regression test that confirms this.
- **Parameterised SQL.** All spot-checked sites bind parameters; no string concatenation into SQL.
- **`audit()` coverage.** No new mutating routes, so no new audit gaps; existing comp/task/igc/pilot/pilot-status routes still call `audit()` with `describeChange()`-style descriptions.
- **MCP per-tool auth propagation.** Every tool forwards `apiKey` via `compApi` / `compApiRaw`; none forge identity. Unchanged.
- **wrangler.toml bindings.** Single canonical production resource IDs; auth-api + competition-api intentionally share D1 (`taskscore-auth`); auth-api shares the `glidecomp` R2 bucket for cascading delete. No preview-vs-prod cross-wiring.
- **`optionalAuth` PII (SEC-15 class).** No new `optionalAuth` routes added; the prior systematic walk (comp/task/igc/audit/score/pilot-status/pilot/user-files) still applies. Note: SEC-03 (admin emails on `GET /api/comp/:comp_id`) is no longer treated as a leak — see its status row above for the by-design reclassification. The SEC-15 pilot-list redaction (`serializeCompPilotPublic`) is unaffected and still in place.
- **Secrets.** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET` referenced as env only; no hard-coded keys in source or any `wrangler.toml`. API-key prefix still `glc_`.
- **Cascading delete on account delete.** `auth-api/src/index.ts:138-150` still walks every R2 object under `u/{user_id}/` before dropping the user row. Unchanged. If a future feature adds a new prefix under `u/{user_id}/` (e.g. avatars), this is the source of truth and must be updated.

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the allowlisted CORS.
2. Cookie attribute verification on a live deploy.
3. IGC / XCTask parser fuzzing.
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just the miniflare regression test).
6. Confirm the comp-api worker doesn't accept a legacy `Cookie: test-user=…` header in production.
7. TOCTOU / idempotency on `/api/user/tracks` + `/api/user/tasks` quota checks (UX bug class, no security exposure — from the 2026-05-18 round).
8. **Flip the CSP from Report-Only to enforced** (from the 2026-05-25 round). Requires a live Pages-deploy CSP-report pass across the analysis map, the theme editor's Google-Fonts loader, and the share-target flow.

No new scope gaps added this round.

### Where to start the next review

1. Commit reviewed up to: HEAD = `fde480c` (parent of this review's PR). Diff against that next round.
2. `bun audit` should be clean after this PR — if a new advisory pops up, walk the dependency tree for reachability before triaging severity.
3. Re-run the prior-findings table; remaining Open items are SEC-04 (manufacturer-record check), SEC-05 (innerHTML pattern), SEC-06 (`bodyLimit` middleware), SEC-08 (rate-limit headers). All Low/Medium. SEC-06 is still the next-highest-leverage small-diff win but needs local upload testing before landing.
4. Walk any new mutating endpoints (authn / authz / `audit()` / Zod) — none existed this round. Recent trajectory is the per-user files/preferences surface from 2026-05-18 plus the SEC-02 hardening from the prior round, so watch for shared/public-profile features or any new field on a public-readable endpoint that could re-introduce a SEC-15-class PII leak (the pilot list — not the admin list, which is by-design public per the SEC-03 reclassification).
5. Confirm the SEC-13 fix held: on a mobile device, share an IGC file with a name like `weird?name#here.igc` to GlideComp's share target, then open DevTools on the analysis page and inspect the cached response — the `X-File-Name` header should be the original name minus any control chars, the cache-key URL should be percent-encoded, and the analysis page should load the file.
6. Fill in the `test.todo(...)` placeholders in `web/workers/auth-api/test/routes.test.ts` (tiers 2-4 — username format validation, API-key round-trip, rate-limit 429 with `Retry-After`). The rate-limit one would close SEC-08 if paired with a `Retry-After` header in the response.
7. Address scope-gap #8 (CSP enforce) on the next preview deploy.
8. Do NOT re-open SEC-03. It is accepted by design — comp organisers' emails are intentionally visible to all pilots and to the public.

---

## 2026-06-08 — Re-review

### Methodology

- Read `docs/security-review.md` end-to-end first, carrying the prior round's "Scope gaps" and "Where to start" pointers into this round's scope.
- Diffed `master` vs the prior review's landing commit `e433ee5` (`git log e433ee5..HEAD`). **One commit since** — `c39d6c3` (weekly dep upgrade 2026-06-07: wrangler 4.95.0→4.98.0, vitest 4.1.7→4.1.8, vite 7.3.3→7.3.5, better-auth 1.6.13→1.6.14, @cloudflare/vitest-pool-workers 0.16.10→0.16.13, @cloudflare/workers-types 4.20260531→4.20260607, @types/node 25.9.1→25.9.2). **No application source code changes** since the 2026-06-01 round (`git diff e433ee5..HEAD -- 'web/workers/**/src/**/*.ts' 'web/frontend/src/**/*.ts' 'functions/**' 'web/engine/src/**/*.ts' 'web/frontend/public/sw.js' 'web/frontend/public/_headers' 'web/frontend/public/_redirects' 'web/workers/**/wrangler.toml'` returns empty). No new `[[routes]]` blocks, no new bindings, no new mutating endpoints.
- Re-walked every prior `SEC-NN` finding line-by-line against current code. Because the application source is byte-identical to the 2026-06-01 round, each prior round's verification still holds; this round spot-checked the fix sites to confirm nothing was reverted (`grep -rn "X-Glidecomp-Internal-User\|INTERNAL_USER_HEADER" web/workers/` → only test/comment references; `validateAndDecompressIgc` caps and gzip-magic present; `xctskSchema` still in use; `serializeCompPilotPublic` still zeros the three PII fields; CORS allowlist unchanged on both public workers; `_headers` file intact with the four enforced headers + the Report-Only CSP).
- Ran `bun audit` at HEAD — **0 vulnerabilities**. Overrides held: `grep -E "kysely@|qs@|ws@" bun.lock` → single `kysely@0.28.17`, `qs@6.15.2`, `ws@8.21.0`.
- Used the otherwise-quiet round to close **SEC-04** (manufacturer-record check on the decompressed first byte — Low, open as a sub-issue since 2026-05-04 when SEC-11 subsumed the size/shape cap but explicitly left the content shape for a later round) inline. The fix moves the content check into `validateAndDecompressIgc` so both upload routes (`routes/igc.ts` self-upload + on-behalf, `routes/user-files.ts` per-user track) inherit it without any route-level change.
- Ran `bun run typecheck:all` (clean), `bun run test:all` (green: 412 engine/airscore/root + 52 auth-api + 254 competition-api + 21 mcp-api — the competition-api count is +1 from prior round, accounting for the SEC-04 negative-path tests minus one consolidation), and `bun audit` (clean).
- Did **not** re-run dynamic CSRF PoC, live cookie-attribute checks, IGC/XCTask parser fuzzing, a Cloudflare zone-settings snapshot, or a CSP-Report-Only live-deploy walkthrough — still in scope-gaps below.

### Executive summary

No new application source code landed since the 2026-06-01 round — the only commit is the weekly dep upgrade (covered by `bun audit` — clean at HEAD) — so there was no fresh attack surface to audit, and re-verification confirmed the SEC-01 / SEC-10 / SEC-11 / SEC-12 / SEC-13 / SEC-15 / SEC-16 / SEC-17 fixes all hold byte-for-byte. With the round otherwise quiet, this PR closes **SEC-04** inline: `validateAndDecompressIgc` now also verifies that the decompressed body starts with `A` (manufacturer record) and contains `HFDTE` (date header) — the same `isValidIgcContent` shape check the airscore proxy worker has had since the 2026-03-04 audit. Both upload routes (`routes/igc.ts` self-upload, on-behalf-of admin upload, and `routes/user-files.ts` per-user track) inherit the fix via the shared helper, blocking authenticated callers from stashing up to 2 MiB of arbitrary gzipped text per registered pilot per task and per user in R2. Three new typed-error tests (non-IGC plain text, A-record-but-no-HFDTE, HFDTE-but-no-A) lock the behaviour; the existing decompressed-size boundary test was retargeted to valid IGC content of cap-length so it still asserts the size boundary without colliding with the new content check. Three test files that produce minimal upload bodies (`igc-routes.test.ts`, `pilot-status.test.ts`, `signup-linking.test.ts`) had their precomputed gzip blob refreshed to wrap `"AXCT001Test\r\nHFDTE010126\r\n"` instead of an empty body, and the `gzipText` helper in `user-files.test.ts` was retrofitted to prepend the same IGC prefix to every upload — these are mechanical fixture refreshes, not coverage changes. No Critical or High findings this round; **SEC-05** (innerHTML pattern), **SEC-06** (`bodyLimit` middleware), **SEC-08** (rate-limit headers), and scope-gap #8 (flip CSP from Report-Only to enforce) remain Open and small-diff candidates for future rounds.

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-06-08 | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Re-verified `web/workers/auth-api/src/index.ts:13-33` and `web/workers/competition-api/src/index.ts:23-44`. Allowlist (`glidecomp.com` + `*.glidecomp.pages.dev` + `localhost`) unchanged. `cors.test.ts` regression test still passes. |
| SEC-02  | No security response headers (`_headers`)                              | **Fixed (2026-05-25)** | `web/frontend/public/_headers` unchanged; still ships with the CSP as `Content-Security-Policy-Report-Only`. Flip-to-enforce remains scope-gap #8. |
| SEC-03  | Admin emails returned on public comp detail                            | **Accepted (by design, 2026-06-01)** | Unchanged. Comp organisers' emails intentionally visible. Not to be re-opened without a product-design change. |
| SEC-04  | IGC upload size/shape — manufacturer-record check                      | ~~Open~~ **Fixed (2026-06-08, this PR)** | `web/workers/competition-api/src/igc-validation.ts:101-110` now adds a `not_igc_content` typed error: after the streaming decompression succeeds, the helper rejects payloads whose decoded text doesn't start with `A` or doesn't contain `HFDTE` — the same `isValidIgcContent` shape the airscore worker has had at `web/workers/airscore-api/src/handlers/track.ts:14-16`. Both upload paths (`web/workers/competition-api/src/routes/igc.ts:170` self-upload, `routes/igc.ts:449` on-behalf, `routes/user-files.ts:250` per-user track) inherit the fix without per-route changes; the existing `IgcValidationException` catch in each route maps it to a 400 with the same `err.detail.message` plumbing. Three new tests in `web/workers/competition-api/test/igc-validation.test.ts` (lines 116-138) cover the three rejection paths (non-IGC plain text, A-record-but-no-HFDTE, HFDTE-but-no-A); the existing decompressed-size boundary test (line 94) was retargeted to a 2 MiB valid IGC payload (prefix + `'x'` padding to cap) so it still asserts the size boundary independently of the new content check. Fixture refresh — `fakeIgcPayload()` in three other test files (`igc-routes.test.ts:16`, `pilot-status.test.ts:13`, `signup-linking.test.ts:15`) was updated to a precomputed gzip of `"AXCT001Test\r\nHFDTE010126\r\n"`, and `gzipText()` in `user-files.test.ts:24-32` now prepends the same `IGC_PREFIX` constant to every upload (and two round-trip assertions were updated to assert against `IGC_PREFIX + suffix`). All 254 competition-api tests pass. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | `grep -rn "innerHTML =" web/frontend/src \| wc -l` → 116 sites (identical to prior rounds — no frontend source changes). All interpolations of user data still route through `sanitizeText()` / `escapeHtml()`. |
| SEC-06  | No JSON body-size cap                                                  | **Open**            | Still no `bodyLimit` middleware (`grep -rn bodyLimit web/workers/*/src/` → none). Hono is at `4.12.23` (override), so `bodyLimit({ maxSize: 256*1024 })` with a per-route override for IGC remains the documented fix. Deferred (not closed this round) because a wrong cap would break IGC/user-track uploads and a security-review PR shouldn't risk that without local upload testing. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged. `BETTER_AUTH_URL = "https://glidecomp.com"` in `web/workers/auth-api/wrangler.toml`. `is-local-dev.test.ts` regression test still passes. |
| SEC-08  | Rate-limit headers not surfaced                                        | **Open**            | Unchanged (`grep -rn "Retry-After\|X-RateLimit" web/workers/auth-api/src/` → none). The `test.todo("rate limit: 61st request inside 60s window returns 429")` placeholder in `web/workers/auth-api/test/routes.test.ts:78` is still in place. |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `web/workers/competition-api/src/middleware/auth.ts:15-32` byte-identical to the fix. `grep -rn "X-Glidecomp-Internal-User\|INTERNAL_USER_HEADER" web/workers/` returns only test/comment references in `competition-api/test/auth-bypass.test.ts`, `mcp-api/test/util.test.ts`, and `mcp-api/vitest.config.ts`. The `auth-bypass.test.ts` regression test still passes. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `web/workers/competition-api/src/igc-validation.ts:22-110` — the same 1 MiB compressed + gzip-magic + 2 MiB streaming-decompressed caps; with the SEC-04 fix landing in this PR the helper now also enforces the IGC content shape after decompression. Three callsites unchanged (`routes/igc.ts:170, :449`, `routes/user-files.ts:250`). The `decompressed_too_large` and `TypeError: Decompression failed.` log lines during `test:comp` are the SEC-11 negative-path assertions firing as expected (6 errors, same baseline as prior round). |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `web/workers/competition-api/src/validators.ts:228` unchanged; used by `createTaskSchema` / `updateTaskSchema` and the user-task route. |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | **Fixed (2026-06-01)** | `web/frontend/public/sw.js:53-68` unchanged from the fix; control chars stripped from `X-File-Name`, cache key `encodeURIComponent`-encoded. Consumer in `web/frontend/src/analysis/main.ts:1998-2008` unchanged. |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix.                                            |
| SEC-15  | Unauthenticated PII on public pilot list                               | **Fixed**           | `web/workers/competition-api/src/routes/pilot.ts:123-130, 386-419` unchanged. `serializeCompPilotPublic` still redacts the three PII fields for non-admins; admin path still returns full PII. |
| SEC-16  | Transitive `kysely@0.28.16` JSON-path traversal                        | **Fixed**           | Override held: `grep "kysely@" bun.lock` → single `kysely@0.28.17` entry. `bun audit` clean for kysely. |
| SEC-17  | `qs` (DoS) via MCP SDK→express; `ws` (memory disclosure) via dev tooling | **Fixed**         | Overrides held: `grep -E "qs@\|ws@" bun.lock` → single `qs@6.15.2` and `ws@8.21.0`. `bun audit` clean. |

### New findings

No new `SEC-NN` findings this round.

`bun audit` is clean; the diff since 2026-06-01 contains no application source changes (only the weekly dep upgrade). The dep upgrade was reviewed for new advisories — none. The `better-auth 1.6.13→1.6.14` patch bump was checked against the kysely-adapter for new JSON-path usage (still none — kysely-adapter does table CRUD only), so the SEC-16 reachability analysis remains valid.

### Re-checked but no change

Because every `*.ts` under `web/workers/*/src/` and `web/frontend/src/` is byte-identical to the 2026-06-01 round (with the exception of the SEC-04 fix landed in this PR, which touches `igc-validation.ts` only), the prior round's detailed walks still hold. Spot-confirmed this round:

- **Authn / authz.** `requireAuth` resolves identity only by forwarding inbound `cookie` / `x-api-key` to auth-api (`middleware/auth.ts:15-32`); no header-trust backdoor. `requireCompAdmin` gates on a `comp_admin` row (`middleware/auth.ts:72-95`). No new mutating routes added.
- **Worker route surfaces.** `[[routes]]` across all four workers unchanged from the 2026-06-01 walk: airscore (`/api/airscore/*`), comp (`/api/comp`, `/api/comp/*`, `/api/user`, `/api/user/*`, `/api/u/*`), mcp (`/mcp`, `/mcp/*`), auth (`/api/auth/*`). No new public surface.
- **CORS.** Allowlist (`glidecomp.com`, `*.glidecomp.pages.dev`, `localhost`) on both auth-api and competition-api; disallowed origins get an empty `Access-Control-Allow-Origin`. The `cors.test.ts` regression suite on auth-api still passes.
- **Parameterised SQL.** All spot-checked sites bind parameters; no string concatenation into SQL.
- **`audit()` coverage.** No new mutating routes, so no new audit gaps; existing comp/task/igc/pilot/pilot-status routes still call `audit()` with `describeChange()`-style descriptions.
- **MCP per-tool auth propagation.** Every tool under `web/workers/mcp-api/src/tools/*.ts` forwards `apiKey` via `compApi` / `compApiRaw`; none forge identity. Unchanged.
- **wrangler.toml bindings.** Single canonical production resource IDs; auth-api + competition-api intentionally share D1 (`taskscore-auth`); auth-api shares the `glidecomp` R2 bucket for cascading delete. No preview-vs-prod cross-wiring.
- **`optionalAuth` PII (SEC-15 class).** No new `optionalAuth` routes added — current set is `comp.ts:145, 210`, `task.ts:125`, `igc.ts:605, 704`, `audit.ts:28`, `score.ts:24, 95`, `pilot-status.ts:121`, `pilot.ts:372`, `user-files.ts:694, 729, 751`. The 2026-05-18 systematic walk of SELECT columns still applies (PII-free except for `comp.ts:210` admin emails, which are accepted-by-design per SEC-03).
- **Secrets.** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET` referenced as env only; no hard-coded keys in source or any `wrangler.toml`. API-key prefix still `glc_`.
- **Cascading delete on account delete.** `auth-api/src/index.ts:138-150` still walks every R2 object under `u/{user_id}/` before dropping the user row. Unchanged. If a future feature adds a new prefix under `u/{user_id}/` (e.g. avatars), this is the source of truth and must be updated.

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the allowlisted CORS.
2. Cookie attribute verification on a live deploy.
3. IGC / XCTask parser fuzzing.
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just the miniflare regression test).
6. Confirm the comp-api worker doesn't accept a legacy `Cookie: test-user=…` header in production.
7. TOCTOU / idempotency on `/api/user/tracks` + `/api/user/tasks` quota checks (UX bug class, no security exposure — from the 2026-05-18 round).
8. **Flip the CSP from Report-Only to enforced** (from the 2026-05-25 round). Requires a live Pages-deploy CSP-report pass across the analysis map, the theme editor's Google-Fonts loader, and the share-target flow.

No new scope gaps added this round.

### Where to start the next review

1. Commit reviewed up to: HEAD = `c39d6c3` (parent of this review's PR). Diff against that next round.
2. `bun audit` should be clean after this PR — if a new advisory pops up, walk the dependency tree for reachability before triaging severity (the `qs`/`ws` pattern from 2026-05-25: both flagged Moderate but neither reachable in production).
3. Re-run the prior-findings table; remaining Open items are **SEC-05** (innerHTML pattern), **SEC-06** (`bodyLimit` middleware), **SEC-08** (rate-limit headers). All Low/Medium. SEC-06 is still the next-highest-leverage small-diff win but needs local upload testing before landing. SEC-08 is paired with the `test.todo` in `web/workers/auth-api/test/routes.test.ts:78` — filling it in is the natural pairing.
4. Walk any new mutating endpoints (authn / authz / `audit()` / Zod) — none existed this round. Recent trajectory is the per-user files/preferences surface from 2026-05-18 plus the SEC-02 hardening from 2026-05-25, so watch for shared/public-profile features or any new field on a public-readable endpoint that could re-introduce a SEC-15-class PII leak (the pilot list — not the admin list, which is by-design public per the SEC-03 reclassification).
5. Confirm the SEC-04 fix held: send a gzipped non-IGC body to `POST /api/user/tracks` (auth-required) on a deployed env and expect `400 {"error":"File does not look like an IGC track log"}`. Same against `POST /api/comp/.../task/.../igc`.
6. Address scope-gap #8 (CSP enforce) on the next preview deploy.
7. Do NOT re-open SEC-03. It is accepted by design — comp organisers' emails are intentionally visible to all pilots and to the public.

---

## 2026-06-11 — Re-review

### Methodology

- Read `docs/security-review.md` end-to-end first, carrying the prior round's "Scope gaps" and "Where to start" pointers into this round's scope.
- Diffed `master` vs the prior review's reference commit `c39d6c3` (`git log c39d6c3..HEAD`). Two commits landed since: `d78ae72` (the prior review's own PR — SEC-04 fix in `igc-validation.ts` plus test-fixture refreshes, already documented in the 2026-06-08 round) and `fe39af4` (iOS map-rendering fix). The latter is the only new application code: it touches `web/frontend/src/analysis/leaflet-provider.ts`, `mapbox-provider.ts`, and `main.ts` to re-measure the map (`invalidateSize()` / `map.resize()`) before `fitBounds` and to resync on `pageshow` / `visibilitychange` / `visualViewport.resize` / `orientationchange`, plus a `styles.css` tweak. **No security implications**: no DOM sinks, no interpolation of untrusted data, no new network surface, no new routes, bindings, or mutating endpoints (`git diff c39d6c3..HEAD -- 'web/workers/**/src/**/*.ts' 'functions/**' 'web/engine/src/**/*.ts' 'web/workers/**/wrangler.toml' 'web/frontend/public/**'` shows only the already-reviewed SEC-04 helper change).
- Re-walked every prior `SEC-NN` finding against current code. Fix-site spot-checks all intact: `grep -rn "X-Glidecomp-Internal-User|INTERNAL_USER_HEADER" web/workers/` → only test/comment references (SEC-10); `validateAndDecompressIgc` caps + gzip-magic + `not_igc_content` shape check present (SEC-11/SEC-04); `xctskSchema` in use (SEC-12); `serializeCompPilotPublic` zeros the three PII fields (SEC-15); CORS allowlist unchanged on both public workers (SEC-01); `_headers` intact with four enforced headers + Report-Only CSP (SEC-02); `sw.js` filename sanitisation intact (SEC-13); `innerHTML =` count still 116 (SEC-05).
- Ran `bun audit` at HEAD — flagged **1 new critical** transitive advisory: `shell-quote@1.8.3` via `concurrently`. See SEC-18; fixed inline via override, `bun audit` now clean. Prior overrides held (`grep -E "kysely@|qs@|ws@" bun.lock` → single `kysely@0.28.17`, `qs@6.15.2`, `ws@8.21.0`).
- Used the otherwise-quiet round to close **SEC-08** (rate-limit headers — Low, open since 2026-04-20) inline. Investigating the fix surfaced that the pre-fix behaviour was worse than documented: a rate-limited (or invalid/revoked) `x-api-key` on `GET /api/auth/me` made Better Auth's apiKey before-hook throw an `APIError` out of `auth.api.getSession`, which escaped to `app.onError` and surfaced as a **500** — not a 429 — with no `Retry-After`. Details in the SEC-08 status row.
- Ran `bun run typecheck:all` (clean), `bun run test:all` (green: 412 engine/airscore/root + 55 auth-api + 254 competition-api + 21 mcp-api — auth-api is +3 from the three filled-in API-key todos), and `bun audit` (clean).
- Did **not** re-run dynamic CSRF PoC, live cookie-attribute checks, IGC/XCTask parser fuzzing, a Cloudflare zone-settings snapshot, or a CSP-Report-Only live-deploy walkthrough — still in scope-gaps below.

### Executive summary

The only application change since 2026-06-08 is a frontend-only iOS map-rendering fix with no security surface, and re-verification confirmed every prior fix holds. The worst new item is **SEC-18**: `bun audit` flagged a **critical** advisory in transitive `shell-quote@1.8.3` (GHSA-w7jw-789q-3m8p — `quote()` does not escape newlines in object `.op` values) pulled in by `concurrently`, a root devDependency used only by the local `bun run dev` scripts; reachability is negligible (dev-only, command strings come from our own `package.json`, nothing ships to Workers or Pages) but it was **fixed inline** via a `"shell-quote": "^1.8.4"` override and `bun audit` is clean again. With the round otherwise quiet, **SEC-08 was also closed inline**: `/api/auth/me` now converts the apiKey plugin's rate-limit `APIError` into a real 429 with a `Retry-After` derived from the plugin's `tryAgainIn` (pre-fix it leaked out as a 500 with no header), a worker-wide after-middleware stamps `Retry-After: 60` on any other 429 leaving auth-api (covers the Better Auth catch-all endpoints), and invalid/expired/revoked API keys now resolve to `{ user: null }` like a garbage cookie instead of 500ing. Three previously-stubbed API-key integration tests were filled in, including a 61-request regression test that pins the 429 + `Retry-After` contract. No Critical or High findings against application code; remaining Open items are SEC-05 (innerHTML pattern) and SEC-06 (`bodyLimit` middleware).

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-06-11 | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Re-verified `web/workers/auth-api/src/index.ts:14-24` and `web/workers/competition-api/src/index.ts:23-44`. Allowlist unchanged; `cors.test.ts` regression suite still passes. |
| SEC-02  | No security response headers (`_headers`)                              | **Fixed (2026-05-25)** | `web/frontend/public/_headers` unchanged; CSP still Report-Only. Flip-to-enforce remains scope-gap #8. |
| SEC-03  | Admin emails returned on public comp detail                            | **Accepted (by design, 2026-06-01)** | Unchanged. Not to be re-opened without a product-design change. |
| SEC-04  | IGC upload size/shape — manufacturer-record check                      | **Fixed (2026-06-08)** | `web/workers/competition-api/src/igc-validation.ts:110-112` unchanged from the fix (`not_igc_content` typed error; first byte `A` + `HFDTE` required). All three upload callsites inherit it. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | 116 `innerHTML =` sites under `web/frontend/src/` (identical to prior rounds — the iOS map fix added none). All interpolations of user data still route through `sanitizeText()` / `escapeHtml()`. |
| SEC-06  | No JSON body-size cap                                                  | **Open**            | Still no `bodyLimit` middleware (`grep -rn bodyLimit web/workers/*/src/` → none). Remains the next-highest-leverage small-diff win; needs local upload testing before landing. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged. `BETTER_AUTH_URL = "https://glidecomp.com"` in `web/workers/auth-api/wrangler.toml`; `is-local-dev.test.ts` still passes. |
| SEC-08  | Rate-limit headers not surfaced                                        | ~~Open~~ **Fixed (2026-06-11, this PR)** | Pre-fix the problem was worse than documented: Better Auth's apiKey before-hook **throws** `APIError("TOO_MANY_REQUESTS")` out of `auth.api.getSession`, so a rate-limited `x-api-key` on `GET /api/auth/me` escaped to `app.onError` and returned a **500** (and an invalid/revoked key also 500ed). Fix in `web/workers/auth-api/src/index.ts`: (a) `/api/auth/me` (lines 60-95) catches `APIError` — a 429 becomes a JSON 429 with `Retry-After` computed from the plugin's `tryAgainIn` (ms→s, `:73-82`), and any other API-key `APIError` (invalid / expired / revoked) resolves to `200 { user: null }`, mirroring the garbage-cookie behaviour; (b) a worker-wide after-middleware (`:36-47`) stamps `Retry-After: 60` (the apiKey plugin's window) on any 429 leaving `/api/auth/*` without one, covering the Better Auth catch-all endpoints. The three `test.todo` placeholders in `web/workers/auth-api/test/routes.test.ts` are filled in (`:90` round-trip, `:104` revoked-key-no-500, `:124` rate-limit): the rate-limit regression test creates a key, makes 60 passing `/me` calls, and asserts the 61st returns 429 with `0 < Retry-After ≤ 60` and `user: null`. Downstream: comp-api's `resolveUser` treats the 429 body (`user` absent) as unauthenticated, same as it treated the pre-fix 500 — no behaviour change for comp-api callers, but direct MCP/API clients now get a correct, parseable back-off signal. |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `web/workers/competition-api/src/middleware/auth.ts:15-32` byte-identical to the fix. Grep returns only test/comment references. `auth-bypass.test.ts` still passes. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `web/workers/competition-api/src/igc-validation.ts` unchanged (1 MiB compressed + gzip-magic + 2 MiB streaming-decompressed caps + content-shape check). Three callsites unchanged. |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `web/workers/competition-api/src/validators.ts:228` unchanged. |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | **Fixed (2026-06-01)** | `web/frontend/public/sw.js:53-68` unchanged from the fix.            |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix.                                            |
| SEC-15  | Unauthenticated PII on public pilot list                               | **Fixed**           | `web/workers/competition-api/src/routes/pilot.ts:123-130, 417` unchanged. `serializeCompPilotPublic` still redacts the three PII fields for non-admins. |
| SEC-16  | Transitive `kysely@0.28.16` JSON-path traversal                        | **Fixed**           | Override held: single `kysely@0.28.17` in `bun.lock`. `bun audit` clean for kysely. |
| SEC-17  | `qs` (DoS) via MCP SDK→express; `ws` (memory disclosure) via dev tooling | **Fixed**         | Overrides held: single `qs@6.15.2` and `ws@8.21.0` in `bun.lock`. `bun audit` clean. |

### New findings

---

#### SEC-18 — Transitive `shell-quote@1.8.3` carries critical advisory GHSA-w7jw-789q-3m8p (newline-escaping bypass in `quote()`) — **Critical (advisory) / negligible (reachability)** — ~~Open~~ **Fixed (2026-06-11, this PR)**

> **Resolution:** added `"shell-quote": "^1.8.4"` to the `overrides` block in the root `package.json`. After `bun install` the lockfile resolves a single `shell-quote@1.8.4` entry (pre-fix: `shell-quote@1.8.3`, pinned exactly by `concurrently@9.2.1`'s dependency spec). `bun audit` reports zero vulnerabilities. `bun run typecheck:all` and all test suites pass; `concurrently`'s usage is unaffected by the patch bump.

**Files**
- `package.json` (overrides block) — fix applied here.
- `bun.lock` — pre-fix `shell-quote@1.8.3` via `concurrently@9.2.1`; post-fix a single `shell-quote@1.8.4`.
- `package.json:19-20` — the only consumer: the `dev` / `dev:workers` scripts run `concurrently` to multiplex local dev servers.

**Advisory**
- [GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p) — `shell-quote`: `quote()` does not escape newlines in object `.op` values, allowing command injection when attacker-controlled operator objects are serialised back into a shell command line. Vulnerable: `>=1.1.0 <=1.8.3`. Fix: `1.8.4`. Severity: Critical.

**Reachability analysis**
- `shell-quote` enters the tree solely via `concurrently@9.2.1`, a root **devDependency**. Nothing under `web/workers/*/src/`, `web/frontend/src/`, `web/engine/src/`, or `functions/` imports `shell-quote` or `concurrently` (`grep -rn "shell-quote" web/ functions/` → no source hits); neither ships to the Cloudflare Workers runtime or the static Pages bundle.
- `concurrently` uses `shell-quote` to parse/format the command strings passed to it — and every command string in this repo comes from our own `package.json` `dev` scripts, not from any external or attacker-controlled input. The vulnerable path (attacker-controlled `.op` objects fed to `quote()`) is not constructible here.
- Production reachability: none. Local-dev reachability: only if a developer pipes untrusted input into `concurrently` arguments, which no script does.

**Severity rationale**
Documenting as **Critical (advisory) / negligible (reachability)** — same posture as SEC-16/SEC-17. Per this routine's policy, Critical findings are fixed inline regardless; keeping `bun audit` clean is also what lets the next round treat any non-clean audit as signal.

**Regression test**
`bun audit` (step 8 of `/security-review-repo`) is the regression detector. No in-app code path exists to assert against.

---

### Re-checked but no change

Because the only application change since 2026-06-08 is the frontend-only iOS map fix, the prior rounds' detailed walks still hold. Spot-confirmed this round:

- **The iOS map fix (`fe39af4`) itself.** New code paths: `invalidateSize()` / `map.resize()` calls before `fitBounds`, plus `pageshow` / `visibilitychange` / `visualViewport.resize` (debounced) / `orientationchange` listeners in `web/frontend/src/analysis/main.ts:165-192` that call `window.scrollTo(0, 0)` and `mapRenderer?.invalidateSize()`. No DOM sinks, no interpolated data, no network calls, no message handlers — no security surface.
- **Authn / authz.** `requireAuth` resolves identity only by forwarding inbound `cookie` / `x-api-key` to auth-api; no header-trust backdoor. No new mutating routes.
- **Worker route surfaces.** `[[routes]]` across all four workers unchanged: airscore (`/api/airscore/*`), comp (`/api/comp`, `/api/comp/*`, `/api/user`, `/api/user/*`, `/api/u/*`), mcp (`/mcp`, `/mcp/*`), auth (`/api/auth/*`). No new public surface.
- **CORS.** Allowlist (`glidecomp.com`, `*.glidecomp.pages.dev`, `localhost`) on both public workers; disallowed origins get an empty `Access-Control-Allow-Origin`. The SEC-08 Retry-After middleware runs after the CORS middleware and does not alter CORS headers.
- **Parameterised SQL.** No new SQL sites this round; spot-checked sites all bind parameters.
- **`audit()` coverage.** No new mutating routes, so no new audit gaps.
- **MCP per-tool auth propagation.** Every tool forwards `apiKey` via `compApi` / `compApiRaw`; none forge identity. Unchanged.
- **wrangler.toml bindings.** Unchanged; single canonical production resource IDs.
- **`optionalAuth` PII (SEC-15 class).** No new `optionalAuth` routes; the 2026-05-18 systematic walk still applies.
- **Secrets.** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET` referenced as env only; no hard-coded keys in source or any `wrangler.toml`. API-key prefix still `glc_`.
- **Cascading delete on account delete.** `auth-api/src/index.ts` still walks every R2 object under `u/{user_id}/` before dropping the user row (now at lines ~170-185 after the SEC-08 edits shifted the file). Unchanged in behaviour.

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the allowlisted CORS.
2. Cookie attribute verification on a live deploy.
3. IGC / XCTask parser fuzzing.
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just the miniflare regression test).
6. Confirm the comp-api worker doesn't accept a legacy `Cookie: test-user=…` header in production.
7. TOCTOU / idempotency on `/api/user/tracks` + `/api/user/tasks` quota checks (UX bug class, no security exposure — from the 2026-05-18 round).
8. **Flip the CSP from Report-Only to enforced** (from the 2026-05-25 round). Requires a live Pages-deploy CSP-report pass across the analysis map, the theme editor's Google-Fonts loader, and the share-target flow.

No new scope gaps added this round.

### Where to start the next review

1. Commit reviewed up to: HEAD = `fe39af4` (parent of this review's PR). Diff against that next round.
2. `bun audit` should be clean after this PR — if a new advisory pops up, walk the dependency tree for reachability before triaging severity (this round's `shell-quote` and the earlier `qs`/`ws`/`kysely` cases are the template).
3. Re-run the prior-findings table; remaining Open items are **SEC-05** (innerHTML pattern) and **SEC-06** (`bodyLimit` middleware) — both deferred-by-design, neither urgent. SEC-06 is still the next-highest-leverage small-diff win but needs local upload testing before landing.
4. Walk any new mutating endpoints (authn / authz / `audit()` / Zod) — none existed this round. Watch for shared/public-profile features or any new field on a public-readable endpoint that could re-introduce a SEC-15-class PII leak.
5. Confirm the SEC-08 fix held on a live deploy: exhaust an API key's 60-req window against `GET https://glidecomp.com/api/auth/me` and check the 61st response is `429` with a `Retry-After` header (not a 500).
6. Confirm the `shell-quote` override held — `grep "shell-quote@" bun.lock` should show a single `1.8.4`+ entry. Drop the override if `concurrently` bumps its own pin.
7. Address scope-gap #8 (CSP enforce) on the next preview deploy.
8. Do NOT re-open SEC-03. It is accepted by design.

---

## 2026-06-12 — Re-review

### Methodology

- Read `docs/security-review.md` end-to-end first, carrying the prior round's "Scope gaps" and "Where to start" pointers into this round's scope.
- Diffed `master` vs the prior review's reference commit `fe39af4` (`git log fe39af4..HEAD`). **One commit since** — `9b3d25a`, the prior review's own PR (#176): the SEC-18 `shell-quote` override and the SEC-08 fix in `web/workers/auth-api/src/index.ts` plus its tests. No other application code landed. No new `[[routes]]` blocks, no new bindings, no new mutating endpoints.
- Re-reviewed the SEC-08 fix code with fresh eyes since it is the only new application code since the reference commit (it was authored inside the prior review's PR, so this is its first independent re-check). The `APIError` catch on `/api/auth/me` correctly distinguishes 429 (→ JSON 429 + `Retry-After` from `tryAgainIn`) from other API-key errors (→ `{ user: null }`, mirroring a garbage cookie) and re-throws non-`APIError` exceptions; the worker-wide after-middleware only adds `Retry-After` to 429s that lack one and copies the response correctly before mutating headers. No new concerns.
- Re-walked every prior `SEC-NN` finding against current code. Fix-site spot-checks all intact: `grep -rn "X-Glidecomp-Internal-User|INTERNAL_USER_HEADER" web/workers/` → only test/comment references (SEC-10); `validateAndDecompressIgc` caps + gzip-magic + `not_igc_content` shape check present (SEC-11/SEC-04); `xctskSchema` in use on both task routes and the user-task route (SEC-12); `serializeCompPilotPublic` still zeros the three PII fields (SEC-15); CORS allowlist unchanged on both public workers (SEC-01); `_headers` intact with four enforced headers + Report-Only CSP (SEC-02); `sw.js` filename sanitisation intact (SEC-13); `innerHTML =` count still 116 (SEC-05).
- Ran `bun audit` at HEAD — **0 vulnerabilities**. All four overrides held (`grep -E '"(kysely|qs|ws|shell-quote)@' bun.lock` → single `kysely@0.28.17`, `qs@6.15.2`, `ws@8.21.0`, `shell-quote@1.8.4`).
- Used the otherwise-quiet round to close **SEC-06** (no JSON body-size cap at the HTTP layer — Low/Medium, open since 2026-04-20 and repeatedly deferred for fear of breaking uploads). The deferral reason is now addressed with route-level regression tests in miniflare that prove large-but-legitimate IGC uploads still pass. Details in the SEC-06 status row.
- Ran `bun run typecheck:all` (clean), `bun run test:all` (green: 412 engine/airscore/root + 56 auth-api + 258 competition-api + 21 mcp-api — competition-api is +4 and auth-api +1 from the new SEC-06 regression tests), and `bun audit` (clean).
- **First live verification of SEC-02:** `curl -I` against this PR's Pages preview deploy (`d26f06d4.glidecomp.pages.dev`) confirmed the `_headers` file is actually served — all four enforced headers present (`X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: geolocation=(), microphone=(), camera=()`) plus the `Content-Security-Policy-Report-Only` exactly as authored. Prior rounds had only verified the file in-repo. Note: Pages serves static assets with `access-control-allow-origin: *` — benign (no credentials, public content), recorded so the next round doesn't re-investigate it. The CSP-violation walkthrough (scope-gap #8, flip to enforce) still requires a browser pass and remains open.
- Did **not** re-run dynamic CSRF PoC, live cookie-attribute checks, IGC/XCTask parser fuzzing, a Cloudflare zone-settings snapshot, or a CSP-Report-Only violation walkthrough — still in scope-gaps below.

### Executive summary

No new application code landed since the 2026-06-11 round other than that round's own PR (the SEC-08 fix, re-reviewed this round with fresh eyes — clean), so there was no fresh attack surface to audit. `bun audit` is clean and all four dependency overrides held. Re-verification confirmed every prior fix holds byte-for-byte. With the round otherwise quiet, this PR closes **SEC-06** inline: both public workers now register Hono's `bodyLimit` middleware worker-wide, so oversize request bodies are rejected with a JSON 413 while streaming — before any handler can buffer them via `c.req.arrayBuffer()` / `c.req.text()` (which previously allowed a single request to allocate up to the 100 MB Workers ceiling, the residual risk noted in the 2026-05-18 round against `/api/user/tracks`, and to reach the preferences route's own 64 KiB check only after full buffering). The competition-api cap is `MAX_COMPRESSED_BYTES + 1 KiB` (~1 MiB) so the SEC-11 helper's typed 400 remains the user-facing error at the IGC boundary and the largest legitimate JSON body (bulk pilot import, 250 bounded entries) fits comfortably; the auth-api cap is 128 KiB (Better Auth payloads and the 64 KiB preferences blob are far below it). Five new regression tests cover: oversize JSON → 413, oversize IGC upload → 413, a ~600 KB-compressed legitimate IGC upload still succeeding (pinning the cap above real-world uploads), the cap-ordering invariant, and an oversize auth-api body → 413. No new `SEC-NN` findings; the only remaining Open item is **SEC-05** (innerHTML render pattern, deferred-by-design).

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-06-12 | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Re-verified `web/workers/auth-api/src/index.ts:15-25` and `web/workers/competition-api/src/index.ts:25-35`. Allowlist unchanged; `cors.test.ts` regression suite still passes. |
| SEC-02  | No security response headers (`_headers`)                              | **Fixed (2026-05-25)** | `web/frontend/public/_headers` unchanged; CSP still Report-Only. Flip-to-enforce remains scope-gap #8. |
| SEC-03  | Admin emails returned on public comp detail                            | **Accepted (by design, 2026-06-01)** | Unchanged. Not to be re-opened without a product-design change. |
| SEC-04  | IGC upload size/shape — manufacturer-record check                      | **Fixed (2026-06-08)** | `igc-validation.ts` `not_igc_content` check unchanged; all three upload callsites inherit it. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | 116 `innerHTML =` sites under `web/frontend/src/` (identical to prior rounds — no frontend changes). All interpolations of user data still route through `sanitizeText()` / `escapeHtml()`. |
| SEC-06  | No JSON body-size cap                                                  | ~~Open~~ **Fixed (2026-06-12, this PR)** | Worker-wide `bodyLimit` registered on both public workers. **competition-api** (`web/workers/competition-api/src/index.ts:51-66`): cap `MAX_BODY_BYTES = MAX_COMPRESSED_BYTES + 1024` (~1 MiB + 1 KiB), imported from the SEC-11 helper so the two caps can't drift apart — sitting just above the IGC compressed cap keeps `validateAndDecompressIgc`'s typed 400 as the user-facing error at the 1 MiB boundary while `bodyLimit` guards the gross-abuse case (a 100 MB body is now refused at the `Content-Length` check or aborted mid-stream, never buffered). A single worker-wide cap was chosen over the originally-proposed 256 KiB-with-per-route-override because the bulk pilot validator legitimately admits ~250 × ~2.5 KiB ≈ 600 KiB JSON, which a 256 KiB global cap would have broken. **auth-api** (`web/workers/auth-api/src/index.ts:37-49`): cap 128 KiB — this also closes the residual buffering gap on `/api/auth/preferences`, whose own 64 KiB check ran only after `c.req.text()` had buffered the whole body. Both register before route dispatch, so the 413 fires before auth (cheapest rejection first) and returns the same JSON error shape as the rest of the worker. Regression tests: `web/workers/competition-api/test/body-limit.test.ts` (4 tests — cap-ordering invariant, oversize JSON → 413 unauthenticated, oversize IGC upload → 413, and a ~600 KB-compressed random-content IGC upload → 201 proving real track uploads survive the cap) and `web/workers/auth-api/test/routes.test.ts` (oversize dev-login body → 413). All suites green. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged. `BETTER_AUTH_URL = "https://glidecomp.com"` in `web/workers/auth-api/wrangler.toml`; `is-local-dev.test.ts` still passes. |
| SEC-08  | Rate-limit headers not surfaced                                        | **Fixed (2026-06-11)** | Re-reviewed the fix code with fresh eyes this round (it was the only new app code since the reference commit) — the `APIError` 429/other split, `tryAgainIn` → `Retry-After` conversion, and the worker-wide 429 after-middleware are all correct; the 61-request regression test in `routes.test.ts` still passes. The new bodyLimit middleware registers before the Retry-After middleware and does not interact with it. |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `middleware/auth.ts` byte-identical to the fix; grep returns only test/comment references. `auth-bypass.test.ts` still passes. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `igc-validation.ts` unchanged (1 MiB compressed + gzip-magic + 2 MiB streaming-decompressed caps + content-shape check). Now additionally backstopped by the SEC-06 route-level cap, which rejects oversize bodies before the helper's compressed-size check ever allocates them. |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `validators.ts:228` unchanged.                      |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | **Fixed (2026-06-01)** | `web/frontend/public/sw.js:53-68` unchanged from the fix.            |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix.                                            |
| SEC-15  | Unauthenticated PII on public pilot list                               | **Fixed**           | `routes/pilot.ts` unchanged. `serializeCompPilotPublic` still redacts the three PII fields for non-admins. |
| SEC-16  | Transitive `kysely@0.28.16` JSON-path traversal                        | **Fixed**           | Override held: single `kysely@0.28.17` in `bun.lock`. `bun audit` clean. |
| SEC-17  | `qs` (DoS) via MCP SDK→express; `ws` (memory disclosure) via dev tooling | **Fixed**         | Overrides held: single `qs@6.15.2` and `ws@8.21.0` in `bun.lock`. `bun audit` clean. |
| SEC-18  | Transitive `shell-quote@1.8.3` newline-escaping bypass                 | **Fixed (2026-06-11)** | Override held: single `shell-quote@1.8.4` in `bun.lock`. `bun audit` clean. |

### New findings

No new `SEC-NN` findings this round.

`bun audit` is clean; the diff since 2026-06-11 contains no application changes other than the prior review's own PR, which was re-reviewed this round (see Methodology) and found clean. No new mutating routes, no new bindings, no new public surfaces.

### Re-checked but no change

Because the only commit since the reference is the prior review's own PR, the prior rounds' detailed walks still hold. Spot-confirmed this round:

- **Authn / authz.** `requireAuth` resolves identity only by forwarding inbound `cookie` / `x-api-key` to auth-api; no header-trust backdoor. No new mutating routes.
- **Worker route surfaces.** `[[routes]]` across all four workers unchanged: airscore (`/api/airscore/*`), comp (`/api/comp`, `/api/comp/*`, `/api/user`, `/api/user/*`, `/api/u/*`), mcp (`/mcp`, `/mcp/*`), auth (`/api/auth/*`). No new public surface.
- **CORS.** Allowlist (`glidecomp.com`, `*.glidecomp.pages.dev`, `localhost`) on both public workers; disallowed origins get an empty `Access-Control-Allow-Origin`. The new bodyLimit middleware runs after CORS, so preflights (no body) are unaffected.
- **Parameterised SQL.** No new SQL sites this round; spot-checked sites all bind parameters.
- **`audit()` coverage.** No new mutating routes, so no new audit gaps.
- **MCP per-tool auth propagation.** Every tool forwards `apiKey` via `compApi` / `compApiRaw`; none forge identity. Unchanged.
- **wrangler.toml bindings.** Unchanged; single canonical production resource IDs.
- **`optionalAuth` PII (SEC-15 class).** No new `optionalAuth` routes; the 2026-05-18 systematic walk still applies.
- **Secrets.** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET` referenced as env only; no hard-coded keys in source or any `wrangler.toml`. API-key prefix still `glc_`.
- **Cascading delete on account delete.** `auth-api/src/index.ts` still walks every R2 object under `u/{user_id}/` before dropping the user row. Unchanged in behaviour (line numbers shifted slightly by the bodyLimit insertion).

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the allowlisted CORS.
2. Cookie attribute verification on a live deploy.
3. IGC / XCTask parser fuzzing.
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just the miniflare regression test).
6. Confirm the comp-api worker doesn't accept a legacy `Cookie: test-user=…` header in production.
7. TOCTOU / idempotency on `/api/user/tracks` + `/api/user/tasks` quota checks (UX bug class, no security exposure — from the 2026-05-18 round).
8. **Flip the CSP from Report-Only to enforced** (from the 2026-05-25 round). Requires a live Pages-deploy CSP-report pass across the analysis map, the theme editor's Google-Fonts loader, and the share-target flow.

No new scope gaps added this round.

### Where to start the next review

1. Commit reviewed up to: HEAD = `9b3d25a` (parent of this review's PR). Diff against that next round.
2. `bun audit` should be clean after this PR — if a new advisory pops up, walk the dependency tree for reachability before triaging severity (the `shell-quote` / `qs` / `ws` / `kysely` cases are the template).
3. Re-run the prior-findings table; the only remaining Open item is **SEC-05** (innerHTML pattern) — deferred-by-design, not urgent. A lint rule forbidding `innerHTML =` with interpolated template literals remains the documented incremental step if a round has spare scope budget.
4. Walk any new mutating endpoints (authn / authz / `audit()` / Zod) — none existed this round. Watch for shared/public-profile features or any new field on a public-readable endpoint that could re-introduce a SEC-15-class PII leak.
5. Confirm the SEC-06 fix held on a live deploy: `curl -s -o /dev/null -w "%{http_code}" -X POST -H "Content-Length: 104857600" https://glidecomp.com/api/comp` should return 413 (not 401/400); a normal IGC upload through the UI should still succeed.
6. Confirm the SEC-08 fix held on a live deploy: exhaust an API key's 60-req window against `GET https://glidecomp.com/api/auth/me` and check the 61st response is `429` with a `Retry-After` header (not a 500).
7. Address scope-gap #8 (CSP enforce) on the next preview deploy.
8. Do NOT re-open SEC-03. It is accepted by design.

---

## 2026-06-20 — Re-review

### Methodology

- Read `docs/security-review.md` end-to-end first, carrying the prior round's "Scope gaps" and "Where to start" pointers into this round's scope.
- Diffed `master` against the prior review's reference commit `9b3d25a` (the commit the 2026-06-12 round said it reviewed "up to"). Commits since: `f4a916c` (#178 — UX: Basecoat toasts/dialogs + loading feedback), `fc80c32` (#177 — the 2026-06-12 review's own PR, the SEC-06 `bodyLimit` fix), `8b12e30` (#179 — a project-reboot planning doc, no code), and `24712c1` (#180 — weekly dependency upgrade, 2026-06-14).
- **Important scope correction — a previously-unreviewed commit.** Because PRs land as squash merges, `f4a916c` (#178) merged into `master` *between* `9b3d25a` and the 2026-06-12 review PR (`fc80c32`), but it was **not** an ancestor of that review's diff base (`fe39af4`). Confirmed with `git merge-base --is-ancestor f4a916c 9b3d25a` → false. So the 2026-06-12 round's "one commit since (9b3d25a, our own PR)" claim silently skipped #178's 444-line frontend change (a new `web/frontend/src/feedback.ts` plus edits to `comp-detail.ts`, `comp.ts`, `dashboard.ts`, `settings.ts`, `kitchensink.ts` and six `.html` files). This round reviews it in full. No security finding resulted, but the gap is the reason this round diffs from `9b3d25a` rather than from `fc80c32`.
- Walked every line of the `f4a916c` (#178) frontend diff for DOM-sink / XSS regressions (SEC-05 class): read the new `feedback.ts` toast/confirm/alert module in full and every `toast.*` / `confirmDialog` / `alertDialog` callsite across the five touched `.ts` files, plus every new `innerHTML =` site and the `setAttribute("style", …)` in `dashboard.ts`.
- Re-walked every prior `SEC-NN` finding against current code. Fix-site spot-checks all intact (greps below).
- Ran `bun install` (node_modules was absent on the fresh clone) and `bun audit` at HEAD — **11 advisories (5 high, 3 moderate, 3 low)**, all in transitive dev/test/build tooling. See SEC-19; **fixed inline** via four new `overrides`, `bun audit` now clean.
- Ran `bun run typecheck:all` (clean), `bun run test:all` (green: 412 engine/airscore/root + 56 auth-api [+6 todo] + 258 competition-api + 21 mcp-api), and `bun audit` (clean) after the override bumps — confirming the `undici` / `vite` / `@babel/core` / `form-data` bumps didn't break the miniflare/jsdom test runners.
- Did **not** re-run dynamic CSRF PoC, live cookie-attribute checks, IGC/XCTask parser fuzzing, a Cloudflare zone-settings snapshot, or a CSP-Report-Only violation walkthrough — still in scope-gaps below.

### Executive summary

The only previously-unreviewed application code is the #178 UX commit (`f4a916c`), which swaps native `alert()`/`confirm()` for a new Basecoat-styled `feedback.ts` toast/dialog module and adds a storage-usage meter to the dashboard — **no new XSS surface**: `feedback.ts` HTML-escapes every interpolated string at the boundary (toast `description`, dialog `title`/`message`/labels all go through an `escapeHtml()` that round-trips via `textContent`), every caller that passes user data (`track.pilot_name`, a duplicate status `key`, an uploaded `file.name`) is therefore safe, and the dashboard's only attribute sink (`barEl.setAttribute("style", \`width: ${…toFixed(1)}%\`)`) interpolates a computed number. The worst item this round is **SEC-19**: `bun audit` was dirty at HEAD — 11 advisories including 5 High (`form-data` CRLF injection via jsdom, `vite` `server.fs.deny` bypass, and several `undici` advisories — TLS-validation bypass, SSRF via SOCKS5 pool reuse, WebSocket DoS — via `wrangler`/`@cloudflare/vitest-pool-workers`) plus a Low `@babel/core` arbitrary-file-read via the `agents` build chain. **None are reachable in production** (every flagged package is dev/test/build-only: jsdom, vitest, vitest-pool-workers, wrangler, vite tooling, and the Agents SDK's babel/rolldown build step — nothing ships to the Cloudflare Workers runtime or the static Pages bundle). Following the SEC-16/17/18 precedent, **all were fixed inline** by pinning the patched in-major versions via `overrides` (`form-data@^4.0.6`, `undici@^7.28.0`, `vite@^7.3.5`, `@babel/core@^7.29.7`); `bun audit` is clean again and all suites pass. No new mutating endpoints, routes, or bindings landed since the last round; the only remaining Open application finding is **SEC-05** (innerHTML render pattern, deferred-by-design — count ticked 116 → 119 from the three new, fully-escaped `feedback.ts`/`comp.ts` sites).

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-06-20 | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Re-verified the allowlist on both public workers (`web/workers/auth-api/src/index.ts`, `web/workers/competition-api/src/index.ts`); unchanged since 2026-06-12. `cors.test.ts` regression suite passes. |
| SEC-02  | No security response headers (`_headers`)                              | **Fixed (2026-05-25)** | `web/frontend/public/_headers` unchanged; CSP still Report-Only. Flip-to-enforce remains scope-gap #8. |
| SEC-03  | Admin emails returned on public comp detail                            | **Accepted (by design, 2026-06-01)** | Unchanged. Not to be re-opened without a product-design change. |
| SEC-04  | IGC upload size/shape — manufacturer-record check                      | **Fixed (2026-06-08)** | `igc-validation.ts` `not_igc_content` check unchanged; all three upload callsites inherit it. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | `grep -rn "innerHTML =" web/frontend/src \| wc -l` → 119 (was 116). The +3 are all from #178 and all safe: `feedback.ts:70` (`confirmDialog`) and `:108` (`alertDialog`) interpolate only `escapeHtml()`-escaped strings and static Tailwind class constants; `comp.ts:101` is a static "Failed to load competitions" error message with no interpolation. All other user-data interpolations still route through `sanitizeText()` / `escapeHtml()`. |
| SEC-06  | No JSON body-size cap                                                  | **Fixed (2026-06-12)** | Worker-wide `bodyLimit` still registered on both public workers (`grep -c bodyLimit …/index.ts` → 2 each — import + registration). Re-reviewed this round as it first appears in this diff range (it predates the `9b3d25a` base only by merge ordering); the fix matches the 2026-06-12 write-up. `body-limit.test.ts` passes. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged. `BETTER_AUTH_URL = "https://glidecomp.com"` in `web/workers/auth-api/wrangler.toml`; `is-local-dev.test.ts` passes. |
| SEC-08  | Rate-limit headers not surfaced                                        | **Fixed (2026-06-11)** | `/api/auth/me` `APIError` 429/other split + worker-wide `Retry-After` after-middleware unchanged; the 61-request regression test in `routes.test.ts` passes (56 auth-api tests green). |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `grep -rn "X-Glidecomp-Internal-User\|INTERNAL_USER_HEADER" web/workers/` (excluding tests/`.md`) → no `src` trust path. `middleware/auth.ts` forwards only inbound `cookie` / `x-api-key`. `auth-bypass.test.ts` passes. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `validateAndDecompressIgc` present and referenced by all three upload routes; caps + gzip-magic + content-shape check unchanged. Backstopped by the SEC-06 route-level cap. |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `validators.ts` unchanged; used by both task routes and the user-task route. |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | **Fixed (2026-06-01)** | `web/frontend/public/sw.js` unchanged from the fix; #178 did not touch the service worker. |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix.                                            |
| SEC-15  | Unauthenticated PII on public pilot list                               | **Fixed**           | `serializeCompPilotPublic` still present in `routes/pilot.ts`, still zeroing the three PII fields for non-admins. No new `optionalAuth` routes added. |
| SEC-16  | Transitive `kysely@0.28.16` JSON-path traversal                        | **Fixed**           | Override held: single `kysely@0.28.17` in `bun.lock`. `bun audit` clean. |
| SEC-17  | `qs` (DoS) via MCP SDK→express; `ws` (memory disclosure) via dev tooling | **Fixed**         | Overrides held: single `qs@6.15.2` and `ws@8.21.0` in `bun.lock`. `bun audit` clean. |
| SEC-18  | Transitive `shell-quote@1.8.3` newline-escaping bypass                 | **Fixed (2026-06-11)** | Override held: single `shell-quote@1.8.4` in `bun.lock`. `bun audit` clean. |

### New findings

---

#### SEC-19 — Dirty `bun audit` at HEAD: 11 transitive advisories (5 High) in dev/test/build tooling — **High (advisory) / negligible (reachability)** — ~~Open~~ **Fixed (2026-06-20, this PR)**

> **Resolution:** added four entries to the root `package.json` `overrides` block — `"@babel/core": "^7.29.7"`, `"form-data": "^4.0.6"`, `"undici": "^7.28.0"`, `"vite": "^7.3.5"` — each pinning the patched release within the package's existing major line (no major-version jump, so the dev/test/build toolchain stays API-compatible). After `bun install` the lockfile resolves a single fixed version of each (`@babel/core@7.29.7`, `form-data@4.0.6`, `undici@7.28.0`, `vite@7.3.5`; the vulnerable `vite@7.3.2` and `form-data@4.0.5`/`undici@7.24.8`/`@babel/core@7.29.0` copies are gone). `bun audit` reports **zero vulnerabilities**. `bun run typecheck:all`, the 412 engine/airscore/root + 56 auth-api + 258 competition-api + 21 mcp-api suites, all pass — confirming the bumped `undici`/`vite` didn't break the miniflare-backed (`@cloudflare/vitest-pool-workers`/`wrangler`) or jsdom-backed test runners.

**Files**
- `package.json` (overrides block) — fix applied here (four new lines).
- `bun.lock` — pre-fix had `@babel/core@7.29.0`, `form-data@4.0.5`, `undici@7.24.8`, and both `vite@7.3.2` + `vite@7.3.5`; post-fix a single fixed version of each.

**Advisories (pre-fix `bun audit`)**
- [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx) — `form-data` **High**: CRLF injection via unescaped multipart field names/filenames. Vulnerable `>=4.0.0 <4.0.6`. Path: `@glidecomp/frontend › jsdom › form-data`.
- [GHSA-fx2h-pf6j-xcff](https://github.com/advisories/GHSA-fx2h-pf6j-xcff) — `vite` **High**: `server.fs.deny` bypass on Windows alternate paths. [GHSA-v6wh-96g9-6wx3](https://github.com/advisories/GHSA-v6wh-96g9-6wx3) — `launch-editor` **Moderate**: NTLMv2 hash disclosure via UNC path on Windows. Vulnerable `vite >=7.0.0 <=7.3.4`. Paths: `@glidecomp/frontend › {vite, @tailwindcss/vite, vitest}`, `mcp-api › agents`.
- `undici >=7.23.0 <7.28.0` — five advisories: [GHSA-vmh5-mc38-953g](https://github.com/advisories/GHSA-vmh5-mc38-953g) **High** (TLS cert-validation bypass via dropped `requestTls` in SOCKS5 ProxyAgent), [GHSA-vxpw-j846-p89q](https://github.com/advisories/GHSA-vxpw-j846-p89q) **High** (WebSocket DoS via fragment-count bypass), [GHSA-hm92-r4w5-c3mj](https://github.com/advisories/GHSA-hm92-r4w5-c3mj) **High** (cross-origin request routing via SOCKS5 proxy pool reuse), [GHSA-pr7r-676h-xcf6](https://github.com/advisories/GHSA-pr7r-676h-xcf6) / [GHSA-p88m-4jfj-68fv](https://github.com/advisories/GHSA-p88m-4jfj-68fv) **Moderate**, [GHSA-35p6-xmwp-9g52](https://github.com/advisories/GHSA-35p6-xmwp-9g52) / [GHSA-g8m3-5g58-fq7m](https://github.com/advisories/GHSA-g8m3-5g58-fq7m) **Low**. Paths: `auth-api › @cloudflare/vitest-pool-workers › undici`, `@glidecomp/frontend › wrangler › undici`.
- [GHSA-4x5r-pxfx-6jf8](https://github.com/advisories/GHSA-4x5r-pxfx-6jf8) — `@babel/core` **Low**: arbitrary file read via `sourceMappingURL` comment. Vulnerable `<=7.29.0`. Path: `mcp-api › agents › @babel/plugin-proposal-decorators › @babel/core` (the Agents SDK's decorator/rolldown-babel build step).

**Reachability analysis**
Every flagged package is a **dev/test/build-time** transitive dependency and is not bundled into any deployed artifact:
- `form-data` enters only via `jsdom` (frontend unit-test DOM). Not shipped to Workers or Pages.
- `vite` is the build tool / dev server. The two flagged advisories are a Windows dev-server `fs.deny` bypass and a Windows `launch-editor` UNC-path NTLM leak — both require running the local dev server, neither affects the built static bundle. The vulnerable `7.3.2` copy was pulled by `@tailwindcss/vite` / `agents` / `vitest`; the frontend's own direct `vite` was already `7.3.5`.
- `undici` is Node's HTTP client, pulled by `wrangler` and `@cloudflare/vitest-pool-workers` (miniflare) for local dev/test. The Workers runtime uses its own native `fetch`, not `undici`; nothing in `web/workers/*/src/` imports it.
- `@babel/core` is pulled by `agents` for a build-time decorator transform (`@babel/plugin-proposal-decorators` / `@rolldown/plugin-babel`). It runs at mcp-api bundle time over our own source, never at the Workers runtime, and the advisory requires Babel to process attacker-controlled JS carrying a malicious `sourceMappingURL` — not a path this build exercises.

Production reachability: **none** for all 11. The advisory ceiling is High (the `form-data`/`vite`/`undici` items), which is why the finding is filed High-by-advisory, but the practical exposure is negligible.

**Severity rationale**
Documented as **High (advisory) / negligible (reachability)** — same posture as SEC-16 (High advisory, Low reachability), SEC-17 (Moderate), and SEC-18 (Critical advisory, negligible reachability). Per this routine's policy, High-and-above findings are fixed inline when the diff is small and obvious; an `overrides` bump is exactly that, and keeping `bun audit` clean is the signal the next round relies on to treat any non-clean audit as real.

**Note on version choice.** The latest releases are `undici@8.x`, `vite@8.x`, and `@babel/core@8.x`, but those are major bumps the toolchain isn't ready for — `docs/dependency-review-log.md` explicitly tracks Vite 8 as blocked on `@cloudflare/vitest-pool-workers` support ([workers-sdk#11064](https://github.com/cloudflare/workers-sdk/issues/11064)). Each override therefore pins the highest patched release *within the current major* (`undici@7.28.0`, `vite@7.3.5`, `@babel/core@7.29.7`), which clears every advisory without a risky major migration.

**Regression test**
`bun audit` (step 8 of `/security-review-repo`) is the regression detector, backed by the full worker/frontend test suites that exercise the bumped `undici`/`vite`/`jsdom`/`babel` toolchain. No in-app code path exists to assert against.

---

### Re-checked but no change

- **#178 UX commit (`f4a916c`) — full DOM-sink walk.** `web/frontend/src/feedback.ts` is the new shared toast/confirm/alert module: `escapeHtml()` (`:11-15`) escapes via `textContent` round-trip; `showToast` (`:30-43`) escapes the `description` before handing it to Basecoat's `innerHTML`-based toast renderer (the only non-escaped field, `category`, is a fixed 4-value union from internal callers); `confirmDialog`/`alertDialog` (`:64-128`) interpolate only `escapeHtml()`-escaped `title`/`message`/labels and static Tailwind class constants into their `innerHTML`. Every caller in `comp-detail.ts`, `comp.ts`, `dashboard.ts`, `settings.ts`, `kitchensink.ts` that passes user-controlled data (`track.pilot_name`, a duplicate pilot-status `key`, an uploaded `file.name`) is therefore safe. The new `dashboard.ts` storage meter writes `textEl.textContent` (safe) and `barEl.setAttribute("style", \`width: ${(…).toFixed(1)}%\`)` (numeric only). New `innerHTML =` sites in `comp.ts`/`settings.ts` are static constants / loading skeletons. The six touched `.html` files add only static markup (loading skeletons, the storage-meter container) — no inline `<script>`, `on*=` handlers, or `javascript:` URIs.
- **Authn / authz.** `requireAuth` resolves identity only by forwarding inbound `cookie` / `x-api-key` to auth-api; no header-trust backdoor. No new mutating routes (the #178 change is frontend-only and adds no new backend calls).
- **Worker route surfaces.** No `wrangler.toml` changes since `9b3d25a` (`git diff --stat 9b3d25a..HEAD -- '*wrangler.toml'` empty). `[[routes]]` unchanged across all four workers. No new public surface.
- **CORS.** Allowlist (`glidecomp.com`, `*.glidecomp.pages.dev`, `localhost`) on both public workers; unchanged.
- **Parameterised SQL.** No new SQL sites this round (no worker-source changes beyond the already-reviewed SEC-06 bodyLimit).
- **`audit()` coverage.** No new mutating routes, so no new audit gaps.
- **MCP per-tool auth propagation.** Every tool forwards `apiKey` via `compApi` / `compApiRaw`; none forge identity. Unchanged.
- **wrangler.toml bindings.** Unchanged; single canonical production resource IDs.
- **`optionalAuth` PII (SEC-15 class).** No new `optionalAuth` routes; the 2026-05-18 systematic walk still applies.
- **Secrets.** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET` referenced as env only; no hard-coded keys in source or any `wrangler.toml`. API-key prefix still `glc_`.

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the allowlisted CORS.
2. Cookie attribute verification on a live deploy.
3. IGC / XCTask parser fuzzing.
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just the miniflare regression test).
6. Confirm the comp-api worker doesn't accept a legacy `Cookie: test-user=…` header in production.
7. TOCTOU / idempotency on `/api/user/tracks` + `/api/user/tasks` quota checks (UX bug class, no security exposure — from the 2026-05-18 round).
8. **Flip the CSP from Report-Only to enforced** (from the 2026-05-25 round). Requires a live Pages-deploy CSP-report pass across the analysis map, the theme editor's Google-Fonts loader, and the share-target flow.

New process gap from this round:

9. **Review-base selection must not rely on `master`'s linear log.** This round found that #178 (`f4a916c`) slipped past the 2026-06-12 round because squash-merge ordering placed it between the prior review's diff base and its landing commit, so a `fe39af4..HEAD` diff never showed it. Going forward, derive the next base from the **"reviewed up to" commit recorded in the doc** (not the parent of the prior review's own PR) and, before trusting the diff, run `git merge-base --is-ancestor <each-feature-commit> <base>` for any PR merged in the same window to confirm nothing was skipped. (No security impact this round — #178 reviewed clean — but the gap could hide a real finding.)

### Where to start the next review

1. Commit reviewed up to: HEAD = `24712c1` (parent of this review's PR). Diff against that next round — and per scope-gap #9, double-check no sibling PR merged out-of-order between `9b3d25a` and `24712c1` was missed (this round confirmed `f4a916c`, `fc80c32`, `8b12e30`, `24712c1` are the complete set).
2. `bun audit` should be clean after this PR. If a new advisory pops up, walk the dependency tree for reachability before triaging severity (the SEC-19 `undici`/`vite`/`form-data`/`@babel/core` and earlier `shell-quote`/`qs`/`ws`/`kysely` cases are the template — all were dev/test/build-only and fixed via in-major `overrides`).
3. Confirm the four new overrides held — `grep -E '"(@babel/core|form-data|undici|vite)@' bun.lock` should show a single fixed version of each (`7.29.7`, `4.0.6`, `7.28.0`, `7.3.5`). Drop an override (or bump it) if its upstream starts requiring a newer major — in particular, revisit `vite`/`undici` once `@cloudflare/vitest-pool-workers` gains Vite 8 / undici 8 support ([workers-sdk#11064](https://github.com/cloudflare/workers-sdk/issues/11064)).
4. Re-run the prior-findings table; the only remaining Open application item is **SEC-05** (innerHTML pattern) — deferred-by-design. A lint rule forbidding `innerHTML =` with interpolated template literals remains the documented incremental step; `feedback.ts`'s centralised `escapeHtml()` is a good model to migrate other sites toward.
5. Walk any new mutating endpoints (authn / authz / `audit()` / Zod) — none existed this round. The #179 reboot plan targets a v1 launch by 2026-07-01, so expect a burst of new surface soon; watch for shared/public-profile features or new fields on public-readable endpoints that could re-introduce a SEC-15-class PII leak.
6. Do NOT re-open SEC-03. It is accepted by design — comp organisers' emails are intentionally visible to all pilots and to the public.

---

## 2026-06-21 — Re-review

### Methodology

- Read `docs/security-review.md` end-to-end first, carrying the prior round's "Scope gaps" and "Where to start" pointers into this round's scope.
- Diffed `master` against the prior round's recorded "reviewed up to" commit `24712c1` (per scope-gap #9 from the 2026-06-20 round, the base is taken from the doc's recorded commit, **not** the parent of the prior review's own PR, so an out-of-order squash merge can't be skipped). `git log 24712c1..HEAD` shows a single commit: `d564842` — the 2026-06-20 review's own PR (#182, the SEC-19 dependency overrides + the appended doc section). `git diff --stat 24712c1..HEAD` touches only `bun.lock`, `package.json`, and `docs/security-review.md`. **No new application source code, no new `[[routes]]` blocks, no new bindings, no new mutating endpoints** (`git diff --stat 24712c1..HEAD -- 'web/workers/**/src/**/*.ts' 'web/frontend/src/**/*.ts' 'functions/**' 'web/engine/src/**/*.ts' 'web/workers/**/wrangler.toml' 'web/frontend/public/**'` returns empty).
- Re-walked every prior `SEC-NN` finding against current code. Fix-site spot-checks all intact: `grep -rn "X-Glidecomp-Internal-User|INTERNAL_USER_HEADER" web/workers --include=*.ts` (excluding tests/comments) → no `src` trust path (SEC-10); `validateAndDecompressIgc` + `MAX_COMPRESSED_BYTES`/`MAX_BODY_BYTES` + `not_igc_content` shape check present (SEC-11/SEC-04); `bodyLimit` registered on both public workers (SEC-06); `serializeCompPilotPublic` present at `routes/pilot.ts:123,417` (SEC-15); CORS allowlist unchanged; `innerHTML =` count still 119 (SEC-05); no `test-user` reference in either public worker's `src` (scope-gap #6 spot-check still clean).
- Ran `bun install` (node_modules was absent on the fresh clone) and `bun audit` at HEAD — **0 vulnerabilities**. All eight overrides held (`grep -E '"(kysely|qs|ws|shell-quote|@babel/core|form-data|undici|vite)@' bun.lock` → single `kysely@0.28.17`, `qs@6.15.2`, `ws@8.21.0`, `shell-quote@1.8.4`, `@babel/core@7.29.7`, `form-data@4.0.6`, `undici@7.28.0`, `vite@7.3.5`).
- Used the otherwise-quiet round to **close the longest-standing scope gap — "IGC / XCTask parser fuzzing" (open since 2026-04-20)**. Wrote a seeded randomized fuzzer (`web/engine/tests/parser-robustness.test.ts`) that throws ~15k random byte-strings / record-soups / JSON payloads at both parsers. `parseIGC` is fully robust (0 throws across 9k+ inputs, as designed — length checks + `parseInt`→NaN). `parseXCTask` surfaced a robustness defect → **SEC-20** (two `TypeError` crash classes on untrusted input), **fixed inline** in this PR.
- Ran `bun run typecheck:all` (clean), `bun run test:all` (green: 419 engine/airscore/root [+7 from the new fuzz/robustness tests] + 56 auth-api [+6 todo] + 258 competition-api + 21 mcp-api), and `bun audit` (clean).
- Did **not** re-run dynamic CSRF PoC, live cookie-attribute checks, a Cloudflare zone-settings snapshot, or a CSP-Report-Only live-deploy walkthrough — still in scope-gaps below.

### Executive summary

No new application code landed since 2026-06-20 — the only commit is that round's own PR (#182), already documented — so there was no fresh attack surface, and re-verification confirmed every prior fix (SEC-01/04/06/08/10/11/12/13/15 and the SEC-16/17/18/19 dependency overrides) holds. `bun audit` is clean and all eight overrides held. With the round quiet, this PR finally **closes the parser-fuzzing scope gap (open since the very first 2026-04-20 round)** and the fuzzer found a real robustness defect, filed as **SEC-20** (Low): `parseXCTask` threw uncatchable-by-intent `TypeError`s on two untrusted-input classes — (1) valid-JSON primitives (`null` / `123` / `"x"` / `true`) tripped `TypeError: null is not an Object` via the `'turnpoints' in data` check, and (2) a non-string `waypoint.name`/`description`/`n` (legal in attacker-controlled JSON) tripped `TypeError: input.replace is not a function` inside `sanitizeText` — the shared XSS-escaping boundary for **all three** untrusted parsers (IGC, XCTask, AirScore). Every production caller already wraps `parseXCTask` in a generic `try/catch` and the server-side callers (`scoring.ts`, `routes/user-files.ts`) are gated by the SEC-12 `xctskSchema` (object-shaped, string-typed names), so practical exposure is **Low** — but a crashing XSS-escaping boundary is exactly the kind of latent fragility a future caller could trip. **Fixed inline** by (a) making `sanitizeText` coerce non-strings instead of throwing (`null`/`undefined`→`''`, primitives stringified, result still HTML-safe), and (b) guarding `parseXCTask` to reject non-object JSON with a clean catchable `Error` instead of a `TypeError`. Three new robustness/fuzz test groups (15k+ randomized inputs) lock the contract: `parseIGC` never throws; `parseXCTask` never throws a `TypeError`. No Critical/High/Medium findings this round; the only remaining Open application item is **SEC-05** (innerHTML render pattern, deferred-by-design).

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-06-21 | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Allowlist unchanged on both public workers (`web/workers/auth-api/src/index.ts`, `web/workers/competition-api/src/index.ts`). `cors.test.ts` regression suite passes. |
| SEC-02  | No security response headers (`_headers`)                              | **Fixed (2026-05-25)** | `web/frontend/public/_headers` unchanged; CSP still Report-Only. Flip-to-enforce remains scope-gap #8. |
| SEC-03  | Admin emails returned on public comp detail                            | **Accepted (by design, 2026-06-01)** | Unchanged. Not to be re-opened without a product-design change. |
| SEC-04  | IGC upload size/shape — manufacturer-record check                      | **Fixed (2026-06-08)** | `igc-validation.ts` `not_igc_content` check unchanged; all three upload callsites inherit it. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | `grep -rn "innerHTML =" web/frontend/src \| wc -l` → 119 (unchanged — no frontend source changes this round). All interpolations of user data still route through `sanitizeText()` / `escapeHtml()` — and `sanitizeText` is now crash-proof against non-string input (SEC-20), strengthening this boundary. |
| SEC-06  | No JSON body-size cap                                                  | **Fixed (2026-06-12)** | Worker-wide `bodyLimit` still registered on both public workers (`grep -c bodyLimit …/index.ts` → 2 each: import + registration). `body-limit.test.ts` passes. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged. `BETTER_AUTH_URL = "https://glidecomp.com"` in `web/workers/auth-api/wrangler.toml`; `is-local-dev.test.ts` passes. |
| SEC-08  | Rate-limit headers not surfaced                                        | **Fixed (2026-06-11)** | `/api/auth/me` `APIError` 429/other split + worker-wide `Retry-After` after-middleware unchanged; the 61-request regression test passes. |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `middleware/auth.ts` forwards only inbound `cookie` / `x-api-key`. Grep returns only test/comment references. `auth-bypass.test.ts` passes. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `validateAndDecompressIgc` present (1 MiB compressed + gzip-magic + 2 MiB streaming-decompressed caps + content-shape check); referenced by all three upload routes; backstopped by the SEC-06 route-level cap. |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `validators.ts` unchanged; used by both task routes and the user-task route. This is also what bounds SEC-20's server-side reachability (object-shaped, string-typed `name`), so the two server-side `parseXCTask` callers can't hit the SEC-20 crash classes. |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | **Fixed (2026-06-01)** | `web/frontend/public/sw.js` unchanged from the fix.                 |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix.                                            |
| SEC-15  | Unauthenticated PII on public pilot list                               | **Fixed**           | `serializeCompPilotPublic` still present in `routes/pilot.ts:123,417`, still zeroing the three PII fields for non-admins. No new `optionalAuth` routes. |
| SEC-16  | Transitive `kysely@0.28.16` JSON-path traversal                        | **Fixed**           | Override held: single `kysely@0.28.17` in `bun.lock`. `bun audit` clean. |
| SEC-17  | `qs` (DoS) via MCP SDK→express; `ws` (memory disclosure) via dev tooling | **Fixed**         | Overrides held: single `qs@6.15.2` and `ws@8.21.0` in `bun.lock`. `bun audit` clean. |
| SEC-18  | Transitive `shell-quote@1.8.3` newline-escaping bypass                 | **Fixed (2026-06-11)** | Override held: single `shell-quote@1.8.4` in `bun.lock`. `bun audit` clean. |
| SEC-19  | Dirty `bun audit` — 11 transitive advisories (dev/test/build tooling)  | **Fixed (2026-06-20)** | Four overrides held: single `@babel/core@7.29.7`, `form-data@4.0.6`, `undici@7.28.0`, `vite@7.3.5` in `bun.lock`. `bun audit` clean. |

### New findings

---

#### SEC-20 — `parseXCTask` throws uncaught `TypeError` on untrusted input (valid-JSON primitives; non-string waypoint names crash the shared `sanitizeText` XSS boundary) — **Low** — ~~Open~~ **Fixed (2026-06-21, this PR)**

> **Resolution:** two small defensive fixes close the whole class. (1) `web/engine/src/sanitize.ts` — `sanitizeText` now coerces non-string input instead of calling `.replace` on it: `null`/`undefined` → `''`, other non-strings → `String(input)` before escaping, so the result is always an HTML-safe string and the function can never crash its caller. (2) `web/engine/src/xctsk-parser.ts:334-346` — after `JSON.parse`, `parseXCTask` now rejects non-object / `null` parses with a clean, catchable `Error('Invalid XCTSK: expected a JSON object')` instead of letting the `'turnpoints' in data` check throw `TypeError: null is not an Object`. Arrays remain tolerated (they degrade to an empty task, unchanged behaviour). New regression coverage in `web/engine/tests/parser-robustness.test.ts` (6 groups, ~15k seeded-random inputs) pins the contract — `parseIGC` never throws on any input; `parseXCTask` only ever throws clean `Error`/`SyntaxError`, never a `TypeError` — plus non-string-coercion cases added to `web/engine/tests/sanitize.test.ts`. All 419 engine/airscore/root tests pass.

**Files**
- `web/engine/src/sanitize.ts:7-22` — the shared XSS-escaping boundary; pre-fix assumed `typeof input === 'string'` and called `.replace` directly.
- `web/engine/src/xctsk-parser.ts:323-350` — `parseXCTask`; pre-fix did `'turnpoints' in data` immediately after `JSON.parse` with no object guard.
- `web/engine/src/xctsk-parser.ts:131-194` (`parseV1`) / `:199-249` (`parseV2`) — pass `wp.name` / `wp.description` / `tpObj.n` (typed `as string`, but actually attacker-controlled JSON of any type) straight into `sanitizeText`.

**Evidence (pre-fix, found by the new fuzzer)**

```
parseXCTask('null')   -> TypeError: null is not an Object. (evaluating '"turnpoints" in data')
parseXCTask('123')    -> TypeError: 123 is not an Object.  (evaluating '"turnpoints" in data')
parseXCTask('"hello"')-> TypeError: "hello" is not an Object.
parseXCTask('true')   -> TypeError: true is not an Object.
parseXCTask('{"turnpoints":[{"waypoint":{"name":42,...}}]}')
                      -> TypeError: input.replace is not a function.   (inside sanitizeText)
parseXCTask('{"t":[{"n":99,...}]}')   // v2 compact
                      -> TypeError: input.replace is not a function.
```

`parseIGC`, by contrast, threw **0 times across 9000+ random inputs** — it is defensive by construction (every record parser length-checks first and uses `parseInt`, which yields `NaN` rather than throwing). No `parseIGC` fix needed; the fuzzer now pins that as a regression guard.

**Impact**
- All production `parseXCTask` callers already wrap it in a generic `try/catch` (`web/frontend/src/analysis/task-editor.ts:261`, `dashboard.ts:251`, `analysis/main.ts:1381/1895/1978`, `xctsk-fetch.ts`, `storage.ts`), so a malformed uploaded/pasted `.xctsk` surfaces as the intended "invalid task" error UX rather than an unhandled exception. The two server-side callers (`web/workers/competition-api/src/scoring.ts:128`, `routes/user-files.ts:469`) only ever see input that already passed the SEC-12 `xctskSchema` (object-shaped, `name` constrained to a `string`), so neither crash class is reachable there.
- Net practical exposure is **Low**: client-side only, self-inflicted (the uploader's own session), caught by callers, and the server paths are schema-gated. There is no XSS, data leak, auth bypass, or cross-user effect.
- The reason it is still worth fixing: `sanitizeText` is the **single shared XSS-escaping boundary** for IGC, XCTask, *and* AirScore-API text. A boundary whose contract is "escape this string safely" should never throw when handed a non-string — a future caller that doesn't wrap it (or that relies on its return value in a non-try/catch path) would turn a hostile JSON field into an uncaught crash. Making it total (never-throwing, always-safe-string) removes that latent foot-gun for every present and future caller.

**Severity rationale**
**Low** — a robustness / latent-uncaught-exception defect, not an exploitable vulnerability. Filed as a SEC-NN (rather than just a scope-gap note) because it is a concrete code fix with a regression test, in keeping with how prior quiet rounds closed SEC-13 (Low) and SEC-04 (Low sub-issue). It is the direct output of finally executing the 2026-04-20 "parser fuzzing" scope gap.

**Regression test**
`web/engine/tests/parser-robustness.test.ts` — a seeded (`mulberry32`) deterministic fuzzer:
- `parseIGC` never throws: a fixed hostile-input set + 5000 random byte-strings + 2000 random multi-line B/H/C/E record soups.
- `parseXCTask` throws only clean errors: explicit primitive cases assert `instanceof Error && !(instanceof TypeError)`; non-string `name`/`description`/`n` cases assert `.not.toThrow()`; 8000 random JSON payloads (half `XCTSK:`-prefixed) assert **zero** `TypeError`s.
- `web/engine/tests/sanitize.test.ts` gains a non-string-coercion group (null/undefined → `''`, number → its digits, hostile-`toString` object still HTML-safe).

---

### Re-checked but no change

Because every `*.ts` under `web/workers/*/src/`, `web/frontend/src/`, and `web/engine/src/` (other than the two SEC-20 fix files) is byte-identical to the 2026-06-20 round, the prior rounds' detailed walks still hold. Spot-confirmed this round:

- **Authn / authz.** `requireAuth` resolves identity only by forwarding inbound `cookie` / `x-api-key` to auth-api (`middleware/auth.ts`); no header-trust backdoor. `requireCompAdmin` gates on a `comp_admin` row. No new mutating routes.
- **Worker route surfaces.** `[[routes]]` unchanged across all four workers: airscore (`/api/airscore/*`), comp (`/api/comp`, `/api/comp/*`, `/api/user`, `/api/user/*`, `/api/u/*`), mcp (`/mcp`, `/mcp/*`), auth (`/api/auth/*`). No new public surface (`git diff --stat 24712c1..HEAD -- '*wrangler.toml'` empty).
- **CORS.** Allowlist (`glidecomp.com`, `*.glidecomp.pages.dev`, `localhost`) on both public workers; disallowed origins get an empty `Access-Control-Allow-Origin`. Unchanged.
- **Parameterised SQL.** No new SQL sites this round; spot-checked sites all bind parameters.
- **`audit()` coverage.** No new mutating routes, so no new audit gaps.
- **MCP per-tool auth propagation.** Every tool forwards `apiKey` via `compApi` / `compApiRaw`; none forge identity. Unchanged.
- **wrangler.toml bindings.** Unchanged; single canonical production resource IDs; auth-api + competition-api intentionally share D1; auth-api shares the `glidecomp` R2 bucket for cascading delete.
- **`optionalAuth` PII (SEC-15 class).** No new `optionalAuth` routes; the 2026-05-18 systematic walk still applies (PII-free except the by-design SEC-03 admin emails).
- **Secrets.** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET` referenced as env only; no hard-coded keys in source or any `wrangler.toml`. API-key prefix still `glc_`.
- **Legacy `test-user` cookie (scope-gap #6).** `grep -rn "test-user" web/workers/auth-api/src web/workers/competition-api/src` → no hits. No test-only cookie backdoor shipped.

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the allowlisted CORS.
2. Cookie attribute verification on a live deploy.
3. ~~IGC / XCTask parser fuzzing~~ — **done this round** (`web/engine/tests/parser-robustness.test.ts`; SEC-20). The fuzzer is now a permanent regression guard; future rounds need only re-run it, not re-derive it. *(Possible future extension: fuzz `parseXCTaskAsync`'s `XCTSKZ:` deflate path and the v2 polyline decoder against truncated/garbage base64 — both looked robust on inspection but were not part of this round's randomized corpus.)*
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just the miniflare regression test).
6. Confirm the comp-api worker doesn't accept a legacy `Cookie: test-user=…` header in production (static check clean again this round; live-deploy confirmation still pending).
7. TOCTOU / idempotency on `/api/user/tracks` + `/api/user/tasks` quota checks (UX bug class, no security exposure — from the 2026-05-18 round).
8. **Flip the CSP from Report-Only to enforced** (from the 2026-05-25 round). Requires a live Pages-deploy CSP-report pass across the analysis map, the theme editor's Google-Fonts loader, and the share-target flow.
9. **Review-base selection must not rely on `master`'s linear log** (from the 2026-06-20 round) — applied this round: base taken from the doc's recorded `24712c1`, and the single commit since (`d564842`) confirmed to be the prior review's own PR.

### Where to start the next review

1. Commit reviewed up to: HEAD = `d564842` (parent of this review's PR). Diff against that next round, and per scope-gap #9 derive the base from this recorded commit (not the parent of this review's own PR) and `git merge-base --is-ancestor` any sibling PRs merged in the window.
2. `bun audit` should be clean after this PR. If a new advisory pops up, walk the dependency tree for reachability before triaging severity (the SEC-16/17/18/19 cases are the template — all dev/test/build-only, fixed via in-major `overrides`). Confirm the eight overrides still resolve to single fixed versions.
3. Re-run the prior-findings table; the only remaining Open application item is **SEC-05** (innerHTML pattern) — deferred-by-design. A lint rule forbidding `innerHTML =` with interpolated template literals remains the documented incremental step; `feedback.ts`'s centralised `escapeHtml()` is the migration model. Note `sanitizeText` is now total/crash-proof (SEC-20), which marginally hardens this boundary.
4. Walk any new mutating endpoints (authn / authz / `audit()` / Zod). The #179 reboot plan targets a v1 launch by 2026-07-01, so expect a burst of new surface soon; watch for shared/public-profile features or new fields on public-readable endpoints that could re-introduce a SEC-15-class PII leak.
5. The parser fuzzer (`web/engine/tests/parser-robustness.test.ts`) runs as part of `bun run test:all` — if a future parser change makes `parseIGC` throw or `parseXCTask` throw a `TypeError`, it will fail there. Extend it to `parseXCTaskAsync` / the v2 polyline decoder if those paths grow (scope-gap #3 note).
6. Do NOT re-open SEC-03. It is accepted by design — comp organisers' emails are intentionally visible to all pilots and to the public.

---

## 2026-06-21 (II) — Re-review

> Second review pass on the same calendar day as the prior round. The prior 2026-06-21 round (#183) closed the main parser-fuzzing scope gap and fixed SEC-20; this pass picks up the **leftover** of that gap — the two parser paths the prior round explicitly deferred ("Possible future extension: fuzz `parseXCTaskAsync`'s `XCTSKZ:` deflate path and the v2 polyline decoder … both looked robust on inspection but were not part of this round's randomized corpus") — and finds that one of them was *not* in fact robust.

### Methodology

- Read `docs/security-review.md` end-to-end first, carrying the prior round's "Scope gaps" and "Where to start" pointers into this round's scope.
- Diffed `master` against the prior round's recorded "reviewed up to" commit `d564842` (per scope-gap #9, base taken from the doc's recorded commit, **not** the parent of the prior review's own PR). `git log d564842..HEAD` shows a single commit: `63413b2` — the prior 2026-06-21 review's own PR (#183, the SEC-20 fix + appended doc section). `git diff --stat d564842..HEAD` touches only `docs/security-review.md`, `web/engine/src/sanitize.ts`, `web/engine/src/xctsk-parser.ts`, and the two engine test files — i.e. exactly the SEC-20 fix. **No new `[[routes]]`, no new bindings, no new mutating endpoints, no new worker/frontend source** beyond that already-documented PR (`git diff --stat d564842..HEAD -- 'web/workers/**/wrangler.toml' 'functions/**'` empty). `git merge-base --is-ancestor d564842 HEAD` → true; no sibling PR merged out-of-order in the window.
- Re-walked every prior `SEC-NN` finding against current code. Fix-site spot-checks all intact: `grep -rn "X-Glidecomp-Internal-User|INTERNAL_USER_HEADER" web/workers/**/src/**/*.ts` → no `src` trust path (SEC-10); `validateAndDecompressIgc` + `MAX_COMPRESSED_BYTES` (1 MiB) / `MAX_BODY_BYTES` / `not_igc_content` shape check present (SEC-11/04); `bodyLimit` registered on both public workers (`grep -c bodyLimit …/index.ts` → 2 each) (SEC-06); `serializeCompPilotPublic` at `routes/pilot.ts:123,417` (SEC-15); CORS allowlist unchanged; `innerHTML =` count still 119 (SEC-05); no `test-user` reference in either public worker's `src` (scope-gap #6 spot-check clean).
- Ran `bun install` (node_modules absent on the fresh clone) and `bun audit` at HEAD — **0 vulnerabilities**. All eight overrides held (`grep -E '"(kysely|qs|ws|shell-quote|@babel/core|form-data|undici|vite)@' bun.lock` → single `kysely@0.28.17`, `qs@6.15.2`, `ws@8.21.0`, `shell-quote@1.8.4`, `@babel/core@7.29.7`, `form-data@4.0.6`, `undici@7.28.0`, `vite@7.3.5`).
- **Executed scope-gap #3's deferred extension.** Extended the `web/engine/tests/parser-robustness.test.ts` fuzzer to the two paths the prior round left untested: (a) `parseXCTaskAsync`'s `XCTSKZ:` base64+deflate decode, and (b) the v2 polyline decoder (`decodePolyline` / `decodePolylineValue`) reached via a `t[].z` field. The polyline decoder is robust (0 throws across 3000 random `z` strings — it is length-bounded and `charCodeAt` past the end yields `NaN`, which the bitwise ops absorb, with no infinite loop). The deflate path was **not** robust → **SEC-21**, **fixed inline** in this PR.
- Ran `bun run typecheck:all` (clean), `bun run test:all` (green: 422 engine/airscore/root [+3 from the new deflate/polyline fuzz groups] + 56 auth-api [+6 todo] + 258 competition-api + 21 mcp-api), and `bun audit` (clean).
- Did **not** re-run dynamic CSRF PoC, live cookie-attribute checks, a Cloudflare zone-settings snapshot, or a CSP-Report-Only live-deploy walkthrough — still in scope-gaps below.

### Executive summary

No new application code landed since the prior 2026-06-21 round — the only commit is that round's own PR (#183) — so there was no fresh attack surface, and re-verification confirmed every prior fix holds (`bun audit` clean, all eight overrides intact). With the round otherwise quiet, this pass executed the **leftover of the parser-fuzzing scope gap** the prior round deferred, and the fuzzer found a real robustness defect, filed as **SEC-21** (Low): `parseXCTaskAsync`'s default `XCTSKZ:` deflate path — which decodes attacker-controlled base64 and inflates it via `DecompressionStream('deflate')` — crashed on corrupt/truncated input in two ways: (1) it surfaced the runtime's raw `TypeError` (`Z_BUF_ERROR`) instead of a clean catchable `Error`, breaking the same "parsers only throw clean errors" contract SEC-20 established for `parseXCTask`; and (2) the manual stream **writer was never awaited**, so a failed inflate leaked an **unhandled promise rejection** (confirmed by a `process.on('unhandledRejection')` probe — 2/2 probe tests failed on escaping rejections). Practical exposure is **Low**: `parseXCTaskAsync` has no in-repo caller yet (it is a public engine API for XCTrack's compressed-QR `XCTSKZ:` format; in-repo flows use the sync `parseXCTask`, which rejects `XCTSKZ:` outright), and any future caller would wrap it in try/catch — but an unhandled rejection can terminate a Node/Worker process and a crashing untrusted-input parser is exactly the latent foot-gun SEC-20 set out to remove. **Fixed inline** by piping the bytes through a `Response` body (no dangling writer to leak) inside a `try/catch` that re-throws a single clean `Error('Invalid XCTSKZ: could not decompress task data')`. The fuzzer now pins both leftover paths (deflate: clean-error-only + zero unhandled rejections across 1500 corrupt inputs; polyline: never-throws across 3000 random `z` fields), fully closing scope-gap #3. No Critical/High/Medium findings; the only remaining Open application item is **SEC-05** (innerHTML render pattern, deferred-by-design).

### Status of prior findings

| ID      | Title                                                                  | Status @ 2026-06-21 (II) | Notes                                                                |
|---------|------------------------------------------------------------------------|---------------------|----------------------------------------------------------------------|
| SEC-01  | Reflective CORS w/ credentials                                         | **Fixed**           | Allowlist unchanged on both public workers; `cors.test.ts` passes.   |
| SEC-02  | No security response headers (`_headers`)                              | **Fixed (2026-05-25)** | `web/frontend/public/_headers` unchanged; CSP still Report-Only. Flip-to-enforce remains scope-gap #8. |
| SEC-03  | Admin emails returned on public comp detail                            | **Accepted (by design, 2026-06-01)** | Unchanged. Not to be re-opened without a product-design change. |
| SEC-04  | IGC upload size/shape — manufacturer-record check                      | **Fixed (2026-06-08)** | `igc-validation.ts` `not_igc_content` check unchanged; all three upload callsites inherit it. |
| SEC-05  | `innerHTML` is the default render primitive                            | **Open**            | `grep -rn "innerHTML =" web/frontend/src \| wc -l` → 119 (unchanged — no frontend source changes this round). All user-data interpolations still route through `sanitizeText()` / `escapeHtml()`. |
| SEC-06  | No JSON body-size cap                                                  | **Fixed (2026-06-12)** | Worker-wide `bodyLimit` still registered on both public workers (2 each: import + registration). `body-limit.test.ts` passes. |
| SEC-07  | Dev-only endpoints gated by `BETTER_AUTH_URL` hostname                 | **Verified safe**   | Unchanged. `BETTER_AUTH_URL = "https://glidecomp.com"`; `is-local-dev.test.ts` passes. |
| SEC-08  | Rate-limit headers not surfaced                                        | **Fixed (2026-06-11)** | `/api/auth/me` `APIError` 429 split + worker-wide `Retry-After` unchanged; 61-request regression test passes. |
| SEC-09  | `Math.random()` non-security use                                       | **Closed (Info)**   | No new uses; staying closed.                                         |
| SEC-10  | Authentication bypass via trusted `X-Glidecomp-Internal-User` header   | **Fixed**           | `middleware/auth.ts` forwards only inbound `cookie` / `x-api-key`. Grep returns only test/comment references. `auth-bypass.test.ts` passes. |
| SEC-11  | IGC gzip-bomb decompression                                            | **Fixed**           | `validateAndDecompressIgc` present (1 MiB compressed + gzip-magic + 2 MiB streaming-decompressed caps + content-shape check); referenced by all three upload routes. |
| SEC-12  | `xctsk` body has no shape, depth, or size cap                          | **Fixed**           | `xctskSchema` in `validators.ts` unchanged; used by both task routes and the user-task route. Also bounds the two server-side `parseXCTask` callers (object-shaped, string `name`). |
| SEC-13  | Service worker stores share-target uploads under unsanitised filenames | **Fixed (2026-06-01)** | `web/frontend/public/sw.js` unchanged from the fix.                 |
| SEC-14  | Service-binding trust comment misleads readers                         | **Closed**          | Resolved with SEC-10 fix.                                            |
| SEC-15  | Unauthenticated PII on public pilot list                               | **Fixed**           | `serializeCompPilotPublic` still present at `routes/pilot.ts:123,417`, still zeroing the three PII fields for non-admins. No new `optionalAuth` routes. |
| SEC-16  | Transitive `kysely@0.28.16` JSON-path traversal                        | **Fixed**           | Override held: single `kysely@0.28.17` in `bun.lock`. `bun audit` clean. |
| SEC-17  | `qs` (DoS) via MCP SDK→express; `ws` (memory disclosure) via dev tooling | **Fixed**         | Overrides held: single `qs@6.15.2` and `ws@8.21.0`. `bun audit` clean. |
| SEC-18  | Transitive `shell-quote@1.8.3` newline-escaping bypass                 | **Fixed (2026-06-11)** | Override held: single `shell-quote@1.8.4`. `bun audit` clean. |
| SEC-19  | Dirty `bun audit` — 11 transitive advisories (dev/test/build tooling)  | **Fixed (2026-06-20)** | Four overrides held: single `@babel/core@7.29.7`, `form-data@4.0.6`, `undici@7.28.0`, `vite@7.3.5`. `bun audit` clean. |
| SEC-20  | `parseXCTask` throws `TypeError` on untrusted input                    | **Fixed (2026-06-21)** | `sanitizeText` non-string coercion + `parseXCTask` non-object guard unchanged; `parser-robustness.test.ts` passes. SEC-21 is the async-path sibling of this same robustness class. |

### New findings

---

#### SEC-21 — `parseXCTaskAsync` `XCTSKZ:` deflate path throws a raw `TypeError` and leaks an unhandled promise rejection on corrupt input — **Low** — ~~Open~~ **Fixed (2026-06-21, this PR)**

> **Resolution:** `web/engine/src/xctsk-parser.ts` — the default-decompression branch of `parseXCTaskAsync` was rewritten to (a) pipe the decoded bytes through a `Response` body (`new Response(bytes).body.pipeThrough(new DecompressionStream('deflate'))`) instead of a manually-driven `WritableStream` writer, so there is no un-awaited `writer.write()` / `writer.close()` promise left to escape as an unhandled rejection; and (b) wrap the whole base64-decode-and-inflate in a `try/catch` that re-throws a single clean, catchable `Error('Invalid XCTSKZ: could not decompress task data')`. `parseXCTaskAsync` now honours the same contract `parseXCTask` got in SEC-20: corrupt/untrusted input yields only clean `Error`/`SyntaxError`, never a raw `TypeError`, and never an escaping unhandled rejection. New regression coverage in `web/engine/tests/parser-robustness.test.ts` (two new `parseXCTaskAsync` groups + one polyline group) pins it.

**Files**
- `web/engine/src/xctsk-parser.ts:378-403` — `parseXCTaskAsync` default `DecompressionStream('deflate')` branch. Pre-fix: `const writer = ds.writable.getWriter(); writer.write(bytes); writer.close();` — neither promise awaited — then `await new Response(ds.readable).text()` with no surrounding try/catch.
- `web/engine/src/xctsk-parser.ts:89-126` (`decodePolyline`) / `:70-82` (`decodePolylineValue`) — the v2 polyline decoder, the other scope-gap #3 leftover path. **No defect** (length-bounded loop, `NaN`-absorbing bitwise ops) — added to the fuzzer as a regression guard only.

**Evidence (pre-fix, found by the extended fuzzer)**

```
parseXCTaskAsync('XCTSKZ:aGVsbG8gd29ybGQ=')  // valid base64, not a deflate stream
    -> TypeError (Z_BUF_ERROR)   + unhandled rejection from the dangling writer
parseXCTaskAsync('XCTSKZ:eJw=')              // zlib header, truncated body
    -> TypeError (Z_BUF_ERROR)   + unhandled rejection
parseXCTaskAsync('XCTSKZ:')                  // empty payload
    -> TypeError                 + unhandled rejection
```

A `process.on('unhandledRejection', …)` probe over 1500 random `XCTSKZ:`-prefixed corrupt strings tripped the handler (the two probe tests failed purely on escaping rejections, even though every `await` was wrapped in try/catch — the rejection came from the *writable* side, which the caller never holds a handle to). Invalid-base64-alphabet input (e.g. `XCTSKZ:!!!`) already threw a catchable `DOMException` from `atob`; the fix folds that into the same clean-`Error` path for a uniform contract.

**Impact**
- **Low / latent.** `parseXCTaskAsync` currently has **no in-repo caller** — it is a public `web/engine` API for XCTrack's compressed-QR `XCTSKZ:` format, exported via `web/engine/src/index.ts`. Every in-repo `.xctsk` flow (`task-editor.ts`, `dashboard.ts`, `analysis/main.ts`, `xctsk-fetch.ts`, `storage.ts`) uses the **sync** `parseXCTask`, which rejects an `XCTSKZ:` prefix outright with a clean `Error`, so today nothing reaches the buggy branch. There is no XSS, data leak, auth bypass, or cross-user effect.
- The reason it is still worth fixing: an **unhandled promise rejection** is not a benign throw — under Node's default `--unhandled-rejections=throw` it terminates the process, and in a Cloudflare Worker it can fault the request context. A parser that consumes untrusted input (a pasted/scanned XCTSKZ task) should never be able to crash its host out-of-band, regardless of whether the caller wrapped the visible `await`. This is the exact async sibling of SEC-20 — the same "untrusted-input parser must only fail cleanly" principle, extended to the path SEC-20's round deferred.

**Severity rationale**
**Low** — a robustness / latent-uncaught-exception defect, not an exploitable vulnerability, and with no current caller. Filed as a SEC-NN (rather than a scope-gap note) because it is a concrete code fix with a regression test, exactly as SEC-20 was the prior round. It is the direct output of finishing scope-gap #3's deferred extension.

**Regression test**
`web/engine/tests/parser-robustness.test.ts` — two new `parseXCTaskAsync` groups + one polyline group:
- `parseXCTaskAsync` rejects a fixed set of corrupt `XCTSKZ:` inputs (empty / invalid-base64 / valid-base64-non-deflate / truncated-deflate / long-garbage) with `instanceof Error && !(instanceof TypeError)`.
- `parseXCTaskAsync` leaks **zero** unhandled rejections across 1500 random corrupt `XCTSKZ:` payloads (asserted via a `process.on('unhandledRejection')` counter).
- `parseXCTask` v2 polyline decoder never throws across 3000 random `z` fields.
All 422 engine/airscore/root tests pass.

---

### Re-checked but no change

Because every `*.ts` under `web/workers/*/src/`, `web/frontend/src/`, and `web/engine/src/` (other than the SEC-21 fix file) is byte-identical to the prior 2026-06-21 round, that round's detailed walks still hold. Spot-confirmed this round:

- **Authn / authz.** `requireAuth` resolves identity only by forwarding inbound `cookie` / `x-api-key` to auth-api; no header-trust backdoor. No new mutating routes.
- **Worker route surfaces.** `[[routes]]` unchanged across all four workers (`git diff --stat d564842..HEAD -- '*wrangler.toml'` empty). No new public surface.
- **CORS.** Allowlist (`glidecomp.com`, `*.glidecomp.pages.dev`, `localhost`) on both public workers; disallowed origins get an empty `Access-Control-Allow-Origin`. Unchanged.
- **Parameterised SQL.** No new SQL sites this round; spot-checked sites all bind parameters.
- **`audit()` coverage.** No new mutating routes, so no new audit gaps.
- **MCP per-tool auth propagation.** Every tool forwards `apiKey` via `compApi` / `compApiRaw`; none forge identity. Unchanged.
- **wrangler.toml bindings.** Unchanged; single canonical production resource IDs.
- **`optionalAuth` PII (SEC-15 class).** No new `optionalAuth` routes; the 2026-05-18 systematic walk still applies.
- **Secrets.** `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID/SECRET` referenced as env only; no hard-coded keys in source or any `wrangler.toml`. API-key prefix still `glc_`.
- **Legacy `test-user` cookie (scope-gap #6).** `grep -rn "test-user" web/workers/auth-api/src web/workers/competition-api/src` → no hits.
- **`sanitizeText` non-string coercion (SEC-20).** Re-confirmed present at `web/engine/src/sanitize.ts:11-14`; the shared XSS boundary still cannot crash on a non-string.

### Scope gaps still not done

Carried forward from prior rounds:

1. Dynamic CSRF PoC against the allowlisted CORS.
2. Cookie attribute verification on a live deploy.
3. ~~IGC / XCTask parser fuzzing~~ — **fully closed**. The main gap closed 2026-06-21 (SEC-20); this round closed the two deferred leftover paths — `parseXCTaskAsync`'s `XCTSKZ:` deflate decode (SEC-21, was buggy) and the v2 polyline decoder (robust). The fuzzer (`web/engine/tests/parser-robustness.test.ts`) now covers `parseIGC`, `parseXCTask`, `parseXCTaskAsync`, and the polyline decoder as permanent regression guards. *(Nothing parser-shaped remains un-fuzzed; re-open only if a new parser/format is added.)*
4. Cloudflare zone settings snapshot (HSTS, TLS min, WAF, bot management).
5. Verify SEC-10 fix on a deployed comp-api endpoint (not just the miniflare regression test).
6. Confirm the comp-api worker doesn't accept a legacy `Cookie: test-user=…` header in production (static check clean again this round; live-deploy confirmation still pending).
7. TOCTOU / idempotency on `/api/user/tracks` + `/api/user/tasks` quota checks (UX bug class, no security exposure — from the 2026-05-18 round).
8. **Flip the CSP from Report-Only to enforced** (from the 2026-05-25 round). Requires a live Pages-deploy CSP-report pass across the analysis map, the theme editor's Google-Fonts loader, and the share-target flow.
9. **Review-base selection must not rely on `master`'s linear log** (from the 2026-06-20 round) — applied this round: base taken from the doc's recorded `d564842`, the single commit since (`63413b2`) confirmed to be the prior review's own PR via `git merge-base --is-ancestor`.

### Where to start the next review

1. Commit reviewed up to: HEAD = `63413b2` (parent of this review's PR). Diff against that next round, and per scope-gap #9 derive the base from this recorded commit (not the parent of this review's own PR) and `git merge-base --is-ancestor` any sibling PRs merged in the window.
2. `bun audit` should be clean after this PR. If a new advisory pops up, walk the dependency tree for reachability before triaging severity (the SEC-16/17/18/19 cases are the template — all dev/test/build-only, fixed via in-major `overrides`). Confirm the eight overrides still resolve to single fixed versions.
3. Re-run the prior-findings table; the only remaining Open application item is **SEC-05** (innerHTML pattern) — deferred-by-design. A lint rule forbidding `innerHTML =` with interpolated template literals remains the documented incremental step; `feedback.ts`'s centralised `escapeHtml()` is the migration model.
4. Walk any new mutating endpoints (authn / authz / `audit()` / Zod). The #179 reboot plan targets a v1 launch by 2026-07-01 (now ~10 days out), so expect a burst of new surface imminently; watch for shared/public-profile features or new fields on public-readable endpoints that could re-introduce a SEC-15-class PII leak.
5. The parser fuzzer now covers all four parser entry points (`parseIGC`, `parseXCTask`, `parseXCTaskAsync`, polyline decoder) and runs under `bun run test:all`. Scope-gap #3 is fully closed — extend the fuzzer only if a new parser/format lands.
6. Do NOT re-open SEC-03. It is accepted by design — comp organisers' emails are intentionally visible to all pilots and to the public.
