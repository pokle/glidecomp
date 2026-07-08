import { defineConfig } from "@playwright/test";

/**
 * SSR e2e config: runs e2e/ssr.spec.ts against the built output served through
 * the real Cloudflare Pages runtime (wrangler pages dev + the SSR Function),
 * not the SPA dev server — because SSR only happens on the built dist. The auth
 * and comp Workers run in dev and are bound to pages dev via --service.
 *
 * Run with: bun run test:e2e:ssr
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: ["**/ssr.spec.ts"],
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [["html", { open: "never" }], ["list"]] : [["list"]],
  use: {
    baseURL: "http://localhost:3100",
    headless: true,
    launchOptions: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium" }],
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
      command: "bash web/scripts/ssr-e2e-serve.sh",
      url: "http://localhost:3100/comp",
      reuseExistingServer: !process.env.CI,
      // Build + seed + wrangler startup — allow generous time.
      timeout: 180_000,
    },
  ],
});
