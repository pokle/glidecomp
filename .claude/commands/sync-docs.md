# Sync Documentation

Audit all documentation files against the current codebase and fix any discrepancies.

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

#### C. Stale TODOs
- Check TODO items marked as incomplete — are any actually done?
- Check TODO items marked as done — are they really done?

### Phase 3: Present findings

Organize all findings into a plan with three sections:
1. **Rotted docs** — factual errors to fix
2. **Missing feature docs** — new features to document
3. **Stale TODOs** — TODO items to update

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
| `docs/TODO.md` | All source files (check completed items) |
| `CLAUDE.md` | Project structure, build commands |
| `README.md` | `package.json` scripts, project structure |

## Important notes

- Use subagents for parallel verification — don't try to read everything sequentially
- Spot-check numeric values (colors, sizes, intervals) rather than trusting docs at face value
- When documenting new features, keep the style consistent with existing docs
- Don't add documentation for future/planned features — only document what's implemented
- Don't modify code — only modify documentation files
