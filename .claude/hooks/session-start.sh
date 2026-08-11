#!/bin/bash
# SessionStart hook — install workspace dependencies before the session begins.
#
# Claude Code on the web clones the repo fresh into a new container, so
# `node_modules/` is absent every time. Without this, the first command a
# session runs fails on unresolved imports — and `bun test` in particular
# reports those as ordinary test failures (51 of them, in one recorded case),
# which reads as a broken tree rather than a missing install.
#
# CLAUDE.md has told readers to run `bun install` for a long time; four
# sessions logged in docs/security-review.md hit the empty clone anyway.
# Prose is advisory, so this makes it mechanical.
#
# `bun install` (not `--frozen-lockfile`) because the container caches its
# state after the hook completes, and a plain install reuses that cache best.
# It is idempotent and non-interactive; ~0.5s once warm, ~10s cold.
set -euo pipefail

# Local sessions have their own node_modules and their own opinions about when
# to touch it. Only the fresh-clone remote containers need this.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

echo "SessionStart: installing workspace dependencies with bun…"
bun install
echo "SessionStart: dependencies ready."
