# Whole-repo security review

You are the periodic full-repository security review for GlideComp. The built-in `/security-review` skill only looks at pending changes on the current branch — this routine looks at the **whole repo** and is paired with a living memory of findings across rounds: `docs/security-review.md` (the index — findings register, standing scope gaps, review log) plus one archived file per round under `docs/security-review/rounds/`.

Land a PR that (a) adds a new round file under `docs/security-review/rounds/`, (b) updates the index's register, gap list, review log and "Where to start" section, and (c) fixes any **Critical** issues inline so the round closes them.

## 1. Read the memory first

Read `docs/security-review.md` (the index) in full, then the most recent
round file in `docs/security-review/rounds/` in full, before touching
anything else. Both are deliberately small enough to read whole. Only open
older round files when a register row or the latest round sends you there.
From the index take:

- The **Review Log** — the date of the last round and what was in scope.
- The **findings register** — every `SEC-NN` and its current status (`Open` / `Fixed` / `Accepted` / `Closed`). This table, not any round file, is the source of truth for status.
- The **standing scope gaps** (`G-NN`) — the "we said we'd check this next time" items. Prioritise them.
- The **Where to start the next review** section.

Do not re-derive what's already known. The point of the log is that each round builds on the last.

## 2. Plan the scope

Before reading code, write down (in your head or as TaskCreate items) what you intend to cover:

- Every worker under `web/workers/*/src/` (auth-api, competition-api, airscore-api).
- Pages Functions under `functions/api/`.
- Frontend under `web/frontend/src/` — the main UI is a React SPA under `src/react/` (grep it for `dangerouslySetInnerHTML`, ref-based DOM HTML writes, and unencoded interpolation into `href`/`src`/`location.*`); the vanilla analysis page (`src/analysis/**`) and 3D replay (`src/replay/**`) are where `innerHTML`-style sinks still live. Across both: data flow from untrusted files (IGC, XCTask, share-target uploads) and API strings (pilot/team/comp/task names) into the DOM.
- Engine package under `web/engine/src/` — parsers (`igc-parser.ts`, `xctsk-parser.ts`) and any `eval`/`Function`-style constructs.
- Infrastructure: every `wrangler.toml` (especially `[[routes]]` blocks and binding IDs), `Containerfile`, `web/frontend/public/_redirects`, `web/frontend/public/_headers` (if present), `web/frontend/public/sw.js`.
- `package.json` + `bun.lock` via `bun audit`.

Carry forward the prior round's scope gaps — if the last round flagged "wrangler.toml binding cross-environment audit" or a similar deferred item, do it this round unless you have a reason not to.

## 3. Diff against the previous review

Find the commit referenced in the last round (or the date if no commit is named) and run:

```
git log --oneline <prev-sha>..HEAD
git diff <prev-sha>..HEAD -- '**/wrangler.toml' '**/src/**/*.ts' '**/functions/**'
```

Every new mutating endpoint added since the last round must be checked for: (a) authn middleware, (b) authz middleware, (c) `audit()` call per CLAUDE.md policy, (d) Zod validator with bounded fields. Any new `[[routes]]` block or binding is a new public surface.

**`.github/workflows/` may not be in the working tree.** Some sandboxed review sessions check out the repo without `.github/workflows/` present on disk, so `git diff <rev1> <rev2> -- .github/workflows/deploy.yml` (or any pathspec under it) silently returns *empty* instead of erroring — it looks identical to "no CI change happened" even when one did. `git show <rev>:<path> | wc -l` still works (reads from the object database, not the working tree), so if `--stat` (no pathspec) shows a change under `.github/` but a pathspec'd `git diff` shows nothing, diff the two blobs directly: `diff <(git show <rev1>:.github/workflows/deploy.yml) <(git show <rev2>:.github/workflows/deploy.yml)`.

## 4. Re-walk every prior finding

For each prior `SEC-NN`, open the file/lines cited and verify the current state. Three outcomes:

- **Fixed** — confirm the fix is still in place; if so, mark it Fixed in the new round's status table and stop re-checking it next round only if it's a structural fix (an allowlist, a deleted code path). One-line patches should keep being re-checked.
- **Open** — restate it in the new round's status table, with a fresh line/file reference if the code moved.
- **Regressed** — the fix was reverted or worked-around. Treat as a fresh High-or-above finding and call it out in the executive summary.

## 5. Look for new issues

Run static analysis with the full set of categories in mind. The list below is non-exhaustive — use your judgement, but at minimum cover:

