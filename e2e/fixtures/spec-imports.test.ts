/**
 * Every spec must take `test` from ./fixtures/test, never from
 * `@playwright/test` directly.
 *
 * That import is what installs the stack-up fixture, and a spec that skips it
 * loses nothing visible: it passes, every day, until the day `wrangler dev`
 * crashes mid-run (see web/scripts/dev-workers.sh) and that one spec asserts
 * against a closed port while the rest of the suite waits for the restart. The
 * failure would then look like a product bug in whichever spec happened to
 * forget — which is precisely the confusion this whole arrangement removes.
 *
 * A rule nothing enforces is a rule that drifts, so: enforced here.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const E2E_DIR = dirname(import.meta.dir);

/** Type-only imports are erased, so they can name the package harmlessly. */
const VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+["']@playwright\/test["']/m;

describe("e2e specs", () => {
  const specs = readdirSync(E2E_DIR).filter((f) => f.endsWith(".spec.ts"));

  test("there are specs to check", () => {
    expect(specs.length).toBeGreaterThan(0);
  });

  for (const spec of specs) {
    test(`${spec} imports test/expect from ./fixtures/test`, () => {
      const source = readFileSync(join(E2E_DIR, spec), "utf8");
      expect(VALUE_IMPORT.test(source)).toBe(false);
      expect(source).toContain('from "./fixtures/test"');
    });
  }
});
