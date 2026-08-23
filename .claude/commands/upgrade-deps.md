# Weekly dependency upgrade

You are the weekly dependency-upgrade routine for the GlideComp project. Your job is to land a clean, green PR that bumps deps and fixes any vulnerabilities — and to leave breadcrumbs for the next run.

## 1. Read the log first

Read `docs/dependency-review-log.md`. At minimum, read the most recent two entries and every "Lessons / Notes for Future Sessions" section. The lessons accumulate value only if you actually use them — apply them before deciding anything below.

## 2. Audit dependencies

- Run `bun audit`.
- Check for upgrades. For each candidate upgrade, read its changelog.
- For each upgrade, note:
  - **Code changes required** → make them in this PR.
  - **Runtime requirement changes** (Node version, Bun version, OS) → if the new floor is above what `.github/workflows/*.yml` actually installs, raise the CI version *in the same PR*. Grep workflows for `setup-node` / `setup-bun`. **`engines.node` in package.json is advisory only — bun does not enforce it, so CI must explicitly install the right Node version.** This is the specific hole that broke CI for ~5 days in May 2026.
  - **Major-version bumps of pre-1.0 packages** → keep them pinned exact (no caret), per existing convention. Example in the log: `agents`.
  - **Workspace consistency** → if you bump a package at the root, check whether sub-packages in `web/workers/*` and `web/frontend` need the same bump.
  - **A version range covering a patch does not guarantee `bun install` will move to it.** Check `bun.lock` after installing, not just the `package.json` range. If a package a workspace already allows (e.g. `^7.9.5`) is still locked to an older patch that `bun audit` flags, force it — **never a bare `bun update <pkg>` from the repo root**, which can silently add that package as a *new direct dependency of the root `package.json`* if bun decides to resolve it there. **`bun update --filter '<workspace-name>' <pkg...>` run from the repo root is not a reliable fix either** — the 2026-08-23 cycle saw it leave the target workspace's `package.json` untouched and instead add several packages as stray new root dependencies, the exact failure `--filter` is supposed to prevent. What worked: `cd web/<workspace-dir> && bun update <pkg...>` (no `--filter`, run from inside the workspace directory itself). Whichever form you use, `git diff package.json` (root) afterwards to catch a stray addition before it lands in a commit — if one shows up, revert it by hand and re-run `bun install` to confirm the workspace-scoped version still holds.
  - **`bun audit` flagging a package your `package.json` already pins to a safe version doesn't mean the audit is stale.** A transitive dependency can resolve a *second, separately-versioned nested copy* that bypasses your direct pin entirely — check `bun.lock` for a second key (e.g. `astro/sharp` alongside plain `sharp`) before assuming it's a false positive. The fix is usually a root-level `overrides` entry to unify the resolution, not a version bump.
  - **The audit's vulnerability count is not stable between cycles even with no lockfile changes** — new advisories get published and indexed against versions you already have installed. Always run `bun audit` fresh rather than trusting last cycle's logged count as this cycle's starting point.

## 3. Verify locally — before pushing

All four must pass locally:

```
bun run typecheck:all
bun run test:all
bun run test:e2e
bun audit
```

`bun run test:e2e` is mandatory and easy to skip — it's the only thing that exercises `wrangler dev` startup, and it's what would have caught the May 2026 outage. If e2e fails locally, fix the root cause; do not push and "see if CI catches it."

**A Playwright bump does not need a manual browser install, and this is not a lesson worth relearning.** Four cycles in a row logged `Executable doesn't exist at …chromium_headless_shell-<rev>…` as a fresh discovery and hand-ran `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 bunx playwright install chromium chromium-headless-shell`, because Playwright pins the browser revision to the library version and the containers pre-bake a stale one. `bun run test:e2e` now installs the pinned build itself (`web/scripts/ensure-playwright-browsers.sh`). Record a Playwright bump's *revision change* if you like — it explains a slow first run — but don't re-derive the workaround, and don't reach for `--with-deps` (it wants root/apt; the OS packages are already validated in these images).

## 4. Push, then watch CI to green

After pushing, wait for the Deploy run to complete. On Claude Code on the web there is **no `gh` CLI** — watch CI with the GitHub MCP tools instead: `mcp__github__actions_list` (find the latest `deploy.yml` run for your branch/head SHA), then poll `mcp__github__actions_get` until it concludes, and `mcp__github__get_job_logs` (with `failed_only`) to read failures. Do **not** poll with Bash `sleep`; if you need to wait between checks, end the turn and use the `send_later` MCP tool to resume. (On a local terminal with `gh` available, `gh run watch <run-id> --exit-status` is the equivalent.)

If CI fails:

- **Read the actual error.** If output is silent (e.g. `bun run --filter` swallowed the inner stderr — the failure mode looks like `error: script "X" exited with code 1` with nothing else), reproduce the inner command directly. The `Probe auth-api startup` step in `.github/workflows/deploy.yml` is the canonical pattern: run wrangler directly from the workspace dir, bypassing `bun run --filter`, so real stderr appears. Add a similar probe if you're diagnosing a different worker.
- **Diagnose the root cause.** Don't retry blindly, don't disable tests, don't skip `--frozen-lockfile`.
- **Don't mark the PR ready while CI is red.**

## 5. Update the log

Add a new dated entry to `docs/dependency-review-log.md` with these sections:

- **Security Vulnerabilities Fixed** — table of CVE/GHSA, severity, what was patched.
- **Dependency Upgrades** — table of From/To/workspaces/notes.
- **Code Changes Required** — what you had to change and why.
- **Packages Not Upgraded (intentional)** — version comparison + reason for skipping.
- **Verification** — list every check you ran (mention e2e explicitly).
- **Lessons / Notes for Future Sessions** — record both successes *and* failures. If something tripped you up, the next routine should not have to learn it again.

Convert any relative dates ("today", "this week") to absolute dates.

## 6. Open the PR

Use a clear title and a body that links to the new log entry.

---

This routine itself lives at `.claude/commands/upgrade-deps.md`. If you discover a missing step or stale instruction while running, edit this file in the same PR.
