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
      // dev-login does a real signUp + signIn (Better Auth hashes a password
      // on each call). Multi-user tests do this twice plus several round
      // trips — the default 5s timeout is too tight on CI runners.
      testTimeout: 15000,
      onUnhandledError,
    },
  };
});

/**
 * Better Auth leaves a floating rejected promise behind every `APIError` an
 * endpoint throws — a wrong OTP, a duplicate sign-up, a bad password. The
 * awaited path is fine: the router still catches the same error and answers
 * 400/422, which is what this suite asserts. But the error is caught and
 * rethrown through three layers (the transaction wrapper, the endpoint
 * wrapper, the dispatch layer) and each leaves a reference that rejects with
 * nobody listening. vitest 4 fails a run that reports any unhandled error.
 *
 * Upstream, open, no maintainer response:
 * https://github.com/better-auth/better-auth/issues/10658 — which arrives at
 * this same workaround, and says plainly that it does not address the root
 * cause. The leak predates 1.7 (that issue is on 1.6.23, under a newer
 * vitest-pool-workers than ours); what changed here is that it became
 * VISIBLE on 1.7.5, having not fired on 1.6.26 with this pool version.
 *
 * So ignore exactly that: a Better Auth `APIError` carrying a 4xx, which by
 * construction is one the library has already turned into a response. A 5xx
 * APIError, and every other unhandled error, still fails the run.
 */
function onUnhandledError(error: unknown): boolean | void {
  const e = error as {
    name?: unknown;
    statusCode?: unknown;
    errorStack?: unknown;
  };
  if (
    e?.name === "APIError" &&
    typeof e.statusCode === "number" &&
    e.statusCode >= 400 &&
    e.statusCode < 500 &&
    typeof e.errorStack === "string" &&
    e.errorStack.includes("better-auth")
  ) {
    return false;
  }
}
