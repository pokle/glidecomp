/**
 * The MCP fence (web/workers/competition-api/src/middleware/mcp-fence.ts)
 * admits `/api/comp/:comp_id`, and a comp id is a short run of lowercase
 * letters — so a fixed word served directly under /api/comp/ (`pilot`,
 * `lookup`, …) would pass for one unless the fence names it. This scans the
 * routes for every such word and fails when one is missing from
 * STATIC_COMP_SEGMENTS, which is how `/api/comp/pilot` (the account's own
 * profile) was caught being admitted.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATIC_COMP_SEGMENTS } from "../workers/competition-api/src/middleware/mcp-fence";

const ROUTES_DIR = join(import.meta.dir, "../workers/competition-api/src/routes");

function staticCompSegments(): string[] {
  const words = new Set<string>();
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".ts")) continue;
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(/["'`]\/api\/comp\/([a-z][a-z0-9.-]*)(?=[/"'`])/g)) words.add(m[1]!);
  }
  return [...words].sort();
}

describe("MCP fence: fixed words under /api/comp/", () => {
  test("every one a route serves is named in STATIC_COMP_SEGMENTS", () => {
    expect(staticCompSegments()).toEqual([...STATIC_COMP_SEGMENTS].sort());
  });
});
