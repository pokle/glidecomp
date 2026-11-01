/**
 * Which competitions a caller may see: as a SQL fragment for a search, and as
 * a yes/no for a route handed one competition's id.
 *
 * A hidden (`test`) comp is never DISCOVERABLE except by its own admins (and
 * super admins): every endpoint that can name a competition it was not given
 * the id of — the comp list, the 404 page's lookup, the search box, the
 * sitemap — applies `visibleCompsFilter` or `test = 0`, or it becomes the way
 * to find a hidden competition.
 *
 * Given the id, a hidden comp can be READ by its admins and by anyone whose
 * link carries its share key (`hiddenFromViewer`, see share-key.ts). The id
 * alone opens nothing — ids are sequential in a public encoding, so knowing
 * one proves nothing. WRITES stay admin-only (`hiddenFromCaller`): a shared
 * link is for looking at a draft, not for changing it.
 */
import type { AuthUser } from "./env";
import { isCompAdmin, isSuperAdmin } from "./super-admin";
import { shareKeyMatches } from "./share-key";

/**
 * Whether a READ of a hidden competition must answer this caller as a missing
 * one: true unless the caller administers it or presented its share key.
 *
 * Every read route handed a comp id goes through this, so the rule cannot
 * drift between them. `key` is `c.var.ids.comp_key`, which `sqidsMiddleware`
 * splits off the comp-id segment; `comp.share_key` is the comp's own.
 *
 * The key is checked before the admin lookup only because it needs no query.
 * A wrong key is no worse than none: 404 in the route's own not-found wording,
 * exactly as for a comp that does not exist.
 */
export async function hiddenFromViewer(
  db: D1Database,
  compId: number,
  comp: { test: number | boolean; share_key?: string | null },
  user: Pick<AuthUser, "id" | "email"> | null | undefined,
  key: string | undefined
): Promise<boolean> {
  if (!comp.test) return false;
  if (shareKeyMatches(key, comp.share_key)) return false;
  return !(await isCompAdmin(db, compId, user));
}

/**
 * Whether a WRITE to a hidden `test` competition must answer this caller as a
 * missing one. Reads use `hiddenFromViewer` above, which also honours the
 * share key; this deliberately does not. A `test` comp is the organiser's own
 * staging area — a pre-publish rehearsal, a draft shared for feedback, or one
 * of the synthetic fixtures `docs/sample-data.md` seeds.
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
