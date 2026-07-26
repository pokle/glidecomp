#!/usr/bin/env bash
# Print the Cloudflare Pages branch-alias preview URL for a branch.
#
#   bash web/scripts/preview-url.sh                 # current branch
#   bash web/scripts/preview-url.sh some/branch     # a named branch
#   bash web/scripts/preview-url.sh --check         # ...and probe that it resolves
#
# Only the URL goes to stdout, so it can be substituted straight into a PR
# body: PREVIEW=$(bun run --silent preview-url)
#
# WHY THIS EXISTS: the slug is the branch name lowercased, with every
# non-alphanumeric replaced by '-', truncated to 28 characters. Derived by
# hand that is easy to get wrong, because the cut usually lands mid-token and
# the result ends in a character that reads like a typo you should trim —
# `claude/glidecomp-issue-454-0midgz` becomes `claude-glidecomp-issue-454-0`,
# whose trailing "0" looks droppable and is not. A wrong preview URL is a
# 404 published in a PR body, so compute it, never eyeball it.

set -euo pipefail

ZONE="glidecomp.pages.dev"
SLUG_MAX=28

check=0
branch=""
for arg in "$@"; do
  case "$arg" in
    --check) check=1 ;;
    -*) echo "unknown flag: $arg" >&2; exit 2 ;;
    *) branch="$arg" ;;
  esac
done

if [ -z "$branch" ]; then
  branch=$(git rev-parse --abbrev-ref HEAD)
  if [ "$branch" = "HEAD" ]; then
    echo "detached HEAD — pass a branch name explicitly" >&2
    exit 1
  fi
fi

# Lowercase → non-alphanumerics to '-' → first SLUG_MAX chars. printf '%s'
# (not echo) so no trailing newline reaches tr and becomes a '-'.
#
# Deliberately NOT trimming a trailing '-' when the cut lands on a separator:
# what Cloudflare does in that case is unverified here, and inventing a rule
# is how the hand-derived URLs went wrong in the first place. If you hit a
# branch whose slug ends in '-', check the real alias and record it here.
slug=$(printf '%s' "$branch" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9' '-' | cut -c "1-$SLUG_MAX")
url="https://${slug}.${ZONE}"

# The alias only exists once the branch has been pushed and built.
if ! git rev-parse --verify --quiet "refs/remotes/origin/${branch}" >/dev/null; then
  echo "warning: origin/${branch} not found — push before sharing this URL" >&2
fi

echo "$url"

if [ "$check" -eq 1 ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -L --max-time 20 "$url" || echo 000)
  case "$code" in
    2*) echo "check: $code OK" >&2 ;;
    000) echo "check: no response (network blocked, or the deploy is still building)" >&2 ;;
    *) echo "check: HTTP $code — alias not live yet, or the slug is wrong" >&2 ;;
  esac
fi
