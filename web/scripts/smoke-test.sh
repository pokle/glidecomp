#!/usr/bin/env bash
#
# Post-deploy smoke tests for a GlideComp Cloudflare Pages deployment.
#
# Single source of truth shared by the branch-preview and master (production)
# deploy paths in .github/workflows/deploy.yml, so both exercise identical
# checks and can never drift. Runnable locally against any deployment:
#
#   bash web/scripts/smoke-test.sh https://<slug>.glidecomp.pages.dev <git-sha>
#   bash web/scripts/smoke-test.sh https://glidecomp.com <git-sha> --scores-api https://glidecomp.com
#
# Args:
#   $1  DEPLOY_URL     base URL of the deployment to test
#   $2  EXPECTED_SHA   the git SHA that should be live (build-time <meta name="git-sha">)
#   --scores-api URL   (optional) also run the stale-first scores check against URL.
#                      That check targets the competition worker, which is routed
#                      on the apex domain (not *.pages.dev previews) and is only
#                      freshly deployed by the master job — so it is production-only
#                      and skipped for branch previews.
#
# Emits ::error:: annotations for CI and exits non-zero if any check fails.

set -uo pipefail

DEPLOY_URL="${1:-}"
EXPECTED_SHA="${2:-}"
if [ $# -ge 2 ]; then shift 2; else shift $#; fi

SCORES_API=""
while [ $# -gt 0 ]; do
  case "$1" in
    --scores-api) SCORES_API="${2:-}"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$DEPLOY_URL" ] || [ -z "$EXPECTED_SHA" ]; then
  echo "Usage: smoke-test.sh <deploy_url> <expected_sha> [--scores-api <url>]" >&2
  exit 2
fi

echo "Smoke-testing ${DEPLOY_URL} @ ${EXPECTED_SHA}"
fail=0

# ── SPA routes serve the app shell at the right version ──────────────────────
# SPA routes must serve the app shell directly with HTTP 200 (no redirect).
# Catches _redirects / Cloudflare clean-URL regressions that send SPA routes
# elsewhere — e.g. the /app.html -> /app outage where every SPA route
# 308-redirected to a "Page not found".
# Retry with backoff: /comp is served by the SSR Pages Function, which can
# propagate to the edge after the static assets, so a just-finished deploy may
# transiently 404 it. On the FIRST deploy of a new branch (fresh preview
# environment) that lag was measured at ~33s — run 29703696216 saw /comp 404
# for the whole old 10×3s window and then serve the correct SHA two seconds
# after it expired — so the budget is 20×3s (~60s): comfortable headroom for
# first-time deploys while a live route still passes on the first attempt.
ROUTE_ATTEMPTS=20
check_route() {
  local route="$1" code=""
  for attempt in $(seq 1 "$ROUTE_ATTEMPTS"); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "${DEPLOY_URL}${route}")
    if [ "$code" = "200" ]; then echo "${route} -> ${code}"; return 0; fi
    echo "${route} -> ${code} (attempt ${attempt}/${ROUTE_ATTEMPTS}, retrying in 3s…)"
    sleep 3
  done
  echo "::error::${route} returned HTTP ${code} after retries (expected 200 — route not serving the app shell)"
  return 1
}

# Version check via the build-time <meta name="git-sha"> in the shell. Same
# propagation race as the routes above: right after a deploy the SSR Pages
# Function can answer /comp with 200 before the rendered shell (and its git-sha
# meta) has propagated to the edge, so a single read intermittently sees no
# meta. Retry until it appears and matches.
check_sha() {
  local deployed=""
  for attempt in $(seq 1 10); do
    deployed=$(curl -s "${DEPLOY_URL}/comp" | grep -oP '<meta name="git-sha" content="\K[a-f0-9]+' | head -1)
    if [ "$deployed" = "$EXPECTED_SHA" ]; then
      echo "Deployed SHA: ${deployed}"
      return 0
    fi
    echo "Deployed SHA: ${deployed:-<not found>} (attempt ${attempt}/10, retrying in 3s…)"
    sleep 3
  done
  if [ -z "$deployed" ]; then
    echo "::error::Could not read git-sha meta from ${DEPLOY_URL}/comp after retries"
  else
    echo "::error::Deployed SHA ${deployed} does not match expected ${EXPECTED_SHA} after retries"
  fi
  return 1
}

echo "── SPA routes serve the app shell at the right version"
for route in /comp /u/me /scores; do check_route "$route" || fail=1; done
check_sha || fail=1

# ── SSR public pages render content (no JS) ──────────────────────────────────
# Assert that a page's server HTML contains a needle, retrying with backoff.
# Capture-then-grep (never `curl | grep -q`): under `pipefail` a short-circuiting
# `grep -q` closes the pipe early and curl dies with SIGPIPE (141), which
# pipefail would surface as a false "not found" even on a match.
# The retry matters because the SSR Pages Function falls back to the plain SPA
# shell (no content) on any transient loader/render error, so a just-deployed
# page can serve the contentless shell for a few seconds while it warms — the
# same propagation race every other check here retries for.
check_contains() {
  local url="$1" needle="$2" label="$3" html attempt
  for attempt in $(seq 1 10); do
    html=$(curl -s "$url")
    if grep -qF "$needle" <<<"$html"; then echo "Good — ${label}"; return 0; fi
    echo "${label}: '${needle}' not present yet (attempt ${attempt}/10, retrying in 3s…)"
    sleep 3
  done
  echo "::error::${url} HTML did not contain '${needle}' — ${label} not server-rendering after retries"
  return 1
}

