#!/usr/bin/env bash
# Start every Cloudflare Worker for local dev in ONE wrangler session.
#
# Why one session and not three (issue #477): auth-api and competition-api share
# a single D1 SQLite file via `--persist-to web/.wrangler/state`. Run as separate
# `wrangler dev` processes, they are two Miniflare *processes* writing that file
# concurrently, which intermittently surfaces as
# `D1_ERROR: Failed to parse body as JSON, got: Error: internal error`
# — and can take the whole `wrangler dev` process down with it, cascading a CI
# run into a dozen unrelated-looking failures.
#
# `wrangler dev -c … -c …` puts all of them in one Miniflare instance, so the
# database has a single writer. The catch is that only the PRIMARY config's port
# is exposed, so the primary is `dev-router` — a dev-only Worker that dispatches
# `/api/*` to its siblings over service bindings, exactly as the Pages Functions
# in `functions/api/` do in production. Everything therefore talks to ONE port:
#
#   http://localhost:8790   (DEV_API_PORT to override)
#
# Args are forwarded to wrangler, so the docker container can add
# `--ip 0.0.0.0`.
#
# ── Why this script supervises wrangler instead of exec'ing it ──
#
# `wrangler dev` kills ITSELF over a lost client connection. When a request to a
# Worker is severed mid-flight, wrangler's ProxyWorker reports
# `Error: Network connection lost.` to its ProxyController, and the
# ProxyController treats every error from the ProxyWorker as fatal: the whole
# dev session exits 1 (`DevEnv.handleErrorEvent` excuses only two other reasons,
# and wrangler 4.118.0 still behaves this way). Nothing restarts it, so from
# that moment the port is simply dead.
#
# In CI that lost a whole E2E run about one time in eight — a random test would
# fail, then every test after it, because they were all talking to a closed
# port. The e2e reporter (e2e/reporters/stack-health.ts) recognises the shape and
# says so, but recognising it does not get the run back.
#
# So: run wrangler under a restart loop. A crash now costs the seconds it takes
# to come back rather than the rest of the run, and the e2e suite waits out the
# gap (the stack-up fixture in e2e/fixtures/test.ts) instead of asserting against
# a dead port. The restart is announced loudly on stderr — this is a workaround
# for somebody else's bug, and it must never look like normal operation.
#
# Three things it deliberately does NOT do:
#   * restart a session that never served the port at all — that is a config or
#     compile error, and looping on it would hide the message that explains it;
#   * restart into ports something else still holds — that only prints "Address
#     already in use" once per attempt and buries the real story;
#   * restart forever — DEV_WORKERS_MAX_RESTARTS is the ceiling, so a genuinely
#     sick stack still fails the run rather than spinning.

set -euo pipefail
cd "$(dirname "$0")/../.."

PORT="${DEV_API_PORT:-8790}"
# wrangler also binds a devtools inspector port (9229 by default). Two
# worktrees running side by side collide on it just as they do on PORT, and
# the error names the inspector rather than the thing you set — so it gets its
# own override.
INSPECTOR_PORT="${DEV_INSPECTOR_PORT:-9229}"
# Ten, not two or three: on a slow machine the crash below has fired several
# times in one suite, and each one costs about eight seconds and one retried
# test. A ceiling this high is still a ceiling, and the two guards further down
# — never served, ports still held — are what catch a stack that is actually
# broken rather than unlucky.
MAX_RESTARTS="${DEV_WORKERS_MAX_RESTARTS:-10}"

# The Workers own the D1 schema; apply migrations before anything can serve a
# request against a missing table. Outside the restart loop: the schema does not
# change between attempts, and a second migrator process on the same SQLite file
# is exactly the contention this stack was rearranged to avoid.
bun run db:migrate

state_dir="$(mktemp -d)"
served_flag="$state_dir/served"
trap 'rm -rf "$state_dir"' EXIT

# NOTE: deliberately no `set -m` here. Job control would put wrangler in its own
# process group, which reads as an improvement — you could then reap the whole
# tree with one signal — and is a trap: whoever supervises THIS script kills by
# process group too. Playwright's `webServer` teardown SIGKILLs the group, so a
# wrangler outside it survives its supervisor, holds the stdio pipe it inherited,
# and Playwright waits on that pipe forever. Runs hung after every restart. One
# process group, and a kill aimed at this script reaches wrangler as well.
wrangler_pid=""
watcher_pid=""

# Stop a process and everything under it — children first, so nothing is
# re-parented to init while its parent is still being asked to leave. Only
# reaches a LIVE tree, which is all the shutdown path needs; an already-dead
# wrangler's leftovers are caught by the port checks instead. Best-effort
# throughout: the ports are the proof, not the signals.
stop_tree() {
  local pid="$1" child
  [ -n "$pid" ] || return 0
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    stop_tree "$child"
  done
  kill -TERM "$pid" 2>/dev/null || true
  return 0
}

