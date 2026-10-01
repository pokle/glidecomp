import {
  chargeBudgetKey,
  peekBudgetKey,
  type BudgetVerdict,
} from "@glidecomp/worker-kit/rate-limit";

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
 * Four layers (see docs/2026-07-14-email-otp-signin-plan.md §5):
 *  1. Per-code attempts: `allowedAttempts` in the emailOTP plugin (auth.ts).
 *  2. Per-IP request limits: Better Auth's built-in limiter (D1-backed via
 *     rateLimit.storage = "database") with the customRules below. `window`
 *     is in seconds — Better Auth's unit for rate-limit windows.
 *  3. Per-email send throttle: `otpSendAllowed` / `registerOtpEmailSend`
 *     below, so a distributed abuser (many IPs) can neither bombard one inbox
 *     nor mint fresh codes to guess at (SEC-56).
 *  4. Per-email failure budget: `otpVerifyAllowed` /
 *     `registerOtpVerifyFailure` below (SEC-56).
 *
 * Layers 3 and 4 are keyed on the ACCOUNT rather than the caller, and each is
 * checked in index.ts before the request reaches Better Auth. That ordering
 * is the point. Better Auth mints and stores a new code, with a fresh set of
 * attempts, BEFORE it calls our sendVerificationOTP hook, so when layer 3
 * lived only inside that hook it withheld the email but not the code: every
 * refused request still handed a guesser three more tries. Layer 2 cannot
 * stop that guesser on its own, because it counts per client address (per /64
 * for IPv6), and a free IPv6 /48 is 65,536 of those.
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

/**
 * Per-address budget of WRONG codes, across every caller (SEC-56).
 *
 * Charged only when a sign-in code is refused, so someone who types their code
 * correctly never touches it. Ten in an hour is more fumbling than a person
 * does, and holds a distributed guesser to 240 tries a day against a
 * million-code space, each cycle of which emails the owner a code they did not
 * ask for. Once spent, sign-in by code for that address answers 429 until the
 * window ends, whoever asks; Google sign-in is unaffected.
 *
 * Keep the window at or under a day: the nightly purge
 * (competition-api data-retention.ts) drops rate-limit rows older than two.
 */
export const OTP_VERIFY_FAILURE_BUDGET = {
  max: 10,
  windowMs: 60 * 60_000,
} as const;

/** Throttle keys share Better Auth's rateLimit table under these namespaces. */
const OTP_EMAIL_KEY_PREFIX = "otp-email:";
const OTP_FAIL_KEY_PREFIX = "otp-fail:";

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const OTP_EMAIL_SEND_BUDGET = {
  max: OTP_EMAIL_SEND_THROTTLE.maxSends,
  windowMs: OTP_EMAIL_SEND_THROTTLE.windowMs,
};

/**
 * Record one OTP send for `email` and report whether it is within the
 * per-address throttle. The counter is the shared fixed-window one (see
 * @glidecomp/worker-kit/rate-limit); this names the key and the budget.
 *
 * Charged in the sendVerificationOTP hook, where it decides whether an email
 * goes out. Whether a CODE is minted is decided earlier, by
 * `otpSendAllowed` in index.ts.
 */
export async function registerOtpEmailSend(
  db: D1Database,
  email: string,
  now: number = Date.now()
): Promise<boolean> {
  const verdict = await chargeBudgetKey(
    db,
    OTP_EMAIL_KEY_PREFIX + normalizeEmail(email),
    OTP_EMAIL_SEND_BUDGET,
    now
  );
  return verdict.allowed;
}

/**
 * Is there room for one more code for `email`? Reads, never writes, so it can
 * run before Better Auth's own validation and per-IP limiter without letting a
 * request they would refuse leave a row behind. The charge stays in the hook,
 * where only a request Better Auth accepted reaches it.
 */
export async function otpSendAllowed(
  db: D1Database,
  email: string,
  now: number = Date.now()
): Promise<boolean> {
  const verdict = await peekBudgetKey(
    db,
    OTP_EMAIL_KEY_PREFIX + normalizeEmail(email),
    OTP_EMAIL_SEND_BUDGET,
    now
  );
  return verdict.allowed;
}

/**
 * May `email` try another sign-in code? Reads, never writes — the budget is
 * charged only once a code has actually been refused
 * (`registerOtpVerifyFailure`), so asking cannot move it.
 */
export async function otpVerifyAllowed(
  db: D1Database,
  email: string,
  now: number = Date.now()
): Promise<BudgetVerdict> {
  return peekBudgetKey(db, OTP_FAIL_KEY_PREFIX + normalizeEmail(email), OTP_VERIFY_FAILURE_BUDGET, now);
}

/** Charge one refused sign-in code against `email`'s failure budget. */
export async function registerOtpVerifyFailure(
  db: D1Database,
  email: string,
  now: number = Date.now()
): Promise<void> {
  await chargeBudgetKey(db, OTP_FAIL_KEY_PREFIX + normalizeEmail(email), OTP_VERIFY_FAILURE_BUDGET, now);
}
