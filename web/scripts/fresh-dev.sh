#!/usr/bin/env bash

set -ex

bun run kill-state
bun run seed
# The CIVL world rankings are imported daily into PRODUCTION by a GitHub
# Actions cron, so a wiped local database has none — and the roster editor
# then correctly offers nothing to fill from. Seeds the bundled August 2026
# snapshot of all ten lists (web/samples/civl-rankings/).
bun run seed-civl-rankings
bun run dev
