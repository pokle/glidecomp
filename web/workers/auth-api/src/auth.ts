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

export type AuthEnv = {
  glidecomp_auth: D1Database;
  R2: R2Bucket;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
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
      ...(isLocalDev(env)
        ? []
        : [
            oAuthProxy({
              productionURL: "https://glidecomp.com",
            }),
          ]),
    ],
    // Enable email/password auth in dev only (for dev-login endpoint)
    ...(isLocalDev(env)
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
