/**
 * Every raw-HTML sink in the frontend is pinned here.
 *
 * The analysis page and 3D replay are vanilla TS, so `innerHTML`-style
 * rendering is legitimate there — but every interpolated value that reaches
 * such a sink must be wrapped in `escapeHtml()` (src/escape-html.ts) at the
 * point of interpolation. That discipline has failed silently twice: SEC-41
 * (2026-08-12) found eight unescaped sinks that had shipped across at least
 * three review rounds, and SEC-47 (2026-08-17) found a ninth the SEC-41 sweep
 * itself missed. Each existed because nothing flagged a new sink at
 * introduction time.
 *
 * This is that flag — the security-review log calls it gap #9. The repo has
 * no ESLint, so like one-kit.test.ts it is a test instead. It pins:
 *
 *  1. ZERO `dangerouslySetInnerHTML` under src/react/ — the React tree
 *     renders untrusted strings as JSX text, which auto-escapes. (The one
 *     `innerHTML` allowed there assigns a module-constant SVG.)
 *  2. An exact per-file count of HTML sinks (`innerHTML`/`outerHTML`
 *     assignment, `insertAdjacentHTML`, mapbox's `setHTML`) across all of
 *     src/.
 *
 * If this test failed because you added (or removed) a sink: audit the new
 * sink's template for interpolated values — anything that came from an API
 * response, an IGC/XCTask/waypoint file, or user input gets `escapeHtml()`
 * — then update BASELINE below. Do not widen it without that audit; the
 * count change IS the review prompt.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// vitest runs with the workspace root as cwd (web/frontend); import.meta.url
// is a vite-virtual path here, so it can't be used to find the source tree.
const SRC = join(process.cwd(), "src");

// Assignments (including +=) and the call-style sinks. `(?!=)` keeps
// comparisons (`===`) out.
const SINK = /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)|\.insertAdjacentHTML\s*\(|\.setHTML\s*\(/g;

const BASELINE: Record<string, number> = {
  "analysis/analysis-panel.ts": 17,
  "analysis/main.ts": 2,
  "analysis/map-annotations.ts": 2,
  "analysis/map-provider-shared.ts": 7,
  "analysis/mapbox-provider.ts": 14,
  "analysis/storage-menu.ts": 4,
  "analysis/task-editor.ts": 19,
  "react/pages/CompWaypoints.tsx": 1, // constant PIN_SVG only
  "replay/gaggle-ui.ts": 6,
  "replay/main.ts": 2,
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("raw-HTML sinks are pinned (security-review gap #9)", () => {
  const files = sourceFiles(SRC).filter((f) => !f.endsWith("html-sinks.test.ts"));

  it("src/react/ has no dangerouslySetInnerHTML", () => {
    const offenders = files
      .filter((f) => f.startsWith(join(SRC, "react") + sep))
      .filter((f) => readFileSync(f, "utf8").includes("dangerouslySetInnerHTML"))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });

  it("per-file sink counts match the audited baseline", () => {
    const counts: Record<string, number> = {};
    for (const f of files) {
      const n = (readFileSync(f, "utf8").match(SINK) ?? []).length;
      if (n > 0) counts[f.slice(SRC.length + 1)] = n;
    }
    // Sorted for a stable diff when this fails.
    const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
    expect(sorted).toEqual(BASELINE);
  });
});
