# Dependency Review Log

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
