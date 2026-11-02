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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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

  test("a spec that tags a test PHONE_ONLY is one the mobile project runs", () => {
    // The desktop project never schedules a PHONE_ONLY test, so in a spec the
    // mobile project does not run either, the tag would mean "never".
    const listed = new Set<string>(MOBILE_SPEC_FILES);
    const stranded = readdirSync(E2E_DIR)
      .filter((f) => f.endsWith(".spec.ts") && !listed.has(f))
      .filter((f) => /\bPHONE_ONLY\b/.test(readFileSync(join(E2E_DIR, f), "utf8")));
    expect(
      stranded,
      "these specs tag a test PHONE_ONLY but are not in MOBILE_SPEC_FILES, so " +
        "that test runs in no project at all"
    ).toEqual([]);
  });
});
