#!/usr/bin/env bash

set -ex

bun run kill-state
bun run seed
bun run dev
