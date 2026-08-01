# Sync Documentation

Audit all documentation against the current codebase and fix any discrepancies.
"Documentation" means the markdown files **and the explanatory comments in the
source** — this codebase carries a lot of load-bearing prose in file headers and
block comments, and it rots exactly the same way.

## Instructions

### Phase 1: Discover all docs

Find all markdown files in `docs/`, the root directory, and any subdirectories. Read every doc file to understand what they claim.

### Phase 2: Verify docs against code

For each doc, check the following categories of issues:

#### A. Rotted docs (factually wrong about current code)
- **File paths**: Do all referenced source files still exist? Have any been deleted or renamed?
- **File listings**: Do architecture/structure sections list all files that actually exist? Are any missing?
- **Feature descriptions**: Do described features match the current implementation? Check for:
  - UI elements that no longer exist (removed tabs, menu items, toggles)
  - UI elements that exist but aren't documented
  - Changed defaults or behavior (e.g., a feature that was optional is now always-on)
  - Wrong values (intervals, thresholds, colors, sizes) — spot-check key values against code
- **Package names and versions**: Do dependency references match `package.json`?
- **API signatures**: Do documented function signatures match the actual code?

#### B. Missing feature documentation
- Check recent git commits (`git log --oneline -20`) for features that may not be documented
- Check for source files that exist but aren't mentioned in any doc
- Check map provider specs against actual layers, controls, and interactions

#### C. Stale status claims
Open work is tracked in [GitHub issues](https://github.com/pokle/glidecomp/issues),
not in a checked-in TODO file (`docs/TODO.md` was removed as stale). So check:
- Checklists inside plan/spec docs (e.g. the dated `docs/2026-*-plan.md` files):
  are items marked incomplete actually shipped, or vice versa?
- Docs that describe something as "planned", "not yet implemented", or "TODO"
  in prose — is it implemented now?
- Dated review/report docs are point-in-time snapshots: correct forward-looking
  pointers, but don't rewrite their historical narrative.

#### D. Rotted code comments

File-header and block comments in this repo explain *why* — architecture, the
rule a module enforces, what is and isn't server-rendered. They go stale the
same way docs do, and they're worse when wrong: they're read at the moment
someone is about to change the code. Check them too:

- **Paths and names**: comments naming a file, directory or symbol that has
  since moved or been deleted (`src/react/ui/`, `main.tsx`, a renamed helper).
- **Architectural claims**: "deliberately NOT server-rendered", "admin-only",
  "there is no X" — verify against the code that decides it (for SSR, the
  `ROUTES` list in `functions/comp/[[path]].ts`; for visibility, the route's own
  `canView…` helper). A comment asserting a *negative* is the likeliest to have
  been overtaken.
- **Superseded migrations**: comments describing a kit, library or pattern the
  codebase has since moved off.
- **Cross-references**: comments pointing at a doc, issue or section that no
  longer says what the comment claims.

Grep for the claim, not just the file. When a doc fix corrects a fact, grep the
source for the same wrong fact — a stale comment is often where the stale doc
got it from.

### Phase 3: Present findings

Organize all findings into a plan with four sections:
1. **Rotted docs** — factual errors to fix
2. **Missing feature docs** — new features to document
3. **Stale status claims** — "planned"/"not implemented" claims to update
4. **Rotted code comments** — comments contradicted by the code around them

Present the plan to the user and wait for approval before making changes.

### Phase 4: Fix the docs

After user approval:
1. Make all the edits
2. Commit with a descriptive message
3. Push to the remote

## Key files to always check

These are the main doc files and the source files they describe:

| Doc | Key source files to verify against |
|-----|-----------------------------------|
| `docs/mapbox-interactions-spec.md` | `web/frontend/src/analysis/mapbox-provider.ts`, `map-provider-shared.ts` |
| `docs/igc-analysis-tool-spec.md` | `web/frontend/src/analysis/*.ts`, `web/engine/src/*.ts`, `web/frontend/src/analysis.html` |
| `docs/configurable-units-spec.md` | `web/engine/src/units.ts`, `web/frontend/src/analysis/config.ts` |
| `docs/sparkline-spec.md` | `web/frontend/src/analysis/analysis-panel.ts` |
| `docs/optimized-task-line-spec.md` | `web/engine/src/task-optimizer.ts` |
| `docs/browser-storage-spec.md` | `web/frontend/src/analysis/storage.ts`, `storage-menu.ts` |
| `docs/airscore-api-worker-spec.md` | `web/workers/airscore-api/src/**/*.ts` |
| `docs/event-detection/*.md` | `web/engine/src/event-detector.ts`, `circle-detector.ts`, `glide-speed.ts` |
| `CLAUDE.md` | Project structure, build commands |
| `README.md` | `package.json` scripts, project structure |

Comment hotspots — the file headers that carry the most architectural prose, and
so rot the loudest:

| Source file | What its comments claim |
|-------------|-------------------------|
| `web/frontend/src/react/routes.tsx` | Which routes are SSR'd, which are lazy, why |
| `functions/comp/[[path]].ts` | The authoritative `ROUTES` / `NOINDEX_SHELL_ROUTES` lists |
| `web/frontend/src/react/globals.css`, `src/analysis.css` | Which component kit and token layer the app uses |
| `web/workers/competition-api/src/routes/*.ts` | Per-route visibility rules (`canView…`), audit/bump obligations |
| `web/engine/src/thresholds.ts`, `track-quality.ts` | Whether constants are fixed or overridable |

## Important notes

- Use subagents for parallel verification — don't try to read everything sequentially
- Spot-check numeric values (colors, sizes, intervals) rather than trusting docs at face value
- When documenting new features, keep the style consistent with existing docs
- Don't add documentation for future/planned features — only document what's implemented
- **Comment fixes are comment-only.** Correcting a stale comment is in scope;
  changing the code it sits above is not. If a comment is wrong because the
  *code* is wrong, say so and leave the code alone.
