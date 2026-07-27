/**
 * The app ships ONE component kit.
 *
 * `src/react/ui/` held the shadcn/Base UI kit while the RAC migration was in
 * flight (#483). Both kits coexisting was the cost of migrating incrementally;
 * now that the migration is finished, a second kit creeping back in is a
 * regression — two ways to spell "button", two focus models, two sets of
 * gotchas, and double the bundle.
 *
 * This is the guard the plan called an ESLint rule. The repo has no ESLint, so
 * it's a test instead: same effect, runs in the suite that already exists, and
 * fails with an explanation rather than a rule code.
 *
 * If you genuinely need a component neither `rac/` nor a third-party package
 * provides, add it to `rac/` (a static styled element is fine — see
 * `rac/badge.tsx` and `rac/alert.tsx`, which own no behaviour at all), or to
 * `react/vendor/` if it's a thin wrapper over someone else's widget.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// vitest runs with the workspace root as cwd (web/frontend); import.meta.url
// is a vite-virtual path here, so it can't be used to find the source tree.
const SRC = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("one component kit", () => {
  it("has no src/react/ui directory", () => {
    expect(readdirSync(join(SRC, "react"))).not.toContain("ui");
  });

  it("nothing imports from @/react/ui/*", () => {
    const offenders = sourceFiles(SRC)
      .filter((f) => !f.endsWith("one-kit.test.ts"))
      .filter((f) => /from\s+["'][^"']*react\/ui\//.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(SRC.length + 1));

    expect(offenders).toEqual([]);
  });
});
