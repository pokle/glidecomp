#!/usr/bin/env bash
# Container-side entrypoint for the isolated preview (see Containerfile and
# web/scripts/container-preview.sh).
#
# The host checkout is bind-mounted read-only at /src. We stage it into /app,
# where the image's Linux node_modules already lives, then do exactly what
# `bun run preview` does: build, migrate, start the Workers, seed, serve.
#
# Everything binds to the container's own loopback except `wrangler pages dev`,
# which binds 0.0.0.0:3000 so the published port reaches it. The Workers stay on
# localhost by design: nothing outside needs them, because pages dev reaches
# them over service bindings, in-process. They share ONE wrangler session behind
# the dev-router on :8790 (issue #477) — there is no per-Worker port any more.
set -euo pipefail

# Stage the source. The excludes matter for three different reasons:
#   node_modules  — /app's is Linux-arm64 from the image; /src's is macOS-arm64.
#   .wrangler     — /app/web/.wrangler/state is the mounted volume (D1 + R2).
#   dist*         — host build output; we rebuild below.
# rsync's --delete does not touch excluded paths, so all three survive it.
echo "preview: staging source from /src…"
rsync -a --delete \
  --exclude 'node_modules/' \
  --exclude '.wrangler/' \
  --exclude 'dist/' \
  --exclude 'dist-ssr/' \
  --exclude '.git/' \
  --exclude '.claude/' \
  /src/ /app/

cd /app

# Vite inlines VITE_* at build time and the build happens here, at run time —
# so the tokens arrive as env vars and never enter an image layer.
printf 'VITE_MAPBOX_TOKEN=%s\nVITE_ARCGIS_API_KEY=%s\n' \
  "${VITE_MAPBOX_TOKEN:-}" "${VITE_ARCGIS_API_KEY:-}" > .env

# Cheap when the image's tree already satisfies the lockfile; self-heals when
# you've changed a dependency since the image was built.
bun install --frozen-lockfile

echo "preview: building web/frontend/dist…"
bun run build

# better-auth's baseURL, and what isLocalDev() keys off. It has to match the
# origin the browser actually uses — the *host* port, passed in by the run
# script — not the container's :3000.
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-http://localhost:3000}"
cat > web/workers/auth-api/.dev.vars <<EOF
GOOGLE_CLIENT_ID=dummy-for-dev
GOOGLE_CLIENT_SECRET=dummy-for-dev
BETTER_AUTH_SECRET=dev-only-not-for-production-udYkKa80ccUbQLHAOdqAcnFfUEiHBA51YLpwgpwYZcSA
BETTER_AUTH_URL=${PUBLIC_ORIGIN}
EOF

# `dev:workers` applies the D1 migrations before starting the Workers, so by the
# time they answer, the tables the seeder needs are there.
if [ "${SKIP_SEED:-0}" = "1" ]; then
  seed_step="echo 'preview: SKIP_SEED=1 — leaving existing data alone.'"
else
  seed_step="echo 'preview: seeding sample competitions…'; bun run seed"
fi

pages_cmd="
  echo 'preview: waiting for the API Workers…'
  # /__ready is 200 only once EVERY Worker in the session answers, and 503 until
  # then — so -f keeps this loop waiting rather than racing ahead on a partly
  # loaded stack. (Waiting on a single Worker's own port is what this used to
  # do; those ports no longer exist.)
  until curl -sf -o /dev/null http://localhost:8790/__ready; do sleep 1; done
  ${seed_step}
  echo 'preview: serving ${PUBLIC_ORIGIN}'
  exec bunx wrangler pages dev web/frontend/dist --ip 0.0.0.0 --port 3000 \
    --compatibility-date=2025-03-10 --compatibility-flags=nodejs_compat \
    --service COMPETITION_API=competition-api --service AUTH_API=auth-api
"

exec bunx concurrently -k -n workers,pages -c blue,magenta \
  'bun run dev:workers' \
  "$pages_cmd"