check_ssr_content() {
  local local_fail=0 name="" cid="" body attempt
  # robots.txt + the dynamic sitemap must be served. Both are backed by Pages
  # Functions (/sitemap.xml is dynamic), so they're subject to the same
  # post-deploy edge-propagation race as the SPA routes above — a fresh
  # deployment can serve the static assets seconds before the Functions
  # propagate. Retry with backoff instead of a single un-retried read.
  check_route /robots.txt || local_fail=1
  check_route /sitemap.xml || local_fail=1

  # The defining SSR property: a public comp's name is present in the server
  # HTML of /comp AND its hub — with no JavaScript run. /api/comp is served by
  # its own Pages Function, so retry until it returns parseable JSON (same race).
  for attempt in $(seq 1 10); do
    body=$(curl -s "${DEPLOY_URL}/api/comp")
    name=$(echo "$body" | jq -r '[.comps[] | select(.test==false)][0].name // empty' 2>/dev/null)
    cid=$(echo "$body" | jq -r '[.comps[] | select(.test==false)][0].comp_id // empty' 2>/dev/null)
    if [ -n "$name" ] && [ -n "$cid" ]; then break; fi
    echo "/api/comp not ready yet (attempt ${attempt}/10, retrying in 3s…)"
    sleep 3
  done
  if [ -z "$name" ] || [ -z "$cid" ]; then
    echo "::warning::No public comp to verify SSR content against — skipping"
    return "$local_fail"
  fi
  echo "Verifying SSR content for '${name}' (${cid})"
  check_contains "${DEPLOY_URL}/comp" "$name" "/comp server-renders the comp list" || local_fail=1
  check_contains "${DEPLOY_URL}/comp/${cid}" "$name" "/comp/${cid} server-renders the comp hub" || local_fail=1
  return "$local_fail"
}

echo "── SSR public pages render content (no JS)"
check_ssr_content || fail=1

# ── dev-login is NOT accessible ──────────────────────────────────────────────
check_dev_login() {
  local status
  status=$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST "${DEPLOY_URL}/api/auth/dev-login" \
    -H 'Content-Type: application/json' \
    -d '{"name":"smoke","email":"smoke@test.local"}')
  echo "POST /api/auth/dev-login returned HTTP ${status}"
  if [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
    echo "::error::CRITICAL: dev-login endpoint is accessible at ${DEPLOY_URL}!"
    return 1
  fi
  echo "Good — dev-login is blocked"
  return 0
}

echo "── dev-login is NOT accessible"
check_dev_login || fail=1

# ── scores serve stale-first from D1 with ETag/304 (production only) ──────────
# The competition worker is routed on the apex domain (not the pages.dev
# preview) and is only freshly deployed by the master job, so this runs against
# --scores-api and is skipped for branch previews. The sample comp is always
# seeded in prod; if the list is ever empty, warn and skip rather than failing
# the deploy over missing sample data.
check_scores() {
  local api="$1" comp_id headers xcache etag code
  comp_id=$(curl -s "${api}/api/comp" | jq -r '.comps[0].comp_id // empty')
  if [ -z "$comp_id" ]; then
    echo "::warning::No public comps found — skipping score smoke test"
    return 0
  fi
  echo "Checking comp ${comp_id} scores"
  # Worker deploys propagate over a minute or two — a request landing on a
  # not-yet-updated instance serves the previous version's headers (this bit the
  # first stale-first deploy: an old instance answered X-Cache: HIT with no
  # ETag). Retry until the new signature (X-Cache AND ETag) appears, then assert.
  headers=$(mktemp)
  xcache=""; etag=""
  for attempt in 1 2 3 4 5 6; do
    curl -s -o /dev/null -D "$headers" "${api}/api/comp/${comp_id}/scores"
    xcache=$(grep -i '^x-cache:' "$headers" | tr -d '\r' | awk '{print $2}')
    etag=$(grep -i '^etag:' "$headers" | tr -d '\r' | cut -d' ' -f2-)
    echo "attempt ${attempt}: X-Cache: ${xcache:-<missing>}  ETag: ${etag:-<missing>}"
    if [ -n "$xcache" ] && [ -n "$etag" ]; then break; fi
    sleep 10
  done
  case "$xcache" in
    HIT|HIT-STALE|MISS) ;;
    *) echo "::error::/scores X-Cache header missing or unexpected (${xcache:-none})"; return 1 ;;
  esac
  if [ -z "$etag" ]; then
    echo "::error::/scores response has no ETag"; return 1
  fi
  # A conditional re-request of unchanged scores must transfer nothing.
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "If-None-Match: ${etag}" "${api}/api/comp/${comp_id}/scores")
  echo "Conditional GET -> ${code}"
  if [ "$code" != "304" ] && [ "$code" != "200" ]; then
    echo "::error::Conditional GET returned ${code} (expected 304, or 200 if a re-score landed mid-check)"
    return 1
  fi
  echo "Good — scores are stale-first with working conditional requests"
  return 0
}

if [ -n "$SCORES_API" ]; then
  echo "── scores serve stale-first from D1 with ETag/304 (${SCORES_API})"
  check_scores "$SCORES_API" || fail=1
fi

if [ "$fail" = "0" ]; then
  echo "All smoke tests passed for ${EXPECTED_SHA}"
else
  echo "::error::One or more smoke tests failed"
fi
exit "$fail"
