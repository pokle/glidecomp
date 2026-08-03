#!/usr/bin/env bash
# Build the frontend + SSR bundle, seed the sample comp, and serve the built
# output through the real Cloudflare Pages runtime (wrangler pages dev + the SSR
# Function). Used as the webServer for playwright.ssr.config.ts. The auth + comp
# Workers are started separately by that config and bound here via --service.
set -euo pipefail
cd "$(dirname "$0")/../.."

# SPA shell + SSR bundle. Astro static pages aren't needed for the four SSR
# routes or the /u/me shell fallback, so skip them for a faster build.
( cd web/frontend && bunx vite build && bunx vite build --config vite.ssr.config.ts )

# The comp Worker owns the D1 schema; wait for it before seeding (seed writes
# local D1 state directly and needs the tables to exist). All the Workers share
# one wrangler dev session behind the dev-router on :8790 — see
# web/scripts/dev-workers.sh.
API_PORT="${DEV_API_PORT:-8790}"
echo "ssr-e2e: waiting for the API Workers on :${API_PORT} (/__ready)…"
for _ in $(seq 1 60); do
  # -f so the 503 that /__ready returns while a Worker is still loading
  # counts as "not yet", not as "answered".
  if curl -sf -o /dev/null "http://localhost:${API_PORT}/__ready"; then break; fi
  sleep 1
done
# Just the one comp: these tests only need a single public comp, and seeding the
# whole bundled set would slow the build and make discover()'s "first non-test
# comp" pick depend on seed order.
bun run seed corryong-cup-2026

exec npx wrangler pages dev web/frontend/dist --port "${SSR_PORT:-3100}" \
  --compatibility-date=2025-03-10 --compatibility-flags=nodejs_compat \
  --service COMPETITION_API=competition-api --service AUTH_API=auth-api
