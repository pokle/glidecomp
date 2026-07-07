import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { createTaskSchema, updateTaskSchema } from "../validators";
import { audit, describeChange } from "../audit";
import { summarizeXctskChange, describeTaskSummary } from "../xctsk-summary";
import { timezoneForXctsk } from "@glidecomp/engine/timezone";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

const MAX_TASKS_PER_COMP = 50;

/**
 * Validate a task's geometry against the competition's scoring format.
 *
 * Open-distance competitions score from the take-off exit with no goal, so
 * every task must define exactly one turnpoint, typed TAKEOFF. GAP tasks are
 * unconstrained here. Returns an error message, or null when the geometry is
 * acceptable (including when no route is set yet).
 */
function validateTaskGeometryForFormat(
  scoringFormat: string,
  xctsk: { turnpoints?: { type?: string }[] } | null | undefined
): string | null {
  if (scoringFormat !== "open_distance" || !xctsk) return null;
  const turnpoints = xctsk.turnpoints ?? [];
  if (turnpoints.length !== 1 || turnpoints[0]?.type !== "TAKEOFF") {
    return "Open distance tasks must have exactly one turnpoint, of type Takeoff.";
  }
  return null;
}

/**
 * Fill in the comp's timezone from a just-saved route's location (#269).
 * Write-time derivation: only runs while comp.timezone is NULL, so an
 * explicit organizer setting (or an earlier derivation) is never
 * overwritten. Purely presentational — scoring runs on UTC regardless.
 */
async function deriveCompTimezone(
  db: D1Database,
  user: AuthUser | null | undefined,
  compId: number,
  xctsk: unknown
): Promise<void> {
  const comp = await db
    .prepare("SELECT name, timezone FROM comp WHERE comp_id = ?")
    .bind(compId)
    .first<{ name: string; timezone: string | null }>();
  if (!comp || comp.timezone !== null) return;
  const zone = timezoneForXctsk(xctsk);
  if (!zone) return;
  await db
    .prepare("UPDATE comp SET timezone = ? WHERE comp_id = ?")
    .bind(zone, compId)
    .run();
  await audit(db, user, compId, {
    subject_type: "comp",
    subject_id: compId,
    subject_name: comp.name,
    description: `Set timezone to "${zone}" (derived from the task location; adjustable in Competition Settings)`,
  });
}

