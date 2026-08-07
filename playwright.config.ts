import { defineConfig } from "@playwright/test";
import { FRONTEND_URL, API_READY_URL } from "./e2e/fixtures/stack";

export default defineConfig({
  testDir: "./e2e",
  // ssr.spec.ts needs the built output served through the real Pages runtime
  // (wrangler pages dev), not this config's SPA dev server — it has its own
  // config (playwright.ssr.config.ts, run via `bun run test:e2e:ssr`).
  //
  // e2e/fixtures/ holds the suite's plumbing, and one bun:test file that guards
  // it. Playwright's default testMatch claims any `*.test.ts` under testDir, and
  // loading that one fails the whole run before a single spec starts:
  // `Only URLs with a scheme in: file, data, and node are supported by the
  // default ESM loader. Received protocol 'bun:'`. It is run by `bun run test`,
  // not from here. (playwright.ssr.config.ts needs no such line — it selects
  // with testMatch rather than sweeping the directory.)
  testIgnore: ["**/ssr.spec.ts", "**/fixtures/**"],
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
  // behind the dev-router on :8790. The readiness URL is the router's /__ready,
  // which answers 200 only once EVERY Worker responds — with three ports we got
  // that guarantee for free by waiting on each; behind one port a probe of any
  // single route would let the run start while a sibling was still loading, and
  // a request landing on a loading Worker takes `wrangler dev` down with it.
  webServer: [
    {
      command: "bun run dev:workers",
      url: API_READY_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      // The port comes from DEV_FRONTEND_PORT via vite.config.ts, not a CLI
      // flag: `dev` runs vite under concurrently, which swallows extra args.
      command: "bun run dev:frontend",
      url: FRONTEND_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        // The map specs serve every Mapbox response from recordings and
        // synthetic tiles (e2e/fixtures/mapbox.ts), so they need no real token
        // — but they DO need a non-empty one, and that is easy to miss because
        // a developer's shell usually has the real thing exported.
        //
        // With the variable absent, mapbox-gl refuses to construct a Map at
        // all: no canvas, no controls, no scale bar, so every map assertion
        // fails on `element(s) not found`, PLACE_SEARCH_AVAILABLE is false so
        // the geocoder combobox never renders, and analysis/elevation.ts
        // throws "Mapbox access token is not configured". None of that names
        // the missing variable, and CI has no VITE_MAPBOX_TOKEN — which is how
        // a suite that was green on six machines went red on the runner.
        //
        // A FAKE token is the right default rather than a secret: it keeps the
        // suite runnable by anyone with no credentials, spends no Mapbox quota,
        // and proves the offline path really is offline. A real one still wins
        // when it is present, which is what MAPBOX_RECORD=1 and MAPBOX_LIVE=1
        // need.
        VITE_MAPBOX_TOKEN:
          process.env.VITE_MAPBOX_TOKEN ||
          "pk.eyJ1IjoiZTJlLWZpeHR1cmUiLCJhIjoiZTJlIn0.not-a-real-token",
      },
    },
  ],
});
