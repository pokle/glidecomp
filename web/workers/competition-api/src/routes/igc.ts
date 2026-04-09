import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { updatePenaltySchema } from "../validators";
import { parseIGC } from "@glidecomp/engine";
import { audit } from "../audit";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

const MAX_IGC_SIZE = 5 * 1024 * 1024; // 5 MB
const MAX_PILOTS_PER_TASK = 250;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Ensure a `pilot` row exists for the given user. Returns the pilot_id.
 */
async function ensurePilot(
  db: D1Database,
  userId: string,
  userName: string
): Promise<number> {
  const existing = await db
    .prepare("SELECT pilot_id FROM pilot WHERE user_id = ?")
    .bind(userId)
    .first<{ pilot_id: number }>();
  if (existing) return existing.pilot_id;

  const res = await db
    .prepare("INSERT INTO pilot (user_id, name) VALUES (?, ?)")
    .bind(userId, userName)
    .run();
  return res.meta.last_row_id;
}

/**
 * Ensure a `comp_pilot` row exists for the given pilot + comp.
 * Returns the comp_pilot_id.
 */
async function ensureCompPilot(
  db: D1Database,
  compId: number,
  pilotId: number,
  pilotName: string,
  defaultPilotClass: string
): Promise<number> {
  const existing = await db
    .prepare(
      "SELECT comp_pilot_id FROM comp_pilot WHERE comp_id = ? AND pilot_id = ?"
    )
    .bind(compId, pilotId)
    .first<{ comp_pilot_id: number }>();
  if (existing) return existing.comp_pilot_id;

  const res = await db
    .prepare(
      `INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, pilot_class)
       VALUES (?, ?, ?, ?)`
    )
    .bind(compId, pilotId, pilotName, defaultPilotClass)
    .run();
  return res.meta.last_row_id;
}