# Is anything listening on this port right now? bash's own /dev/tcp, so the
# container image needs no curl.
#
# In a CHILD bash, not `( exec 3<> … )`, because bash may run a one-command
# subshell without forking — and then a refused connection is a failed `exec`
# in THIS shell, which exits it. That silently killed the supervisor at the
# first probe of a port that was not up yet, i.e. every single time.
listening() {
  bash -c "exec 3<>/dev/tcp/127.0.0.1/$1" 2>/dev/null
}

# Wait for a port to go quiet, so the next attempt can bind it. Returns 1 if it
# never does — restarting into a held port only produces "Address already in
# use" once per attempt until the budget runs out, which buries the real story.
wait_port_free() {
  local port="$1" i
  for ((i = 0; i < 40; i++)); do
    listening "$port" || return 0
    sleep 0.25
  done
  return 1
}

# Ctrl-C, or Playwright tearing its webServer down: pass it on and go quietly.
# Without this the loop would treat the signalled exit as a crash and restart
# the very session that was just asked to stop.
shutdown() {
  trap - INT TERM
  [ -n "$watcher_pid" ] && kill "$watcher_pid" 2>/dev/null || true
  stop_tree "$wrangler_pid"
  exit 0
}
trap shutdown INT TERM

# "Did this attempt ever serve?" — a successful connect means wrangler bound the
# port, which is the only thing separating a mid-run crash from a failure to
# start.
watch_for_listening() {
  local i
  for ((i = 0; i < 120; i++)); do
    if listening "$PORT"; then
      touch "$served_flag"
      return 0
    fi
    sleep 1
  done
}

restarts=0
while true; do
  rm -f "$served_flag"

  bunx wrangler dev \
    --config web/workers/dev-router/wrangler.toml \
    --config web/workers/auth-api/wrangler.toml \
    --config web/workers/competition-api/wrangler.toml \
    --config web/workers/airscore-api/wrangler.toml \
    --persist-to web/.wrangler/state \
    --port "$PORT" \
    --inspector-port "$INSPECTOR_PORT" \
    "$@" &
  wrangler_pid=$!

  watch_for_listening &
  watcher_pid=$!

  status=0
  wait "$wrangler_pid" || status=$?
  kill "$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true
  watcher_pid=""

  stop_tree "$wrangler_pid"
  wrangler_pid=""

  # wrangler's `q` shortcut, in a session a person is actually sitting at.
  # A quit is the one exit that must NOT be restarted — and a TTY on stdin is
  # what tells the two apart, because the exit code cannot: `bunx` reports 0
  # for some deaths of the wrangler process underneath it, so "exited 0" alone
  # would let a real crash pass for a deliberate stop. Under Playwright,
  # `concurrently` or CI there is no TTY and no `q`, so every exit that reaches
  # here is a crash. (A signalled stop never reaches here at all — the INT/TERM
  # trap exits first.)
  #
  # Written as an `if`, not `[ … ] && exit 0`: under `set -e` a trailing test
  # that comes out false IS the script's exit status, so the shorthand would
  # kill the supervisor on exactly the crash it exists to survive.
  if [ "$status" -eq 0 ] && [ -t 0 ]; then
    exit 0
  fi

  # Whatever wrangler reported, reaching here means the stack is gone and we are
  # not restarting it — so never hand back a 0 that would read as success.
  fail_status=$status
  if [ "$fail_status" -eq 0 ]; then
    fail_status=1
  fi

  if [ ! -f "$served_flag" ]; then
    echo "dev-workers: wrangler dev exited ($status) without ever serving :$PORT." >&2
    echo "dev-workers: that is a startup failure, not a mid-run crash — read the error above." >&2
    exit "$fail_status"
  fi

  restarts=$((restarts + 1))
  if [ "$restarts" -gt "$MAX_RESTARTS" ]; then
    echo "dev-workers: wrangler dev has now died $restarts times (limit $MAX_RESTARTS). Giving up." >&2
    exit "$fail_status"
  fi

  # A crash wrangler shut down cleanly frees both ports within a moment. One
  # that is still held means something outlived it — another worktree's session,
  # or a `workerd` orphaned by a hard kill — and restarting into that would only
  # spell "Address already in use" five times over.
  if ! wait_port_free "$PORT" || ! wait_port_free "$INSPECTOR_PORT"; then
    echo "dev-workers: wrangler dev died (exit $status), but :$PORT or :$INSPECTOR_PORT is still held." >&2
    echo "dev-workers: something outlived it — \`bun run kill-dev\` clears leftovers, and" >&2
    echo "dev-workers: DEV_API_PORT / DEV_INSPECTOR_PORT move this session out of another's way." >&2
    exit "$fail_status"
  fi

  echo "" >&2
  echo "────────────────────────────────────────────────────────────────────────" >&2
  echo "dev-workers: wrangler dev died (exit $status) — restarting it ($restarts/$MAX_RESTARTS)." >&2
  echo "dev-workers: usually 'Error: Network connection lost.' reported by the" >&2
  echo "dev-workers: ProxyWorker, which wrangler treats as fatal. The Workers are" >&2
  echo "dev-workers: coming back on :$PORT; D1 and R2 state on disk is untouched." >&2
  echo "────────────────────────────────────────────────────────────────────────" >&2
  echo "" >&2
done
