import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // ssr.spec.ts needs the built output served through the real Pages runtime
  // (wrangler pages dev), not this config's SPA dev server — it has its own
  // config (playwright.ssr.config.ts, run via `bun run test:e2e:ssr`).
  testIgnore: ["**/ssr.spec.ts"],
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  // Force sequential runs in CI. With 2 workers, the comp-creation +
  // user-files tests overlap on the shared local D1 and intermittently
  // race a 500 out of GET /api/comp/:id. Locally we keep the default
  // (parallel) for speed; CI prioritises determinism.
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["list"]]
    : [["list"]],
  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    launchOptions: {
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
    // Keep a full per-step + network trace for any failed test. Lets us see
    // whether GHA flakes are races in our code or just slow infrastructure.
    // Traces land in test-results/ — branch-deploy.yml and deploy.yml upload
    // that path alongside playwright-report/ so they're downloadable from
    // the Actions UI. Open one locally with `bunx playwright show-trace`.
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
    },
  ],
  webServer: [
    {
      command: "bun run dev:auth",
      url: "http://localhost:8788/api/auth/me",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "bun run dev:comp",
      url: "http://localhost:8789/api/comp",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "bun run dev:frontend",
      url: "http://localhost:3000",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
