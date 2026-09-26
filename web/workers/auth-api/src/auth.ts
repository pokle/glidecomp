import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { emailOTP, jwt, oAuthProxy } from "better-auth/plugins";
import { AsyncLocalStorage } from "node:async_hooks";
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
type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

/**
 * The current request's ExecutionContext, for the two hooks that hand work to
 * `waitUntil` (the OTP email send and the pilot bootstrap).
 *
 * The Better Auth instance is built once per isolate (see createAuth), so it
 * cannot capture a request's context at construction the way it used to: that
 * would hand one request's work to another's lifetime. Async local storage
 * carries it to the hook instead. Outside runWithExecutionCtx() there is none,
 * and the hooks await their work inline — which is what dev-login, and the
 * tests that sign in through it, rely on.
 */
const executionCtxStore = new AsyncLocalStorage<WaitUntil>();

export function runWithExecutionCtx<T>(ctx: WaitUntil, fn: () => T): T {
  return executionCtxStore.run(ctx, fn);
}

async function inBackground(work: Promise<unknown>): Promise<void> {
  const ctx = executionCtxStore.getStore();
  if (ctx) ctx.waitUntil(work);
  else await work;
}

/**
 * How long a signed-in browser's `session_data` cookie vouches for it before
 * someone reads D1 again. It is also how long a revoked session, or a sign-out
 * on another device, keeps working — the price of not asking D1 on every
 * request. Five minutes is Better Auth's own default.
 */
export const SESSION_CACHE_MAX_AGE_S = 5 * 60;

/** How long an isolate trusts its copy of the `jwks` table. */
const JWKS_CACHE_MS = 5 * 60 * 1000;

type JwkRow = {
  id: string;
  publicKey: string;
  privateKey: string;
  createdAt: Date;
  expiresAt?: Date;
  alg?: "EdDSA" | "ES256" | "ES512" | "PS256" | "RS256";
  crv?: "Ed25519" | "P-256" | "P-521";
};

/**
 * The jwt plugin reads the whole `jwks` table every time it signs or checks a
 * session-cache cookie — one D1 query per `/me`, which is the very cost the
 * cookie cache is here to remove. The keys change only when one is minted, so
 * each isolate keeps a copy for a few minutes and drops it when it mints one
 * itself. An empty table is never cached: the first request after it fills
 * must see the key rather than mint a second.
 *
 * Another isolate's freshly minted key is at worst unknown here for
 * JWKS_CACHE_MS; a cookie signed with it then fails the cache check and falls
 * through to the D1 session read, which is where every request went before.
 */
function cachedJwksAdapter(db: D1Database) {
  let cached: { rows: JwkRow[]; at: number } | null = null;
  return {
    async getJwks(): Promise<JwkRow[]> {
      if (cached && Date.now() - cached.at < JWKS_CACHE_MS) return cached.rows;
      const { results } = await db
        .prepare('SELECT id, "publicKey", "privateKey", "createdAt", "expiresAt", alg, crv FROM jwks')
        .all<{
          id: string;
          publicKey: string;
          privateKey: string;
          createdAt: string;
          expiresAt: string | null;
          alg: string | null;
          crv: string | null;
        }>();
      const rows = results.map((r) => ({
        id: r.id,
        publicKey: r.publicKey,
        privateKey: r.privateKey,
        createdAt: new Date(r.createdAt),
        ...(r.expiresAt ? { expiresAt: new Date(r.expiresAt) } : {}),
        ...(r.alg ? { alg: r.alg as JwkRow["alg"] } : {}),
        ...(r.crv ? { crv: r.crv as JwkRow["crv"] } : {}),
      }));
      cached = rows.length > 0 ? { rows, at: Date.now() } : null;
      return rows;
    },
    async createJwk(data: Omit<JwkRow, "id">): Promise<JwkRow> {
      const row: JwkRow = { ...data, id: crypto.randomUUID() };
      await db
        .prepare(
          'INSERT INTO jwks (id, "publicKey", "privateKey", "createdAt", "expiresAt", alg, crv) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .bind(
          row.id,
          row.publicKey,
          row.privateKey,
          row.createdAt.toISOString(),
          row.expiresAt?.toISOString() ?? null,
          row.alg ?? null,
          row.crv ?? null
        )
        .run();
      cached = null;
      return row;
    },
  };
}

