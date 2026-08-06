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
 * The COUNTER itself is @glidecomp/worker-kit/rate-limit, shared with
 * auth-api: both workers write the same `rateLimit` table in the same D1
 * database, so the window semantics have to mean one thing. What lives here is
 * the part that is this worker's alone — which budgets exist, how big they
 * are, and why.
 */

import {
  chargeBudgetKey,
  peekBudgetKey,
  type Budget,
  type BudgetVerdict,
} from "@glidecomp/worker-kit/rate-limit";

export type { Budget, BudgetVerdict };

/** Keys share Better Auth's rateLimit table under this namespace. */
const KEY_PREFIX = "anon-igc:";

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

/** Where a budget's row lives. One place, so peek and charge cannot drift. */
function keyFor(scope: string, identity: string | number): string {
  return `${KEY_PREFIX}${scope}:${identity}`;
}

/**
 * Is there room for one more charge? Reads, never writes — this is how a
 * damage budget is charged late (only once a track is actually stored) while
 * still turning away something already at its cap before the body is read.
 */
export function peekBudget(
  db: D1Database,
  scope: string,
  identity: string | number,
  budget: Budget,
  now: number = Date.now()
): Promise<BudgetVerdict> {
  return peekBudgetKey(db, keyFor(scope, identity), budget, now);
}

/** Charge one attempt and report whether it is within budget. */
export function chargeBudget(
  db: D1Database,
  scope: string,
  identity: string | number,
  budget: Budget,
  now: number = Date.now()
): Promise<BudgetVerdict> {
  return chargeBudgetKey(db, keyFor(scope, identity), budget, now);
}
