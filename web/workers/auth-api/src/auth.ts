import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { oAuthProxy } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { API_KEY_RATE_LIMIT } from "./rate-limit";

export function isLocalDev(env: { BETTER_AUTH_URL: string }): boolean {
  try {
    return new URL(env.BETTER_AUTH_URL).hostname === "localhost";
  } catch {
    return false;
  }
}

/**
 * Whether the email/password test-login path (and the /api/auth/dev-login
 * endpoint) is available: always in local dev, and on per-branch preview
 * stacks, whose generated config sets ENABLE_TEST_LOGIN=1 (previews can't use
 * Google OAuth — a per-branch hostname can't be a registered redirect URI, and
 * preview data is throwaway by design). Production sets neither, and the
 * deploy workflow's smoke test asserts dev-login stays blocked there.
 */
export function isTestLoginEnabled(env: {
  BETTER_AUTH_URL: string;
  ENABLE_TEST_LOGIN?: string;
}): boolean {
  return isLocalDev(env) || env.ENABLE_TEST_LOGIN === "1";
}

export type AuthEnv = {
  glidecomp_auth: D1Database;
  R2: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  /** "1" only on preview stacks — see isTestLoginEnabled. */
  ENABLE_TEST_LOGIN?: string;
};

export function createAuth(env: AuthEnv) {
  const db = new Kysely({ dialect: new D1Dialect({ database: env.glidecomp_auth }) });

  return betterAuth({
    database: {
      db,
      type: "sqlite",
    },
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: ["https://glidecomp.com", "https://*.glidecomp.pages.dev"],
    plugins: [
      // Cast needed: @better-auth/api-key resolves a separate copy of
      // @better-auth/core with structurally identical but nominally distinct types.
      apiKey({
        defaultPrefix: "glc_",
        enableSessionForAPIKeys: true,
        rateLimit: {
          enabled: true,
          timeWindow: API_KEY_RATE_LIMIT.timeWindowMs,
          maxRequests: API_KEY_RATE_LIMIT.maxRequests,
        },
      }) as unknown as BetterAuthPlugin,
      // The oAuthProxy routes Google callbacks through production; test-login
      // deployments (local dev, preview stacks) have no working Google client,
      // so the proxy is omitted there — it must never bounce a preview
      // sign-in through the production auth worker.
      ...(isTestLoginEnabled(env)
        ? []
        : [
            oAuthProxy({
              productionURL: "https://glidecomp.com",
            }),
          ]),
    ],
    // Email/password auth exists only for the dev-login endpoint (local dev
    // and preview stacks) — never in production.
    ...(isTestLoginEnabled(env)
      ? { emailAndPassword: { enabled: true, minPasswordLength: 1 } }
      : {}),
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },
    user: {
      additionalFields: {
        username: {
          type: "string",
          required: false,
          unique: true,
          input: false,
        },
      },
    },
  });
}
