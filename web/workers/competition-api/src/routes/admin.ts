/**
 * Super-admin-only routes: a directory of every registered user plus cheap
 * per-user stats (stored tracks/tasks, comps administered/flown). Gated by
 * the hardcoded allowlist in `../super-admin` — there is no comp-scoped
 * admin equivalent, since this spans every user in the system.
 */
import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { requireAuth } from "../middleware/auth";
import { isSuperAdmin } from "../super-admin";

type Variables = { user: AuthUser };
type HonoEnv = { Bindings: Env; Variables: Variables };

type UserRow = {
  id: string;
  name: string;
  email: string;
  username: string | null;
  image: string | null;
  email_verified: number;
  created_at: string;
  track_count: number;
  task_count: number;
  admin_comp_count: number;
  pilot_comp_count: number;
};

export const adminRoutes = new Hono<HonoEnv>()
  // ── GET /api/admin/whoami ── Cheap super-admin check (no DB query) for
  // gating UI, e.g. whether the dashboard shows a link to /api/admin/users.
  .get("/api/admin/whoami", requireAuth, async (c) => {
    return c.json({ is_super_admin: isSuperAdmin(c.var.user) });
  })

  // ── GET /api/admin/users ── List every registered user with cheap stats
  .get("/api/admin/users", requireAuth, async (c) => {
    if (!isSuperAdmin(c.var.user)) {
      return c.json({ error: "Forbidden" }, 403);
    }

    // Every stat is a correlated subquery against a table indexed on
    // user_id (user_track/user_task PKs, comp_admin PK, pilot.user_id
    // unique index) — cheap even as the user table grows.
    const rows = await c.env.DB.prepare(
      `SELECT
         u.id, u.name, u.email, u.username, u.image,
         u."emailVerified" as email_verified,
         u."createdAt" as created_at,
         (SELECT COUNT(*) FROM user_track ut WHERE ut.user_id = u.id) as track_count,
         (SELECT COUNT(*) FROM user_task utk WHERE utk.user_id = u.id) as task_count,
         (SELECT COUNT(*) FROM comp_admin ca WHERE ca.user_id = u.id) as admin_comp_count,
         (SELECT COUNT(*) FROM comp_pilot cp
            JOIN pilot p ON p.pilot_id = cp.pilot_id
            WHERE p.user_id = u.id) as pilot_comp_count
       FROM "user" u
       ORDER BY u."createdAt" DESC`
    ).all<UserRow>();

    const users = rows.results.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      username: r.username,
      image: r.image,
      email_verified: !!r.email_verified,
      created_at: r.created_at,
      is_super_admin: isSuperAdmin({ email: r.email }),
      track_count: r.track_count,
      task_count: r.task_count,
      admin_comp_count: r.admin_comp_count,
      pilot_comp_count: r.pilot_comp_count,
    }));

    return c.json({ users });
  });
