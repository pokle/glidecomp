import { betterAuth } from "better-auth";
import { oAuthProxy } from "better-auth/plugins";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

export function isLocalDev(env: { BETTER_AUTH_URL: string }): boolean {
  try {
    return new URL(env.BETTER_AUTH_URL).hostname === "localhost";
  } catch {
    return false;
  }
}

export type AuthEnv = {
  glidecomp_auth: D1Database;
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
    plugins: isLocalDev(env)
      ? []
      : [
          oAuthProxy({
            productionURL: "https://glidecomp.com",
          }),
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
