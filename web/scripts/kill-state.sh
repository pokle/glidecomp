#!/usr/bin/env bash
# Reset the local dev database/storage state (D1 + R2 + KV) back to empty.
#
# The local workers persist their miniflare state to `.wrangler/state` dirs:
#   - web/.wrangler/state              (shared: auth-api + competition-api D1, R2, KV)
#   - web/workers/airscore-api/.wrangler/state
# Wiping these clears every account, session, competition, uploaded track and
# cached score. Handy when local auth gets wedged (e.g. `account_not_linked`
# from a stale user with no linked OAuth identity) or you just want a clean slate.
#
# Sibling of kill-dev.sh: this resets *data*, kill-dev.sh kills *processes*.

set -euo pipefail

# Resolve the repo root from this script's location (web/scripts/kill-state.sh).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

# A live workerd holds the sqlite files open — resetting under it leaves the
# running worker writing stale state back on exit. Stop dev first (no-op if
# nothing is running).
bun run kill-dev || true

STATE_DIRS=(
  "web/.wrangler/state"
  "web/workers/airscore-api/.wrangler/state"
)

removed_any=0
for dir in "${STATE_DIRS[@]}"; do
  if [ -d "$dir" ]; then
    echo "Removing $dir"
    rm -rf "$dir"
    removed_any=1
  fi
done

if [ $removed_any -eq 0 ]; then
  echo "No local state found — already clean."
fi

# Re-apply migrations so the D1 schema is ready to use (empty tables), matching
# what `bun run dev` would do on its next start.
echo "Re-applying D1 migrations…"
bun run db:migrate

echo "Done. Local database state reset."
echo "Start fresh with: bun run dev   (re-seed sample data with: bun run seed:sample)"
