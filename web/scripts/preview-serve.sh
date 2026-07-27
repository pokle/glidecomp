#!/usr/bin/env bash
# The "serve" half of `bun run preview`: a faithful local preview of the whole
# system through the REAL Cloudflare Pages runtime — SSR Functions, the sitemap,
# the static Astro pages and the SPA shell — bound to the locally-running
# Workers. Unlike `bun run dev` (Vite), this exercises everything Pages does in
# production; the trade-off is no HMR (a code change needs a re-run).
#
# `bun run preview` runs this alongside `dev:workers` (which migrates D1 and
# starts the auth / competition / airscore Workers in one wrangler session).
# This half does the one-off build + seed, then hands off to `wrangler pages
# dev`, which reaches the Workers by name via `--service` (every worker in a
# multi-config session registers in wrangler's local dev registry).
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT="${PREVIEW_PORT:-3000}"

# Full production build → web/frontend/dist (Vite app + SSR bundle + Astro
# static pages), exactly what Pages serves in prod.
echo "preview: building web/frontend/dist…"
bun run build

# The competition Worker owns the D1 schema; wait for it before seeding (seed
# writes local D1 state directly and needs the tables to exist). All the Workers
# share one wrangler dev session behind the dev-router on :8790 — see
# web/scripts/dev-workers.sh.
echo "preview: waiting for the API Workers on :8790 (/__ready)…"
for _ in $(seq 1 120); do
  # -f so the 503 that /__ready returns while a Worker is still loading
  # counts as "not yet", not as "answered".
  if curl -sf -o /dev/null "http://localhost:8790/__ready"; then break; fi
  sleep 1
done

# Seed every bundled sample comp into local D1 + R2, so the preview has data.
echo "preview: seeding sample competitions…"
bun run seed

echo "preview: serving http://localhost:${PORT} (Ctrl-C to stop)"
exec bunx wrangler pages dev web/frontend/dist --port "$PORT" \
  --compatibility-date=2025-03-10 --compatibility-flags=nodejs_compat \
  --service COMPETITION_API=competition-api --service AUTH_API=auth-api