/**
 * One Better Auth instance per isolate. Building it cost about 1 ms of CPU on
 * every request (0.34 ms to construct, the rest in its lazy init), for an
 * object that depends on nothing but `env` — which is the same object for
 * every request an isolate serves. Per-request state reaches it through its
 * arguments, and the ExecutionContext through runWithExecutionCtx().
 */
const instances = new WeakMap<AuthEnv, ReturnType<typeof buildAuth>>();

export function createAuth(env: AuthEnv) {
  let auth = instances.get(env);
  if (!auth) {
    auth = buildAuth(env);
    instances.set(env, auth);
  }
  return auth;
}

function buildAuth(env: AuthEnv) {
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
          await inBackground(send);
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
      // Signs the session-cache cookie (session.cookieCache below) with an
      // asymmetric key instead of BETTER_AUTH_SECRET, so competition-api and
      // the SSR Function can check it with the PUBLIC key from
      // /api/auth/jwks and never hold anything that can sign a session.
      // The private key lives in the `jwks` table, encrypted with the secret.
      jwt({
        sessionCookieCache: true,
        // The plugin's other product — a JS-readable JWT on every
        // get-session response, and at /api/auth/token — has no caller here.
        // Nothing mints one (index.ts 404s /token); nothing would verify one.
        disableSettingJwtHeader: true,
        adapter: cachedJwksAdapter(env.glidecomp_auth),
      }),
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
    //
    // cookieCache: every D1 session read also sets a `session_data` cookie —
    // a JWT of the session and user, signed by the jwt plugin above — that
    // vouches for the browser for SESSION_CACHE_MAX_AGE_S. /me answers from
    // it without touching D1, and competition-api and the SSR Function check
    // it themselves (@glidecomp/worker-kit/session-cookie) without calling
    // /me at all. Anything that writes "user" directly must re-issue it, or
    // the old values are served until it expires (see refreshSessionCache in
    // index.ts).
    session: {
      expiresIn: 60 * 60 * 24 * 60,
      updateAge: 60 * 60 * 24,
      cookieCache: {
        enabled: true,
        maxAge: SESSION_CACHE_MAX_AGE_S,
        strategy: "jwt",
      },
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
      database: {
        // Better Auth 1.7.3 added validation of the live schema against
        // the one its configuration expects, before every `auth.api.*` call
        // and every request through `auth.handler`. It cannot run on D1: the
        // Kysely SQLite introspector reads `sqlite_master`, which D1 refuses
        // with `not authorized: SQLITE_AUTH`. Left on, the check throws on
        // the first query of every request, so nobody can sign in at all —
        // and because a check that FAILED is never cached (only a clean one
        // is), that is one doomed D1 round trip per request, forever.
        //
        // In no changelog. Reported upstream at better-auth#11346; when
        // that closes, re-test before deleting this line rather than
        // trusting the release note — the two D1 `SQLITE_AUTH` issues
        // better-auth has ALREADY fixed (#10551, #10976, August 2026) were
        // the MIGRATION path, and this check landed after them
        // (#11168/#11178, September) and reintroduced the same
        // incompatibility on a different code path. "Fixes D1" has meant
        // the other path before.
        //
        // Nothing is lost by turning it off. This schema is not generated by
        // Better Auth's CLI: it is hand-written in web/db/migrations and
        // applied by wrangler, and the drift the check exists to catch is
        // what test/schema.test.ts asserts instead — table by table, column
        // by column, against the very same getAuthTables() the check reads,
        // over PRAGMA table_info, which D1 does allow.
        validateSchema: false,
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
          // (the main auth handler); dev-login runs outside one, so tests
          // get the bootstrap synchronously.
          after: async (session) => {
            await inBackground(
              bootstrapPilotForUser(env.glidecomp_auth, session.userId)
            );
          },
        },
      },
    },
  });
}
