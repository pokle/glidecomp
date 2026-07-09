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
# local D1 state directly and needs the tables to exist).
echo "ssr-e2e: waiting for competition-api on :8789…"
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://localhost:8789/api/comp"; then break; fi
  sleep 1
done
bun run seed:sample

exec npx wrangler pages dev web/frontend/dist --port 3100 \
  --compatibility-date=2025-03-10 --compatibility-flags=nodejs_compat \
  --service COMPETITION_API=competition-api --service AUTH_API=auth-api
