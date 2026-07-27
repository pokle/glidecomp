#!/usr/bin/env bash
# Host driver for the isolated preview: `bun run preview:container`.
#
# Runs the whole stack — pages dev + the three Workers + D1 + R2 — inside one
# Apple container(1) VM, and publishes a single port to your Mac. Run it as many
# times as you like on different ports; each instance is independent.
#
#   bun run preview:container              # http://localhost:3000
#   PORT=3001 bun run preview:container    # a second, wholly separate instance
#   SKIP_SEED=1 PORT=3001 bun run ...      # keep that instance's existing data
#   REBUILD=1 bun run preview:container    # only after a dependency change
#
# Your checkout is bind-mounted READ-ONLY at /src and staged into the container
# on start, so a source edit needs a restart (Ctrl-C, re-run) — not an image
# rebuild. There is no HMR: `preview` serves a production build through the real
# Pages runtime, same as `bun run preview` on the host. Use `bun run dev` when
# you want a fast edit loop.
#
# ONE PORT IS ENOUGH. The browser never talks to anything but the published
# port: /api/auth, /api/comp, /api/admin, /api/u, /api/user and the SSR /comp
# pages are all same-origin Pages Functions that reach the Workers over service
# bindings, in-process. The Workers' own ports (8787-8789) and the workerd
# inspectors (9229-9231) stay inside the VM.
#
# The one exception is the analysis page's AirScore import
# (web/frontend/src/analysis/airscore-client.ts), which hardcodes
# http://localhost:8787 whenever the hostname is localhost. There is no
# functions/api/airscore/ proxy to route it through, so that one button is
# inert in the container. Everything else works.
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="$PWD"

# Clear of every port this project already uses: 3000 (vite), 3100 (the SSR e2e
# harness), 4321 (astro), 8787-8789 (workers), 9229-9231 (workerd inspectors).
#
# Deliberately NOT 3000 for a second reason. A native `bun run dev` binds Vite to
# [::1]:3000 while a published container port binds 127.0.0.1:3000 — macOS treats
# those as separate sockets, so BOTH succeed and `localhost` silently resolves to
# whichever the resolver prefers (::1). You get the other instance's app, served
# without a single error. Hence the preflight below.
PORT="${PORT:-3200}"
IMAGE="${IMAGE:-glidecomp-preview}"
NAME="glidecomp-preview-${PORT}"
VOLUME="glidecomp-state-${PORT}"
VOLUME_SIZE="${VOLUME_SIZE:-8G}"

command -v container >/dev/null || {
  echo "error: Apple's container(1) is not installed — 'brew install container'." >&2
  exit 1
}
container system status >/dev/null 2>&1 || container system start

# Refuse a port anything already holds, on EITHER stack. Publishing to
# 127.0.0.1 when something owns [::1] succeeds and then quietly serves you the
# wrong app — see the PORT comment above.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: something is already listening on port ${PORT}:" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 | sed 's/^/  /' >&2
  echo "Pick another with PORT=<n> bun run preview:container." >&2
  exit 1
fi

# Vite inlines these into the bundle, and the build runs inside the container,
# so they are passed at run time. They never enter an image layer.
mapbox_token="${VITE_MAPBOX_TOKEN:-}"
arcgis_key="${VITE_ARCGIS_API_KEY:-}"
if [ -f .env ]; then
  [ -n "$mapbox_token" ] || mapbox_token=$(grep -m1 '^VITE_MAPBOX_TOKEN=' .env | cut -d= -f2- || true)
  [ -n "$arcgis_key" ]   || arcgis_key=$(grep -m1 '^VITE_ARCGIS_API_KEY=' .env | cut -d= -f2- || true)
fi
[ -n "$mapbox_token" ] || echo "warning: no VITE_MAPBOX_TOKEN — maps will not render." >&2

# The image is just the dependency tree, so a rebuild is rare: only a changed
# bun.lock, workspace manifest or patch needs one. Source changes never do.
#
# We detect that by hashing exactly the files the image's dependency layer is
# built from — the same list the Containerfile COPYs — and stamping it beside
# the image. Drift => rebuild, automatically.
#
# Note this is a SPEED optimisation, not a correctness one. The entrypoint runs
# `bun install --frozen-lockfile` after staging, which reconciles /app/node_modules
# to whatever lockfile the mount brought in — verified by deleting a package and
# watching it come back. So a missed rebuild costs a slower start, never wrong
# dependencies. That is why the stamp living on the host (and so being able to
# go stale if the image is rebuilt elsewhere) is an acceptable trade for not
# paying a container spin-up on every invocation.
deps_hash=$(cat bun.lock package.json \
                web/engine/package.json web/frontend/package.json \
                web/samples/package.json web/workers/*/package.json \
                patches/* 2>/dev/null | shasum -a 256 | cut -c1-16)
stamp="web/.wrangler/container-preview-${IMAGE}.deps"

rebuild_reason=""
if [ "${REBUILD:-0}" = "1" ]; then
  rebuild_reason="REBUILD=1"
elif ! container image inspect "$IMAGE" >/dev/null 2>&1; then
  rebuild_reason="no ${IMAGE} image yet"
elif [ ! -f "$stamp" ]; then
  rebuild_reason="no dependency stamp — image provenance unknown"
elif [ "$(cat "$stamp")" != "$deps_hash" ]; then
  rebuild_reason="dependencies changed since the image was built"
fi

if [ -n "$rebuild_reason" ]; then
  echo "preview: rebuilding dependency image ${IMAGE} (${rebuild_reason})…"
  container build -t "$IMAGE" -f Containerfile --progress plain .
  mkdir -p "$(dirname "$stamp")"
  printf '%s' "$deps_hash" > "$stamp"
fi

# D1 + R2 live on this volume, NOT in your host checkout's web/.wrangler/state.
# That is the whole isolation story: nothing here can disturb a running
# `bun run dev`, and two previews on two ports cannot disturb each other.
container volume inspect "$VOLUME" >/dev/null 2>&1 \
  || container volume create -s "$VOLUME_SIZE" "$VOLUME" >/dev/null

container rm -f "$NAME" >/dev/null 2>&1 || true

# .git is not staged into the container (97 MB, and the mount is read-only), so
# hand the build the commit it would otherwise shell out to git for.
git_sha=$(git rev-parse HEAD 2>/dev/null || echo unknown)

echo "preview: starting ${NAME} on http://localhost:${PORT}"
# The default VM allocation is too small for `vite build` — it gets OOM-killed
# (exit 137) partway through transforming. These are overridable but don't go
# much lower.
exec container run --rm --name "$NAME" \
  --cpus "${CPUS:-6}" --memory "${MEMORY:-8G}" \
  -p "127.0.0.1:${PORT}:3000" \
  -v "${REPO}:/src:ro" \
  -v "${VOLUME}:/app/web/.wrangler/state" \
  -e "PUBLIC_ORIGIN=http://localhost:${PORT}" \
  -e "SKIP_SEED=${SKIP_SEED:-0}" \
  -e "GIT_SHA=${git_sha}" \
  -e "VITE_MAPBOX_TOKEN=${mapbox_token}" \
  -e "VITE_ARCGIS_API_KEY=${arcgis_key}" \
  "$IMAGE"
