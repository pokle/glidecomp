import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { createTaskSchema, updateTaskSchema, validated } from "../validators";
import { audit, auditAll, describeChange } from "../audit";
import {
  boolFromDb,
  boolToDb,
  deepChanged,
  planPatch,
  type PatchFieldTable,
} from "../lib/patch-fields";
import type { z } from "zod";
import { bumpAndRevalidateScores } from "../score-store";
import { summarizeXctskChange, describeTaskSummary } from "../xctsk-summary";
import { timezoneForXctsk } from "@glidecomp/engine/timezone";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

const MAX_TASKS_PER_COMP = 50;

/** First line (or 80 characters) of a block of prose, whitespace collapsed —
 * enough for an audit reader to recognise the change without the log entry
 * becoming the document. */
function excerpt(text: string, max = 80): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

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


/**
 * What each updatable task field means: where it is stored, and what a change
 * to it does to the audit log and to the published scores.
 *
 * Read the `bumpsScores` column down: the task's date, its scored classes and
 * its route feed the scored output; weather notes and the submissions-closed
 * flag deliberately do not. Weather notes are prose about the day and change
 * no score. Closing the task is not a scoring input either — nothing the
 * scorer reads depends on whether further evidence may arrive, and closing the
 * day does not retroactively change a single points figure. Both are still
 * audit-logged: the notes are published text attributed to the organisers, and
 * the close is the record that makes a later organiser upload legible rather
 * than mysterious.
 *
 * `pilot_classes` is absent from the table on purpose — it lives in
 * `task_class`, not on the task row, so its write and its diff are handled by
 * the caller.
 */
function taskFieldTable(
  normalisedStopTime: string | null | undefined
): PatchFieldTable<z.infer<typeof updateTaskSchema>> {
  return {
    name: {
      column: "name",
      describe: (was, now) => describeChange("task name", was, now),
    },
    task_date: {
      column: "task_date",
      describe: (was, now) => describeChange("task date", was, now),
      bumpsScores: true,
    },
    // Compared as PARSED routes, not as the stored strings: two encodings of
    // the same route are the same route, and only the summariser wants the
    // JSON back.
    xctsk: {
      column: "xctsk",
      toDb: (v) => (v ? JSON.stringify(v) : null),
      fromDb: (v) => (v ? JSON.parse(v as string) : null),
      changed: deepChanged,
      describe: (was, now) => {
        if (!was && now) return `Set task route: ${describeTaskSummary(now)}`;
        if (was && !now) return "Cleared task route";
        if (!was || !now) return [];
        const summary = summarizeXctskChange(JSON.stringify(was), now);
        return summary ? `Updated task route: ${summary}` : "Updated task route";
      },
      bumpsScores: true,
    },
    // Stopped tasks (issue #264, S7F §12.3): stored as a normalised ISO UTC
    // instant so the scorer and the UI agree on it. Stopping (or un-stopping)
    // a task rescores every pilot in it — the §12.3 machinery turns on and off
    // with this field.
    stop_announcement_time: {
      column: "stop_announcement_time",
      toDb: () => normalisedStopTime,
      changed: (was) => was !== normalisedStopTime,
      describe: (was) => {
        if (was === null && normalisedStopTime !== null) {
          return `Stopped the task — stop announcement time ${normalisedStopTime} (scored per FAI S7F §12.3)`;
        }
        if (normalisedStopTime === null) {
          return "Cleared the task stop — task scored as run to completion";
        }
        return describeChange(
          "task stop announcement time",
          was,
          normalisedStopTime
        );
      },
      bumpsScores: true,
    },
    // The audit line quotes an EXCERPT rather than the field: a
    // 4000-character debrief pasted verbatim into the public audit log would
    // bury every other entry around it.
    weather_notes: {
      column: "weather_notes",
      fromDb: (v) => (v as string | null) ?? "",
      describe: (was, now) => {
        const text = (now as string).trim();
        if (text.length === 0) return "Cleared the weather notes";
        const had = (was as string).trim().length > 0;
        return `${had ? "Updated" : "Added"} the weather notes: "${excerpt(text)}"`;
      },
    },
    // Says who may still submit, because that is the part an organiser gets
    // wrong: they close the task and are then surprised to find they can
    // still upload.
    submissions_closed: {
      column: "submissions_closed",
      toDb: boolToDb,
      fromDb: boolFromDb,
      describe: (_was, now) =>
        now
          ? "Closed the task for track submissions — organisers can still upload"
          : "Reopened the task for track submissions",
    },
  };
}