export const taskRoutes = new Hono<HonoEnv>()
  // ── POST /api/comp/:comp_id/task ── Create task
  .post(
    "/api/comp/:comp_id/task",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    zValidator("json", createTaskSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      // Verify comp exists
      const comp = await c.env.DB.prepare(
        "SELECT pilot_classes, scoring_format FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ pilot_classes: string; scoring_format: string }>();

      if (!comp) {
        return c.json({ error: "Competition not found" }, 404);
      }

      // Validate pilot_classes are valid for this comp
      const compClasses = JSON.parse(comp.pilot_classes) as string[];
      const invalidClasses = body.pilot_classes.filter(
        (cls) => !compClasses.includes(cls)
      );
      if (invalidClasses.length > 0) {
        return c.json(
          {
            error: `Invalid pilot classes: ${invalidClasses.join(", ")}. Must be one of: ${compClasses.join(", ")}`,
          },
          400
        );
      }

      // Validate task geometry against the comp's scoring format
      const geometryError = validateTaskGeometryForFormat(
        comp.scoring_format,
        body.xctsk
      );
      if (geometryError) {
        return c.json({ error: geometryError }, 400);
      }

      // Enforce task limit
      const countRow = await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM task WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ cnt: number }>();

      if (countRow && countRow.cnt >= MAX_TASKS_PER_COMP) {
        return c.json(
          { error: `Maximum ${MAX_TASKS_PER_COMP} tasks per competition` },
          400
        );
      }

      const now = new Date().toISOString();

      const taskResult = await c.env.DB.prepare(
        `INSERT INTO task (comp_id, name, task_date, creation_date, xctsk)
         VALUES (?, ?, ?, ?, ?)`
      )
        .bind(
          compId,
          body.name,
          body.task_date,
          now,
          body.xctsk ? JSON.stringify(body.xctsk) : null
        )
        .run();

      const taskId = taskResult.meta.last_row_id;

      // Insert task_class entries
      if (body.pilot_classes.length > 0) {
        const batch = body.pilot_classes.map((cls) =>
          c.env.DB.prepare(
            "INSERT INTO task_class (task_id, pilot_class) VALUES (?, ?)"
          ).bind(taskId, cls)
        );
        await c.env.DB.batch(batch);
      }

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "task",
        subject_id: taskId,
        subject_name: body.name,
        description: `Created task "${body.name}" (${body.task_date}, classes: ${body.pilot_classes.join(", ")})`,
      });

      if (body.xctsk) {
        await deriveCompTimezone(c.env.DB, c.var.user, compId, body.xctsk);
      }

      return c.json(
        {
          task_id: encodeId(alphabet, taskId),
          comp_id: encodeId(alphabet, compId),
          name: body.name,
          task_date: body.task_date,
          creation_date: now,
          xctsk: body.xctsk ?? null,
          has_xctsk: !!body.xctsk,
          pilot_classes: body.pilot_classes,
        },
        201
      );
    }
  )

  // ── GET /api/comp/:comp_id/task/:task_id ── Get task details
  .get(
    "/api/comp/:comp_id/task/:task_id",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      // Check comp exists and handle test visibility
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
        if (!(await isCompAdmin(c.env.DB, compId, user))) {
          return c.json({ error: "Not found" }, 404);
        }
      }

      const task = await c.env.DB.prepare(
        `SELECT task_id, comp_id, name, task_date, creation_date, xctsk
         FROM task WHERE task_id = ? AND comp_id = ?`
      )
        .bind(taskId, compId)
        .first<Record<string, unknown>>();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      // Get task classes
      const tc = await c.env.DB.prepare(
        "SELECT pilot_class FROM task_class WHERE task_id = ?"
      )
        .bind(taskId)
        .all<{ pilot_class: string }>();

      // Get track count
      const trackCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM task_track WHERE task_id = ?"
      )
        .bind(taskId)
        .first<{ cnt: number }>();

      return c.json({
        task_id: encodeId(alphabet, task.task_id as number),
        comp_id: encodeId(alphabet, task.comp_id as number),
        name: task.name,
        task_date: task.task_date,
        creation_date: task.creation_date,
        xctsk: task.xctsk ? JSON.parse(task.xctsk as string) : null,
        pilot_classes: tc.results.map((r) => r.pilot_class),
        track_count: trackCount?.cnt ?? 0,
      });
    }
  )

  // ── PATCH /api/comp/:comp_id/task/:task_id ── Update task
  .patch(
    "/api/comp/:comp_id/task/:task_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    zValidator("json", updateTaskSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      // Verify task exists and belongs to comp; capture current state for audit
      const task = await c.env.DB.prepare(
        "SELECT task_id, name, task_date, xctsk FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{
          task_id: number;
          name: string;
          task_date: string;
          xctsk: string | null;
        }>();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      // If a route is being set, validate it against the comp's scoring format
      if (body.xctsk) {
        const comp = await c.env.DB.prepare(
          "SELECT scoring_format FROM comp WHERE comp_id = ?"
        )
          .bind(compId)
          .first<{ scoring_format: string }>();
        const geometryError = validateTaskGeometryForFormat(
          comp?.scoring_format ?? "gap",
          body.xctsk
        );
        if (geometryError) {
          return c.json({ error: geometryError }, 400);
        }
      }

      // Fetch current pilot classes for audit diff
      const currentClassesRes = await c.env.DB.prepare(
        "SELECT pilot_class FROM task_class WHERE task_id = ?"
      )
        .bind(taskId)
        .all<{ pilot_class: string }>();
      const currentClasses = currentClassesRes.results
        .map((r) => r.pilot_class)
        .sort();

      // Validate pilot_classes if provided
      if (body.pilot_classes) {
        const comp = await c.env.DB.prepare(
          "SELECT pilot_classes FROM comp WHERE comp_id = ?"
        )
          .bind(compId)
          .first<{ pilot_classes: string }>();

        if (!comp) return c.json({ error: "Competition not found" }, 404);

        const compClasses = JSON.parse(comp.pilot_classes) as string[];
        const invalidClasses = body.pilot_classes.filter(
          (cls) => !compClasses.includes(cls)
        );
        if (invalidClasses.length > 0) {
          return c.json(
            {
              error: `Invalid pilot classes: ${invalidClasses.join(", ")}. Must be one of: ${compClasses.join(", ")}`,
            },
            400
          );
        }
      }

      // Build dynamic UPDATE
      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.name !== undefined) {
        updates.push("name = ?");
        values.push(body.name);
      }
      if (body.task_date !== undefined) {
        updates.push("task_date = ?");
        values.push(body.task_date);
      }
      if (body.xctsk !== undefined) {
        updates.push("xctsk = ?");
        values.push(body.xctsk ? JSON.stringify(body.xctsk) : null);
      }

      if (updates.length > 0) {
        values.push(taskId);
        await c.env.DB.prepare(
          `UPDATE task SET ${updates.join(", ")} WHERE task_id = ?`
        )
          .bind(...values)
          .run();
      }

      // Update task_class if provided
      if (body.pilot_classes) {
        await c.env.DB.prepare(
          "DELETE FROM task_class WHERE task_id = ?"
        )
          .bind(taskId)
          .run();

        if (body.pilot_classes.length > 0) {
          const batch = body.pilot_classes.map((cls) =>
            c.env.DB.prepare(
              "INSERT INTO task_class (task_id, pilot_class) VALUES (?, ?)"
            ).bind(taskId, cls)
          );
          await c.env.DB.batch(batch);
        }
      }

      // Emit audit entries per changed field
      const auditChanges: string[] = [];
      if (body.name !== undefined && body.name !== task.name) {
        auditChanges.push(describeChange("task name", task.name, body.name));
      }
      if (body.task_date !== undefined && body.task_date !== task.task_date) {
        auditChanges.push(describeChange("task date", task.task_date, body.task_date));
      }
      if (body.pilot_classes !== undefined) {
        const newClasses = [...body.pilot_classes].sort();
        if (JSON.stringify(newClasses) !== JSON.stringify(currentClasses)) {
          auditChanges.push(
            `Changed pilot classes from [${currentClasses.join(", ")}] to [${newClasses.join(", ")}]`
          );
        }
      }
      if (body.xctsk !== undefined) {
        const oldHasXctsk = task.xctsk !== null;
        const newHasXctsk = body.xctsk !== null;
        if (!oldHasXctsk && newHasXctsk) {
          auditChanges.push(
            `Set task route: ${describeTaskSummary(body.xctsk)}`
          );
        } else if (oldHasXctsk && !newHasXctsk) {
          auditChanges.push("Cleared task route");
        } else if (
          oldHasXctsk &&
          newHasXctsk &&
          task.xctsk !== JSON.stringify(body.xctsk)
        ) {
          const summary = summarizeXctskChange(task.xctsk, body.xctsk);
          auditChanges.push(
            summary ? `Updated task route: ${summary}` : "Updated task route"
          );
        }
      }

      const taskName = body.name ?? task.name;
      for (const description of auditChanges) {
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "task",
          subject_id: taskId,
          subject_name: taskName,
          description,
        });
      }

      if (body.xctsk) {
        await deriveCompTimezone(c.env.DB, c.var.user, compId, body.xctsk);
      }

      // Return updated task
      const updated = await c.env.DB.prepare(
        `SELECT task_id, comp_id, name, task_date, creation_date, xctsk
         FROM task WHERE task_id = ?`
      )
        .bind(taskId)
        .first<Record<string, unknown>>();

      if (!updated) return c.json({ error: "Task not found" }, 404);

      const tc = await c.env.DB.prepare(
        "SELECT pilot_class FROM task_class WHERE task_id = ?"
      )
        .bind(taskId)
        .all<{ pilot_class: string }>();

      return c.json({
        task_id: encodeId(alphabet, updated.task_id as number),
        comp_id: encodeId(alphabet, updated.comp_id as number),
        name: updated.name,
        task_date: updated.task_date,
        creation_date: updated.creation_date,
        xctsk: updated.xctsk ? JSON.parse(updated.xctsk as string) : null,
        pilot_classes: tc.results.map((r) => r.pilot_class),
      });
    }
  )

  // ── DELETE /api/comp/:comp_id/task/:task_id ── Delete task
  .delete(
    "/api/comp/:comp_id/task/:task_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;

      // Verify task exists and capture name for audit
      const task = await c.env.DB.prepare(
        "SELECT task_id, name FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{ task_id: number; name: string }>();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      // D1 cascade deletes handle task_class and task_track rows
      await c.env.DB.prepare("DELETE FROM task WHERE task_id = ?")
        .bind(taskId)
        .run();

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "task",
        subject_id: taskId,
        subject_name: task.name,
        description: `Deleted task "${task.name}"`,
      });

      // TODO (Iteration 9): Enqueue R2 cleanup via Cloudflare Queue

      return c.json({ success: true });
    }
  )

;

