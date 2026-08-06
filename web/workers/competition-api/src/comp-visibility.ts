/**
 * Which competitions a caller may see: as a SQL fragment for a search, and as
 * a yes/no for a route handed one competition's id.
 *
 * `test` comps are hidden from everyone except their own admins (and super
 * admins). Every endpoint that can name a competition it was not given the id
 * of — the 404 page's lookup, the search box — has to apply the same rule, or
 * it becomes the way to discover a hidden competition. Every endpoint that
 * WAS given the id has to apply it too, or knowing the id becomes the way in.
 */
import type { AuthUser } from "./env";
import { isCompAdmin, isSuperAdmin } from "./super-admin";

/**
 * Whether a hidden `test` competition must answer this caller as a missing one.
 *
 * The single-competition counterpart of `visibleCompsFilter` below, for the
 * routes that are handed an id rather than searching for one. A `test` comp is
 * the organiser's own staging area — a pre-publish rehearsal, or one of the
 * synthetic fixtures `docs/sample-data.md` seeds.
 *
 * The read routes have always gated on the flag, and so has the anonymous
 * submit; the WRITE routes did not (SEC-37/38), so any account that knew or
 * guessed the id could read a hidden roster through `registration/resolve` and
 * write a track, a manual flight or a pilot status into a hidden competition.
 * Being signed in is not a claim to a competition.
 *
 * A caller who fails this gets a 404 in the route's own not-found wording
 * rather than a 403, because "you may not" still says the competition exists.
 * `test` is precisely the flag that says it does not — to you.
 *
 * Admins are the exception the flag is for: an organiser rehearsing a
 * competition has to be able to run it, or the rehearsal proves nothing.
 */
export async function hiddenFromCaller(
  db: D1Database,
  compId: number,
  test: number | boolean,
  user: Pick<AuthUser, "id" | "email"> | null | undefined
): Promise<boolean> {
  if (!test) return false;
  return !(await isCompAdmin(db, compId, user));
}

/**
 * SQL restricting a query to the comps this caller may see, plus its binds.
 * `compAlias` is the alias the `comp` table has in the caller's query.
 *
 * Mirrors the comp routes: everything non-`test`, plus the `test` comps the
 * caller administers (all of them, for a super admin).
 */
export async function visibleCompsFilter(
  db: D1Database,
  user: AuthUser | null,
  compAlias: string
): Promise<{ sql: string; binds: unknown[] }> {
  if (isSuperAdmin(user)) return { sql: "1 = 1", binds: [] };
  if (!user) return { sql: `${compAlias}.test = 0`, binds: [] };
  const rows = await db
    .prepare("SELECT comp_id FROM comp_admin WHERE user_id = ?")
    .bind(user.id)
    .all<{ comp_id: number }>();
  const ids = rows.results.map((r) => r.comp_id);
  if (ids.length === 0) return { sql: `${compAlias}.test = 0`, binds: [] };
  const placeholders = ids.map(() => "?").join(",");
  return {
    sql: `(${compAlias}.test = 0 OR ${compAlias}.comp_id IN (${placeholders}))`,
    binds: ids,
  };
}
