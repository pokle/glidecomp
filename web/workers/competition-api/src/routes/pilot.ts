import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { updatePilotSchema, updateCompPilotSchema } from "../validators";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

export const pilotRoutes = new Hono<HonoEnv>()
  // ── GET /api/comp/pilot ── Get current user's pilot profile
  // (literal path — must be registered before /api/comp/:comp_id/pilot)
  .get("/api/comp/pilot", requireAuth, async (c) => {
    const user = c.var.user;

    const pilot = await c.env.DB.prepare(
      `SELECT pilot_id, user_id, name, civl_id, sporting_body_ids, phone, glider
       FROM pilot WHERE user_id = ?`
    )
      .bind(user.id)
      .first<Record<string, unknown>>();

    if (!pilot) {
      return c.json({
        name: user.name,
        civl_id: null,
        sporting_body_ids: null,
        phone: null,
        glider: null,
      });
    }

    return c.json({
      name: pilot.name,
      civl_id: pilot.civl_id ?? null,
      sporting_body_ids: pilot.sporting_body_ids
        ? JSON.parse(pilot.sporting_body_ids as string)
        : null,
      phone: pilot.phone ?? null,
      glider: pilot.glider ?? null,
    });
  })

  // ── PATCH /api/comp/pilot ── Update current user's pilot profile
  .patch(
    "/api/comp/pilot",
    requireAuth,
    zValidator("json", updatePilotSchema),
    async (c) => {
      const user = c.var.user;
      const body = c.req.valid("json");

      const existing = await c.env.DB.prepare(
        "SELECT pilot_id FROM pilot WHERE user_id = ?"
      )
        .bind(user.id)
        .first<{ pilot_id: number }>();

      if (!existing) {
        await c.env.DB.prepare(
          "INSERT INTO pilot (user_id, name) VALUES (?, ?)"
        )
          .bind(user.id, user.name)
          .run();
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.name !== undefined) {
        updates.push("name = ?");
        values.push(body.name);
      }
      if (body.civl_id !== undefined) {
        updates.push("civl_id = ?");
        values.push(body.civl_id);
      }
      if (body.sporting_body_ids !== undefined) {
        updates.push("sporting_body_ids = ?");
        values.push(
          body.sporting_body_ids
            ? JSON.stringify(body.sporting_body_ids)
            : null
        );
      }
      if (body.phone !== undefined) {
        updates.push("phone = ?");
        values.push(body.phone);
      }
      if (body.glider !== undefined) {
        updates.push("glider = ?");
        values.push(body.glider);
      }

      if (updates.length > 0) {
        values.push(user.id);
        await c.env.DB.prepare(
          `UPDATE pilot SET ${updates.join(", ")} WHERE user_id = ?`
        )
          .bind(...values)
          .run();
      }

      const pilot = await c.env.DB.prepare(
        `SELECT name, civl_id, sporting_body_ids, phone, glider
         FROM pilot WHERE user_id = ?`
      )
        .bind(user.id)
        .first<Record<string, unknown>>();

      return c.json({
        name: pilot!.name,
        civl_id: pilot!.civl_id ?? null,
        sporting_body_ids: pilot!.sporting_body_ids
          ? JSON.parse(pilot!.sporting_body_ids as string)
          : null,
        phone: pilot!.phone ?? null,
        glider: pilot!.glider ?? null,
      });
    }
  )

  // ── PATCH /api/comp/:comp_id/pilot/:comp_pilot_id ── Admin: update pilot class/details
  .patch(
    "/api/comp/:comp_id/pilot/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    zValidator("json", updateCompPilotSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const body = c.req.valid("json");

      // Verify comp_pilot exists in this comp
      const existing = await c.env.DB.prepare(
        "SELECT comp_pilot_id FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?"
      )
        .bind(compPilotId, compId)
        .first<{ comp_pilot_id: number }>();

      if (!existing) {
        return c.json({ error: "Pilot not found in this competition" }, 404);
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.pilot_class !== undefined) {
        // Validate the new class is valid for this comp
        const comp = await c.env.DB.prepare(
          "SELECT pilot_classes FROM comp WHERE comp_id = ?"
        )
          .bind(compId)
          .first<{ pilot_classes: string }>();

        const compClasses = JSON.parse(comp!.pilot_classes) as string[];
        if (!compClasses.includes(body.pilot_class)) {
          return c.json(
            { error: `Invalid pilot class. Must be one of: ${compClasses.join(", ")}` },
            400
          );
        }

        updates.push("pilot_class = ?");
        values.push(body.pilot_class);
      }
      if (body.team_name !== undefined) {
        updates.push("team_name = ?");
        values.push(body.team_name);
      }
      if (body.driver_contact !== undefined) {
        updates.push("driver_contact = ?");
        values.push(body.driver_contact);
      }
      if (body.first_start_order !== undefined) {
        updates.push("first_start_order = ?");
        values.push(body.first_start_order);
      }

      if (updates.length > 0) {
        values.push(compPilotId);
        await c.env.DB.prepare(
          `UPDATE comp_pilot SET ${updates.join(", ")} WHERE comp_pilot_id = ?`
        )
          .bind(...values)
          .run();
      }

      return c.json({ success: true });
    }
  )

  // ── GET /api/comp/:comp_id/pilot ── List registered pilots for a comp
  .get(
    "/api/comp/:comp_id/pilot",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();

      if (!comp) {
        return c.json({ error: "Not found" }, 404);
      }

      if (comp.test) {
        if (!user) {
          return c.json({ error: "Not found" }, 404);
        }
        const isAdmin = await c.env.DB.prepare(
          "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
        )
          .bind(compId, user.id)
          .first();
        if (!isAdmin) {
          return c.json({ error: "Not found" }, 404);
        }
      }

      const pilots = await c.env.DB.prepare(
        `SELECT comp_pilot_id, registered_pilot_name, pilot_class, team_name
         FROM comp_pilot WHERE comp_id = ?
         ORDER BY registered_pilot_name ASC`
      )
        .bind(compId)
        .all<{
          comp_pilot_id: number;
          registered_pilot_name: string;
          pilot_class: string;
          team_name: string | null;
        }>();

      return c.json({
        pilots: pilots.results.map((p) => ({
          comp_pilot_id: encodeId(alphabet, p.comp_pilot_id),
          name: p.registered_pilot_name,
          pilot_class: p.pilot_class,
          team_name: p.team_name,
        })),
      });
    }
  );
