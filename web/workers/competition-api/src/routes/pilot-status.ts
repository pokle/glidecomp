import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth } from "../middleware/auth";
import {
  upsertPilotStatusSchema,
  updatePilotStatusNoteSchema,
} from "../validators";
import { audit, describeChange } from "../audit";
import { parsePilotStatuses, type PilotStatusConfig } from "./comp";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

interface StatusRow {
  task_pilot_status_id: number;
  task_id: number;
  comp_pilot_id: number;
  status_key: string;
  note: string | null;
  set_by_name: string;
  set_at: string;
}

/**
 * Serialize a task_pilot_status row for API responses. Joins the status
 * config (label) from the comp's pilot_statuses so the UI has everything
 * needed to render a badge in one response.
 */
function serializeStatus(
  alphabet: string,
  row: StatusRow & { pilot_name: string },
  statuses: PilotStatusConfig[]
) {
  const cfg = statuses.find((s) => s.key === row.status_key);
  return {
    task_pilot_status_id: encodeId(alphabet, row.task_pilot_status_id),
    task_id: encodeId(alphabet, row.task_id),
    comp_pilot_id: encodeId(alphabet, row.comp_pilot_id),
    pilot_name: row.pilot_name,
    status_key: row.status_key,
    status_label: cfg?.label ?? row.status_key,
    note: row.note,
    set_by_name: row.set_by_name,
    set_at: row.set_at,
  };
}

/**
 * Authorisation: a caller may mutate pilot status if they are
 *   (a) a comp admin, or
 *   (b) themselves the pilot being marked (self-service), or
 *   (c) a registered pilot in the same comp AND `open_igc_upload` is
 *       enabled (buddy marking). We reuse the existing `open_igc_upload`
 *       flag because it expresses the same "pilots trust each other" mode
 *       that's already configured for on-behalf track uploads — no new
 *       setting to explain.
 *
 * Returns null on success, or an error tuple to return.
 */
async function authorizeStatusMutation(
  db: D1Database,
  compId: number,
  targetCompPilotId: number,
  user: AuthUser,
  openIgcUpload: boolean
): Promise<{ status: 403; error: string } | null> {
  const isAdmin = await db
    .prepare("SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?")
    .bind(compId, user.id)
    .first();
  if (isAdmin) return null;

  // Is the caller the registered pilot themselves?
  const self = await db
    .prepare(
      `SELECT cp.comp_pilot_id FROM comp_pilot cp
       JOIN pilot p ON cp.pilot_id = p.pilot_id
       WHERE cp.comp_pilot_id = ? AND p.user_id = ?`
    )
    .bind(targetCompPilotId, user.id)
    .first();
  if (self) return null;

  if (!openIgcUpload) {
    return {
      status: 403,
      error: "Only admins or the pilot themselves can set status in this competition",
    };
  }

  // Buddy marking — caller must be registered in this comp
  const buddy = await db
    .prepare(
      `SELECT cp.comp_pilot_id FROM comp_pilot cp
       JOIN pilot p ON cp.pilot_id = p.pilot_id
       WHERE cp.comp_id = ? AND p.user_id = ?`
    )
    .bind(compId, user.id)
    .first();
  if (!buddy) {
    return {
      status: 403,
      error: "Only registered pilots can set status on behalf of others in this competition",
    };
  }
  return null;
}

