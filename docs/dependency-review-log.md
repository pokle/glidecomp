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
