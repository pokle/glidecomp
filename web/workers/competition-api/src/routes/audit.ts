import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { optionalAuth } from "../middleware/auth";

type Variables = {
  user: AuthUser | null;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.coerce.number().int().positive().optional(),
  subject_type: z.enum(["comp", "task", "pilot", "track"]).optional(),
});

const DEFAULT_LIMIT = 50;

export const auditRoutes = new Hono<HonoEnv>()
  // ── GET /api/comp/:comp_id/audit ── List audit entries
  .get(
    "/api/comp/:comp_id/audit",
    optionalAuth,
    sqidsMiddleware,
    zValidator("query", auditQuerySchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const user = c.var.user;
      const { limit, before, subject_type } = c.req.valid("query");
      const alphabet = c.env.SQIDS_ALPHABET;

      // Test comps require admin access
      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();

      if (!comp) return c.json({ error: "Not found" }, 404);

      if (comp.test) {
        if (!user) return c.json({ error: "Not found" }, 404);
        const isAdmin = await c.env.DB.prepare(
          "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
        )
          .bind(compId, user.id)
          .first();
        if (!isAdmin) return c.json({ error: "Not found" }, 404);
      }

      const effectiveLimit = limit ?? DEFAULT_LIMIT;

      // Build the query. We over-fetch by 1 to determine has_more.
      const clauses: string[] = ["comp_id = ?"];
      const bindings: unknown[] = [compId];
      if (before !== undefined) {
        clauses.push("audit_id < ?");
        bindings.push(before);
      }
      if (subject_type) {
        clauses.push("subject_type = ?");
        bindings.push(subject_type);
      }
      bindings.push(effectiveLimit + 1);

      const rows = await c.env.DB.prepare(
        `SELECT audit_id, timestamp, actor_user_id, actor_name,
                subject_type, subject_id, subject_name, description
         FROM audit_log
         WHERE ${clauses.join(" AND ")}
         ORDER BY audit_id DESC
         LIMIT ?`
      )
        .bind(...bindings)
        .all<{
          audit_id: number;
          timestamp: string;
          actor_user_id: string | null;
          actor_name: string;
          subject_type: string;
          subject_id: number | null;
          subject_name: string | null;
          description: string;
        }>();

      const all = rows.results;
      const hasMore = all.length > effectiveLimit;
      const entries = hasMore ? all.slice(0, effectiveLimit) : all;
      const nextBefore = hasMore ? entries[entries.length - 1].audit_id : null;

      return c.json({
        entries: entries.map((e) => ({
          audit_id: e.audit_id,
          timestamp: e.timestamp,
          actor_name: e.actor_name,
          subject_type: e.subject_type,
          // Encode subject_id so the frontend can link to sqids routes
          // (task_id, comp_pilot_id, etc.). The encoding is ambiguous across
          // subject types but matches the route pattern each type uses.
          subject_id:
            e.subject_id !== null ? encodeId(alphabet, e.subject_id) : null,
          subject_name: e.subject_name,
          description: e.description,
        })),
        has_more: hasMore,
        next_before: nextBefore,
      });
    }
  );
