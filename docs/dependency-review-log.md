# Dependency Review Log

This log is written by the weekly upgrade routine at `.claude/commands/upgrade-deps.md`. The routine reads the most recent entries and "Lessons" sections each run, then appends a new dated entry. Edit the routine itself when steps need to change.

## 2026-07-05

### Security Vulnerabilities Fixed

None. `bun audit` reported 0 vulnerabilities before and after this cycle. All upgrades this week are routine maintenance bumps, not security-forced.

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **wrangler** | 4.105.0 | 4.107.0 | root, frontend, auth-api, competition-api, airscore-api | 4.106.0: AI Search job management, R2 jurisdiction support, multi-profile auth (`wrangler auth create/list/…`), D1 migrations in test harness (`worker.applyD1Migrations()`), workflow introspection helpers. 4.107.0: cache options for WorkerEntrypoint exports, declarative Durable Object `exports` map (alternative to `migrations`), `wrangler flagship` commands, OS-keychain OAuth storage (`--use-keyring`). **Removed the deprecated `--experimental-vm-modules` flag** (not used here — grepped). workerd → 1.20260701.1. Requires Node ≥22.0.0 (CI installs Node 22 — no bump needed). No breaking changes affecting our usage. |
| **@cloudflare/vitest-pool-workers** | 0.16.20 | 0.18.0 | auth-api, competition-api | Bundles wrangler 4.107.0 + miniflare 4.20260701.0 (keeps them aligned). 0.17.0: `introspectWorkflow(...).get()` now returns a promise (breaking, but we don't use Workflows — grepped `introspectWorkflow`, no hits); CommonJS `require("./x.wasm?module")` fix. 0.18.0: declarative Durable Object `exports` support. Peer dep vitest ^4.1.0 (we're on 4.1.9). |
| **better-auth** | 1.6.22 | 1.6.23 | frontend, auth-api | Feature/bugfix release: Yandex OAuth provider added; drizzle-adapter D1/postgres-js affected-row counting fix; Stripe org-subscription actions target the correct org; CLI Drizzle schema default-value escaping fix. No security fixes, no breaking API changes. |
| **@better-auth/api-key** | 1.6.22 | 1.6.23 | auth-api | Aligned with better-auth 1.6.23. |
| **@cloudflare/workers-types** | 4.20260628.1 | 4.20260702.1 | root, frontend, auth-api, competition-api, airscore-api | Weekly type definition update (stays within `^4`; the new 5.x major is intentionally deferred — see below). |
| **tailwindcss** | 4.3.1 | 4.3.2 | frontend | Patch release. |
| **@tailwindcss/vite** | 4.3.2 | 4.3.2 | frontend | Aligned with tailwindcss 4.3.2. |
| **three** | 0.185.0 | 0.185.1 | frontend | Patch release. |
| **concurrently** | 9.2.1 | 9.2.3 | root | Patch bump within `^9` (major 10.x still deferred — ESM-only, drops `--name-separator`). |

### Code Changes Required