export const taskRoutes = new Hono<HonoEnv>()
  // ── POST /api/comp/:comp_id/task ── Create task
  .post(
    "/api/comp/:comp_id/task",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", createTaskSchema),
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
        // Materialize a scores row right away (empty field for now) so the
        // public's first visit reads a row instead of computing.
        await bumpAndRevalidateScores(c, [taskId]);
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
        `SELECT task_id, comp_id, name, task_date, creation_date, xctsk,
                stop_announcement_time, weather_notes, submissions_closed
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
        stop_announcement_time: (task.stop_announcement_time as string | null) ?? null,
        // Public: the organizer's account of the day's conditions is the
        // ground truth pilots read the modelled weather and the field
        // analysis against, so everyone who can see the task can see it.
        weather_notes: (task.weather_notes as string | null) ?? "",
        // Public too: a pilot has to be able to see that the task stopped
        // taking files without first trying to send one.
        submissions_closed: !!task.submissions_closed,
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
    validated("json", updateTaskSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      // Verify task exists and belongs to comp; capture current state for audit
      const task = await c.env.DB.prepare(
        `SELECT task_id, name, task_date, xctsk, stop_announcement_time,
                weather_notes, submissions_closed
         FROM task WHERE task_id = ? AND comp_id = ?`
      )
        .bind(taskId, compId)
        .first<{
          task_id: number;
          name: string;
          task_date: string;
          xctsk: string | null;
          stop_announcement_time: string | null;
          weather_notes: string | null;
          submissions_closed: number;
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

      // Stopped tasks: normalise the announcement to an ISO UTC instant
      // before it is compared or stored.
      const normalisedStopTime =
        body.stop_announcement_time !== undefined
          ? body.stop_announcement_time === null
            ? null
            : new Date(Date.parse(body.stop_announcement_time)).toISOString()
          : undefined;

      const plan = planPatch(
        body,
        task as unknown as Record<string, unknown>,
        taskFieldTable(normalisedStopTime)
      );

      if (plan.assignments.length > 0) {
        await c.env.DB.prepare(
          `UPDATE task SET ${plan.assignments.join(", ")} WHERE task_id = ?`
        )
          .bind(...plan.values, taskId)
          .run();
      }

      // The scored classes live in their own table, so their write and their
      // diff sit outside the field table.
      let scoreInputsChanged = plan.bumpsScores;
      const auditChanges = [...plan.audits];
      if (body.pilot_classes) {
        const statements: D1PreparedStatement[] = [
          c.env.DB.prepare("DELETE FROM task_class WHERE task_id = ?").bind(taskId),
          ...body.pilot_classes.map((cls) =>
            c.env.DB.prepare(
              "INSERT INTO task_class (task_id, pilot_class) VALUES (?, ?)"
            ).bind(taskId, cls)
          ),
        ];
        await c.env.DB.batch(statements);

        const newClasses = [...body.pilot_classes].sort();
        if (JSON.stringify(newClasses) !== JSON.stringify(currentClasses)) {
          auditChanges.push(
            `Changed pilot classes from [${currentClasses.join(", ")}] to [${newClasses.join(", ")}]`
          );
          scoreInputsChanged = true;
        }
      }

      if (scoreInputsChanged) {
        await bumpAndRevalidateScores(c, [taskId]);
      }

      const taskName = body.name ?? task.name;
      await auditAll(
        c.env.DB,
        c.var.user,
        compId,
        auditChanges.map((description) => ({
          subject_type: "task" as const,
          subject_id: taskId,
          subject_name: taskName,
          description,
        }))
      );

      if (body.xctsk) {
        await deriveCompTimezone(c.env.DB, c.var.user, compId, body.xctsk);
      }

      // Return updated task
      const updated = await c.env.DB.prepare(
        `SELECT task_id, comp_id, name, task_date, creation_date, xctsk,
                stop_announcement_time, weather_notes, submissions_closed
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
        stop_announcement_time:
          (updated.stop_announcement_time as string | null) ?? null,
        weather_notes: (updated.weather_notes as string | null) ?? "",
        submissions_closed: !!updated.submissions_closed,
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

