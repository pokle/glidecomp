import { defineConfig } from "@playwright/test";
import { FRONTEND_URL, API_URL } from "./e2e/fixtures/stack";

export default defineConfig({
  testDir: "./e2e",
  // ssr.spec.ts needs the built output served through the real Pages runtime
  // (wrangler pages dev), not this config's SPA dev server — it has its own
  // config (playwright.ssr.config.ts, run via `bun run test:e2e:ssr`).
  testIgnore: ["**/ssr.spec.ts"],
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // Sequential. The original reason was the cross-process D1 race (two
  // Miniflare processes on one SQLite file) — that's fixed: `dev:workers` now
  // runs every Worker in ONE session behind the dev-router (issue #477,
  // web/scripts/dev-workers.sh). What still argues for one worker is test
  // isolation, not the database: these specs share mutable fixtures — the
  // seeded "Corryong Cup 2026" comp (comp-waypoints saves and restores its
  // waypoints; comp-detail asserts against them) and the single super-admin
  // account. Running them concurrently would have one spec observing another's
  // half-applied edit. The suite is startup-dominated, so sequential costs only
  // a few seconds (~37s vs ~32s) — not worth buying flakiness back. Give the
  // shared specs their own fixtures before raising this.
  workers: 1,
  // Sweeps comps left behind by a killed run before anything else — see the
  // file for why the local database needs sweeping at all.
  globalSetup: "./e2e/global-setup.ts",
  reporter: [
    // Always first: it turns "the stack died" into one honest line and stops
    // the run, instead of a dozen unrelated-looking product failures.
    ["./e2e/reporters/stack-health.ts"],
    ...(process.env.CI
      ? ([["html", { open: "never" }], ["list"]] as const)
      : ([["list"]] as const)),
  ],
  use: {
    baseURL: FRONTEND_URL,
    headless: true,
    launchOptions: {
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    // Keep a full per-step + network trace for any failed test. Lets us see
    // whether GHA flakes are races in our code or just slow infrastructure.
    // Traces land in test-results/ — deploy.yml's E2E job uploads that path
    // alongside playwright-report/ so they're downloadable from
    // the Actions UI. Open one locally with `bunx playwright show-trace`.
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
    },
  ],
  // One entry, not three: every Worker lives in a single wrangler session
  // behind the dev-router on :8790. /api/comp is the readiness probe because it
  // is a real D1 read through competition-api — it proves the database is
  // reachable, not just that a port is open.
  webServer: [
    {
      command: "bun run dev:workers",
      url: `${API_URL}/api/comp`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "bun run dev:frontend",
      url: FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
