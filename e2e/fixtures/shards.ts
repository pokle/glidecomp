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
 * It needed doing twice. The August split made three shards; by November the
 * organiser one had tripled (56 tests and 204s of wall clock on run
 * 32481474298, about 150 tests and 426–677s by run 41422433753), because the
 * mobile-first pages it covers run every test twice, desktop and phone. Its
 * test step had a median of 10m40s over 15 runs and finished last in all 15 —
 * longer than the whole unsplit suite had been. So it is now three shards
 * (organiser-comp, organiser-pilots, organiser-tasks), and the suite drives a
 * production build instead of the Vite dev server, which halved the cost of a
 * page load (web/scripts/e2e-serve-dist.ts).
 *
 * Measured on run 41430947899, the first green run of both changes, against
 * the 15-run median before them:
 *
 *   organiser tests        10m40s in one shard → 1m31s / 1m51s / 2m32s in three
 *   maps-and-analysis       4m33s → 3m33s
 *   public-and-pilot        4m12s → 2m14s
 *   the whole run          11m32s → 5m16s, with Test → Deploy now the long pole
 *
 * The same organiser specs took 292s of wall clock across their three shards,
 * against 426s in one on the fastest dev-server run (41422433753) — and that
 * 293s includes seeding the sample comp in two shards rather than one.
 *
 * ── Plan for the slow runner ────────────────────────────────────────────────
 *
 * GitHub's runners are not all one speed. The same 146 tests took 7.2m on
 * three runs (41422433753, 41421051154, 41420543044) and 10.2–10.6m on three
 * others (41420589270, 41419728049, 41418101252): every spec 1.35–1.5× slower,
 * server startup 8s → 12s. About two jobs in three land on the slow kind. A
 * shard sized on a fast run will be the long pole on most runs.
 *
 * ── Why an explicit list rather than Playwright's `--shard=i/N` ─────────────
 *
 * Because `--shard` balances by test COUNT and this suite's per-test durations
 * are nowhere near uniform. `filterForShard` (playwright/lib/runner) sums
 * `group.tests.length` and cuts the sequence into equal-sized pieces, walking
 * groups in project-then-filename order. Measured against the real durations
 * from run 32355085390, `--shard=i/4` yields 292s / 90s / 69s / 103s: the
 * alphabetical run of analysis-map, explain-affordance and task-analysis —
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
 * There is no point chasing much below the `test` → `deploy` chain: Test's job
 * has a median of 3m38s and Deploy's 1m26s on a branch (about 2m on master,
 * which deploys the Workers too), so that ~5–5.5 minutes is the floor for the
 * whole build until the deploy path changes.
 */

/**
 * The shards, subject by subject. Seconds are the measured chromium+mobile
 * wall clock for that spec on run 41430947899 (production build), including
 * any seeding that ran just before it; a slow runner takes about 1.45× as long.
 */
export const E2E_SHARDS = {
  /**
   * The map, the analysis page and the charts that explain a score — the
   * heaviest specs in the suite, and heavy for real reasons: they render
   * Mapbox (from recordings), draw charts, and wait on the analysis the engine
   * computes. With page loads cheap, this is now the slowest shard; most of it
   * is the map itself, which a production build does not make faster.
   * task-analysis is `mode: "serial"` with a shared `beforeAll` page, so it
   * cannot be split further.
   */
  "maps-and-analysis": [
    "analysis-map.spec.ts", // 76.8s
    "trusted-types.spec.ts", // 57.1s
    "report-card.spec.ts", // 28.4s
    "task-analysis.spec.ts", // 20.6s
    "explain-affordance.spec.ts", // 4.5s
    "lazy-map-in-view.spec.ts", // 2.0s
  ],

  /*
   * What an organiser does, in three shards. Nine of the twelve `mobile` specs
   * are in them, because the organiser's pages are built mobile-first (#636,
   * #637, and the waypoints and pilots lists), so most of these run twice.
   */

  /**
   * The competition itself: its pages and settings, starting one, sharing a
   * hidden one, its results record, and an assistant acting on it. A spec
   * about creating something on a comp page (a task, a test IGC) goes here.
   */
  "organiser-comp": [
    "comp-detail.spec.ts", // 33.5s (chromium + mobile), ~12s of it seeding the sample comp
    "comp-settings-pages.spec.ts", // 21.2s (chromium + mobile)
    "comp-new.spec.ts", // 5.0s (chromium + mobile)
    "task-new-page.spec.ts", // new — measure on its first CI run (chromium + mobile)
    "task-test-igc.spec.ts", // new — measure on its first CI run (chromium + mobile)
    "hidden-comp-share-link.spec.ts", // 4.9s
    "results-record.spec.ts", // 2.9s
    "comp-creation.spec.ts", // 2.5s
    "mcp.spec.ts", // 2.3s
    "popover-position.spec.ts", // 1.3s
  ],

  /**
   * The roster: the pilots list and each pilot's page, the CIVL rankings fill,
   * and the mutations to pilots and tracks that must move a score — plus the
   * kit form's own rules, whose worked example is the pilot page.
   */
  "organiser-pilots": [
    "comp-pilots.spec.ts", // 54.4s (chromium + mobile)
    "civl-rankings.spec.ts", // 20.8s, ~11s of it seeding 14,535 ranked pilots
    "forms.spec.ts", // 10.0s (chromium + mobile)
    "scoring-mutations.spec.ts", // 7.2s
  ],

  /**
   * Where the task flies: the waypoint file and the task's own pages (its
   * settings, the route editor, weather notes). comp-waypoints is the single
   * heaviest spec an organiser has.
   */
  "organiser-tasks": [
    "comp-waypoints.spec.ts", // 89.0s (chromium + mobile), ~17s of it seeding the sample comp
    "task-settings-pages.spec.ts", // 36.7s (chromium + mobile)
  ],

  /**
   * What everyone else sees: submitting a track, signing in, the prerendered
   * content pages, search, the repairable 404, and the public API's own
   * documentation (api-doc.spec.ts, which is about the public API surface).
   */
  "public-and-pilot": [
    "track-submission.spec.ts", // 25.9s (chromium + mobile)
    "task-submit-link.spec.ts", // new — measure on its first CI run (chromium + mobile)
    "full-screen-sheets.spec.ts", // 19.6s, ~17s of it seeding the sample comp
    "legal-notice.spec.ts", // 12.9s
    "settings-save-ux.spec.ts", // 7.2s
    "settings-api-keys.spec.ts", // new — creating an API key (chromium + mobile)
    "user-files-upload.spec.ts", // 5.6s
    "email-otp-signin.spec.ts", // 5.4s
    "account-name-sync.spec.ts", // 5.3s
    "static-pages.spec.ts", // 5.1s
    "search.spec.ts", // 4.6s
    "transient-api-failure.spec.ts", // 4.5s
    "not-found-suggestions.spec.ts", // 4.4s
    "last-used-sign-in.spec.ts", // 3.8s
    "api-doc.spec.ts", // 2.3s
    "non-route-links.spec.ts", // 0.7s
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
