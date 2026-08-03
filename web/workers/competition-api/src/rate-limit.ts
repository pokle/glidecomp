/**
 * Budgets for the anonymous track-submission endpoint.
 *
 * This is the only route in this worker that anyone can reach without an
 * account, and it is not a cheap one: it writes an object to R2, writes to D1,
 * and schedules a task rescore. So it gets budgets, and they are the kind that
 * bound damage rather than the kind that bound traffic.
 *
 * The unit worth protecting is A PILOT'S TRACK, not a request. Somebody who
 * can name a pilot can replace that pilot's file, so the tightest budget is
 * per registration: enough submissions that a pilot can fix a genuinely wrong
 * upload several times over, few enough that nobody can sit there rewriting
 * someone else's track all afternoon.
 *
 * Same mechanism as `auth-api/src/rate-limit.ts` — one atomic upsert against
 * the `rateLimit` table that migration 0017 already ships, in the same D1
 * database this worker is bound to. Deliberately not KV: KV is eventually
 * consistent with a ~1 write/s per-key ceiling, which is exactly the wrong
 * shape for a counter.
 */

/** Keys share Better Auth's rateLimit table under this namespace. */
const KEY_PREFIX = "anon-igc:";

export interface Budget {
  max: number;
  windowMs: number;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Per registration. Six is chosen from the pilot's side: land, upload the
 * wrong file, upload the right one, discover the logger split the flight,
 * upload again — that is four on a bad day. Six leaves room and still stops a
 * griefer.
 */
export const ANON_SUBMIT_PER_PILOT: Budget = { max: 6, windowMs: DAY_MS };

/**
 * Per competition. MAX_PILOTS_PER_TASK is 250, so 300 a day is above anything
 * a real comp does while still capping a flood aimed at one event.
 */
export const ANON_SUBMIT_PER_COMP: Budget = { max: 300, windowMs: DAY_MS };

/**
 * Per client address, charged ONLY when an identifier matched nobody.
 *
 * Without this, the endpoint answers "is this email registered for this
 * comp?" as fast as you can ask. National IDs are already public on the
 * roster so nothing leaks there, but email addresses are not, and a miss
 * budget is what keeps the endpoint from becoming a way to test them.
 */
export const ANON_SUBMIT_MISSES: Budget = { max: 20, windowMs: DAY_MS };

/**
 * Per signed-in account, on the registration resolver.
 *
 * That endpoint is read-only and requires an account, so it needs no damage
 * budget — but it does disclose MASKED addresses from a comp's unclaimed
 * roster, and it can be pointed at any competition. Sixty a day is far more
 * than a pilot at a six-day comp will ever use and far less than an
 * enumeration sweep needs.
 */
export const RESOLVE_PER_USER: Budget = { max: 60, windowMs: DAY_MS };

export interface BudgetVerdict {
  allowed: boolean;
  /** Seconds until the window resets, for `Retry-After`. */
  retryAfterSeconds: number;
}

/**
 * Charge one attempt against `key` and report whether it is within budget.
 *
 * Fixed window anchored at the first attempt: `lastRequest` holds the window
 * start and `count` the attempts in it; an attempt after the window expires
 * resets both. One atomic upsert (UNIQUE index on "key"), so two concurrent
 * requests cannot both read a stale count and slip past the cap.
 */
export async function chargeBudget(
  db: D1Database,
  scope: string,
  identity: string | number,
  budget: Budget,
  now: number = Date.now()
): Promise<BudgetVerdict> {
  const key = `${KEY_PREFIX}${scope}:${identity}`;
  const windowStart = now - budget.windowMs;

  const row = await db
    .prepare(
      `INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest") VALUES (?1, ?2, 1, ?3)
       ON CONFLICT("key") DO UPDATE SET
         "count" = CASE WHEN "rateLimit"."lastRequest" <= ?4 THEN 1 ELSE "rateLimit"."count" + 1 END,
         "lastRequest" = CASE WHEN "rateLimit"."lastRequest" <= ?4 THEN excluded."lastRequest" ELSE "rateLimit"."lastRequest" END
       RETURNING "count", "lastRequest"`
    )
    .bind(crypto.randomUUID(), key, now, windowStart)
    .first<{ count: number; lastRequest: number }>();

  const count = row?.count ?? 1;
  const windowOpenedAt = row?.lastRequest ?? now;
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((windowOpenedAt + budget.windowMs - now) / 1000)
  );

  return { allowed: count <= budget.max, retryAfterSeconds };
}
