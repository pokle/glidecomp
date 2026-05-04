# GlideComp Security Review

> **Purpose:** Living memory log for security audits. Each review should append a new dated section and mark prior findings as `Fixed` / `Open` / `Accepted`, preserving history so we can spot regressions.

---

## Review Log

| Date       | Reviewer | Scope                            | Status       |
|------------|----------|----------------------------------|--------------|
| 2026-04-20 | Claude   | Full repo (auth, comp, MCP, FE)  | Initial      |
| 2026-04-20 | Claude   | SEC-01 remediation               | Fixed inline |
| 2026-05-04 | Claude   | Re-review + new findings (SEC-10..14) | SEC-10, SEC-11, SEC-14 fixed inline (this PR) |

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

#### SEC-12 — `xctsk` task body has no shape, depth, or size cap — **Medium** — Open

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

1. Re-evaluate SEC-12 (unbounded xctsk) first — the only Medium+ open exploitable item remaining now that SEC-10 and SEC-11 are fixed.
2. `git log` since `560ccbd` to spot any new mutating endpoints; for each, verify (a) authn middleware, (b) authz middleware, (c) audit() call, (d) Zod validator with bounded fields.
3. `bun audit` and a fresh diff of `docs/dependency-review-log.md`.
4. Re-run the whole prior-findings table; update Status column.
5. Confirm the SEC-10 fix held: send `X-Glidecomp-Internal-User` to a deployed comp-api endpoint and check it gets 401 (regression test only covers the in-process miniflare path).
