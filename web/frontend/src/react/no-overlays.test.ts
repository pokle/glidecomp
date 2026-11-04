/**
 * No full-screen overlays, and no imitation of the browser's Back.
 *
 * CLAUDE.md's rule (owner decision, 2026-11-02, tracked in #823): a screen of
 * its own is a PAGE with its own URL, left with the browser's Back. Browser
 * navigation must simply work; we do not imitate it. The machinery that made
 * full-screen sheets usable was deleted in #817 once the last of them had
 * become a page:
 *
 * - `rac/full-screen-sheet.tsx` (`FullScreenSheet`, `SheetHeader`/`SheetBody`/
 *   `SheetFooter`) and `FormSheet` in `rac/form.tsx`;
 * - `lib/use-sheet-scroll-reset.ts`;
 * - `lib/use-back-dismiss.ts`, which pushed a history entry for every open
 *   sheet and dialog (and for every dirty form) so that Back could be caught —
 *   and which needed a stack, a walk queue and dead-entry handling to keep
 *   those entries straight.
 *
 * Each grew its own iOS bug. This fails if any of it comes back, or if
 * anything in the SPA starts pushing or walking history entries by hand
 * again: navigation goes through the router (`navigate()`, `<Link>`), and
 * Back is the browser's.
 *
 * A page that another page opened leaves by a real Back — and only one module
 * decides that: `lib/leave.ts` (`useLeave`, `openedHere`). The pages had grown
 * six names for the same marker, each checked by its own copy of the same
 * three lines. So `navigate(-1)` is allowed there, and in the master-detail
 * selection, which unwinds only the one entry it pushed itself.
 *
 * Same shape as `one-kit.test.ts`: a test rather than a lint rule, because the
 * repo has no ESLint.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// vitest runs with the workspace root as cwd (web/frontend).
const REACT = join(process.cwd(), "src", "react");

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

const DELETED = [
  "rac/full-screen-sheet.tsx",
  "lib/use-back-dismiss.ts",
  "lib/use-sheet-scroll-reset.ts",
];

describe("no full-screen overlays", () => {
  it.each(DELETED)("%s stays deleted", (path) => {
    expect(existsSync(join(REACT, path))).toBe(false);
  });

  it("nothing imports the overlay machinery, or a FormSheet", () => {
    const offenders = sourceFiles(REACT)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return (
          /from\s+["'][^"']*(full-screen-sheet|use-back-dismiss|use-sheet-scroll-reset)["']/.test(src) ||
          /\bFormSheet\b\s*[,}(<]/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""))
        );
      })
      .map((f) => f.slice(REACT.length + 1));
    expect(offenders).toEqual([]);
  });

  it("nothing pushes or walks history entries by hand", () => {
    const offenders = sourceFiles(REACT)
      .filter((f) =>
        /\bhistory\.(pushState|back|go|forward)\s*\(/.test(
          // Comments may name what is gone; code may not use it.
          readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
        )
      )
      .map((f) => f.slice(REACT.length + 1));
    expect(offenders).toEqual([]);
  });

  it("nothing but lib/leave.ts walks back a page", () => {
    const allowed = ["lib/leave.ts", "components/use-master-detail-selection.ts"];
    const offenders = sourceFiles(REACT)
      .filter((f) =>
        /\bnavigate\(\s*-\d/.test(
          readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")
        )
      )
      .map((f) => f.slice(REACT.length + 1))
      .filter((f) => !allowed.includes(f));
    expect(offenders).toEqual([]);
  });
});
