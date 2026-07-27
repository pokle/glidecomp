import { defineConfig } from "@playwright/test";
import { API_URL } from "./e2e/fixtures/stack";

const SSR_URL = "http://localhost:3100";

/**
 * SSR e2e config: runs e2e/ssr.spec.ts against the built output served through
 * the real Cloudflare Pages runtime (wrangler pages dev + the SSR Function),
 * not the SPA dev server — because SSR only happens on the built dist. The
 * Workers run in one wrangler dev session (see web/scripts/dev-workers.sh) and
 * `wrangler pages dev` binds to them by name via --service, through wrangler's
 * local dev registry — every worker in a multi-config session registers there,
 * not just the primary.
 *
 * Run with: bun run test:e2e:ssr
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/ssr.spec.ts"],
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // discover() picks the seeded fixture out of the public comp list; a comp
  // left behind by a killed `test:e2e` run is exactly what broke it once
  // (issue #477). Sweep those first.
  globalSetup: "./e2e/global-setup.ts",
  reporter: [
    [
      "./e2e/reporters/stack-health.ts",
      { frontendUrl: SSR_URL, frontendLabel: "the Pages runtime" },
    ],
    ...(process.env.CI
      ? ([["html", { open: "never" }], ["list"]] as const)
      : ([["list"]] as const)),
  ],
  use: {
    baseURL: SSR_URL,
    headless: true,
    launchOptions: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
  webServer: [
    {
      command: "bun run dev:workers",
      url: `${API_URL}/api/comp`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "bash web/scripts/ssr-e2e-serve.sh",
      url: `${SSR_URL}/comp`,
      reuseExistingServer: !process.env.CI,
      // Build + seed + wrangler startup — allow generous time.
      timeout: 180_000,
    },
  ],
});