export const igcRoutes = new Hono<HonoEnv>()
  // ── POST /api/comp/:comp_id/task/:task_id/igc ── Upload IGC
  .post(
    "/api/comp/:comp_id/task/:task_id/igc",
    requireAuth,
    sqidsMiddleware,
    async (c) => {
      const user = c.var.user;
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const alphabet = c.env.SQIDS_ALPHABET;

      // Verify comp exists and check close_date
      const comp = await c.env.DB.prepare(
        "SELECT comp_id, close_date, default_pilot_class FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{
          comp_id: number;
          close_date: string | null;
          default_pilot_class: string;
        }>();

      if (!comp) {
        return c.json({ error: "Competition not found" }, 404);
      }

      if (comp.close_date) {
        // Treat date-only close_date (e.g. "2026-12-31") as end-of-day UTC
        const closeDateTime = comp.close_date.includes("T")
          ? comp.close_date
          : comp.close_date + "T23:59:59Z";
        if (new Date() > new Date(closeDateTime)) {
          return c.json(
            { error: "Competition is closed for track submissions" },
            400
          );
        }
      }

      // Verify task exists and belongs to comp
      const task = await c.env.DB.prepare(
        "SELECT task_id FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      // Read the request body as gzip-compressed IGC data
      const body = await c.req.arrayBuffer();
      if (body.byteLength === 0) {
        return c.json({ error: "Empty file" }, 400);
      }
      if (body.byteLength > MAX_IGC_SIZE) {
        return c.json({ error: "File too large (max 5MB)" }, 400);
      }

      // Open registration: ensure pilot + comp_pilot
      const pilotId = await ensurePilot(c.env.DB, user.id, user.name);
      const compPilotId = await ensureCompPilot(
        c.env.DB,
        compId,
        pilotId,
        user.name,
        comp.default_pilot_class
      );

      // Enforce max pilots per task
      const pilotCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM task_track WHERE task_id = ?"
      )
        .bind(taskId)
        .first<{ cnt: number }>();

      // Check if this pilot already has a track (replacement doesn't count toward limit)
      const existingTrack = await c.env.DB.prepare(
        "SELECT task_track_id, igc_filename, penalty_points, penalty_reason FROM task_track WHERE task_id = ? AND comp_pilot_id = ?"
      )
        .bind(taskId, compPilotId)
        .first<{
          task_track_id: number;
          igc_filename: string;
          penalty_points: number;
          penalty_reason: string | null;
        }>();

      if (
        !existingTrack &&
        pilotCount &&
        pilotCount.cnt >= MAX_PILOTS_PER_TASK
      ) {
        return c.json(
          { error: `Maximum ${MAX_PILOTS_PER_TASK} pilots per task` },
          400
        );
      }

      // R2 path: /c/{comp_id}/t/{task_id}/{comp_pilot_id}.igc
      const r2Key = `c/${compId}/t/${taskId}/${compPilotId}.igc`;
      const now = new Date().toISOString();

      // Extract pilot name from IGC header (best-effort — null if unparseable)
      let igcPilotName: string | null = null;
      try {
        const decompressedStream = new Response(body).body!.pipeThrough(
          new DecompressionStream("gzip")
        );
        const igcText = new TextDecoder().decode(
          await new Response(decompressedStream).arrayBuffer()
        );
        const igc = parseIGC(igcText);
        igcPilotName = igc.header.pilot || igc.header.competitionId || null;
      } catch {
        // Unparseable IGC — store null, scoring will skip it too
      }

      // Upload to R2 with gzip content-encoding
      await c.env.R2.put(r2Key, body, {
        httpMetadata: {
          contentType: "application/octet-stream",
          contentEncoding: "gzip",
        },
      });

      if (existingTrack) {
        // Replace existing track, preserving penalties
        // Delete old R2 object if filename differs (shouldn't since we use comp_pilot_id)
        if (existingTrack.igc_filename !== r2Key) {
          await c.env.R2.delete(existingTrack.igc_filename);
        }

        await c.env.DB.prepare(
          `UPDATE task_track
           SET igc_filename = ?, uploaded_at = ?, file_size = ?, igc_pilot_name = ?,
               uploaded_by_user_id = ?, uploaded_by_name = ?
           WHERE task_track_id = ?`
        )
          .bind(
            r2Key,
            now,
            body.byteLength,
            igcPilotName,
            user.id,
            user.name,
            existingTrack.task_track_id
          )
          .run();

        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "track",
          subject_id: existingTrack.task_track_id,
          subject_name: user.name,
          description: `Replaced IGC for ${user.name} (${formatBytes(body.byteLength)})`,
        });

        return c.json({
          task_track_id: encodeId(alphabet, existingTrack.task_track_id),
          comp_pilot_id: encodeId(alphabet, compPilotId),
          igc_filename: r2Key,
          uploaded_at: now,
          file_size: body.byteLength,
          replaced: true,
        });
      }

      // Insert new track
      const trackResult = await c.env.DB.prepare(
        `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size, igc_pilot_name, uploaded_by_user_id, uploaded_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          taskId,
          compPilotId,
          r2Key,
          now,
          body.byteLength,
          igcPilotName,
          user.id,
          user.name
        )
        .run();

      const newTrackId = trackResult.meta.last_row_id;

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: newTrackId,
        subject_name: user.name,
        description: `Uploaded IGC for ${user.name} (${formatBytes(body.byteLength)})`,
      });

      return c.json(
        {
          task_track_id: encodeId(alphabet, newTrackId),
          comp_pilot_id: encodeId(alphabet, compPilotId),
          igc_filename: r2Key,
          uploaded_at: now,
          file_size: body.byteLength,
          replaced: false,
        },
        201
      );
    }
  )

  // ── POST /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id ── Upload on behalf
  // Authorised if the caller is either (a) a comp admin or (b) a registered
  // pilot in this comp AND comp.open_igc_upload is enabled.
  .post(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      // Look up the comp once — need open_igc_upload to gate authorisation
      const comp = await c.env.DB.prepare(
        "SELECT comp_id, close_date, open_igc_upload FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{
          comp_id: number;
          close_date: string | null;
          open_igc_upload: number;
        }>();
      if (!comp) return c.json({ error: "Competition not found" }, 404);

      // Enforce close_date
      if (comp.close_date) {
        const closeDateTime = comp.close_date.includes("T")
          ? comp.close_date
          : comp.close_date + "T23:59:59Z";
        if (new Date() > new Date(closeDateTime)) {
          return c.json(
            { error: "Competition is closed for track submissions" },
            400
          );
        }
      }

      // Authorisation: admin OR registered pilot (when open_igc_upload enabled)
      const isAdmin = await c.env.DB.prepare(
        "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
      )
        .bind(compId, user.id)
        .first();
      if (!isAdmin) {
        if (!comp.open_igc_upload) {
          return c.json(
            { error: "Only admins can upload on behalf of other pilots in this competition" },
            403
          );
        }
        // Caller must be a registered pilot in this comp
        const callerPilot = await c.env.DB.prepare(
          `SELECT cp.comp_pilot_id FROM comp_pilot cp
           JOIN pilot p ON cp.pilot_id = p.pilot_id
           WHERE cp.comp_id = ? AND p.user_id = ?`
        )
          .bind(compId, user.id)
          .first();
        if (!callerPilot) {
          return c.json(
            { error: "Only registered pilots can upload on behalf of others in this competition" },
            403
          );
        }
      }

      // Verify task exists and belongs to comp
      const task = await c.env.DB.prepare(
        "SELECT task_id FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      // Verify comp_pilot exists and belongs to this comp
      const cp = await c.env.DB.prepare(
        "SELECT comp_pilot_id, registered_pilot_name FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?"
      )
        .bind(compPilotId, compId)
        .first<{ comp_pilot_id: number; registered_pilot_name: string }>();

      if (!cp) {
        return c.json({ error: "Pilot not found in this competition" }, 404);
      }

      const targetPilotName = cp.registered_pilot_name;

      // Read the request body
      const body = await c.req.arrayBuffer();
      if (body.byteLength === 0) {
        return c.json({ error: "Empty file" }, 400);
      }
      if (body.byteLength > MAX_IGC_SIZE) {
        return c.json({ error: "File too large (max 5MB)" }, 400);
      }

      // Check for existing track (replacement preserves penalties)
      const existingTrack = await c.env.DB.prepare(
        "SELECT task_track_id, igc_filename, penalty_points, penalty_reason FROM task_track WHERE task_id = ? AND comp_pilot_id = ?"
      )
        .bind(taskId, compPilotId)
        .first<{
          task_track_id: number;
          igc_filename: string;
          penalty_points: number;
          penalty_reason: string | null;
        }>();

      if (!existingTrack) {
        // Enforce max pilots per task for new tracks
        const pilotCount = await c.env.DB.prepare(
          "SELECT COUNT(*) as cnt FROM task_track WHERE task_id = ?"
        )
          .bind(taskId)
          .first<{ cnt: number }>();

        if (pilotCount && pilotCount.cnt >= MAX_PILOTS_PER_TASK) {
          return c.json(
            { error: `Maximum ${MAX_PILOTS_PER_TASK} pilots per task` },
            400
          );
        }
      }

      const r2Key = `c/${compId}/t/${taskId}/${compPilotId}.igc`;
      const now = new Date().toISOString();

      // Extract pilot name from IGC header (best-effort)
      let igcPilotName: string | null = null;
      try {
        const decompressedStream = new Response(body).body!.pipeThrough(
          new DecompressionStream("gzip")
        );
        const igcText = new TextDecoder().decode(
          await new Response(decompressedStream).arrayBuffer()
        );
        const igc = parseIGC(igcText);
        igcPilotName = igc.header.pilot || igc.header.competitionId || null;
      } catch {
        // Ignore — store null
      }

      await c.env.R2.put(r2Key, body, {
        httpMetadata: {
          contentType: "application/octet-stream",
          contentEncoding: "gzip",
        },
      });

      if (existingTrack) {
        if (existingTrack.igc_filename !== r2Key) {
          await c.env.R2.delete(existingTrack.igc_filename);
        }

        await c.env.DB.prepare(
          `UPDATE task_track
           SET igc_filename = ?, uploaded_at = ?, file_size = ?, igc_pilot_name = ?,
               uploaded_by_user_id = ?, uploaded_by_name = ?
           WHERE task_track_id = ?`
        )
          .bind(
            r2Key,
            now,
            body.byteLength,
            igcPilotName,
            user.id,
            user.name,
            existingTrack.task_track_id
          )
          .run();

        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "track",
          subject_id: existingTrack.task_track_id,
          subject_name: targetPilotName,
          description: `Replaced IGC for ${targetPilotName} on behalf (${formatBytes(body.byteLength)})`,
        });

        return c.json({
          task_track_id: encodeId(alphabet, existingTrack.task_track_id),
          comp_pilot_id: encodeId(alphabet, compPilotId),
          igc_filename: r2Key,
          uploaded_at: now,
          file_size: body.byteLength,
          replaced: true,
        });
      }

      const trackResult = await c.env.DB.prepare(
        `INSERT INTO task_track (task_id, comp_pilot_id, igc_filename, uploaded_at, file_size, igc_pilot_name, uploaded_by_user_id, uploaded_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          taskId,
          compPilotId,
          r2Key,
          now,
          body.byteLength,
          igcPilotName,
          user.id,
          user.name
        )
        .run();

      const newTrackId = trackResult.meta.last_row_id;

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: newTrackId,
        subject_name: targetPilotName,
        description: `Uploaded IGC for ${targetPilotName} on behalf (${formatBytes(body.byteLength)})`,
      });

      return c.json(
        {
          task_track_id: encodeId(alphabet, newTrackId),
          comp_pilot_id: encodeId(alphabet, compPilotId),
          igc_filename: r2Key,
          uploaded_at: now,
          file_size: body.byteLength,
          replaced: false,
        },
        201
      );
    }
  )

  // ── GET /api/comp/:comp_id/task/:task_id/igc ── List tracks
  .get(
    "/api/comp/:comp_id/task/:task_id/igc",
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
        const isAdmin = await c.env.DB.prepare(
          "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
        )
          .bind(compId, user.id)
          .first();
        if (!isAdmin) {
          return c.json({ error: "Not found" }, 404);
        }
      }

      // Verify task belongs to comp
      const task = await c.env.DB.prepare(
        "SELECT task_id FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first();

      if (!task) {
        return c.json({ error: "Task not found" }, 404);
      }

      const tracks = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.comp_pilot_id, tt.igc_filename,
                tt.uploaded_at, tt.file_size, tt.penalty_points, tt.penalty_reason,
                tt.igc_pilot_name, tt.uploaded_by_user_id, tt.uploaded_by_name,
                cp.registered_pilot_name as pilot_name,
                cp.pilot_class
         FROM task_track tt
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ?
         ORDER BY tt.uploaded_at ASC`
      )
        .bind(taskId)
        .all<{
          task_track_id: number;
          comp_pilot_id: number;
          igc_filename: string;
          uploaded_at: string;
          file_size: number;
          penalty_points: number;
          penalty_reason: string | null;
          igc_pilot_name: string | null;
          uploaded_by_user_id: string | null;
          uploaded_by_name: string | null;
          pilot_name: string;
          pilot_class: string;
        }>();

      return c.json({
        tracks: tracks.results.map((t) => ({
          task_track_id: encodeId(alphabet, t.task_track_id),
          comp_pilot_id: encodeId(alphabet, t.comp_pilot_id),
          pilot_name: t.pilot_name,
          igc_pilot_name: t.igc_pilot_name,
          pilot_class: t.pilot_class,
          uploaded_at: t.uploaded_at,
          file_size: t.file_size,
          penalty_points: t.penalty_points,
          penalty_reason: t.penalty_reason,
          uploaded_by_name: t.uploaded_by_name,
          /**
           * True when an IGC was uploaded by someone other than the pilot
           * it belongs to. Computed server-side so the UI can just show
           * attribution without comparing names or checking user IDs.
           */
          uploaded_on_behalf:
            t.uploaded_by_name !== null &&
            t.uploaded_by_name !== t.pilot_name,
        })),
      });
    }
  )

  // ── GET /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/download ── Download track
  .get(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/download",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;

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
        const isAdmin = await c.env.DB.prepare(
          "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
        )
          .bind(compId, user.id)
          .first();
        if (!isAdmin) {
          return c.json({ error: "Not found" }, 404);
        }
      }

      // Get track
      const track = await c.env.DB.prepare(
        `SELECT tt.igc_filename
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?`
      )
        .bind(taskId, compPilotId, compId)
        .first<{ igc_filename: string }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }

      const object = await c.env.R2.get(track.igc_filename);
      if (!object) {
        return c.json({ error: "File not found in storage" }, 404);
      }

      // Return the file — R2 transparently decompresses gzip if the client
      // sends Accept-Encoding: gzip, or we can return it raw.
      return new Response(object.body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="${compPilotId}.igc"`,
          ...(object.httpMetadata?.contentEncoding
            ? { "Content-Encoding": object.httpMetadata.contentEncoding }
            : {}),
        },
      });
    }
  )

  // ── PATCH /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id ── Update penalty
  .patch(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    zValidator("json", updatePenaltySchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const body = c.req.valid("json");

      // Verify track exists and capture pilot name for audit
      const track = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.penalty_points AS old_points, cp.registered_pilot_name
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?`
      )
        .bind(taskId, compPilotId, compId)
        .first<{
          task_track_id: number;
          old_points: number;
          registered_pilot_name: string;
        }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }

      await c.env.DB.prepare(
        `UPDATE task_track SET penalty_points = ?, penalty_reason = ?
         WHERE task_track_id = ?`
      )
        .bind(
          body.penalty_points,
          body.penalty_reason ?? null,
          track.task_track_id
        )
        .run();

      const reasonSuffix = body.penalty_reason ? `: ${body.penalty_reason}` : "";
      const description =
        track.old_points === 0
          ? `Set penalty for ${track.registered_pilot_name} to ${body.penalty_points} pts${reasonSuffix}`
          : `Changed penalty for ${track.registered_pilot_name} from ${track.old_points} to ${body.penalty_points} pts${reasonSuffix}`;

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: track.task_track_id,
        subject_name: track.registered_pilot_name,
        description,
      });

      return c.json({ success: true });
    }
  )

  // ── DELETE /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id ── Delete track
  .delete(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;

      // Verify track exists and get filename for R2 cleanup; capture pilot name
      const track = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.igc_filename, cp.registered_pilot_name
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?`
      )
        .bind(taskId, compPilotId, compId)
        .first<{
          task_track_id: number;
          igc_filename: string;
          registered_pilot_name: string;
        }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }

      // Delete from D1 and R2
      await Promise.all([
        c.env.DB.prepare("DELETE FROM task_track WHERE task_track_id = ?")
          .bind(track.task_track_id)
          .run(),
        c.env.R2.delete(track.igc_filename),
      ]);

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: track.task_track_id,
        subject_name: track.registered_pilot_name,
        description: `Deleted IGC for ${track.registered_pilot_name}`,
      });

      return c.json({ success: true });
    }
  );
