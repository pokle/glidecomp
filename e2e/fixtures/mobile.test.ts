/**
 * The `mobile` project's spec list names files that exist.
 *
 * Playwright's `testMatch` is a glob, and a glob that matches nothing is not
 * an error — it is a project with fewer tests. So a spec renamed or split
 * without touching e2e/fixtures/mobile.ts takes its pages out of mobile
 * coverage silently, and the run stays green while the phone pass quietly
 * stops happening. That is the same class of drift e2e/fixtures/spec-imports
 * .test.ts exists to prevent, and the same fix: enforce it here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { MOBILE_SPEC_FILES, MOBILE_TEST_MATCH } from "./mobile";

const E2E_DIR = dirname(import.meta.dir);

describe("the mobile project's spec list", () => {
  test("names at least one spec", () => {
    expect(MOBILE_SPEC_FILES.length).toBeGreaterThan(0);
  });

  for (const file of MOBILE_SPEC_FILES) {
    test(`${file} exists`, () => {
      expect(existsSync(join(E2E_DIR, file))).toBe(true);
    });
  }

  test("names only files Playwright would run at all", () => {
    // ssr.spec.ts is served by a different config entirely
    // (playwright.ssr.config.ts, over the BUILT output), so naming it here
    // would produce a project that matches a spec the config ignores.
    const runnable = new Set(
      readdirSync(E2E_DIR).filter(
        (f) => f.endsWith(".spec.ts") && f !== "ssr.spec.ts"
      )
    );
    for (const file of MOBILE_SPEC_FILES) expect(runnable.has(file)).toBe(true);
  });

  test("the testMatch patterns stay in step with the file list", () => {
    expect(MOBILE_TEST_MATCH).toEqual(
      MOBILE_SPEC_FILES.map((f) => `**/${f}`)
    );
  });
});
