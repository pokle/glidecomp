import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Env, AuthUser } from "../env";
import { requireAuth } from "../middleware/auth";
import { updatePilotSchema } from "../validators";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

export const pilotRoutes = new Hono<HonoEnv>()
  // ── GET /api/comp/pilot ── Get current user's pilot profile
  .get("/api/comp/pilot", requireAuth, async (c) => {
    const user = c.var.user;

    const pilot = await c.env.DB.prepare(
      `SELECT pilot_id, user_id, name, civl_id, sporting_body_ids, phone, glider
       FROM pilot WHERE user_id = ?`
    )
      .bind(user.id)
      .first<Record<string, unknown>>();

    if (!pilot) {
      // No pilot profile yet — return a default based on user info
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

      // Ensure pilot row exists
      const existing = await c.env.DB.prepare(
        "SELECT pilot_id FROM pilot WHERE user_id = ?"
      )
        .bind(user.id)
        .first<{ pilot_id: number }>();

      if (!existing) {
        // Create pilot profile, then apply updates
        await c.env.DB.prepare(
          "INSERT INTO pilot (user_id, name) VALUES (?, ?)"
        )
          .bind(user.id, user.name)
          .run();
      }

      // Build dynamic UPDATE
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

      // Return updated profile
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
  );
