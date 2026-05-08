#!/bin/sh
# Starts all four Cloudflare workers in the docker-compose `workers` container.
# All four wrangler dev processes share the same localhost so service bindings
# (e.g. competition-api → auth-api) resolve through Wrangler's localhost dev
# registry. Each worker runs in its own directory so wrangler picks up its own
# wrangler.toml and ignores the Pages config at the repo root.
set -e

bun install

# Apply D1 migrations for the shared taskscore-auth database (auth-api owns
# auth tables, competition-api owns comp/task/pilot/track tables).
(cd web/workers/auth-api && bunx wrangler d1 migrations apply taskscore-auth --local --persist-to ../../.wrangler/state)
(cd web/workers/competition-api && bunx wrangler d1 migrations apply taskscore-auth --local --persist-to ../../.wrangler/state)

# Each wrangler dev binds its own workerd inspector port. Default is 9229,
# which collides when multiple workers run on the same host.
exec bunx concurrently --kill-others-on-fail \
  -n auth,comp,airscore,mcp \
  -c blue,green,yellow,magenta \
  'cd web/workers/auth-api && bunx wrangler dev --persist-to ../../.wrangler/state --ip 0.0.0.0 --inspector-port 9229' \
  'cd web/workers/competition-api && bunx wrangler dev --persist-to ../../.wrangler/state --ip 0.0.0.0 --inspector-port 9230' \
  'cd web/workers/airscore-api && bunx wrangler dev --ip 0.0.0.0 --inspector-port 9231' \
  'cd web/workers/mcp-api && bunx wrangler dev --persist-to ../../.wrangler/state --ip 0.0.0.0 --inspector-port 9232'
