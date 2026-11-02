#!/usr/bin/env bash
# The e2e suite's frontend webServer (playwright.config.ts): build web/frontend
# for production, then serve dist/ with the dev server's routing
# (web/scripts/e2e-serve-dist.ts says why, with the measurements).
#
# Two builds, run side by side because neither reads the other's output:
#   * `vite build --mode e2e` — the SPA, analysis and replay entries into dist/.
#     The `e2e` mode is the production build plus one thing, the kit form's
#     test bench at /__kit/form (src/react/routes.tsx), which e2e/forms.spec.ts
#     drives. A deploy builds in the default `production` mode, which has no
#     bench.
#   * `astro build` — the prerendered content pages into static/dist/, copied
#     into dist/ once both are done (vite empties dist/ when it starts). Cold,
#     its image step dominates (~16 s re-encoding 51 images to AVIF/WebP); CI
#     restores Astro's image cache so it is ~2 s.
#
# No SSR bundle: this suite never server-renders (playwright.ssr.config.ts does).
#
# VITE_MAPBOX_TOKEN comes from playwright.config.ts, which supplies a fake one
# when the environment has none — see the note there.
set -euo pipefail
cd "$(dirname "$0")/../.."

bun run engine:fingerprint --quiet

cd web/frontend
bunx vite build --mode e2e --logLevel warn &
vite_pid=$!
bunx astro build --root static --silent
wait "$vite_pid"
cp -R static/dist/. dist/

exec bun ../scripts/e2e-serve-dist.ts
