/**
 * The fixed-window counter both Workers keep in D1.
 *
 * Every budget in GlideComp — anonymous submissions per pilot, per comp,
 * futile requests per IP, OTP sends per address — is the same mechanism:
 * one atomic upsert against the `rateLimit` table Better Auth's migration 0017
 * already ships, in the D1 database both Workers are bound to.
 *
 * That last part is why this is shared rather than merely similar. auth-api
 * and competition-api are not two implementations of one idea; they are two
 * writers of one table, and the window semantics (`lastRequest` holds the
 * WINDOW START, not the last attempt) have to mean the same thing in both or
 * the rows one writes are misread by the other.
 *
 * Deliberately not KV: KV is eventually consistent with a ~1 write/s per-key
 * ceiling, which is exactly the wrong shape for a counter.
 */

export interface Budget {
  /** Attempts allowed per window. */
  max: number;
  windowMs: number;
}

export interface BudgetVerdict {
  allowed: boolean;
  /** Seconds until the window resets, for `Retry-After`. */
  retryAfterSeconds: number;
}

function retryAfter(windowOpenedAt: number, budget: Budget, now: number): number {
  return Math.max(1, Math.ceil((windowOpenedAt + budget.windowMs - now) / 1000));
}

/**
 * Is there room for one more charge against `key`? Reads, never writes.
 *
 * This is how a damage budget can be charged late — only once the damage is
 * actually done — without giving up the route's cost rule: something already
 * at its cap is turned away here, before the body is read, and the caller
 * cannot move the counter by asking.
 *
 * Deliberately admits a small race — several concurrent requests can pass the
 * same peek and all go on to act. That is bounded by request concurrency and
 * harmless against budgets of a few per day, which still converge; the
 * alternative is a lock on a counter whose whole point is to be cheap.
 */
export async function peekBudgetKey(
  db: D1Database,
  key: string,
  budget: Budget,
  now: number = Date.now()
): Promise<BudgetVerdict> {
  const row = await db
    .prepare('SELECT "count", "lastRequest" FROM "rateLimit" WHERE "key" = ?')
    .bind(key)
    .first<{ count: number; lastRequest: number }>();

  // No row, or one whose window has expired, is a clean slate: the next charge
  // resets it, so it cannot be over budget.
  if (!row || row.lastRequest <= now - budget.windowMs) {
    return { allowed: true, retryAfterSeconds: 1 };
  }

  return {
    allowed: row.count < budget.max,
    retryAfterSeconds: retryAfter(row.lastRequest, budget, now),
  };
}

/**
 * Charge one attempt against `key` and report whether it is within budget.
 *
 * Fixed window anchored at the first attempt: `lastRequest` holds the window
 * start and `count` the attempts in it; an attempt after the window expires
 * resets both. One atomic upsert (UNIQUE index on "key"), so two concurrent
 * requests cannot both read a stale count and slip past the cap.
 */
export async function chargeBudgetKey(
  db: D1Database,
  key: string,
  budget: Budget,
  now: number = Date.now()
): Promise<BudgetVerdict> {
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

  return {
    allowed: count <= budget.max,
    retryAfterSeconds: retryAfter(windowOpenedAt, budget, now),
  };
}
