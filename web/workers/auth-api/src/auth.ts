import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { oAuthProxy } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import { API_KEY_RATE_LIMIT } from "./rate-limit";
import { deriveUniqueUsername } from "./username";

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
    databaseHooks: {
      user: {
        create: {
          // Auto-assign a public handle at sign-up (from Google OAuth or the
          // dev-login flow) so nobody has to pick one by hand — this is what
          // lets new users skip the onboarding gate. Derived from the display
          // name, falling back to the email local-part, then "pilot".
          before: async (user) => {
            if (typeof user.username === "string" && user.username.length > 0) {
              return; // already set — leave it be
            }
            const emailLocal =
              typeof user.email === "string" ? user.email.split("@")[0] : "";
            const username = await deriveUniqueUsername(
              [typeof user.name === "string" ? user.name : "", emailLocal],
              async (candidate) => {
                const row = await env.glidecomp_auth
                  .prepare('SELECT 1 FROM "user" WHERE username = ?')
                  .bind(candidate)
                  .first();
                return row !== null;
              }
            );
            return { data: { ...user, username } };
          },
        },
      },
    },
  });
}
