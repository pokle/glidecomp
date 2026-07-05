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

## 3. Verify locally — before pushing

All four must pass locally:

```
bun run typecheck:all
bun run test:all
bun run test:e2e
bun audit
```

`bun run test:e2e` is mandatory and easy to skip — it's the only thing that exercises `wrangler dev` startup, and it's what would have caught the May 2026 outage. If e2e fails locally, fix the root cause; do not push and "see if CI catches it."

## 4. Push, then watch CI to green

After pushing, wait for the Branch Deploy run to complete:

```
gh run watch <run-id> --exit-status
```

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
