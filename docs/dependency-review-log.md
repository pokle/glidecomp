# Dependency Review Log

## 2026-04-05 Review

### Upgrades Applied

| Package | From | To | Scope | Notes |
|---------|------|----|-------|-------|
| `@cloudflare/workers-types` | 4.20260404.1 | 4.20260405.1 | devDependency (root, frontend, all workers) | Daily types refresh. No code changes needed. |
| `katex` | 0.16.44 | 0.16.45 | dependency (frontend) | Bug fix: wraps `\vcenter` `mpadded` elements in `mrow` for valid MathML (PR #4193). No code changes needed. |

### Security Audit

| Package | Version | CVE | Status |
|---------|---------|-----|--------|
| `hono` | 4.12.10 | CVE-2026-24771 (XSS in ErrorBoundary) | **Already patched** (fixed in 4.11.7). Not used in codebase anyway. |
| `hono` | 4.12.10 | CVE-2026-29086 (Cookie injection via setCookie) | **Already patched** (fixed in 4.12.4). setCookie not directly used in codebase. |
| `hono` | 4.12.10 | CVE-2026-29045 (Path traversal in serveStatic) | **Already patched** (fixed in 4.12.4). serveStatic not used in codebase. |
| `kysely` | 0.28.15 | CVE-2026-32763 (SQL injection via JSON path keys) | **Already patched** (fixed in 0.28.12). |
| `better-auth` | 1.5.6 | CVE-2025-61928 (Unauthenticated API key creation) | **Already patched** (fixed in 1.3.26). |

**No vulnerabilities found** for: mapbox-gl, threebox-plugin, leaflet, sqids, @turf/bbox, @turf/bearing, @turf/helpers.

### Major Version Upgrades Available (Not Applied)

#### Vite 7.3.1 -> 8.0.3

Skipped — major breaking changes:
- Rolldown replaces esbuild/Rollup as the bundler
- `import.meta.hot.accept` resolution fallback removed
- Default browser target raised
- `customResolver` in `resolve.alias` deprecated
- `vite-tsconfig-paths` plugin deprecated (built-in now)

**Recommendation:** Evaluate in a dedicated branch. Test the full build pipeline before adopting.

#### Zod 3.25.76 -> 4.3.6

Skipped — major breaking changes affecting our code:
- `.strict()` removed from object instances (use `z.strictObject()` instead) — affects `gapParamsSchema` in `validators.ts:26`
- `.email()` on strings moves to top-level `z.email()` — affects `validators.ts:46`
- `z.record(value)` single-arg form removed (requires `z.record(key, value)`) — affects `validators.ts:54,92`
- `.refine()` drops `ctx.path` and type predicates — our usage is simple and likely safe
- Error API changes: `{ message }` -> `{ error }`, `.format()`/`.flatten()` replaced by `z.treeifyError()`
- `@hono/zod-validator` already supports Zod 4 (`peerDependencies: "^3.25.0 || ^4.0.0"`)

**Recommendation:** Migrate when Zod 4 ecosystem stabilizes. Changes are mechanical but require testing all validation paths.

### Lessons / Notes for Future Sessions

- `bun pm scan` requires a security scanner configured in `bunfig.toml` — not usable out of the box. Use `bun outdated` per workspace to check for updates.
- `bun outdated` must be run in each workspace directory separately to catch all updates.
- The project's pinned versions for hono, kysely, and better-auth already include patches for all known CVEs as of this date.
- `threebox-plugin` has inactive maintenance — monitor for alternatives if 3D map features are expanded.
- `leaflet` is pinned to `2.0.0-alpha.1` — track the Leaflet 2.0 stable release.
