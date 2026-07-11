import { Hono } from "hono";
import { z } from "zod";
import type { Env, AuthUser } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { validated } from "../validators";
import { audit } from "../audit";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

// Generous ceiling — a big regional database is a few hundred points; 5000
// keeps a pathological upload from bloating the row while never binding a real
// comp. Mirrors the engine's WaypointFileRecord shape so the frontend can
// round-trip parsed files straight through without a mapping layer.
const MAX_WAYPOINTS = 5000;
const MAX_TEXT = 128;

const waypointSchema = z.object({
  code: z.string().min(1).max(MAX_TEXT),
  name: z.string().max(MAX_TEXT),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  altitude: z.number().min(-2000).max(30000),
  radius: z.number().min(0).max(1_000_000),
});

const waypointsBodySchema = z.object({
  waypoints: z.array(waypointSchema).max(MAX_WAYPOINTS),
});

/**
 * Competition waypoint database (issue #312). One JSON blob per comp that
 * tasks pick from. Not a scoring input — tasks snapshot their turnpoints into
 * their own xctsk — so mutations audit but never bump scores.
 */
export const waypointsRoutes = new Hono<HonoEnv>()
  // ── GET — the comp's waypoints (public, minus hidden test comps) ──
  .get("/api/comp/:comp_id/waypoints", optionalAuth, sqidsMiddleware, async (c) => {
    const compId = c.var.ids.comp_id!;
    const comp = await c.env.DB.prepare("SELECT comp_id, test FROM comp WHERE comp_id = ?")
      .bind(compId)
      .first<{ comp_id: number; test: number }>();
    if (!comp) return c.json({ error: "Not found" }, 404);
    if (comp.test) {
      // Hidden test comps 404 for everyone but their admins (mirrors task GET).
      if (!c.var.user || !(await isCompAdmin(c.env.DB, compId, c.var.user))) {
        return c.json({ error: "Not found" }, 404);
      }
    }

    const row = await c.env.DB.prepare(
      "SELECT waypoints, updated_at FROM comp_waypoints WHERE comp_id = ?"
    )
      .bind(compId)
      .first<{ waypoints: string; updated_at: string }>();

    return c.json({
      waypoints: row ? (JSON.parse(row.waypoints) as unknown[]) : [],
      updated_at: row?.updated_at ?? null,
    });
  })

  // ── PUT — replace the comp's waypoints (admin only) ──
  .put(
    "/api/comp/:comp_id/waypoints",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", waypointsBodySchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const { waypoints } = c.req.valid("json");

      const comp = await c.env.DB.prepare("SELECT name FROM comp WHERE comp_id = ?")
        .bind(compId)
        .first<{ name: string }>();
      const prev = await c.env.DB.prepare(
        "SELECT waypoints FROM comp_waypoints WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ waypoints: string }>();
      const prevCount = prev ? (JSON.parse(prev.waypoints) as unknown[]).length : 0;

      const now = new Date().toISOString();
      await c.env.DB.prepare(
        `INSERT INTO comp_waypoints (comp_id, waypoints, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(comp_id) DO UPDATE SET waypoints = excluded.waypoints, updated_at = excluded.updated_at`
      )
        .bind(compId, JSON.stringify(waypoints), now)
        .run();

      // Audited, but not a scoring input (tasks freeze their own turnpoints).
      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "comp",
        subject_id: compId,
        subject_name: comp?.name ?? "Competition",
        description:
          prevCount === waypoints.length
            ? `Edited competition waypoints (${waypoints.length})`
            : `Updated competition waypoints (${prevCount} → ${waypoints.length})`,
      });

      return c.json({ ok: true, count: waypoints.length, updated_at: now });
    }
  );
