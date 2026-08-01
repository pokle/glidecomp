/**
 * Which competitions a caller may see, as a SQL fragment.
 *
 * `test` comps are hidden from everyone except their own admins (and super
 * admins). Every endpoint that can name a competition it was not given the id
 * of — the 404 page's lookup, the search box — has to apply the same rule, or
 * it becomes the way to discover a hidden competition.
 */
import type { AuthUser } from "./env";
import { isSuperAdmin } from "./super-admin";

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