- **Authn / authz**: every mutating route guarded by `requireAuth` + (where appropriate) `requireCompAdmin` / `authorizeStatusMutation`. No header- or cookie-based "trust me, I am user X" backdoors. Pay particular attention to any worker bound to a public `[[routes]]` pattern — if it trusts an internal-only header, that's a SEC-10-class bypass.
- **CORS**: no reflective `Access-Control-Allow-Origin` paired with `credentials: true`. Allowlist matches the actual production + preview hostnames.
- **Input validation**: Zod schemas on every body, with bounded string/array/JSON sizes. No `z.record(z.unknown())` on stored fields.
- **SQL**: every query parameterised via `.bind(...)`. No string concatenation into SQL.
- **File uploads**: size cap on compressed *and* decompressed payload, content-type / magic-byte check, per-route cap not just the global Workers ceiling.
- **DOM sinks**: `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, and in the React tree `dangerouslySetInnerHTML` — every interpolation must be escaped or come from a trusted constant. In JSX, also check URL-valued attributes (`href`/`src`) built from untrusted data: JSX blocks quote-breakout but not `javascript:` schemes or unencoded params.
- **Secrets**: no hard-coded keys in source or `wrangler.toml` (only env refs). API-key prefixes preserved (`glc_`).
- **Headers**: `_headers` file on Pages with CSP, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`. HSTS at the zone level (note for operator).
- **Audit logging**: every mutating handler calls `audit()` with `describeChange()`-style descriptions. No secrets or full emails in audit payloads.
- **Service bindings**: internal-only headers must be unreachable from public routes. Check every worker's `wrangler.toml` for `[[routes]]` against the trust model.
- **Dependencies**: run `bun audit` and record the result. If it flags something, fix in this PR.

## 6. Fix Critical issues in this PR

Any new finding rated **Critical** (exploitable now, user data or auth at risk) must be fixed inline as part of this PR. Add a regression test where the test surface allows it (e.g. miniflare-level test for an authn bypass; helper-level test for a parser cap). Do not defer Critical fixes to a follow-up PR.

For **High** findings, fix them in this PR if the diff is small and obvious; otherwise file a tracked follow-up and call out the deferral in the executive summary.

For **Medium / Low / Info**, document them and let the next round close them — do not let scope creep block the review PR from landing.

If you do fix a finding inline, mark it in the doc as `~~Open~~ **Fixed (<date>, this PR)**` with a short resolution note pointing at the new file/lines, exactly as the prior rounds did for SEC-01, SEC-10, SEC-11, SEC-12, SEC-14.

## 7. Write the round file and update the index

Create `docs/security-review/rounds/<YYYY-MM-DD>.md` (never rewrite an earlier round file — they are history). Start it with the same two-line archived-round preamble the existing files carry, then:

- **Methodology** — what you read, what you ran (`bun audit`, diffs), and what you explicitly did *not* do.
- **Executive summary** — one paragraph. Lead with the worst new finding. If `bun audit` was clean, say so. If you fixed Critical issues inline, say so.
- **New findings** — one section per `SEC-NN`, severity-tagged, with Files / Evidence / Impact / Remediation. Number continuing from the register's highest.
- **Status changes** — only the prior findings whose status this round moved (with file:line if the finding's code moved). Do NOT restate the full register.
- **Re-checked but no change** — short list of categories you walked and found clean, so the next round knows you covered them.

Then update `docs/security-review.md` (the index) in the same PR:

- Add one **Review Log** line (short headline + link to the round file).
- Update the **findings register** rows whose status moved; add rows for new findings.
- Update the **standing scope gaps**: strike closed gaps with the closing round (keep the `G-NN` id — never renumber or reuse), append new gaps at the next free id.
- Replace the **Where to start the next review** section wholesale: the commit you reviewed up to, the prioritised open items, anything that needs verification on a live deploy.

Convert any relative dates ("today", "last week") to absolute dates before writing.

## 8. Verify locally

```
bun run typecheck:all
bun run test:all
bun audit
```

If you wrote regression tests for an inline fix, run them too. Don't push with red tests.

## 9. Open the PR

Title: `Security review (<YYYY-MM-DD>): <one-line headline>` — the headline is the worst finding (e.g. `SEC-NN critical authn bypass + N new findings`).

Body: short summary of the round, the new SEC-NN IDs introduced, which were fixed inline, and a link to the new round file under `docs/security-review/rounds/`.

If any Critical was fixed inline, the PR description must spell out (a) what the bypass was, (b) how the fix closes it, (c) the regression test that proves it stays closed.

---

This routine itself lives at `.claude/commands/security-review-repo.md`. If you discover a missing step or stale instruction while running, edit this file in the same PR.
