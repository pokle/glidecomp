#!/usr/bin/env bash
# Cloud Agent install: idempotent repository bootstrap for GlideComp.
# Runs after the repo is checked out. Safe to run repeatedly.
set -euo pipefail

# 1. bun — the repo's package manager and script runner (not in the base image).
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"
bun --version

# 2. Dependencies (postinstall regenerates the scoring fingerprint).
bun install

# 3. Auth Worker dev vars — without this every sign-in 404s (file is gitignored).
[ -f web/workers/auth-api/.dev.vars ] || cp web/workers/auth-api/.dev.vars.example web/workers/auth-api/.dev.vars

# 4. Apply local D1 migrations so the schema exists before seeding.
bun run db:migrate

# 5. Seed the bundled sample competitions into local D1 + R2 (best-effort).
#    Uses in-process Miniflare against web/.wrangler/state, so no dev server is
#    required. Non-fatal: a hiccup here must not break environment setup.
bun run seed || echo "warn: seed failed; run 'bun run seed' after the dev stack is up"

# 6. Pre-fetch the pinned Playwright Chromium so e2e is ready (best-effort).
bash web/scripts/ensure-playwright-browsers.sh || echo "warn: playwright browser fetch failed; test:e2e will retry it"

echo "GlideComp install complete."
