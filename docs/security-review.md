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
