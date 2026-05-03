#!/usr/bin/env bash
# Kill leftover dev processes from `bun run dev` (vite + wrangler workers).
# Targets the known dev ports and any matching bun/wrangler/workerd/vite processes.

set -u

PORTS=(3000 8787 8788 8789 8790)
PATTERNS=(
  "bun run dev"
  "bun run --filter"
  "wrangler dev"
  "workerd"
  "vite"
)

killed_any=0

kill_pids() {
  local label="$1"
  shift
  local pids=("$@")
  [ ${#pids[@]} -eq 0 ] && return
  echo "Killing $label: ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true
  sleep 1
  # Force-kill any survivors.
  local survivors=()
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      survivors+=("$pid")
    fi
  done
  if [ ${#survivors[@]} -gt 0 ]; then
    echo "Force-killing $label: ${survivors[*]}"
    kill -9 "${survivors[@]}" 2>/dev/null || true
  fi
  killed_any=1
}

# 1) Anything bound to known dev ports.
for port in "${PORTS[@]}"; do
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    # shellcheck disable=SC2206
    pid_array=($pids)
    kill_pids "port $port" "${pid_array[@]}"
  fi
done

# 2) Matching dev process patterns (skip our own pid + parents).
self_pid=$$
parent_pid=$PPID
for pattern in "${PATTERNS[@]}"; do
  pids=$(pgrep -f "$pattern" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    filtered=()
    for pid in $pids; do
      if [ "$pid" != "$self_pid" ] && [ "$pid" != "$parent_pid" ]; then
        filtered+=("$pid")
      fi
    done
    if [ ${#filtered[@]} -gt 0 ]; then
      kill_pids "pattern '$pattern'" "${filtered[@]}"
    fi
  fi
done

if [ $killed_any -eq 0 ]; then
  echo "No leftover dev processes found."
else
  echo "Done."
fi