None. All upgrades are drop-in replacements with no API changes affecting our usage. The two flagged breaking changes (wrangler dropping `--experimental-vm-modules`, vitest-pool-workers' `introspectWorkflow().get()` becoming async) were both verified as unused in this repo via grep before upgrading.

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| @cloudflare/workers-types | 4.20260702.1 | 5.20260705.1 | **New major (5.x) this cycle.** Stay within `^4` per convention. Evaluate in a focused PR — Cloudflare's date-versioned major bumps usually track a compatibility-date/runtime-surface change. |
| zod | 3.25.76 | 4.4.3 | Major version. Still blocked by `@hono/zod-validator` (honojs/middleware#1148). |
| @hono/zod-validator | 0.7.6 | 0.8.0 | 0.8.0 requires zod 4. Stay on 0.7.6 until zod 4 migration. |
| vite | 7.3.6 | 8.1.3 | Major version. `@cloudflare/vitest-pool-workers` still has known issues with Vite 8. |
| @vitejs/plugin-react | 5.1.4 | 6.0.3 | Major version. Defer to a focused PR (pairs with the Vite 8 evaluation). |
| kysely | 0.28.17 | 0.29.3 | Pre-1.0 minor bump (equivalent to major). Defer to a focused PR. |
| jsdom | 25.0.1 | 29.1.1 | Major version jump. Defer to a focused PR. |
| katex | 0.16.47 | 0.17.0 | Major version. Stay within `^0.16.x` semver range. |
| concurrently | 9.2.3 | 10.0.3 | Major version. ESM-only, drops `--name-separator`. Low priority — defer. |
| @types/node | 25.9.4 | 26.1.0 | Major version jump. Stay on 25.x for now. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, pinned. |

### Verification

- `bun run typecheck:all` — all 5 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api). (The former `mcp-api` worker has been removed from the repo; `typecheck:all` no longer includes it.)
- `bun run test:all` — 501 root/engine tests + 56 auth-api (6 todo) + 288 competition-api all pass. Competition-api reports "6 errors" (unhandled rejections from the deliberate `controller.error()` in the `decompressed_too_large` igc-validation test); verified pre-existing by re-running the suite on the pre-upgrade lockfile (identical 288 passed / 6 errors / exit 0). Overall exit 0.
- `bun run test:e2e` — 6/6 chromium specs pass. Under full parallel load `comp-creation` flaked once with a "New Competition" button click timeout, then passed cleanly on an isolated retry (3.1s) — the same pre-existing remote-environment timing flake documented in every prior entry, not a dependency regression.
- `bun audit` — 0 vulnerabilities.

### Lessons / Notes for Future Sessions

- **`mcp-api` worker is gone.** The repo now has only three workers (`airscore-api`, `auth-api`, `competition-api`); `typecheck:all` / `test:all` cover 5 workspaces, not 6. Older log entries reference `mcp-api` and the `@modelcontextprotocol/sdk` / `agents` deps — those are stale. The `qs`, `fast-uri`, and `ip-address` overrides were originally added for `@modelcontextprotocol/sdk`; with mcp-api removed they may now be **droppable**, but `bun audit` is clean and removing overrides risks re-surfacing a transitive vuln, so they were left in place this cycle. A future focused cleanup could verify whether any dep still pulls those packages and drop the dead overrides.
- **Pre-installed Playwright browsers can be stale relative to the project's Playwright version.** This cycle the environment shipped chromium/headless-shell **rev 1194**, but `@playwright/test` 1.61.1 pins **rev 1228** — every e2e test failed at browser launch (`Executable doesn't exist at …chromium_headless_shell-1228…`). Fix: `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 bunx playwright install chromium chromium-headless-shell` (the download succeeded this time; the CDN is not always reachable, per earlier lessons). This is **not** caused by the dependency bumps (we didn't touch Playwright) — it's an environment provisioning mismatch. Check `ls /opt/pw-browsers/` against the rev Playwright wants if e2e fails at launch.
- **`@cloudflare/vitest-pool-workers` 0.18.0 bundles wrangler 4.107.0.** Continue upgrading these two together — 0.18.0 is the aligned partner for wrangler 4.107.0.
- **`@cloudflare/workers-types` shipped a 5.x major** (5.20260705.1). First major bump of this package in a while. Deferred — needs a focused look at whether the type surface diverges from our compatibility date.
- **wrangler 4.107.0 still only requires Node ≥22.0.0.** CI's `setup-node@v4` with `node-version: 22` (in both `deploy.yml` and `branch-deploy.yml`) remains sufficient — no CI version bump needed this cycle.
- **`esbuild`, `qs`, `ws`, `hono`, `fast-uri`, `ip-address` overrides remain in place.** hono is already at latest (4.12.27). `bun audit` is clean; keep the overrides load-bearing until upstreams ship patched versions natively (and until the mcp-api-removal cleanup above confirms the MCP-SDK-related ones are truly unused).

## 2026-06-28

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| hono | MODERATE | [GHSA-hvrm-45r6-mjfj](https://github.com/advisories/GHSA-hvrm-45r6-mjfj) | JSX context isolation: during SSR, `useContext()`/`useRequestContext()` stored context process-wide instead of per-request, leaking data across concurrent requests after an `await`. Fixed in 4.12.27. Not exploitable here (no JSX SSR), defense-in-depth. |
| hono | MODERATE | [GHSA-w62v-xxxg-mg59](https://github.com/advisories/GHSA-w62v-xxxg-mg59) | XSS via JSX escaping bypass: `cx()` in `hono/css` marked composed class names as already-escaped without actually escaping input, allowing untrusted class names to inject markup during SSR. Fixed in 4.12.27. Not exploitable here (no JSX SSR). |
| hono | MODERATE | [GHSA-xgm2-5f3f-mvvc](https://github.com/advisories/GHSA-xgm2-5f3f-mvvc) | AWS Lambda API Gateway v1 / VPC Lattice adapter de-duplicated repeated header values by substring instead of exact match, potentially compromising IP-based security logic. Fixed in 4.12.27. Not exploitable here (Cloudflare Workers, not AWS Lambda). |
| better-auth | MODERATE | (v1.6.21–1.6.22) | Rate limiting now executes before plugin request handlers. Admin permission changes/bans take immediate effect with session cookie caching. OAuth proxy rejects profile callbacks with mismatched state. PayPal sign-in validates user info against verified ID token subject. SIWE sign-in rejects emails already associated with other accounts. 2FA verification locks out after 5 incorrect TOTP/backup codes. SAML single logout rejects non-http(s) URL schemes. SAML SSO rejects responses with mismatched audience/recipient/destination. SSO provider deletion removes linked accounts. Fixed `X-Forwarded-For` spoofing in multi-hop proxies (api-key package). Unproven credentials revoked during magic link/email OTP sign-in. Server-side OAuth requests refuse redirect responses. |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **wrangler** | 4.103.0 | 4.105.0 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | 4.104.0: `getEnv()` for test harness, ARM64 container fix. 4.105.0: Google Artifact Registry support, D1 migration SQL escaping fix for special characters. workerd bumped to 1.20260625.1. No breaking changes. |
| **hono** | 4.12.26 | 4.12.27 | frontend, auth-api, competition-api, mcp-api (+ root override) | Security: 3 fixes (JSX context isolation, cx() XSS, Lambda header dedup). See above. No breaking changes. |
| **better-auth** | 1.6.20 | 1.6.22 | frontend, auth-api | Security-heavy release: rate limiting ordering, admin ban enforcement, OAuth state validation, 2FA lockout, SAML hardening, credential revocation on magic link sign-in, OAuth redirect blocking. Bug fixes: ZodError with Zod v4 resolved, Google hosted-domain validation, Kysely adapter `update` returns `null` when no row matches. No breaking changes. |
| **@better-auth/api-key** | 1.6.20 | 1.6.22 | auth-api | Aligned with better-auth 1.6.22. Fixed `X-Forwarded-For` spoofing in multi-hop proxies. |
| **vite** | 7.3.5 | 7.3.6 | frontend | Now allows esbuild 0.28 as a dependency (was excluded). No other changes. |
| **@cloudflare/vitest-pool-workers** | 0.16.18 | 0.16.20 | auth-api, competition-api, mcp-api | 0.16.19: wrangler 4.104.0 alignment. 0.16.20: wrangler 4.105.0 alignment, new `evictDurableObject`/`evictAllDurableObjects` test helpers. |
| **@cloudflare/workers-types** | 4.20260621.1 | 4.20260628.1 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | Weekly type definition update. |
| **@playwright/test** | 1.61.0 | 1.61.1 | root | Bug fixes: custom matchers no longer override built-in defaults, Node 22.15 ESM loader regression fixed, pnpm workspace symlink resolution fixed. |

### Code Changes Required

None. All upgrades are drop-in replacements with no API changes affecting our usage.

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| agents | 0.13.3 | 0.17.1 | 0.14.x+ requires zod ^4.0.0 as a peer dependency. Blocked by our zod 3 usage. |
| zod | 3.25.76 | 4.4.3 | Major version. Still blocked by `@hono/zod-validator` (honojs/middleware#1148). |
| vite | 7.3.6 | 8.1.0 | Major version. `@cloudflare/vitest-pool-workers` still has known issues with Vite 8. |
| @hono/zod-validator | 0.7.6 | 0.8.0 | 0.8.0 requires zod 4. Stay on 0.7.6 until zod 4 migration. |
| kysely | 0.28.17 | 0.29.2 | Pre-1.0 minor bump (equivalent to major). Defer to a focused PR. |
| jsdom | 25.0.1 | 29.1.1 | Major version jump. Defer to a focused PR. |
| katex | 0.16.47 | 0.17.0 | Major version. Stay within ^0.16.x semver range. |
| concurrently | 9.2.3 | 10.0.3 | Major version. ESM-only, drops `--name-separator`. Low priority — defer. |
| @modelcontextprotocol/sdk | 1.29.0 (resolved via ^1.12.1) | 2.0.0-alpha | Alpha release. Wait for stable. |
| @types/node | 25.9.4 | 26.0.1 | Major version jump. Stay on 25.x for now. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, pinned. |

### Verification

- `bun run typecheck:all` — all 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api).
- `bun run test:all` — 444 root/engine tests + 56 auth-api + 260 competition-api + 21 mcp-api all pass.
- `bun run test:e2e` — 5/6 chromium specs pass. 1 flaky failure in comp-creation (pre-existing timeout issue in remote execution environment, not related to dependency changes).
- `bun audit` — 0 vulnerabilities.

### Lessons / Notes for Future Sessions

- **Vite 7.3.6 now allows esbuild 0.28.** The `esbuild` override is still load-bearing since without it, bun could resolve vite's esbuild dep to 0.27.x (which has the security advisories). But the override is now within the official vite peer range, not forced.
- **`agents` 0.17.1 is now available** but still requires zod 4. The zod 4 migration remains the single blocker for `agents`, `@hono/zod-validator`, and several other upgrades.
- **`@cloudflare/vitest-pool-workers` 0.16.20 bundles wrangler 4.105.0.** Continue keeping these aligned — upgrade together.
- **`qs` override remains load-bearing.** `@modelcontextprotocol/sdk` still hasn't shipped a patched `qs` version.
- **`ws` override remains load-bearing.** Transitive consumers still haven't shipped with ws >= 8.21.0 natively.
- **`esbuild` override remains load-bearing.** Even though vite 7.3.6 accepts `^0.28.0`, bun could still resolve to 0.27.x without the override. Keep until vite drops 0.27.x support entirely.
- **better-auth 1.6.22 is a significant security release.** Hardens rate limiting, 2FA, SAML, OAuth state validation, and credential handling. No breaking API changes.
- **Playwright headless shell download can fail** in this remote execution environment due to network issues. The main chromium browser downloads fine but the headless shell (needed for `headless: true`) may require manual curl fallback.

## 2026-06-21

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| ws (transitive via wrangler) | HIGH | [GHSA-96hv-2xvq-fx4p](https://github.com/advisories/GHSA-96hv-2xvq-fx4p) | Remote memory-exhaustion DoS in ws >= 8.0.0 < 8.21.0. Fixed by bumping wrangler to 4.103.0 (bundles ws 8.21.0) and updating ws override to ^8.21.0. |
| mapbox-gl | MODERATE | (v3.25.0) | Object prototype pollution from untrusted styles or tiles. Fixed by upgrading to 3.25.0. |
| better-auth | MODERATE | (v1.6.19) | Race conditions allowing duplicate account deletions, token replays, and password resets to bypass rate limits. Fixed by upgrading to 1.6.20. |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **wrangler** | 4.100.0 | 4.103.0 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | Security: ws dep bumped fixing HIGH DoS advisory. New: `--autoconfig` replaces `--experimental-autoconfig`, `Uint8Array` step output fix for local Workflows, source-map crash fix. Removed: `unstable_getWorkerNameFromProject` (moved to `@cloudflare/workers-utils`), experimental autoconfig exports (moved to `@cloudflare/autoconfig`). No impact on our usage. |
| **mapbox-gl** | 3.24.1 | 3.25.0 | root, frontend | **Breaking ESM change:** default export replaced with named exports. Updated `import mapboxgl from` → `import * as mapboxgl from` and moved `mapboxgl.accessToken` to `Map` constructor `accessToken` option. Security: prototype pollution fix. New: `setLanguage`/`getLanguage`/`setWorldview`/`getWorldview`, layer-level `minzoom`/`maxzoom`/`filter` methods. Performance: symbol rendering, protobuf decoding, lazy model loading. |
| **better-auth** | 1.6.18 | 1.6.20 | frontend, auth-api | Security (1.6.19): race condition patches. New: device-code pre-binding, experimental `oauthPopup` plugin. Fixes (1.6.20): account-linking log routing, `APIError` TypeScript inference, refresh cookie `Max-Age` cap. |
| **@better-auth/api-key** | 1.6.18 | 1.6.20 | auth-api | Aligned with better-auth 1.6.20. |
| **hono** | 4.12.25 | 4.12.26 | frontend, auth-api, competition-api, mcp-api (+ root override) | Maintenance: Lambda-edge Content-Length fix, OIDC trusted publishing on npm, build script refactoring. No security fixes. |
| **@cloudflare/vitest-pool-workers** | 0.16.15 | 0.16.18 | auth-api, competition-api, mcp-api | Dependency bump (wrangler 4.103.0, miniflare 4.20260617.1). 0.16.17 bumps undici to 7.28.0 and esbuild to 0.28.1. |
| **vitest** | 4.1.8 | 4.1.9 | frontend, auth-api, competition-api, mcp-api | Stability patch: fixes `importOriginal` with optimizer/query imports, browser mode orchestrator readiness race, `vi.mock()` hoisting issues, worker crash hangs. |
| **@cloudflare/workers-types** | 4.20260613.1 | 4.20260621.1 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | Weekly type definition update. |
| **@playwright/test** | 1.60.0 | 1.61.0 | root | New: virtual WebAuthn authenticator, `page.localStorage`/`page.sessionStorage` APIs, `expect.soft.poll()`, Ubuntu 26.04 support. Browser updates: Chromium 149, Firefox 151, WebKit 26.5. |
| **@types/node** | 25.9.3 | 25.9.4 | root | Type definition update. |
| **ws** (override) | ^8.20.1 | ^8.21.0 | root override | Forced via `overrides` to clear HIGH DoS advisory (GHSA-96hv-2xvq-fx4p). |
| **concurrently** | 9.2.1 | 9.2.3 | root (via lockfile) | Resolved to 9.2.3 within existing ^9.2.1 range. |

### Code Changes Required

- **mapbox-provider.ts**: Changed `import mapboxgl from 'mapbox-gl'` to `import * as mapboxgl from 'mapbox-gl'` (ESM named exports in 3.25.0). Moved `mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN` to `accessToken` option in `new mapboxgl.Map()` constructor (static `accessToken` property removed).
- **threebox-plugin.d.ts**: Changed `import type mapboxgl from 'mapbox-gl'` to `import type * as mapboxgl from 'mapbox-gl'` (type import alignment).

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| agents | 0.13.3 | 0.16.2 | 0.14.x+ requires zod ^4.0.0 as a peer dependency. Blocked by our zod 3 usage. |
| zod | 3.25.76 | 4.4.3 | Major version. Still blocked by `@hono/zod-validator` (honojs/middleware#1148). |
| vite | 7.3.5 | 8.0.16 | Major version. `@cloudflare/vitest-pool-workers` still has known issues with Vite 8. |
| @hono/zod-validator | 0.7.6 | 0.8.0 | 0.8.0 requires zod 4. Stay on 0.7.6 until zod 4 migration. |
| kysely | 0.28.17 | 0.29.2 | Pre-1.0 minor bump (equivalent to major). Defer to a focused PR. |
| jsdom | 25.0.1 | 29.1.1 | Major version jump. Defer to a focused PR. |
| katex | 0.16.47 | 0.17.0 | Major version. Stay within ^0.16.x semver range. |
| concurrently | 9.2.3 | 10.0.3 | Major version. ESM-only, drops `--name-separator`. Low priority — defer. |
| @modelcontextprotocol/sdk | 1.29.0 (resolved via ^1.12.1) | 2.0.0-alpha | Alpha release. Wait for stable. |
| @types/node | 25.9.4 | 26.0.0 | Major version jump. Stay on 25.x for now. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, pinned. |

### Verification

- `bun run typecheck:all` — all 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api).
- `bun run test:all` — 419 root/engine tests + 56 auth-api + 258 competition-api + 21 mcp-api all pass.
- `bun run test:e2e` — 6/6 chromium specs pass.
- `bun audit` — 0 vulnerabilities.

### Lessons / Notes for Future Sessions

- **mapbox-gl 3.25.0 drops the default ESM export.** All `import mapboxgl from 'mapbox-gl'` must become `import * as mapboxgl from 'mapbox-gl'`, and the static `mapboxgl.accessToken` setter is replaced by the `accessToken` option in the `Map` constructor. Named imports (`import { Map } from 'mapbox-gl'`) now work directly. The `map-annotations.ts` file already used named imports and needed no changes.
- **ws override bumped to ^8.21.0.** The previous ^8.20.1 override was insufficient — wrangler 4.102.0 surfaced GHSA-96hv-2xvq-fx4p (HIGH DoS). Keep the override until all transitive consumers (jsdom, vitest-pool-workers, wrangler) ship with ws >= 8.21.0 natively.
- **`qs` override remains load-bearing.** `@modelcontextprotocol/sdk` still hasn't shipped a patched `qs` version.
- **`esbuild` override remains load-bearing.** Vite 7.x still declares `esbuild: "^0.27.0 || ^0.28.0"` in its peer deps. Keep the ^0.28.1 override until vite ships with esbuild >= 0.28.1 natively.
- **`@cloudflare/vitest-pool-workers` 0.16.18 bundles wrangler 4.103.0.** Continue keeping these aligned — upgrade together.
- **`agents` 0.16.2 is now available** but still requires zod 4. The zod 4 migration remains the single blocker for `agents`, `@hono/zod-validator`, and several other upgrades.
- **`@types/node` 26.0.0 is now available** as a major version. Staying on 25.x for safety — evaluate in a focused PR if Node 26 types diverge significantly from our runtime.

## 2026-06-14

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| esbuild | HIGH | [GHSA-gv7w-rqvm-qjhr](https://github.com/advisories/GHSA-gv7w-rqvm-qjhr) | Missing binary integrity verification in Deno module enables RCE via `NPM_CONFIG_REGISTRY` redirection. Fixed by overriding to ^0.28.1. Deno-specific — not exploitable in our Node/Bun environment, but patched for hygiene. |
| esbuild | LOW | [GHSA-g7r4-m6w7-qqqr](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr) | Arbitrary file read via dev server on Windows. Fixed by overriding to ^0.28.1. Windows-only — not exploitable in our environment. |
| hono | MODERATE | (v4.12.25) | CORS wildcard origin reflected request Origin while sending credentials. Body-limit bypass on AWS Lambda via understated Content-Length. Path traversal on Windows via encoded backslash in serveStatic. |
| better-auth | MODERATE | (v1.6.16–1.6.18) | SIWE verification fix, PayPal/Google ID token validation, admin permission enforcement, MCP bearer token expiry hardening, multi-session endpoint hardening, OIDC logout CSRF fix, race conditions on magic links/OTP/device codes via new atomic operations, JWKS cache memory leak fix. |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **wrangler** | 4.98.0 | 4.100.0 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | New: `createTestHarness()` API, `--version-tag` for deploys, local R2 public-bucket URL access, experimental TS config. Fix: memory leak in long-running headless `wrangler dev`. No breaking changes. |
| **hono** | 4.12.23 | 4.12.25 | frontend, auth-api, competition-api, mcp-api (+ root override) | Security: CORS credential leak, body-limit bypass, Windows path traversal. No breaking changes. |
| **better-auth** | 1.6.14 | 1.6.18 | frontend, auth-api | Security-critical: auth hardening across SIWE, OAuth, MCP tokens, multi-session, OIDC logout, and concurrent-request race conditions. JWKS cache memory leak fix. No breaking changes. |
| **@better-auth/api-key** | 1.6.14 | 1.6.18 | auth-api | Aligned with better-auth 1.6.18. |
| **@cloudflare/vitest-pool-workers** | 0.16.13 | 0.16.15 | auth-api, competition-api, mcp-api | Dependency bump (wrangler 4.100.0, miniflare alignment). |
| **@cloudflare/workers-types** | 4.20260607.1 | 4.20260613.1 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | Weekly type definition update. |
| **tailwindcss** | 4.3.0 | 4.3.1 | frontend | Bug fixes: Node 26+ deprecation warnings, `@apply` with CSS mixins, `not-*` for container queries, watch-mode recovery. |
| **@tailwindcss/vite** | 4.3.0 | 4.3.1 | frontend | Aligned with tailwindcss 4.3.1. |
| **mapbox-gl** | 3.24.0 | 3.24.1 | root, frontend | Fix: rendering bug with custom layers + data-driven `line-emissive-strength`. |
| **@types/node** | 25.9.2 | 25.9.3 | root | Type definition update. |
| **esbuild** (override) | 0.27.3 (transitive) | ^0.28.1 | root override | Forced via `overrides` to clear HIGH + LOW advisories on transitive deps of vite, wrangler, vitest-pool-workers. |

### Code Changes Required

None. All upgrades are drop-in replacements with no API changes affecting our usage.

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| agents | 0.13.3 | 0.16.0 | 0.14.x+ requires zod ^4.0.0 as a peer dependency. Blocked by our zod 3 usage. |
| zod | 3.25.76 | 4.4.3 | Major version. Still blocked by `@hono/zod-validator` (honojs/middleware#1148). |
| vite | 7.3.5 | 8.0.16 | Major version. `@cloudflare/vitest-pool-workers` still has known issues with Vite 8. |
| @hono/zod-validator | 0.7.6 | 0.8.0 | 0.8.0 requires zod 4. Stay on 0.7.6 until zod 4 migration. |
| kysely | 0.28.17 | 0.29.2 | Pre-1.0 minor bump (equivalent to major). Defer to a focused PR. |
| jsdom | 25.0.1 | 29.1.1 | Major version jump. Defer to a focused PR. |
| katex | 0.16.47 | 0.17.0 | Major version. Stay within ^0.16.x semver range. |
| concurrently | 9.2.1 | 10.0.3 | Major version. ESM-only, drops `--name-separator`. Low priority — defer. |
| @modelcontextprotocol/sdk | 1.29.0 (resolved via ^1.12.1) | 2.0.0-alpha | Alpha release. Wait for stable. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, pinned. |

### Verification

- `bun run typecheck:all` — all 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api).
- `bun run test:all` — 412 root/engine tests + 56 auth-api + 258 competition-api + 21 mcp-api all pass.
- `bun run test:e2e` — 5/6 chromium specs pass. 1 flaky failure in "upload XCTSK file and switch to the Tasks tab" (pre-existing timeout issue in remote execution environment, not related to dependency changes).
- `bun audit` — 0 vulnerabilities.

### Lessons / Notes for Future Sessions

- **`agents` 0.16.0 is now available** but still requires zod 4. The zod 4 migration remains the single blocker for both `agents` and `@hono/zod-validator` upgrades.
- **`esbuild` override is now load-bearing.** The esbuild override to ^0.28.1 clears two advisories on transitive deps. Vite 7.x declares `esbuild: "^0.27.0 || ^0.28.0"` in its peer deps, so ^0.28.1 is within range. Wrangler bundles its own esbuild internally, so the override only affects the vite/vitest resolution path. Keep the override until vite/wrangler ship with esbuild >=0.28.1 natively.
- **`better-auth` 1.6.18 introduces atomic operations** (`reserveVerificationValue`, `incrementOne`) to prevent concurrent-request race conditions. This is a significant security improvement for magic link, OTP, and device code flows. No API changes for our usage.
- **`qs` and `ws` overrides remain load-bearing.** Neither `@modelcontextprotocol/sdk` nor the transitive consumers of `ws` have shipped patched versions. Keep overrides until upstream catches up.
- **`@cloudflare/vitest-pool-workers` 0.16.15 bundles wrangler 4.100.0.** Continue keeping these aligned — upgrade together.

## 2026-06-07

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| better-auth | MODERATE | (v1.6.14) | OAuth redirect URI validation hardened — rejects dangerous URL schemes and fragments per RFC 6749. Cookie preference fix: `__Secure-` cookie is now preferred when both secure and non-secure cookies are present, preventing potential session confusion. |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **wrangler** | 4.95.0 | 4.98.0 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | New: `web_search`→`websearch` bindings, `migrations_pattern` field for D1, generic `[path]` positional arg for deploy/upload. Fixes: source map upload, `.env` line breaks, D1 logger level. No breaking changes affecting our usage. |
| **better-auth** | 1.6.13 | 1.6.14 | frontend, auth-api | Security: OAuth redirect URI validation, cookie preference fix. Bug fixes: invitation flow for emailed org invitations, nullable fields accept explicit `null`. |
| **@better-auth/api-key** | 1.6.13 | 1.6.14 | auth-api | Aligned with better-auth 1.6.14. |
| **vite** | 7.3.3 | 7.3.5 | frontend | Patch release. |
| **vitest** | 4.1.7 | 4.1.8 | frontend, auth-api, competition-api, mcp-api | Patch release. Bug fixes. |
| **@cloudflare/vitest-pool-workers** | 0.16.10 | 0.16.13 | auth-api, competition-api, mcp-api | Dependency bump (wrangler 4.98.0, miniflare 4.20260603.0). |
| **@cloudflare/workers-types** | 4.20260531.1 | 4.20260607.1 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | Weekly type definition update. |
| **@types/node** | 25.9.1 | 25.9.2 | root | Type definition update. |

### Code Changes Required

None. All upgrades are drop-in replacements with no API changes affecting our usage.

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| agents | 0.13.3 | 0.14.5 | 0.14.x requires zod ^4.0.0 as a peer dependency. Blocked by our zod 3 usage. |
| zod | 3.25.76 | 4.4.3 | Major version. Still blocked by `@hono/zod-validator` (honojs/middleware#1148). |
| vite | 7.3.5 | 8.0.16 | Major version. `@cloudflare/vitest-pool-workers` still has known issues with Vite 8. |
| @hono/zod-validator | 0.7.6 | 0.8.0 | 0.8.0 requires zod 4. Stay on 0.7.6 until zod 4 migration. |
| kysely | 0.28.17 | 0.29.2 | Unblocked by better-auth, but pre-1.0 minor bump (equivalent to major). Defer to a focused PR. |
| jsdom | 25.0.1 | 29.1.1 | Major version jump. Defer to a focused PR. |
| katex | 0.16.47 | 0.17.0 | Major version. Stay within ^0.16.x semver range. |
| concurrently | 9.2.1 | 10.0.3 | Major version. ESM-only, drops `--name-separator`. Low priority — defer. |
| @modelcontextprotocol/sdk | 1.29.0 (resolved via ^1.12.1) | 2.0.0-alpha | Alpha release. Wait for stable. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, pinned. |

### Verification

- `bun run typecheck:all` — all 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api).
- `bun run test:all` — 412 root/engine tests + 52 auth-api + 251 competition-api + 21 mcp-api all pass.
- `bun run test:e2e` — 5/6 chromium specs pass. 1 flaky failure in "delete an uploaded task" (pre-existing timing issue in remote execution environment, not related to dependency changes).
- `bun audit` — 0 vulnerabilities.

### Lessons / Notes for Future Sessions

- **`agents` 0.14.x now requires zod 4.** The `createMcpHandler` API is unchanged, but the zod peer dep makes the upgrade impossible until the zod 4 migration. This creates a new coupling: the zod 4 migration now unblocks both `@hono/zod-validator` 0.8 AND `agents` 0.14.x.
- **`@cloudflare/vitest-pool-workers` 0.16.13 bundles wrangler 4.98.0.** Continue keeping these aligned — upgrade together.
- **`qs` and `ws` overrides remain load-bearing.** Neither `@modelcontextprotocol/sdk` nor the transitive consumers of `ws` have shipped patched versions. Keep overrides until upstream catches up.
- **Wrangler 4.98.0 renames `web_search` binding to `websearch`.** We don't use this binding, so no impact. Note for future: if adopting Cloudflare's managed web search for agents, use `websearch` (not `web_search`).
- **E2e tests still require `.dev.vars`** with `BETTER_AUTH_URL=http://localhost:3000`. Without it, `isLocalDev()` returns false and the dev-login endpoint returns 404. CI creates this file in the workflow.

## 2026-05-31

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| better-auth | HIGH | (v1.6.12) | Fixed high-severity XML injection vulnerability in SAML assertions via samlify library update. Fixed 2FA session cookie leak allowing `session_token` and `session_data` capture when caching was enabled. |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **better-auth** | 1.6.11 | 1.6.13 | frontend, auth-api | Security: SAML XML injection fix, 2FA session cookie leak fix. Bug fixes: field index ordering in migrations, cookie refresh header forwarding, URL-encoding of callback URLs in verification links, OAuth state validation error forwarding, organization invitation routing fix, cascade deletes wrapped in transactions. |
| **@better-auth/api-key** | 1.6.11 | 1.6.13 | auth-api | Aligned with better-auth 1.6.13. |
| **hono** (override + workspaces) | 4.12.22 | 4.12.23 | root override, frontend, auth-api, competition-api, mcp-api | Bug fixes: serve-static normalizes all backslashes (not just the first), IP address utility no longer compresses single 0 group to `::`. New: `Context` class publicly exported, `contentTypeFilter` option for compress middleware. No breaking changes. |
| **wrangler** | 4.94.0 | 4.95.0 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | New: AI coding agent telemetry, `--x-deploy-helpers` flag. Fixes: always-remote bindings validation rejects `remote: false` on remote-only types, `--compatibility-flags` preservation during deploy config flow, Cloudflare Access detection for remote bindings. Workerd updated to 1.20260526.1. No breaking changes. |
| **agents** | 0.13.2 | 0.13.3 | mcp-api | Session auto-compaction enhancements, chat recovery for pre-stream interruptions, workflow instance ID validation, stream error handling, sub-agent identity scoping, facet startup deadlock fix. No breaking changes. Pinned exact (pre-1.0). |
| **@cloudflare/vitest-pool-workers** | 0.16.9 | 0.16.10 | auth-api, competition-api, mcp-api | Dependency bump only (wrangler 4.95.0, miniflare 4.20260526.0). |
| **@cloudflare/workers-types** | 4.20260524.1 | 4.20260531.1 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | Weekly type definition update. |

### Code Changes Required

None. All upgrades are drop-in replacements with no API changes affecting our usage.

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| zod | 3.25.76 | 4.4.3 | Major version. Still blocked by `@hono/zod-validator` (honojs/middleware#1148). |
| vite | 7.3.3 | 8.0.14 | Major version. `@cloudflare/vitest-pool-workers` still has known issues with Vite 8. |
| @hono/zod-validator | 0.7.6 | 0.8.0 | 0.8.0 requires zod 4. Stay on 0.7.6 until zod 4 migration. |
| kysely | 0.28.17 | 0.29.2 | Now unblocked — `better-auth@1.6.13` accepts `^0.28.17 \|\| ^0.29.0`. Defer to a focused PR since 0.29.x is a minor bump of a pre-1.0 package (equivalent to major). |
| jsdom | 25.0.1 | 29.1.1 | Major version jump. Defer to a focused PR. |
| katex | 0.16.47 | 0.17.0 | Major version. Stay within ^0.16.x semver range. |
| concurrently | 9.2.1 | 10.0.0 | Major version. ESM-only, drops `--name-separator`, requires Node 22 (already met). Low risk but low reward — defer. |
| @modelcontextprotocol/sdk | 1.29.0 (resolved via ^1.12.1) | 2.0.0-alpha | Alpha release. Wait for stable. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, pinned. |

### Verification

- `bun run typecheck:all` — all 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api).
- `bun run test:all` — 412 root/engine tests + 52 auth-api + 251 competition-api + 21 mcp-api all pass.
- `bun run test:e2e` — 5/6 chromium specs pass. 1 flaky failure that rotates between comp-creation and user-files-upload specs across runs (pre-existing timing issue in remote execution environment, not related to dependency changes).
- `bun audit` — 0 vulnerabilities.

### Lessons / Notes for Future Sessions

- **Kysely 0.29.x is now unblocked.** `better-auth@1.6.13` declares `"kysely": "^0.28.17 || ^0.29.0"`, removing the previous blocker. `kysely-d1@0.4.0` has `peerDependencies: { kysely: "*" }` so it's also compatible. A focused PR can now upgrade to 0.29.2 — key additions include table narrowing helpers (`$pickTables`/`$omitTables`), `ReadonlyKysely` type, query cancellation via `AbortSignal`, and `SafeNullComparisonPlugin`. Min TypeScript bumped to 5.4 (we're on 6.0.3).
- **E2e tests are flaky in this remote execution environment.** The comp-creation and user-files-upload tests have intermittent timing failures that rotate between runs. All 6 pass in CI (which has dedicated resources). When running locally in constrained environments, expect 5/6 as the baseline.
- **`concurrently` 10.0.0 is available** but is ESM-only and drops the `killOthers` API option (replaced with `killOthersOn`). The CLI flag `--kill-others-on-fail` we use in `package.json` scripts should still work but hasn't been verified. Low priority — defer unless there's a reason to upgrade.
- **`qs` and `ws` overrides remain load-bearing.** Neither `@modelcontextprotocol/sdk` nor the transitive consumers of `ws` have shipped patched versions. Keep overrides until upstream catches up.
- **`katex` 0.17.0 is a major version** — new in this cycle. Review changelog before upgrading; the ^0.16.x range deliberately excludes it.

