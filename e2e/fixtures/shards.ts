/**
 * How the e2e suite is split across parallel CI jobs.
 *
 * The suite runs `workers: 1` (see playwright.config.ts for why — shared
 * mutable fixtures, not the database), so its wall clock is the SUM of every
 * test. That reached ~9m13s of test execution in one job, which made the E2E
 * job the whole build's critical path: on run 32355085390 every other job —
 * unit tests, SSR e2e, even the deploy — was finished by 09:45, and the run
 * did not end until 09:51 because E2E was still going.
 *
 * Splitting it across jobs is what fixes that, and each job gets its OWN
 * wrangler session and its own local D1 file, so the shared-fixture coupling
 * that forces `workers: 1` never arises BETWEEN shards. Inside a shard nothing
 * changes.
 *
 * ── Why an explicit list rather than Playwright's `--shard=i/N` ─────────────
 *
 * Because `--shard` balances by test COUNT and this suite's per-test durations
 * are nowhere near uniform. `filterForShard` (playwright/lib/runner) sums
 * `group.tests.length` and cuts the sequence into equal-sized pieces, walking
 * groups in project-then-filename order. Measured against the real durations
 * from run 32355085390, `--shard=i/4` yields 292s / 90s / 69s / 103s: the
 * alphabetical run of analysis-map, explain-affordance and field-analysis —
 * the three heaviest specs in the suite — all land in shard 1. You would pay
 * for four runners and still wait for a 292s shard.
 *
 * static-pages is the clearest illustration of the mismatch: 19 tests in
 * 13.4s, against analysis-map's 7 tests in 72.8s. Test count says static-pages
 * is nearly three times the work. The clock says it is a fifth of it.
 *
 * So the groups below are balanced by MEASURED DURATION, and chosen along
 * product lines so a new spec has an obvious home. The durations are recorded
 * to make rebalancing a matter of arithmetic rather than archaeology; they are
 * a snapshot, not a contract, and nothing asserts against them.
 *
 * ── Adding a spec ───────────────────────────────────────────────────────────
 *
 * Put it in the shard it belongs to by subject. shards.test.ts fails the build
 * if a spec is in no shard or in two, so an unassigned file cannot silently
 * stop running in CI — which is the entire failure mode this file's existence
 * is guarding against, and the same one e2e/fixtures/mobile.test.ts guards for
 * the phone pass.
 *
 * Rebalance when a shard drifts far enough to become the long pole on its own.
 * There is no point chasing much below ~3 minutes: the `test` → `deploy` chain
 * is ~4m49s, so that is the floor for the whole build until the deploy path
 * changes.
 */

/**
 * The shards, subject by subject. Seconds are the measured chromium+mobile
 * total for that spec from run 32355085390.
 */
export const E2E_SHARDS = {
  /**
   * The map, the analysis page and the charts that explain a score — the
   * heaviest specs in the suite, and heavy for real reasons: they render
   * Mapbox (from recordings), draw charts, and wait on the analysis the engine
   * computes. field-analysis alone is 78.9s, and it is `mode: "serial"` with a
   * shared `beforeAll` page, so it cannot be split further. It sets the floor
   * for how fast any shard can be.
   */
  "maps-and-analysis": [
    "field-analysis.spec.ts", // 78.9s
    "analysis-map.spec.ts", // 72.8s
    "explain-affordance.spec.ts", // 39.9s
    "report-card.spec.ts", // 7.4s
    "lazy-map-in-view.spec.ts", // 4.9s
  ],

  /**
   * What an organiser does to a competition: the comp and task settings pages,
   * the pilots grid, the waypoint editor, the rankings fill, and the mutations
   * that must move a score. Three of the four `mobile` specs are here, because
   * the settings pages were built mobile-first (#636, #637).
   */
  organiser: [
    "comp-detail.spec.ts", // 64.8s (chromium + mobile)
    "task-settings-pages.spec.ts", // 31.4s (chromium + mobile)
    "comp-waypoints.spec.ts", // 26.7s
    "comp-settings-pages.spec.ts", // 22.4s (chromium + mobile)
    "scoring-mutations.spec.ts", // 22.3s
    "civl-rankings.spec.ts", // 16.7s
    "comp-creation.spec.ts", // 4.0s
    "popover-position.spec.ts", // 2.8s
  ],

  /**
   * What everyone else sees: submitting a track, signing in, the prerendered
   * content pages, search, the repairable 404, and the public API's own
   * documentation. The lightest group, which is where api-doc.spec.ts belongs
   * on both counts — it is about the public API surface, and it is skipped in
   * CI today, so its true cost is unmeasured and this shard has the most room
   * to absorb it.
   */
  "public-and-pilot": [
    "track-submission.spec.ts", // 67.0s (chromium + mobile)
    "email-otp-signin.spec.ts", // 13.9s
    "static-pages.spec.ts", // 13.4s
    "user-files-upload.spec.ts", // 13.2s
    "transient-api-failure.spec.ts", // 11.4s
    "search.spec.ts", // 10.6s
    "settings-save-ux.spec.ts", // 10.1s
    "account-name-sync.spec.ts", // new — not yet measured
    "not-found-suggestions.spec.ts", // 9.9s
    "full-screen-sheets.spec.ts", // 6.4s
    "non-route-links.spec.ts", // 2.2s
    "api-doc.spec.ts", // skipped in CI
  ],
} as const satisfies Record<string, readonly string[]>;

export type ShardName = keyof typeof E2E_SHARDS;

/** The shard names, for the CI matrix and for error messages. */
export const SHARD_NAMES = Object.keys(E2E_SHARDS) as ShardName[];

export function isShardName(name: string): name is ShardName {
  return Object.hasOwn(E2E_SHARDS, name);
}

/**
 * Resolve the E2E_SHARD environment variable to a spec-file list.
 *
 * Unset means "the whole suite" — the local default, and what `bun run
 * test:e2e` has always done. An unrecognised value THROWS rather than falling
 * back to everything: a typo in the CI matrix that quietly ran the full suite
 * in all three jobs would triple the bill and still be green, which is exactly
 * the kind of failure nobody goes looking for.
 */
export function shardFromEnv(
  env: string | undefined = process.env.E2E_SHARD
): readonly string[] | null {
  if (!env) return null;
  if (!isShardName(env)) {
    throw new Error(
      `E2E_SHARD="${env}" is not a shard. Known shards: ${SHARD_NAMES.join(", ")}`
    );
  }
  return E2E_SHARDS[env];
}
