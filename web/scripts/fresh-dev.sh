#!/usr/bin/env bash

set -ex

bun run kill-state
bun run seed:sample
bun run dev