## 2026-05-24

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| hono | MODERATE | [GHSA-2gcr-mfcq-wcc3](https://github.com/advisories/GHSA-2gcr-mfcq-wcc3) | `app.mount()` prefix stripping: undecoded paths caused incorrect prefix removal for percent-encoded characters, giving sub-applications wrong routing paths. Fixed in 4.12.21. |
| hono | MODERATE | [GHSA-xrhx-7g5j-rcj5](https://github.com/advisories/GHSA-xrhx-7g5j-rcj5) | IP restriction IPv6 bypass: non-canonical IPv6 formats bypassed deny rules via string comparison in `hono/ip-restriction`. Fixed in 4.12.21. |
| hono | MODERATE | [GHSA-3hrh-pfw6-9m5x](https://github.com/advisories/GHSA-3hrh-pfw6-9m5x) | Cookie header injection: missing validation on `sameSite` and `priority` parameters allowed injecting extra Set-Cookie attributes. Fixed in 4.12.21. |
| hono | MODERATE | [GHSA-f577-qrjj-4474](https://github.com/advisories/GHSA-f577-qrjj-4474) | JWT scheme validation bypass: Authorization header accepted any two-part scheme, not just Bearer tokens. Fixed in 4.12.21. |
| better-auth | HIGH | (v1.6.11) | Invitation takeover — `requireEmailVerificationOnInvitation` now enabled by default. SSRF via unvalidated OIDC endpoints. Device authorization hijack. Magic link race condition. OAuth signing weakness (`"none"` algorithm removed, plain PKCE disabled). |
| qs (transitive via @modelcontextprotocol/sdk) | MODERATE | [GHSA-q8mj-m7cp-5q26](https://github.com/advisories/GHSA-q8mj-m7cp-5q26) | `qs.stringify` crashes with TypeError on null/undefined entries in comma-format arrays when `encodeValuesOnly` is set. Fixed by overriding to ^6.15.2. |
| ws (transitive via jsdom, vitest-pool-workers, wrangler) | MODERATE | [GHSA-58qx-3vcg-4xpx](https://github.com/advisories/GHSA-58qx-3vcg-4xpx) | Uninitialized memory disclosure in ws >= 8.0.0 < 8.20.1. Fixed by overriding to ^8.20.1. |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **hono** (override + workspaces) | 4.12.18 | 4.12.22 | root override, frontend, auth-api, competition-api, mcp-api | 4 security fixes in 4.12.21 (see above). Bug fixes: cookie handling, route base paths, compress middleware, MIME types. No breaking changes. |
| **better-auth** | 1.6.9 | 1.6.11 | frontend, auth-api | Security-critical: invitation takeover, SSRF, magic link race, OAuth signing fixes. Bug fixes: email casing, duplicate Set-Cookie headers, session cleanup on user deletion. |
| **@better-auth/api-key** | 1.6.9 | 1.6.11 | auth-api | Aligned with better-auth 1.6.11. Rate-limited responses now return 429 instead of 401. |
| **wrangler** | 4.87.0 | 4.94.0 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | TZ=UTC for local dev (4.89.0, aligns with production Workers). Stale refresh token fix (4.92.0). OAuth/auth stability fixes (4.93.1, 4.94.0). D1 SQL export improvements. Auto-cleanup of stale `.wrangler/tmp/` dirs. No breaking changes beyond Node 22 requirement (already met). |
| **agents** | 0.12.3 | 0.13.2 | mcp-api | No breaking changes. New: chat SDK state adapter, managed fiber jobs, experimental Postgres-backed sessions. `createMcpHandler` API unchanged. Pinned exact (pre-1.0). |
| **mapbox-gl** | 3.23.0 | 3.24.0 | root, frontend | Performance: reduced per-frame matrix allocations, parallel shader compilation, faster vector icon loading. Bug fixes: memory leak on map destroy, icon scale-factor double-application, fill-extrusion+terrain rendering. Client-side fontstack compositing now default (3.23.0). No breaking changes. |
| **@cloudflare/vitest-pool-workers** | 0.15.2 / 0.14.9 | 0.16.9 | auth-api, competition-api, mcp-api | Aligned with wrangler 4.94.0 / miniflare 4.20260521.0. Same peer deps (vitest ^4.1.0). |
| **vitest** | 4.1.5 | 4.1.7 | frontend, auth-api, competition-api, mcp-api | Patch release. Bug fixes. |
| **@playwright/test** | 1.59.1 | 1.60.0 | root | Minor release. |
| **katex** | 0.16.45 | 0.16.47 | frontend | Patch release. |
| **@cloudflare/workers-types** | 4.20260509.1 | 4.20260524.1 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | Weekly type definition update. |
| **@types/bun** | 1.3.13 | 1.3.14 | root | Type definition update. |
| **@types/node** | 25.6.2 | 25.9.1 | root | Type definition update. |
| **qs** (override) | (transitive) | ^6.15.2 | root override | Forced via `overrides` to clear MODERATE advisory on transitive dep of `@modelcontextprotocol/sdk`. |
| **ws** (override) | (transitive) | ^8.20.1 | root override | Forced via `overrides` to clear MODERATE advisory on transitive deps of jsdom, vitest-pool-workers, wrangler. |

### Code Changes Required

None. All upgrades are drop-in replacements with no API changes affecting our usage.

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| zod | 3.25.76 | 4.4.3 | Major version. Still blocked by `@hono/zod-validator` (honojs/middleware#1148). |
| vite | 7.3.3 | 8.0.14 | Major version. `@cloudflare/vitest-pool-workers` still has known issues with Vite 8. |
| @hono/zod-validator | 0.7.6 | 0.8.0 | 0.8.0 requires zod 4. Stay on 0.7.6 until zod 4 migration. |
| kysely | 0.28.17 | 0.29.2 | 0.29.x is now stable but `better-auth@1.6.11` depends on `kysely: ^0.28.17` — cannot bump to 0.29.x without breaking better-auth's dependency range. Defer until better-auth updates its kysely dep. |
| jsdom | 25.0.1 | 29.1.1 | Major version jump. Defer to a focused PR. |
| @modelcontextprotocol/sdk | 1.29.0 (resolved via ^1.12.1) | 2.0.0-alpha | Alpha release. Wait for stable. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, pinned. |
| katex | 0.16.47 | 0.17.0 | Major version. Stay within ^0.16.x semver range. |

### Verification

- `bun run typecheck:all` — all 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api).
- `bun run test:all` — 411 root/engine tests + 251 competition-api + 21 mcp-api all pass.
- `bun run test:e2e` — 6 chromium specs pass (comp-creation + 5 user-files-upload tests).
- `bun audit` — 0 vulnerabilities.

### Lessons / Notes for Future Sessions

- **Wrangler 4.89.0 TZ=UTC is beneficial, not risky.** The previous session (2026-05-09) skipped wrangler because 4.89.0 introduced `TZ=UTC` for local dev. In practice this aligns local dev with production Workers behavior. The codebase already uses `Date.UTC()` for date construction and locale-aware formatting for display. No tests or behavior were affected by this change.
- **`@cloudflare/vitest-pool-workers` version is tightly coupled to wrangler.** 0.16.9 bundles `wrangler: 4.94.0` and `miniflare: 4.20260521.0` as direct dependencies. When upgrading wrangler, also upgrade vitest-pool-workers to keep them aligned.
- **Kysely 0.29.x is now stable** (not RC), but `better-auth@1.6.11` still depends on `kysely: ^0.28.17`. Upgrading kysely to 0.29.x would break better-auth's dependency range. Monitor better-auth's next releases for a kysely dep bump.
- **better-auth 1.6.11 changes defaults** that could affect existing deployments: `requireEmailVerificationOnInvitation` now defaults to `true`, plain PKCE disabled by default, `"none"` signing algorithm removed. These don't affect our current usage but should be noted if enabling 2FA or OAuth provider features.
- **`qs` and `ws` are new recurring transitive vuln sources.** `qs` comes through `@modelcontextprotocol/sdk`, `ws` comes through jsdom, vitest-pool-workers, and wrangler. Both will likely need override updates in future sessions until upstream packages ship patched versions.
- **E2e tests require `.dev.vars`** with `BETTER_AUTH_URL=http://localhost:3000` to work locally. CI creates this file in the workflow. Without it, `isLocalDev()` returns false and the dev-login endpoint returns 404.

## 2026-05-09

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| hono | MODERATE | [GHSA-qp7p-654g-cw7p](https://github.com/advisories/GHSA-qp7p-654g-cw7p) | CSS Declaration Injection via Style Object Values in JSX SSR. Fixed in 4.12.18. Not exploitable here (no JSX SSR), defense-in-depth. |
| hono | LOW | [GHSA-hm8q-7f3q-5f36](https://github.com/advisories/GHSA-hm8q-7f3q-5f36) | Improper validation of NumericDate claims (exp, nbf, iat) in JWT verify(). Fixed in 4.12.18. |
| hono | MODERATE | [GHSA-p77w-8qqv-26rm](https://github.com/advisories/GHSA-p77w-8qqv-26rm) | Cache Middleware ignores `Vary: Authorization`/`Vary: Cookie` → cross-user cache leakage. Fixed in 4.12.18. Not exploitable here (we don't use hono cache middleware). |
| hono | MODERATE | [GHSA-9vqf-7f2p-gf9v](https://github.com/advisories/GHSA-9vqf-7f2p-gf9v) | `bodyLimit()` bypass for chunked / unknown-length requests. Fixed in 4.12.16. |
| hono | MODERATE | [GHSA-69xw-7hcm-h432](https://github.com/advisories/GHSA-69xw-7hcm-h432) | hono/jsx unvalidated tag names allow HTML injection. Fixed in 4.12.16. |
| fast-uri (transitive via @modelcontextprotocol/sdk) | HIGH | [GHSA-v39h-62p7-jpjc](https://github.com/advisories/GHSA-v39h-62p7-jpjc) | Host confusion via percent-encoded authority delimiters. Fixed by overriding to ^3.1.2. |
| fast-uri (transitive via @modelcontextprotocol/sdk) | HIGH | [GHSA-q3j6-qgpj-74h6](https://github.com/advisories/GHSA-q3j6-qgpj-74h6) | Path traversal via percent-encoded dot segments. Fixed by overriding to ^3.1.2. |
| ip-address (transitive via @modelcontextprotocol/sdk) | MODERATE | [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g) | XSS in `Address6` HTML-emitting methods. Fixed by overriding to ^10.2.0. Not exploitable here (we don't render `Address6` HTML output). |
| kysely | MODERATE | (0.28.17) | Hardened JSON path `.key(...)` and `.at(...)` against SQL injection / exfiltration. |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **hono** (override + workspaces) | 4.12.15 | 4.12.18 | root override, frontend, auth-api, competition-api, mcp-api | Bundles 5 security fixes (see above). No breaking changes; deps: 0 — drop-in. |
| **fast-uri** (override) | (transitive 3.1.x) | ^3.1.2 | root override | Forced via `overrides` to clear two HIGH advisories on transitive deps of `@modelcontextprotocol/sdk`. |
| **ip-address** (override) | (transitive ≤10.1.0) | ^10.2.0 | root override | Forced via `overrides` to clear MODERATE XSS advisory. |
| **kysely** | 0.28.16 | 0.28.17 | auth-api | Security hardening for JSON path operators. |
| **tailwindcss** | 4.2.4 | 4.3.0 | frontend | New utilities (`@container-size`, `scrollbar-*`, `tab-*`, `zoom-*`), stacked/compound `@variant`, no breaking changes. |
| **@tailwindcss/vite** | 4.2.4 | 4.3.0 | frontend | Aligned with tailwindcss 4.3.0; relative import resolution fixes. |
| **vite** | 7.3.2 | 7.3.3 | frontend | Patch release. |
| **@cloudflare/workers-types** | 4.20260503.1 | 4.20260509.1 | root, frontend, auth-api, competition-api, mcp-api, airscore-api | Weekly type definition update. |
| **@types/node** | 25.6.0 | 25.6.2 | root | Type definition update. |

### Code Changes Required

None. All upgrades are drop-in. Hono surface (`Hono`, validators, `setCookie`/`getCookie`) unchanged. Tailwind 4.3.0 only adds utilities.

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| wrangler | 4.87.0 | 4.90.0 | **Skipped this round.** 4.89.0 changed `wrangler dev` to run with `TZ=UTC` instead of inheriting host TZ — a behavioral change that could surprise local dev sessions and tests that depend on host-local time. No security requirement; revisit deliberately. |
| zod | 3.25.76 | 4.4.3 | Major version. Still blocked by `@hono/zod-validator` (honojs/middleware#1148). |
| vite | 7.3.3 | 8.0.11 | Major version. `@cloudflare/vitest-pool-workers` still has known issues with Vite 8. |
| @hono/zod-validator | 0.7.6 | 0.8.0 | 0.8.0 requires zod 4. Stay on 0.7.6 until zod 4 migration. |
| @cloudflare/vitest-pool-workers | 0.15.2 / 0.14.9 | 0.16.3 | Skipped — needs review of its peer ranges (vitest 4.x compat). Defer to a focused PR. |
| @modelcontextprotocol/sdk | 1.29.0 (resolved via ^1.12.1) | 1.29.0 | Already at latest 1.x. v2.0.0 is alpha. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, pinned. |
| agents | 0.12.3 | 0.12.3 | Already at latest; pinned exact (pre-1.0). |

### Verification

- `bun run typecheck:all` — all 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api).
- `bun run test:all` — 411 root/engine tests + 226 competition-api + 21 mcp-api all pass.
- `bun run test:e2e` — 1 chromium spec passes (full webServer flow exercises wrangler dev + frontend dev).
- `bun audit` — 0 vulnerabilities.

### Lessons / Notes for Future Sessions

- **Transitive vulns in `@modelcontextprotocol/sdk` are recurring.** `fast-uri` and `ip-address` are deep transitives; the upstream MCP SDK doesn't move fast enough to ship patched versions, so plan on adding overrides for any new advisories there until the SDK reaches 2.x or restructures its deps. Document each override with the advisory it resolves so a future cleanup can drop it once the upstream catches up.
- **Hono security cadence is high.** Five Hono advisories landed between 4.12.15 and 4.12.18 in roughly a week. Most are not exploitable in this codebase (no JSX SSR, no cache middleware), but the override should be bumped each cycle anyway since `bun audit` reports against the override range.
- **Wrangler 4.89.0 introduces `TZ=UTC` for local dev.** Worth a deliberate bump in a focused PR that runs the e2e suite *and* spot-checks anything time-sensitive (audit log timestamps, scheduled tasks, expiry checks). Don't roll it in with routine bumps — the lessons from the May Node-22 outage still apply: `wrangler dev` is the silent-failure surface.
- **Use `bun pm view <pkg> dist-tags` to confirm the latest stable** before deciding whether `bun outdated` "Latest" is accurate — it disambiguates `next`/`alpha` channels.
- **Keep override list minimal but loud.** When `bun audit` reports a transitive vuln, prefer override + comment in this log over silent suppression. Future sessions should be able to read this entry and know which overrides are still load-bearing vs. removable.

## 2026-05-03

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| @modelcontextprotocol/sdk | HIGH | CVE-2026-0621 | ReDoS in `UriTemplate.partToRegExp()` — catastrophic backtracking on malicious input causes 100% CPU hang. Fixed in 1.25.2. Upgraded from 1.12.1 to 1.29.0. |
| @modelcontextprotocol/sdk | HIGH | GHSA (data leak) | Single `McpServer` with `StreamableHTTPServerTransport` reused across clients leaks responses between client boundaries. Fixed in 1.25.4. |
| postcss (override) | MODERATE | CVE-2026-41305 | XSS via unescaped `</style>` in CSS stringify. Was on exact fix boundary (^8.5.10), bumped to ^8.5.13 for safety. |
| leaflet (code fix) | MODERATE | CVE-2025-69993 | XSS via `bindPopup()` rendering user-supplied input as raw HTML. Mitigated by switching to DOM API (`textContent`/`createElement`) instead of HTML string interpolation in leaflet-provider.ts. |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **@modelcontextprotocol/sdk** | 1.12.1 | 1.29.0 | mcp-api | Critical security fix (CVE-2026-0621 + data leak). 17 minor versions jumped. API surface used (`McpServer`, `createMcpHandler`) unchanged. |
| **agents** | 0.11.5 | 0.12.3 | mcp-api | Security hardening: SSRF protection (private IP blocking), HMAC-SHA256 signed email headers, `callbackPath` for MCP OAuth callbacks. |
| **mapbox-gl** | 3.22.0 | 3.23.0 | root, frontend | Minor release. No breaking changes. |
| **wrangler** | 4.85.0 | 4.87.0 | root | 4.86.0 dropped Node.js 20.x support (Node 20 EOL 2026-04-30). 4.87.0 adds experimental `generateTypes()` API. |
| **@cloudflare/workers-types** | 4.20260426.1 | 4.20260503.1 | root | Weekly type definition update. |
| **@cloudflare/vitest-pool-workers** | ^0.14.9 | ^0.15.2 | competition-api | Now supports vitest ^4.1.0 peer dep. |
| **postcss** (override) | ^8.5.10 | ^8.5.13 | root (override) | Security fix (see above). |
| **engines.node** | >=20 | >=22 | root | Required by wrangler 4.86+. |

### Code Changes Required

- **leaflet-provider.ts**: Replaced `bindPopup()` HTML string interpolation with DOM API (`createElement`/`textContent`) to mitigate CVE-2025-69993 XSS via `bindPopup`. The event data is internally generated (not user input), but this is defense-in-depth.

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| zod | ^3.25.76 | 4.4.2 | Major version. `@hono/zod-validator` does not support Zod 4 yet (honojs/middleware#1148). Migration requires `.strict()` → `strictObject()`, `error.errors` → `error.issues`, etc. |
| vite | ^7.3.2 | 8.0.10 | Major version. Replaces esbuild/Rollup with Rolldown. `@cloudflare/vitest-pool-workers` has known issues with Vite 8. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha for `LeafletMap` constructor API. No stable 2.0 release yet. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, pinned. |

### Verification

- All 406 engine tests pass
- All 5 airscore-api tests pass
- All 203 competition-api vitest tests pass
- All 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api)
- `bun audit` reports 0 vulnerabilities
- **e2e was NOT verified locally on this PR — that gap is what let the CI break ship.** See "Post-merge CI repair" below.

### Post-merge CI repair (2026-05-09)

The original PR for this upgrade left CI red on `deps/upgrade-dependencies-2026-05` for ~5 days. Symptom: every E2E job failed within ~50 ms with only:

```
[WebServer] $ bun run --filter auth-api dev
[WebServer] error: script "dev:auth" exited with code 1
```

No stderr, no wrangler banner — `bun run --filter`'s prefixed-output buffer swallowed the inner stderr because the child died before the buffer flushed.

**Root cause:** wrangler 4.86+ rejects Node < 22, but neither `branch-deploy.yml` nor `deploy.yml` set up Node — they only ran `oven-sh/setup-bun@v2`, leaving the Ubuntu 24.04 runner's default Node 20.20.2 on PATH. `bunx wrangler` resolves through `bin/wrangler.js`'s `#!/usr/bin/env node` shebang, so it ran under Node 20 and bailed instantly with `Wrangler requires at least Node.js v22.0.0`.

`engines.node` in package.json was bumped to `>=22` in this PR, but that field is advisory only — bun doesn't enforce it, and CI didn't pin a Node version, so the new floor went undetected.

**Fixes (commits `2e17c49` + `be80b7b` on this branch):**

1. **Add `actions/setup-node@v4` with `node-version: 22`** to every job in `branch-deploy.yml` and `deploy.yml` that runs bun — this is the actual fix.
2. **Pin `wrangler` to exact `4.87.0`** in root + every workspace package.json (was `^4.85.0` / `^4.87.0`, all floating up to 4.90.0). Not strictly required after the Node fix, but matches what the upgrade commit message claimed.
3. **Add a `Probe auth-api startup` step** to `deploy.yml` that runs `bunx wrangler --version` and `wrangler d1 migrations apply` directly from `web/workers/auth-api`, bypassing `bun run --filter`. Plus a `Dump wrangler logs on failure` step. These exist as a safety net so the next silent-exit regression surfaces real stderr instead of being swallowed.

### Lessons / Notes for Future Sessions

- **When bumping wrangler past 4.86, also bump CI's Node version, not just `engines.node`.** Pre-flight checklist for any wrangler upgrade: (1) check the new wrangler's required Node minimum on its release page, (2) grep `.github/workflows/*.yml` for `setup-node` — if absent or below the new minimum, add/raise it in the *same PR*, (3) run `bun run test:e2e` locally before pushing — e2e is the only thing that exercises `wrangler dev` startup, and silent CI failures look identical to misconfigured webServer.
- **`bun run --filter` swallows stderr from a fast-failing child.** When debugging `error: script "X" exited with code 1` with no other output, run the inner command directly (e.g. `cd web/workers/auth-api && bun run dev`) — the real error is usually staring at you. The `Probe auth-api startup` step in deploy.yml now does this in CI too.
- **`@modelcontextprotocol/sdk` jumped 17 minor versions** (1.12 → 1.29) with critical security fixes. The narrow API surface used (`McpServer`, `createMcpHandler`) was stable across all versions. The custom type declarations in `agents-mcp.d.ts` shield from the full type surface — no changes needed.
- **wrangler 4.86.0 silently dropped Node.js 20 support.** Updated `engines.node` to `>=22` to surface this early in CI/deployment. (See above — `engines.node` alone wasn't enough; CI also needs `setup-node`.)
- **Leaflet XSS (CVE-2025-69993):** Even with alpha/pre-release packages, always use DOM API (`textContent`, `createElement`) instead of string interpolation for `bindPopup`/`bindTooltip`. The upstream fix may not come for 2.0-alpha.
- **`agents` package continues to be pinned** (no caret) since it's pre-1.0 with potential breaking changes on minor bumps. The 0.11.5 → 0.12.3 upgrade changed `partyserver` from ^0.4.1 to ^0.5.5 internally but `createMcpHandler` API is unchanged.
- **Zod 4 migration remains blocked** by `@hono/zod-validator`. Monitor honojs/middleware#1148.
- **threebox-plugin is dormant** (3+ years since last release). If future mapbox-gl upgrades break it, consider forking.
- **`bun update` only bumps root package.json** version specifiers, not workspace sub-packages. Sub-packages resolve via the lockfile.

## 2026-04-26

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| postcss (transitive via vite) | MODERATE | [GHSA-qx2v-qp2m-jg93](https://github.com/advisories/GHSA-qx2v-qp2m-jg93) | XSS via unescaped `</style>` in CSS Stringify output. Fixed by overriding postcss to ^8.5.10 (installed 8.5.12). |
| protocol-buffers-schema (transitive via mapbox-gl) | MODERATE | [GHSA-j452-xhg8-qg39](https://github.com/advisories/GHSA-j452-xhg8-qg39) | Prototype pollution via crafted protobuf schema (CVE-2026-5758). Fixed by overriding to ^3.6.1 (installed 3.6.1). |
| better-auth | MODERATE | (v1.6.6) | SSRF vulnerabilities: loopback detection hardened to cover full `127.0.0.0/8`, IPv6 forms, and cloud metadata FQDNs. `0.0.0.0` no longer treated as loopback. |
| hono (transitive via @modelcontextprotocol/sdk) | MODERATE | [GHSA-458j-xx4x-4375](https://github.com/advisories/GHSA-458j-xx4x-4375) | Stale hono 4.12.12 bundled by MCP SDK. Fixed by overriding hono to ^4.12.15. Not exploitable in our codebase (no JSX SSR). |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **hono** | 4.12.14 | 4.12.15 | frontend, auth-api, competition-api, mcp-api | Bug fix: JWT helper now supports single-line PEM keys. No breaking changes. |
| **better-auth** | 1.6.5 | 1.6.9 | frontend, auth-api | SSRF fix (1.6.6), multi-client-ID support for social providers (1.6.7), OAuth profile fallback when email omitted (1.6.8), edge/browser instrumentation fix (1.6.9). No breaking changes. |
| **@better-auth/api-key** | 1.6.5 | 1.6.9 | auth-api | Aligned with better-auth 1.6.9. |
| **wrangler** | 4.83.0 | 4.85.0 | all workspaces | Artifacts binding support, container placement constraints, cross-process service bindings, custom domain `enabled`/`previews_enabled` fields. No breaking changes. |
| **tailwindcss** | 4.2.2 | 4.2.4 | frontend | Bug fixes: `tracking-*` canonicalization, crash fix for invalid unicode, `@import`/`@plugin` resolution with Vite aliases. |
| **@tailwindcss/vite** | 4.2.2 | 4.2.4 | frontend | Aligned with tailwindcss 4.2.4. |
| **vitest** | 4.1.4 | 4.1.5 | competition-api | Bug fixes: soft assertion diff config, JSX/TSX syntax highlight, MessagePort in web-worker postMessage. |
| **@cloudflare/vitest-pool-workers** | 0.14.7 | 0.14.9 | competition-api | Reduced default log verbosity, workflow binding fix, dependency bumps. |
| **agents** | 0.11.4 | 0.11.5 | mcp-api | Type-level improvements: `Props` generic added to `AIChatAgent`. No behavior change. |
| **@cloudflare/workers-types** | 4.20260418.1 | 4.20260426.1 | all workspaces | Weekly type definition update. |
| **@types/bun** | 1.3.12 | 1.3.13 | root | Type definition update. |
| **postcss** | 8.5.8 | 8.5.12 | (transitive, override) | Security fix + bug fixes. Forced via `overrides` in root package.json. |
| **protocol-buffers-schema** | 3.6.0 | 3.6.1 | (transitive, override) | Security fix. Forced via `overrides` in root package.json. |

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| zod | 3.25.76 | 4.3.6 | Major version. Breaking changes to `.pick()`/`.omit()` on refined schemas, `.extend()` with refinements. Requires `@hono/zod-validator` compatibility review and schema migration. Recommend a separate dedicated PR. |
| vite | 7.3.2 | 8.0.10 | Major version. Replaces esbuild+Rollup with Rolldown. Breaking: `build.rollupOptions` → `build.rolldownOptions`, `optimizeDeps.esbuildOptions` deprecated, changed module resolution. `@cloudflare/vitest-pool-workers` has known issues with Vite 8. Wait for ecosystem stabilization. |
| @modelcontextprotocol/sdk | 1.12.1 (lockfile: 1.29.0) | 2.0.0-alpha | Alpha release. Breaking changes in tool registration API and error handling. Wait for stable. Note: lockfile resolves to 1.29.0 via `^1.12.1` semver range. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha. No newer alpha available. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, not published to npm regularly. |
| kysely | 0.28.16 | 0.29.0-rc.0 | 0.28.16 is the latest stable. 0.29.0 is RC only. |
| @turf/bbox, @turf/bearing, @turf/helpers | 7.3.5 | 7.3.5 | Already at latest. |
| katex | 0.16.45 | 0.16.45 | Already at latest. |
| sqids | 0.3.0 | 0.3.0 | Already at latest. |
| @hono/zod-validator | 0.7.6 | 0.7.6 | Already at latest. |
| @fontsource/atkinson-hyperlegible-next | 5.2.7 | 5.2.7 | Already at latest. |
| mapbox-gl | 3.22.0 | 3.22.0 | Already at latest. |
| threebox-plugin | 2.2.7 | 2.2.7 | Already at latest. |
| typescript | 6.0.3 | 6.0.3 | Already at latest. |
| @playwright/test | 1.59.1 | 1.59.1 | Already at latest. |

### Code Changes Required

None. All upgrades are drop-in replacements with no API changes affecting our usage.

### Verification

- All 411 engine/worker tests pass
- All 203 competition-api vitest tests pass
- All 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api)
- Frontend production build succeeds
- `bun audit` reports 0 vulnerabilities

### Lessons / Notes for Future Sessions

- `bun audit` reports vulnerabilities against the semver range in package.json, not the resolved lockfile version. Even when your direct dependency is patched, transitive dependencies (e.g., `@modelcontextprotocol/sdk` bundling an older hono) may keep the advisory active. Use `overrides` to force transitive dependency versions.
- The `postcss` vulnerability (GHSA-qx2v-qp2m-jg93) is fixed in postcss 8.5.10. Vite 7.3.2 uses `postcss: ^8.5.6` which allows the fix, but bun's lockfile may not auto-resolve to the latest patch — an explicit override ensures the fix.
- `protocol-buffers-schema` is a deep transitive dependency of mapbox-gl (via `resolve-protobuf-schema`). The semver range `^3.3.1` allows 3.6.1, but bun's lockfile had pinned 3.6.0 — an override was needed to bump it.
- `better-auth` 1.6.6 includes important SSRF hardening. If self-hosting the auth worker or exposing it to untrusted input, this is a critical upgrade.
- The `agents` package continues to be pinned to an exact version (no `^`) because it's pre-1.0. Type declaration file `web/workers/mcp-api/src/agents-mcp.d.ts` was not affected by the 0.11.4→0.11.5 upgrade.
- `@cloudflare/vitest-pool-workers` 0.14.8 changed the deprecated `SELF` reference warning. If tests log a new warning about exports, this is the source.

## 2026-04-12

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| vite | HIGH | [GHSA-4w7w-66w2-5vf9](https://github.com/advisories/GHSA-4w7w-66w2-5vf9) | Path Traversal in Optimized Deps `.map` Handling |
| vite | HIGH | [GHSA-v2wj-q39q-566r](https://github.com/advisories/GHSA-v2wj-q39q-566r) | `server.fs.deny` bypassed with queries |
| vite | HIGH | [GHSA-p9ff-h696-f583](https://github.com/advisories/GHSA-p9ff-h696-f583) | Arbitrary File Read via Vite Dev Server WebSocket |
| hono | MODERATE | [GHSA-26pp-8wgv-hjvm](https://github.com/advisories/GHSA-26pp-8wgv-hjvm) | Missing validation of cookie name on write path in setCookie() |
| hono | MODERATE | [GHSA-r5rp-j6wh-rvv4](https://github.com/advisories/GHSA-r5rp-j6wh-rvv4) | Non-breaking space prefix bypass in cookie name handling in getCookie() |
| hono | MODERATE | [GHSA-xpcf-pg52-r92g](https://github.com/advisories/GHSA-xpcf-pg52-r92g) | Incorrect IP matching in ipRestriction() for IPv4-mapped IPv6 addresses |
| hono | MODERATE | [GHSA-xf4j-xp2r-rqqx](https://github.com/advisories/GHSA-xf4j-xp2r-rqqx) | Path traversal in toSSG() |
| hono | MODERATE | [GHSA-wmmm-f939-6g9c](https://github.com/advisories/GHSA-wmmm-f939-6g9c) | Middleware bypass via repeated slashes in serveStatic |
| defu (transitive via better-auth) | HIGH | [GHSA-737v-mqg7-c878](https://github.com/advisories/GHSA-737v-mqg7-c878) | Prototype pollution via `__proto__` key in defaults argument |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **vite** | 7.3.1 | 7.3.2 | frontend | Security-only patch. Fixes all 3 HIGH dev server vulnerabilities. Drop-in replacement. |
| **hono** | 4.12.10 | 4.12.12 | frontend, auth-api, competition-api | 4.12.11 added `classNameSlug` option. 4.12.12 is security-only: fixes 5 moderate vulns. Drop-in replacement. |
| **better-auth** | 1.5.6 | 1.6.2 | frontend, auth-api | Minor version bump. Includes OAuth CSRF fix, session freshAge now based on createdAt, security hardening. No breaking changes for our usage (we don't use 2FA or freshAge). |
| **defu** | 6.1.4 | 6.1.7 | (transitive) | Forced via `overrides` in root package.json. Fixes prototype pollution (GHSA-737v-mqg7-c878). |
| **wrangler** | 4.80.0 | 4.81.1 | root, frontend, auth-api, competition-api, airscore-api | New email routing CLI commands, framework auto-config improvements, workerd bumps. No breaking changes. |
| **vitest** | 4.1.2 | 4.1.4 | competition-api | Bug fixes (fake timer advancement, import hoisting). New experimental features (locators, filterMeta). No breaking changes. |
| **@cloudflare/vitest-pool-workers** | 0.14.1 | 0.14.3 | competition-api | Better V8 coverage error detection, dependency bumps. No breaking changes. |
| **kysely** | 0.28.15 | 0.28.16 | auth-api | Bug fix for `FilterObject` type when `TB` is `never`. No breaking changes. |
| **katex** | 0.16.44 | 0.16.45 | frontend | Wraps vcenter `mpadded` in `mrow` for valid MathML output. No breaking changes. |
| **@cloudflare/workers-types** | 4.20260404.1 | 4.20260412.1 | root, frontend, auth-api, competition-api, airscore-api | Weekly type definition update. |
| **@types/bun** | 1.3.11 | 1.3.12 | root | Type definition update. |
| **@types/node** | 25.5.2 | 25.6.0 | root | Type definition update. |

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| zod | 3.25.76 | 4.3.6 | Major version bump (v3 to v4). Would require migration of all Zod schemas and `@hono/zod-validator` compatibility review. Recommend a separate dedicated PR. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha for new features. No newer alpha available. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, not published to npm regularly. |
| typescript | 6.0.2 | 6.0.2 | Already at latest. |
| @playwright/test | 1.59.1 | 1.59.1 | Already at latest. |

### Code Changes Required

None. All upgrades are drop-in replacements with no API changes affecting our usage.

### Verification

- All 411 engine/worker tests pass
- All 190 competition-api vitest tests pass
- All 5 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api)
- Frontend production build succeeds

### Lessons / Notes for Future Sessions

- `bun audit` may report false positives for transitive dependencies even after they're resolved in the lockfile. Use `overrides` in root package.json to force transitive dependency versions.
- better-auth bundles many optional peer dependencies (prisma, drizzle, mongodb, etc). Most are irrelevant for our Cloudflare D1/Kysely setup.
- The Zod v3 to v4 migration is a significant effort and should be handled separately. Zod v4 changes the import structure and has API differences.
- Vite security patches are dev-server only but still important for local development safety.

## 2026-04-19

### Security Vulnerabilities Fixed

| Package | Severity | Advisory | Description |
|---------|----------|----------|-------------|
| hono | MEDIUM | [GHSA-458j-xx4x-4375](https://github.com/advisories/GHSA-458j-xx4x-4375) | Missing validation of JSX attribute names during SSR allows HTML injection via malformed attribute keys. Not exploitable in our codebase (no JSX SSR usage) but fixed for defense in depth. |
| better-auth | HIGH | [GHSA-xr8f-h2gw-9xh6](https://github.com/advisories/GHSA-xr8f-h2gw-9xh6) | Authorization bypass in `@better-auth/oauth-provider` — unprivileged authenticated users could create OAuth clients when relying on `clientPrivileges` for restriction. |
| agents | MODERATE | (v0.11.2) | Strengthened SSRF checks by properly blocking the full IPv6 link-local range `fe80::/10`. |

### Dependency Upgrades

| Package | From | To | Workspaces | Notes |
|---------|------|----|------------|-------|
| **hono** | 4.12.12 | 4.12.14 | frontend, auth-api, competition-api, mcp-api | Security fix for JSX attribute name injection (GHSA-458j-xx4x-4375). Also fixes AWS Lambda header validation. |
| **better-auth** | 1.6.2 | 1.6.5 | frontend, auth-api | Fixes OAuth provider authorization bypass, 2FA enforcement scope, session refresh after password change, dynamic baseURL resolution, isMounted race condition. |
| **@better-auth/api-key** | 1.6.2 | 1.6.5 | auth-api | Aligned with better-auth 1.6.5. |
| **agents** | 0.10.1 | 0.11.4 | mcp-api | SSRF hardening (0.11.2), critical `subAgent()` cross-DO I/O fix (0.11.3), new WebMCP adapter and `sendEmail()` method. Breaking changes are in `@cloudflare/think` lifecycle hooks and `ToolCallContext` renaming — neither is used in our codebase (we only use `createMcpHandler` from `agents/mcp`). |
| **mapbox-gl** | 3.21.0 | 3.22.0 | root, frontend | Bug fix release: PowerVR crash fix, nested clip layer scopes, webpack warning elimination, sub-pixel line rendering, map-sessions request fix for non-Mapbox API hosts. |
| **@turf/bbox** | 7.3.4 | 7.3.5 | engine | Patch release. |
| **@turf/bearing** | 7.3.4 | 7.3.5 | engine | Patch release. |
| **@turf/helpers** | 7.3.4 | 7.3.5 | engine | Patch release. |
| **wrangler** | 4.81.1 | 4.83.0 | all workspaces | Containers CLI stabilization, undici bump fixing non-2xx POST/PUT errors, startup no longer blocks on slow connections, Flagship/Stream binding fixes in remote mode. |
| **typescript** | 6.0.2 | 6.0.3 | all workspaces | Patch release. |
| **@cloudflare/workers-types** | 4.20260412.1 | 4.20260418.1 | all workspaces | Weekly type definition update. |
| **@cloudflare/vitest-pool-workers** | 0.14.3 | 0.14.7 | competition-api | Dependency bumps (miniflare, wrangler alignment). |

### Packages Not Upgraded (intentional)

| Package | Current | Latest | Reason |
|---------|---------|--------|--------|
| zod | 3.25.76 | 4.3.6 | Major version. Breaking changes to `.pick()`/`.omit()` on refined schemas, `.extend()` with refinements. Requires `@hono/zod-validator` compatibility review and schema migration. Recommend a separate dedicated PR. |
| vite | 7.3.2 | 8.0.8 | Major version. Vite 8 replaces esbuild+Rollup with Rolldown. Breaking changes include `build.rollupOptions` → `build.rolldownOptions`, HMR API changes, CJS interop changes. Also `@cloudflare/vitest-pool-workers` has [known issues with Vite 8](https://github.com/cloudflare/workers-sdk/issues/12994). Recommend waiting for ecosystem stabilization. |
| @modelcontextprotocol/sdk | 1.12.1 | 2.0.0-alpha | Alpha release. Major breaking changes (tool registration API, error handling overhaul, Zod dropped from peerDeps). Wait for stable release. |
| leaflet | 2.0.0-alpha.1 | 1.9.4 (stable) | Intentionally on v2 alpha for new features. No newer alpha available. |
| @pokle/basecoat | 0.3.10-beta3.pokle-selections | - | Custom fork, not published to npm regularly. |

### Code Changes Required

None. All upgrades are drop-in replacements with no API changes affecting our usage. The `agents` 0.10→0.11 upgrade has breaking changes in `@cloudflare/think` lifecycle hooks (`ToolCallContext.args` → `input`, `afterToolCall` discriminated union), but we only use `createMcpHandler` from `agents/mcp` which is unaffected.

### Verification

- All 411 engine/worker tests pass
- All 190 competition-api vitest tests pass
- All 6 workspace typechecks pass (root, engine, airscore-api, auth-api, competition-api, mcp-api)
- Frontend production build succeeds

### Lessons / Notes for Future Sessions

- The `agents` package is pinned to an exact version (no `^`) because it's pre-1.0 and breaking changes happen on minor bumps. When upgrading, check the `agents/mcp` API surface specifically — we only use `createMcpHandler`. The custom type declarations in `web/workers/mcp-api/src/agents-mcp.d.ts` may need updating if the API changes.
- `@modelcontextprotocol/sdk` v2.0.0 is in alpha and removes Zod from peer dependencies in favor of Standard Schema spec. This will be a significant migration when it stabilizes — all `z.` schemas in MCP tool definitions would need to be reviewed.
- Vite 8 migration should be planned alongside `@cloudflare/vitest-pool-workers` support. Track [workers-sdk#11064](https://github.com/cloudflare/workers-sdk/issues/11064) for Vitest 4/Vite 8 compatibility.
- Zod v4 migration should be done in a dedicated PR. Key breaking changes: `.pick()`/`.omit()` on refined schemas throws, `.extend()` with refinements on overwritten props errors (use `.safeExtend()`). Check all schemas in `competition-api/src/validators.ts` and `mcp-api/src/tools/*.ts`.
- `better-auth` 1.6.4 reverted 2FA enforcement scope back to credential sign-in paths only (from all sign-in paths in 1.6.3). This is relevant if we enable 2FA in the future.
