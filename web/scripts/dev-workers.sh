#!/usr/bin/env bash
# Start every Cloudflare Worker for local dev in ONE wrangler session.
#
# Why one session and not three (issue #477): auth-api and competition-api share
# a single D1 SQLite file via `--persist-to web/.wrangler/state`. Run as separate
# `wrangler dev` processes, they are two Miniflare *processes* writing that file
# concurrently, which intermittently surfaces as
# `D1_ERROR: Failed to parse body as JSON, got: Error: internal error`
# — and can take the whole `wrangler dev` process down with it, cascading a CI
# run into a dozen unrelated-looking failures.
#
# `wrangler dev -c … -c …` puts all of them in one Miniflare instance, so the
# database has a single writer. The catch is that only the PRIMARY config's port
# is exposed, so the primary is `dev-router` — a dev-only Worker that dispatches
# `/api/*` to its siblings over service bindings, exactly as the Pages Functions
# in `functions/api/` do in production. Everything therefore talks to ONE port:
#
#   http://localhost:8790   (DEV_API_PORT to override)
#
# Args are forwarded to wrangler, so the docker container can add
# `--ip 0.0.0.0`.

set -euo pipefail
cd "$(dirname "$0")/../.."

PORT="${DEV_API_PORT:-8790}"

# The Workers own the D1 schema; apply migrations before anything can serve a
# request against a missing table.
bun run db:migrate

exec bunx wrangler dev \
  --config web/workers/dev-router/wrangler.toml \
  --config web/workers/auth-api/wrangler.toml \
  --config web/workers/competition-api/wrangler.toml \
  --config web/workers/airscore-api/wrangler.toml \
  --persist-to web/.wrangler/state \
  --port "$PORT" \
  "$@"
