/**
 * API-key rate limit — single source of truth.
 *
 * The Better Auth `apiKey` plugin config in auth.ts enforces these values, and
 * the public API doc (docs/api.md) quotes them. e2e/api-doc.spec.ts asserts the
 * doc's stated limit against this constant, so the number in the doc can't
 * silently drift from what the worker actually enforces. Change it here and the
 * doc test tells you if the doc is now lying.
 */
export const API_KEY_RATE_LIMIT = {
  maxRequests: 60,
  timeWindowMs: 60_000,
} as const;

/**
 * Email-OTP rate limits — single source of truth, same pattern as above.
 *
 * Three layers (see docs/2026-07-14-email-otp-signin-plan.md §5):
 *  1. Per-code attempts: `allowedAttempts` in the emailOTP plugin (auth.ts).
 *  2. Per-IP request limits: Better Auth's built-in limiter (D1-backed via
 *     rateLimit.storage = "database") with the customRules below. `window`
 *     is in seconds — Better Auth's unit for rate-limit windows.
 *  3. Per-email send throttle: `registerOtpEmailSend` below, so a
 *     distributed abuser (many IPs) still can't bombard one inbox.
 */
export const OTP_SEND_RATE_LIMIT = { window: 60, max: 3 } as const;
export const OTP_VERIFY_RATE_LIMIT = { window: 60, max: 5 } as const;

/**
 * Per-address cap. 5 per 15 minutes (not the stingier 3 the plan draft had):
 * the sign-in page's resend button has a 60s cooldown, so a legitimately
 * struggling user (greylisted mail, wrong spam folder) can hit 3 in a few
 * minutes; 5 keeps them unblocked while still capping abuse at pennies.
 */
export const OTP_EMAIL_SEND_THROTTLE = {
  maxSends: 5,
  windowMs: 15 * 60_000,
} as const;

/** Throttle keys share Better Auth's rateLimit table under this namespace. */
const OTP_EMAIL_KEY_PREFIX = "otp-email:";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Record one OTP send for `email` and report whether it is within the
 * per-address throttle. Fixed window anchored at the first send:
 * `lastRequest` holds the window-start timestamp and `count` the sends in
 * that window; a send after the window expires resets both.
 *
 * Single atomic upsert (UNIQUE index on "key") so concurrent sends can't
 * both read a stale count and slip past the cap.
 */
export async function registerOtpEmailSend(
  db: D1Database,
  email: string,
  now: number = Date.now()
): Promise<boolean> {
  const key = OTP_EMAIL_KEY_PREFIX + normalizeEmail(email);
  const windowStart = now - OTP_EMAIL_SEND_THROTTLE.windowMs;
  const row = await db
    .prepare(
      `INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?1, ?2, 1, ?3)
       ON CONFLICT("key") DO UPDATE SET
         "count" = CASE WHEN "rateLimit"."lastRequest" <= ?4 THEN 1 ELSE "rateLimit"."count" + 1 END,
         "lastRequest" = CASE WHEN "rateLimit"."lastRequest" <= ?4 THEN excluded."lastRequest" ELSE "rateLimit"."lastRequest" END
       RETURNING "count"`
    )
    .bind(crypto.randomUUID(), key, now, windowStart)
    .first<{ count: number }>();
  return (row?.count ?? 1) <= OTP_EMAIL_SEND_THROTTLE.maxSends;
}
