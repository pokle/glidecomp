import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Test harness for auth-api.
//
// Some tests need "dev mode" (BETTER_AUTH_URL = localhost) so isLocalDev()
// returns true and dev-login / email-password auth are enabled. Other tests
// need "prod mode" (BETTER_AUTH_URL = glidecomp.com) to prove dev-login is
// gated off. We pick the dev-mode url as the default here; the small number
// of prod-mode tests override BETTER_AUTH_URL inline (see test files).
//
// Secrets are dummies — we never call Google and the secret just needs to
// be 32+ chars for Better Auth's HMAC.
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            BETTER_AUTH_URL: "http://localhost:8788",
            BETTER_AUTH_SECRET: "test-secret-at-least-32-chars-long-ok",
            GOOGLE_CLIENT_ID: "test-google-client-id",
            GOOGLE_CLIENT_SECRET: "test-google-client-secret",
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      include: ["test/**/*.test.ts"],
    },
  };
});
