import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { emailOTP, oAuthProxy } from "better-auth/plugins";
import { apiKey } from "@better-auth/api-key";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
import {
  API_KEY_RATE_LIMIT,
  OTP_SEND_RATE_LIMIT,
  OTP_VERIFY_RATE_LIMIT,
  normalizeEmail,
  registerOtpEmailSend,
} from "./rate-limit";
import { buildOtpEmail, type EmailSendBinding } from "./otp-email";
import { deriveUniqueUsername } from "./username";
import { bootstrapPilotForUser } from "./pilot-bootstrap";

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
  // Optional because miniflare test runs don't provide it; production has it
  // via the wrangler.toml send_email binding, and the prod send path throws
  // loudly if it's somehow absent.
  EMAIL?: EmailSendBinding;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
};

/**
 * Dev/test-only capture of the last sign-in OTP per email, so local flows
 * (and the e2e suite, via GET /api/auth/dev-last-otp) can complete sign-in
 * without a mailbox. Module-scope is fine: it's per-isolate, only ever
 * populated when isLocalDev() — in production OTPs are hashed at rest and
 * exist in plaintext only inside the outbound email.
 */
const devOtps = new Map<string, string>();

export function getDevOtp(email: string): string | undefined {
  return devOtps.get(normalizeEmail(email));
}

// Structural type: Hono's ExecutionContext and workers-types' disagree on
// newer optional members (e.g. tracing); waitUntil is all we use.
export function createAuth(
  env: AuthEnv,
  executionCtx?: { waitUntil(promise: Promise<unknown>): void }
) {
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
      emailOTP({
        otpLength: 6,
        expiresIn: 600, // 10 min — must match OTP_EXPIRY_MINUTES in otp-email.ts
        allowedAttempts: 3,
        // Only the emailed copy is plaintext; the D1 row is useless if leaked.
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          // Sign-in codes only. The plugin also registers password-reset and
          // email-change endpoints; emailAndPassword is disabled in prod so
          // they're inert, and this guard means they can never send mail.
          if (type !== "sign-in") return;

          // Per-email throttle (layer 3). Silently drop past the cap: an
          // error here would be an inbox-existence oracle and a UX dead end;
          // the per-IP limiter below already 429s interactive abuse.
          const allowed = await registerOtpEmailSend(env.glidecomp_auth, email);
          if (!allowed) {
            console.warn("[auth-api] OTP send throttled for", normalizeEmail(email));
            return;
          }

          if (isLocalDev(env)) {
            devOtps.set(normalizeEmail(email), otp);
            console.log(`[auth-api] dev sign-in OTP for ${email}: ${otp}`);
            return;
          }

          if (!env.EMAIL) {
            throw new Error("EMAIL send binding is not configured");
          }
          const send = env.EMAIL.send(
            buildOtpEmail({ email, otp, baseURL: env.BETTER_AUTH_URL })
          ).catch((err) => {
            console.error("[auth-api] OTP email send failed", err);
          });
          // Don't block the response on delivery (per the plugin's own
          // guidance: awaiting leaks a timing signal and slows the endpoint);
          // waitUntil keeps the send alive after the response is returned.
          if (executionCtx) executionCtx.waitUntil(send);
          else await send;
        },
      }),
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
    // 60-day rolling sessions (refreshed at most daily): active users stay
    // signed in indefinitely, idle sessions die after 60 days. Applies to
    // Google and email-OTP sign-ins alike.
    session: {
      expiresIn: 60 * 60 * 24 * 60,
      updateAge: 60 * 60 * 24,
    },
    // Per-IP request limits (layer 2), persisted in D1 (0017_rate_limit.sql)
    // because in-memory counters reset with every workerd isolate. Enabled
    // in dev too so the e2e suite can assert the 429 behavior; server-side
    // auth.api calls (dev-login) bypass rate limiting by design.
    advanced: {
      ipAddress: {
        // Rate-limit keying. Better Auth's default is x-forwarded-for, whose
        // first entry is client-supplied (spoofable) behind Cloudflare;
        // cf-connecting-ip is set by the edge to the real client address and
        // can't be forged through it. Local dev has no real client IP —
        // every request would share one fallback bucket and e2e runs would
        // rate-limit each other — so tests isolate buckets by sending
        // x-test-client-ip, trusted ONLY when isLocalDev().
        ipAddressHeaders: isLocalDev(env)
          ? ["x-test-client-ip", "cf-connecting-ip"]
          : ["cf-connecting-ip"],
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/email-otp/send-verification-otp": {
          window: OTP_SEND_RATE_LIMIT.window,
          max: OTP_SEND_RATE_LIMIT.max,
        },
        "/sign-in/email-otp": {
          window: OTP_VERIFY_RATE_LIMIT.window,
          max: OTP_VERIFY_RATE_LIMIT.max,
        },
      },
    },
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
      session: {
        create: {
          // Lazy pilot bootstrap on every sign-in: ensure the account's
          // `pilot` row exists and claim any email-matching unlinked
          // pre-registrations (see pilot-bootstrap.ts). waitUntil keeps it
          // off the sign-in latency path when an ExecutionContext exists
          // (the main auth handler); dev-login constructs auth without one,
          // so tests get the bootstrap synchronously.
          after: async (session) => {
            const run = bootstrapPilotForUser(
              env.glidecomp_auth,
              session.userId
            );
            if (executionCtx) executionCtx.waitUntil(run);
            else await run;
          },
        },
      },
    },
  });
}
