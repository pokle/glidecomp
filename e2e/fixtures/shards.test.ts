/**
 * Every e2e spec belongs to exactly one shard.
 *
 * The shards are explicit file lists (./shards.ts), which buys duration
 * balance that Playwright's count-based `--shard` cannot give — and costs the
 * one thing an explicit list always costs: a new spec that nobody adds to a
 * list is a spec that never runs. It would not fail. It would not warn. CI
 * would go green three times over while the file sat there untested, and the
 * only symptom would be a test count nobody has memorised.
 *
 * That is the same drift e2e/fixtures/mobile.test.ts exists to stop for the
 * phone pass, and it gets the same treatment: enforced here, in `bun test`, so
 * the guard runs in the `test` job and does not need the whole stack up.
 *
 * The reverse direction matters just as much. A spec named in a shard but
 * deleted or renamed leaves a `testMatch` glob that matches nothing, and
 * Playwright treats that as a project with fewer tests rather than an error.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { E2E_SHARDS, SHARD_NAMES, shardFromEnv } from "./shards";
import { MOBILE_SPEC_FILES } from "./mobile";

const E2E_DIR = dirname(import.meta.dir);

/**
 * The specs playwright.config.ts would run: everything under e2e/ except
 * ssr.spec.ts, which belongs to playwright.ssr.config.ts and its own CI job
 * (it needs the BUILT output behind the Pages runtime, so it can never be part
 * of a shard of this suite).
 */
function runnableSpecs(): string[] {
  return readdirSync(E2E_DIR).filter(
    (f) => f.endsWith(".spec.ts") && f !== "ssr.spec.ts"
  );
}

const assigned = SHARD_NAMES.flatMap((name) => [...E2E_SHARDS[name]]);

describe("the e2e shard lists", () => {
  test("there are shards, and specs to put in them", () => {
    expect(SHARD_NAMES.length).toBeGreaterThan(1);
    expect(runnableSpecs().length).toBeGreaterThan(0);
  });

  test("every runnable spec is in a shard", () => {
    const missing = runnableSpecs().filter((f) => !assigned.includes(f));
    expect(
      missing,
      `these specs are in no shard and would never run in CI — ` +
        `add each to one of ${SHARD_NAMES.join(", ")} in e2e/fixtures/shards.ts`
    ).toEqual([]);
  });

  test("no spec is in two shards", () => {
    const seen = new Set<string>();
    const duplicated: string[] = [];
    for (const file of assigned) {
      if (seen.has(file)) duplicated.push(file);
      seen.add(file);
    }
    expect(
      [...new Set(duplicated)],
      "these specs are in more than one shard, so CI would run them twice"
    ).toEqual([]);
  });

  test("every shard names only files that exist", () => {
    const ghosts = assigned.filter((f) => !existsSync(join(E2E_DIR, f)));
    expect(
      ghosts,
      "these specs are named in a shard but are not on disk — " +
        "a testMatch that matches nothing is silently a smaller run"
    ).toEqual([]);
  });

  test("no shard claims ssr.spec.ts", () => {
    // It runs under playwright.ssr.config.ts, against the built output served
    // by wrangler pages dev. This config ignores it outright, so naming it in
    // a shard would produce a glob that never matches.
    expect(assigned).not.toContain("ssr.spec.ts");
  });

  test("no shard is empty", () => {
    for (const name of SHARD_NAMES) {
      expect(E2E_SHARDS[name].length, `shard "${name}" has no specs`).toBeGreaterThan(0);
    }
  });

  test("every mobile spec is in some shard", () => {
    // The mobile project re-runs these four under a phone descriptor. A mobile
    // spec left out of every shard would take the phone pass down with it, and
    // mobile.test.ts cannot see that — it checks the list against the
    // directory, not against the shards.
    for (const file of MOBILE_SPEC_FILES) expect(assigned).toContain(file);
  });
});

describe("the CI matrix", () => {
  /**
   * The workflow names the shards it runs, and that list has to be the same
   * list. Getting it wrong in one direction is loud — a matrix entry that is
   * no longer a shard throws out of shardFromEnv and fails the job. The other
   * direction is silent, and it is the one that matters: add a shard here,
   * forget the matrix, and those specs simply never run in CI while all three
   * jobs stay green.
   */
  const WORKFLOW = join(dirname(E2E_DIR), ".github/workflows/deploy.yml");

  test("runs exactly the shards defined here", () => {
    const yaml = readFileSync(WORKFLOW, "utf8");
    const line = yaml.match(/^\s*shard:\s*\[([^\]]+)\]/m);
    expect(line, `no \`shard: [...]\` matrix found in ${WORKFLOW}`).toBeTruthy();
    const inWorkflow = line![1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, ""));
    expect([...inWorkflow].sort()).toEqual([...SHARD_NAMES].sort());
  });
});

describe("shardFromEnv", () => {
  test("unset means the whole suite", () => {
    expect(shardFromEnv(undefined)).toBeNull();
    expect(shardFromEnv("")).toBeNull();
  });

  test("a known shard resolves to its specs", () => {
    for (const name of SHARD_NAMES) {
      expect(shardFromEnv(name)).toEqual(E2E_SHARDS[name]);
    }
  });

  test("an unknown shard throws rather than running everything", () => {
    // Falling back to the full suite would make a typo in the CI matrix cost
    // three full runs and stay green — the failure nobody investigates.
    expect(() => shardFromEnv("maps")).toThrow(/not a shard/);
  });
});