export const pilotStatusRoutes = new Hono<HonoEnv>()
  // ── GET /api/comp/:comp_id/task/:task_id/pilot-status ── List all statuses
  // Public (same visibility rules as scores): test comps require admin.
  .get(
    "/api/comp/:comp_id/task/:task_id/pilot-status",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test, pilot_statuses FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number; pilot_statuses: string }>();
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

      // Verify task belongs to this comp
      const task = await c.env.DB.prepare(
        "SELECT task_id FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first();
      if (!task) return c.json({ error: "Task not found" }, 404);

      const rows = await c.env.DB.prepare(
        `SELECT tps.task_pilot_status_id, tps.task_id, tps.comp_pilot_id,
                tps.status_key, tps.note, tps.set_by_name, tps.set_at,
                cp.registered_pilot_name AS pilot_name
         FROM task_pilot_status tps
         JOIN comp_pilot cp ON tps.comp_pilot_id = cp.comp_pilot_id
         WHERE tps.task_id = ?`
      )
        .bind(taskId)
        .all<StatusRow & { pilot_name: string }>();

      const statuses = parsePilotStatuses(comp.pilot_statuses);

      return c.json({
        statuses: rows.results.map((r) => serializeStatus(alphabet, r, statuses)),
      });
    }
  )

  // ── PUT /api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id ──
  // Upsert a pilot's status for a task. Any valid status replaces the
  // previous one (mutually exclusive).
  .put(
    "/api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    zValidator("json", upsertPilotStatusSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, pilot_statuses, open_igc_upload FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{
          comp_id: number;
          pilot_statuses: string;
          open_igc_upload: number;
        }>();
      if (!comp) return c.json({ error: "Competition not found" }, 404);

      const configuredStatuses = parsePilotStatuses(comp.pilot_statuses);
      const cfg = configuredStatuses.find((s) => s.key === body.status_key);
      if (!cfg) {
        return c.json(
          {
            error: `Unknown status "${body.status_key}". Allowed: ${configuredStatuses.map((s) => s.key).join(", ")}`,
          },
          400
        );
      }

      // Verify task belongs to this comp
      const task = await c.env.DB.prepare(
        "SELECT task_id FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first();
      if (!task) return c.json({ error: "Task not found" }, 404);

      // Verify pilot belongs to this comp and get display name
      const cp = await c.env.DB.prepare(
        "SELECT comp_pilot_id, registered_pilot_name FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?"
      )
        .bind(compPilotId, compId)
        .first<{ comp_pilot_id: number; registered_pilot_name: string }>();
      if (!cp) return c.json({ error: "Pilot not found in this competition" }, 404);

      const authErr = await authorizeStatusMutation(
        c.env.DB,
        compId,
        compPilotId,
        user,
        !!comp.open_igc_upload
      );
      if (authErr) return c.json({ error: authErr.error }, authErr.status);

      // Load previous row for audit diff
      const prev = await c.env.DB.prepare(
        `SELECT task_pilot_status_id, status_key, note
         FROM task_pilot_status WHERE task_id = ? AND comp_pilot_id = ?`
      )
        .bind(taskId, compPilotId)
        .first<{
          task_pilot_status_id: number;
          status_key: string;
          note: string | null;
        }>();

      const now = new Date().toISOString();
      const note = body.note ?? null;

      if (prev) {
        await c.env.DB.prepare(
          `UPDATE task_pilot_status
           SET status_key = ?, note = ?, set_by_user_id = ?, set_by_name = ?, set_at = ?
           WHERE task_pilot_status_id = ?`
        )
          .bind(
            body.status_key,
            note,
            user.id,
            user.name,
            now,
            prev.task_pilot_status_id
          )
          .run();
      } else {
        await c.env.DB.prepare(
          `INSERT INTO task_pilot_status
             (comp_id, task_id, comp_pilot_id, status_key, note, set_by_user_id, set_by_name, set_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
          .bind(
            compId,
            taskId,
            compPilotId,
            body.status_key,
            note,
            user.id,
            user.name,
            now
          )
          .run();
      }

      // Audit: describe the change in human-readable form. Using the
      // status label (not key) keeps the log friendly for non-technical
      // users reading the transparency record.
      const prevLabel = prev
        ? (configuredStatuses.find((s) => s.key === prev.status_key)?.label ??
          prev.status_key)
        : null;
      let description: string;
      if (!prev) {
        description = `Set status for ${cp.registered_pilot_name} to "${cfg.label}"`;
      } else if (prev.status_key !== body.status_key) {
        description = describeChange(
          `status for ${cp.registered_pilot_name}`,
          prevLabel,
          cfg.label
        );
      } else if ((prev.note ?? "") !== (note ?? "")) {
        description = describeChange(
          `status note for ${cp.registered_pilot_name} (${cfg.label})`,
          prev.note,
          note
        );
      } else {
        description = `Re-confirmed status for ${cp.registered_pilot_name} as "${cfg.label}"`;
      }

      await audit(c.env.DB, user, compId, {
        subject_type: "pilot",
        subject_id: compPilotId,
        subject_name: cp.registered_pilot_name,
        description,
      });

      // Return the fresh row
      const row = await c.env.DB.prepare(
        `SELECT tps.task_pilot_status_id, tps.task_id, tps.comp_pilot_id,
                tps.status_key, tps.note, tps.set_by_name, tps.set_at,
                cp.registered_pilot_name AS pilot_name
         FROM task_pilot_status tps
         JOIN comp_pilot cp ON tps.comp_pilot_id = cp.comp_pilot_id
         WHERE tps.task_id = ? AND tps.comp_pilot_id = ?`
      )
        .bind(taskId, compPilotId)
        .first<StatusRow & { pilot_name: string }>();

      return c.json(serializeStatus(alphabet, row!, configuredStatuses));
    }
  )

  // ── PATCH /api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id ──
  // Edit just the note on an existing status, leaving the status key
  // unchanged. Used by the inline-editable note UI.
  .patch(
    "/api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    zValidator("json", updatePilotStatusNoteSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, pilot_statuses, open_igc_upload FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{
          comp_id: number;
          pilot_statuses: string;
          open_igc_upload: number;
        }>();
      if (!comp) return c.json({ error: "Competition not found" }, 404);

      const cp = await c.env.DB.prepare(
        "SELECT comp_pilot_id, registered_pilot_name FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?"
      )
        .bind(compPilotId, compId)
        .first<{ comp_pilot_id: number; registered_pilot_name: string }>();
      if (!cp) return c.json({ error: "Pilot not found in this competition" }, 404);

      const authErr = await authorizeStatusMutation(
        c.env.DB,
        compId,
        compPilotId,
        user,
        !!comp.open_igc_upload
      );
      if (authErr) return c.json({ error: authErr.error }, authErr.status);

      const prev = await c.env.DB.prepare(
        `SELECT task_pilot_status_id, status_key, note
         FROM task_pilot_status WHERE task_id = ? AND comp_pilot_id = ?`
      )
        .bind(taskId, compPilotId)
        .first<{
          task_pilot_status_id: number;
          status_key: string;
          note: string | null;
        }>();
      if (!prev) {
        return c.json(
          { error: "No status set for this pilot; PUT first to create one" },
          404
        );
      }

      const now = new Date().toISOString();
      await c.env.DB.prepare(
        `UPDATE task_pilot_status
         SET note = ?, set_by_user_id = ?, set_by_name = ?, set_at = ?
         WHERE task_pilot_status_id = ?`
      )
        .bind(body.note, user.id, user.name, now, prev.task_pilot_status_id)
        .run();

      const configuredStatuses = parsePilotStatuses(comp.pilot_statuses);
      const cfg = configuredStatuses.find((s) => s.key === prev.status_key);

      if ((prev.note ?? "") !== (body.note ?? "")) {
        await audit(c.env.DB, user, compId, {
          subject_type: "pilot",
          subject_id: compPilotId,
          subject_name: cp.registered_pilot_name,
          description: describeChange(
            `status note for ${cp.registered_pilot_name} (${cfg?.label ?? prev.status_key})`,
            prev.note,
            body.note
          ),
        });
      }

      const row = await c.env.DB.prepare(
        `SELECT tps.task_pilot_status_id, tps.task_id, tps.comp_pilot_id,
                tps.status_key, tps.note, tps.set_by_name, tps.set_at,
                cp.registered_pilot_name AS pilot_name
         FROM task_pilot_status tps
         JOIN comp_pilot cp ON tps.comp_pilot_id = cp.comp_pilot_id
         WHERE tps.task_id = ? AND tps.comp_pilot_id = ?`
      )
        .bind(taskId, compPilotId)
        .first<StatusRow & { pilot_name: string }>();

      return c.json(serializeStatus(alphabet, row!, configuredStatuses));
    }
  )

  // ── DELETE /api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id ──
  .delete(
    "/api/comp/:comp_id/task/:task_id/pilot-status/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, pilot_statuses, open_igc_upload FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{
          comp_id: number;
          pilot_statuses: string;
          open_igc_upload: number;
        }>();
      if (!comp) return c.json({ error: "Competition not found" }, 404);

      const cp = await c.env.DB.prepare(
        "SELECT comp_pilot_id, registered_pilot_name FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?"
      )
        .bind(compPilotId, compId)
        .first<{ comp_pilot_id: number; registered_pilot_name: string }>();
      if (!cp) return c.json({ error: "Pilot not found in this competition" }, 404);

      const authErr = await authorizeStatusMutation(
        c.env.DB,
        compId,
        compPilotId,
        user,
        !!comp.open_igc_upload
      );
      if (authErr) return c.json({ error: authErr.error }, authErr.status);

      const prev = await c.env.DB.prepare(
        `SELECT status_key FROM task_pilot_status
         WHERE task_id = ? AND comp_pilot_id = ?`
      )
        .bind(taskId, compPilotId)
        .first<{ status_key: string }>();
      if (!prev) return c.json({ success: true });

      await c.env.DB.prepare(
        `DELETE FROM task_pilot_status
         WHERE task_id = ? AND comp_pilot_id = ?`
      )
        .bind(taskId, compPilotId)
        .run();

      const configuredStatuses = parsePilotStatuses(comp.pilot_statuses);
      const prevLabel =
        configuredStatuses.find((s) => s.key === prev.status_key)?.label ??
        prev.status_key;

      await audit(c.env.DB, user, compId, {
        subject_type: "pilot",
        subject_id: compPilotId,
        subject_name: cp.registered_pilot_name,
        description: `Cleared status "${prevLabel}" for ${cp.registered_pilot_name}`,
      });

      return c.json({ success: true });
    }
  );

/**
 * Track-upload hook. Called by igc.ts after a successful IGC insert or
 * replace. Walks the comp's configured statuses and applies the
 * `on_track_upload` behavior. Only fires audit entries when something
 * actually changed — this keeps the noise low when most statuses are
 * "none".
 *
 * Exported so igc.ts can call it without re-implementing the logic.
 */
export async function applyStatusOnTrackUpload(
  db: D1Database,
  user: AuthUser,
  compId: number,
  taskId: number,
  compPilotId: number,
  pilotName: string,
  compPilotStatusesJson: string
): Promise<void> {
  const configured = parsePilotStatuses(compPilotStatusesJson);
  if (configured.length === 0) return;

  const clearKeys = configured
    .filter((s) => s.on_track_upload === "clear")
    .map((s) => s.key);
  const setKeys = configured.filter((s) => s.on_track_upload === "set");

  if (clearKeys.length > 0) {
    const current = await db
      .prepare(
        `SELECT status_key FROM task_pilot_status
         WHERE task_id = ? AND comp_pilot_id = ?`
      )
      .bind(taskId, compPilotId)
      .first<{ status_key: string }>();

    if (current && clearKeys.includes(current.status_key)) {
      await db
        .prepare(
          `DELETE FROM task_pilot_status
           WHERE task_id = ? AND comp_pilot_id = ?`
        )
        .bind(taskId, compPilotId)
        .run();

      const label =
        configured.find((s) => s.key === current.status_key)?.label ??
        current.status_key;
      await audit(db, user, compId, {
        subject_type: "pilot",
        subject_id: compPilotId,
        subject_name: pilotName,
        description: `Cleared status "${label}" for ${pilotName} because a track was uploaded`,
      });
    }
  }

  // "set" rarely applies (the default config has none), but keep the
  // behaviour symmetric so admins can configure e.g. an auto-flag status.
  // Only one status can exist per (task, pilot) so we pick the last entry
  // in the configured list that says "set". If one is already there, leave
  // it alone to avoid spamming the audit log.
  if (setKeys.length > 0) {
    const toSet = setKeys[setKeys.length - 1];
    const current = await db
      .prepare(
        `SELECT status_key FROM task_pilot_status
         WHERE task_id = ? AND comp_pilot_id = ?`
      )
      .bind(taskId, compPilotId)
      .first<{ status_key: string }>();

    if (!current || current.status_key !== toSet.key) {
      const now = new Date().toISOString();
      if (current) {
        await db
          .prepare(
            `UPDATE task_pilot_status
             SET status_key = ?, note = NULL, set_by_user_id = ?, set_by_name = ?, set_at = ?
             WHERE task_id = ? AND comp_pilot_id = ?`
          )
          .bind(toSet.key, user.id, user.name, now, taskId, compPilotId)
          .run();
      } else {
        await db
          .prepare(
            `INSERT INTO task_pilot_status
               (comp_id, task_id, comp_pilot_id, status_key, note, set_by_user_id, set_by_name, set_at)
             VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`
          )
          .bind(
            compId,
            taskId,
            compPilotId,
            toSet.key,
            user.id,
            user.name,
            now
          )
          .run();
      }
      await audit(db, user, compId, {
        subject_type: "pilot",
        subject_id: compPilotId,
        subject_name: pilotName,
        description: `Set status "${toSet.label}" for ${pilotName} because a track was uploaded`,
      });
    }
  }
}
