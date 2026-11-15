#!/usr/bin/env bash
# What was wrangler doing when it died? Prints, for each death in the session
# log web/scripts/dev-workers.sh keeps, the lines leading up to it.
#
# CI runs this after every e2e run, green ones included
# (.github/workflows/deploy.yml). A crash usually costs one retried test and a
# green run now, so a green run is exactly where the evidence turns up — and
# unread evidence is how CI run 43686074965 came to lose wrangler twice without
# saying which request either crash was serving.
#
# Run it locally after a run the same way:
#
#   bash web/scripts/wrangler-crashes.sh        # 60 lines before each death
#   bash web/scripts/wrangler-crashes.sh 200    # more
#
# How to read it: the dev-router writes `[dev-router] → POST /api/…` when a
# request ARRIVES, and wrangler writes `[wrangler:info] POST /api/… 201 …` when
# it ANSWERS. A request with the first and not the second before the
# `dev-workers: wrangler dev died` banner was in flight when wrangler died.
# Line times are UTC, to line up with the CI log.
set -euo pipefail
cd "$(dirname "$0")/../.."

log="${DEV_WORKERS_LOG:-web/.wrangler/dev-workers.log}"
context="${1:-60}"
# The first line of each of dev-workers.sh's death banners: restarting, giving
# up, ports still held, and never served at all.
DEATH='dev-workers: wrangler dev (died|has now died|exited)'

if [ ! -s "$log" ]; then
  echo "wrangler-crashes: no session log at $log (dev-workers.sh did not run, or ran at a terminal)."
  exit 0
fi

deaths=$(grep -cE "$DEATH" "$log" || true)
if [ "$deaths" -eq 0 ]; then
  echo "wrangler-crashes: wrangler dev did not die in this run."
  exit 0
fi

if [ -n "${GITHUB_ACTIONS:-}" ]; then
  echo "::warning title=wrangler dev died::wrangler dev died $deaths time(s) in this run and was restarted. This step's log shows the requests in flight; the whole session log is in the uploaded report."
fi
echo "wrangler-crashes: wrangler dev died $deaths time(s). The $context lines before each death:"
echo "wrangler-crashes: a '[dev-router] →' line with no '[wrangler:info]' line for it was in flight."
echo
grep -n -B "$context" -E "$DEATH" "$log"
