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
 * ── Damage budgets ──────────────────────────────────────────────────────────
 *
 * Keyed on the thing being protected, so they are charged when the damage
 * happens — AFTER a track is stored, never on an attempt (SEC-39). A budget
 * keyed on a value the caller chooses and charged before the work it bounds is
 * a denial-of-service weapon against whoever owns that value: the identifiers
 * that name a competition and a registration are all public by design (the
 * comp id is in its own URL, and `GET /api/comp/:comp_id/pilot` publishes
 * every pilot's national IDs), so anyone could have spent someone else's
 * allowance without ever uploading a file.
 *
 * `peekBudget` is what preserves "cheapest rejections first" through that
 * move: a comp or pilot already at its cap is still turned away before the
 * body is read, on a read rather than the write this used to cost.
 */

/**
 * Per registration. Six is chosen from the pilot's side: land, upload the
 * wrong file, upload the right one, discover the logger split the flight,
 * upload again — that is four on a bad day. Six leaves room and still stops a
 * griefer.
 *
 * Six is small enough that charging it on attempt was the sharper half of
 * SEC-39: six empty POSTs naming one pilot's public CIVL id took that pilot's
 * whole day, on the one day the route exists for.
 */
export const ANON_SUBMIT_PER_PILOT: Budget = { max: 6, windowMs: DAY_MS };

/**
 * Per competition. MAX_PILOTS_PER_TASK is 250, so 300 a day is above anything
 * a real comp does while still capping a flood aimed at one event.
 */
export const ANON_SUBMIT_PER_COMP: Budget = { max: 300, windowMs: DAY_MS };

/**
 * ── Effort budget ───────────────────────────────────────────────────────────
 *
 * Per client address, charged on every request that ends WITHOUT a track
 * stored — a bad identifier, a comp or task that isn't there, a closed one, an
 * identifier matching nobody or too many, a file that won't parse.
 *
 * Keyed on the caller and charged on wasted work, which is what makes it safe
 * to be the only per-IP budget here. A successful submission costs nothing, so
 * a whole gaggle behind one landing-field connection or a CGNAT address can
 * submit all afternoon; only somebody generating failures pays. A budget on
 * every submission instead would 429 real pilots on exactly the day they need
 * this route.
 *
 * Supersedes the narrower miss-only budget, whose job it still does: without
 * it the endpoint answers "is this email registered for this comp?" as fast as
 * anyone can ask. National IDs are already public on the roster so nothing
 * leaks there, but email addresses are not.
 *
 * Forty rather than the old twenty because it now covers honest fumbling as
 * well as probing — a pilot who mistypes an identifier twice and then feeds it
 * a file their logger wrote badly should not be spending a probe allowance.
 * Still far below what an enumeration sweep needs.
 */
export const ANON_SUBMIT_FUTILE: Budget = { max: 40, windowMs: DAY_MS };

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

/** Where a budget's row lives. One place, so peek and charge cannot drift. */
function keyFor(scope: string, identity: string | number): string {
  return `${KEY_PREFIX}${scope}:${identity}`;
}

function retryAfter(windowOpenedAt: number, budget: Budget, now: number) {
  return Math.max(1, Math.ceil((windowOpenedAt + budget.windowMs - now) / 1000));
}

/**
 * Is there room for one more charge against `key`? Reads, never writes.
 *
 * This is how a damage budget can be charged late (only once a track is
 * actually stored) without giving up the route's cost rule: something already
 * at its cap is turned away here, before the body is read, and the caller
 * cannot move the counter by asking.
 *
 * Deliberately admits a small race — several concurrent requests can pass the
 * same peek and all go on to store. That is bounded by request concurrency and
 * harmless against budgets of 6 and 300 a day, which still converge; the
 * alternative is a lock on a counter whose whole point is to be cheap.
 */
export async function peekBudget(
  db: D1Database,
  scope: string,
  identity: string | number,
  budget: Budget,
  now: number = Date.now()
): Promise<BudgetVerdict> {
  const row = await db
    .prepare('SELECT "count", "lastRequest" FROM "rateLimit" WHERE "key" = ?')
    .bind(keyFor(scope, identity))
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
export async function chargeBudget(
  db: D1Database,
  scope: string,
  identity: string | number,
  budget: Budget,
  now: number = Date.now()
): Promise<BudgetVerdict> {
  const key = keyFor(scope, identity);
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
