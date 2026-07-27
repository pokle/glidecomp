#!/bin/sh
# Starts every Cloudflare Worker in the docker-compose `workers` container.
#
# One wrangler session for all of them (dev-workers.sh explains why: issue #477
# — separate Miniflare processes on one shared D1 file race each other). Service
# bindings resolve inside that session, so nothing depends on the localhost dev
# registry spanning containers either. Only the dev-router's port is exposed;
# the frontend container reaches it via DEV_API_ORIGIN.
set -e

bun install

# dev-workers.sh applies the D1 migrations before starting wrangler.
exec bash web/scripts/dev-workers.sh --ip 0.0.0.0
