#!/usr/bin/env bash
# Install the Chromium build that the PINNED Playwright asks for, if it is
# absent. Run from `test:e2e` and `test:e2e:ssr` before Playwright starts.
#
# Playwright couples the browser revision to the library version in
# `playwright-core/browsers.json` — 1.62.1 wants chromium revision 1234
# (Chrome for Testing 151). An environment that pre-bakes a DIFFERENT revision
# does not satisfy the pin, and the failure is a poor one:
#
#   Executable doesn't exist at .../chromium_headless_shell-1234/...
#
# It arrives AFTER playwright.config.ts has spent up to two minutes booting
# `dev:workers` and vite, so it reads as "slow, then broken" rather than
# "browser missing" — and it names the headless shell, not chromium, because
# both configs run `headless: true`. Claude Code's web containers are exactly
# this case: `/opt/pw-browsers` carries revision 1194 (Chromium 141).
#
# Relaxing the pin to match such an image is the wrong trade — it would freeze
# the e2e browser ten Chrome majors behind for CI and everyone else, to suit one
# container image. Installing on demand keeps every runner on the browser CI
# tests, which is the point of pinning it.
#
# CI installs the build itself (deploy.yml, cached on bun.lock) and this is a
# ~1s no-op there. The same reasoning as .claude/hooks/session-start.sh applies:
# docs said to run `bunx playwright install chromium` for a long time, and prose
# is advisory — this makes it mechanical.
set -euo pipefail

# Honoured by Playwright's own postinstall, and by images that ship browsers
# out-of-band and do not want a download attempted. Leave those alone.
if [ -n "${PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD:-}" ]; then
  exit 0
fi

# Probe with `--dry-run` rather than by building paths ourselves: its output
# names the locations Playwright ALREADY resolved, so this never has to know
# where PLAYWRIGHT_BROWSERS_PATH points, what the per-OS default is, or how a
# revision directory is spelled. ~0.9s, against ~3.4s for an unconditional
# `playwright install` that turns out to have nothing to do.
missing=0
found=0
while IFS= read -r dir; do
  found=1
  [ -d "$dir" ] || missing=1
done < <(bunx playwright install chromium --dry-run 2>/dev/null |
  sed -n 's/^ *Install location: *//p' | sed 's/ *$//')

# Parsed nothing — Playwright is missing, or its output changed shape. Say so
# and step aside rather than triggering a 300 MB download on a bad parse;
# Playwright's own error is then the one the developer sees.
if [ "$found" -eq 0 ]; then
  echo "ensure-playwright-browsers: could not read Playwright's install locations; skipping." >&2
  exit 0
fi

if [ "$missing" -eq 0 ]; then
  exit 0
fi

# Announced, because the alternative is an unexplained multi-minute pause
# before the suite appears to start.
echo "Playwright's pinned Chromium build is missing — downloading it (~300 MB, about a minute)."
bunx playwright install chromium
