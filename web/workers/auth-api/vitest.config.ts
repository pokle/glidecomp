import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(__dirname, "../../db/migrations")
  );

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Override prod vars so isLocalDev() returns true (enables
            // dev-login + email/password) and Better Auth has the secrets
            // it needs to issue/verify session cookies.
            BETTER_AUTH_URL: "http://localhost:8788",
            BETTER_AUTH_SECRET:
              "test-secret-do-not-use-in-prod-1234567890abcdef",
            GOOGLE_CLIENT_ID: "test-client-id",
            GOOGLE_CLIENT_SECRET: "test-client-secret",
          },
          r2Buckets: ["R2"],
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      include: ["test/**/*.test.ts"],
      // Better Auth's dev-login signupEmail throws an internal "user already
      // exists" rejection that escapes the route handler's try/catch on
      // duplicate emails. We use unique emails per test, but suppress here
      // as a safety net (matches competition-api's pattern).
      dangerouslyIgnoreUnhandledErrors: true,
      // dev-login does a real signUp + signIn (Better Auth hashes a password
      // on each call). Multi-user tests do this twice plus several round
      // trips — the default 5s timeout is too tight on CI runners.
      testTimeout: 15000,
    },
  };
});
