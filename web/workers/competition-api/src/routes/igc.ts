import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import {
  updatePenaltySchema,
  trackQualityOverrideSchema,
  validated,
} from "../validators";
import { audit } from "../audit";
import { bumpAndRevalidateScores } from "../score-store";
import { linkExistingRegistrations } from "../pilot-linker";
import { applyStatusOnTrackUpload } from "./pilot-status";
import {
  supersedeActiveManualFlights,
  markLandedFromEvidence,
} from "../manual-flight-store";
import {
  validateAndDecompressIgc,
  IgcValidationException,
} from "../igc-validation";
import {
  TaskPilotLimitError,
  assessUploadedTrack,
  flightSummaryOf,
  formatBytes,
  igcPilotNameOf,
  parseUploadedIgc,
  qualityAuditLine,
  storeUploadedTrack,
  toUploadResult,
} from "../track-upload";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

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
 *
 * Iteration 8g behaviour: before inserting a fresh row, run the linker
 * scoped to this comp so that a previously unlinked admin-registered
 * row for the same person is claimed instead of creating a duplicate.
 * Returns `{ compPilotId, claimedFromPreReg }` — the boolean is used by
 * the caller to emit a different audit description.
 */
/**
 * Thrown when the caller is not on the roster and the competition has closed
 * open registration. The organiser adds pilots themselves in that case.
 */
class RegistrationClosedError extends Error {
  constructor() {
    super("registration closed");
    this.name = "RegistrationClosedError";
  }
}

async function ensureCompPilot(
  db: D1Database,
  compId: number,
  pilotId: number,
  pilotName: string,
  defaultPilotClass: string,
  /** False when `comp.open_registration` is off — an unknown pilot is refused
   *  rather than added. Claiming an existing pre-registration still works:
   *  that pilot IS on the roster, the account just had not been linked yet. */
  mayRegister: boolean
): Promise<{
  compPilotId: number;
  claimedFromPreReg: boolean;
  preRegName: string | null;
  /** True when this upload put the pilot on the roster for the first time. */
  registeredNow: boolean;
}> {
  const existing = await db
    .prepare(
      "SELECT comp_pilot_id FROM comp_pilot WHERE comp_id = ? AND pilot_id = ?"
    )
    .bind(compId, pilotId)
    .first<{ comp_pilot_id: number }>();
  if (existing) {
    return {
      compPilotId: existing.comp_pilot_id,
      claimedFromPreReg: false,
      preRegName: null,
      registeredNow: false,
    };
  }

  // Try to claim a matching unlinked pre-registration in this comp.
  const claimed = await linkExistingRegistrations(db, pilotId, { comp_id: compId });
  if (claimed.length > 0) {
    // Take the first match — if admins pre-registered the same person
    // twice in one comp, subsequent ones will stay unlinked and still
    // show up in admin tools to resolve.
    const first = claimed[0];
    return {
      compPilotId: first.comp_pilot_id,
      claimedFromPreReg: true,
      preRegName: first.registered_pilot_name,
      // The organiser already registered them; this only linked the account.
      registeredNow: false,
    };
  }

  if (!mayRegister) throw new RegistrationClosedError();

  const res = await db
    .prepare(
      `INSERT INTO comp_pilot (comp_id, pilot_id, registered_pilot_name, pilot_class)
       VALUES (?, ?, ?, ?)`
    )
    .bind(compId, pilotId, pilotName, defaultPilotClass)
    .run();
  return {
    compPilotId: res.meta.last_row_id,
    claimedFromPreReg: false,
    preRegName: null,
    registeredNow: true,
  };
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
        "SELECT comp_id, name, close_date, default_pilot_class, open_registration FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{
          comp_id: number;
          name: string;
          close_date: string | null;
          default_pilot_class: string;
          open_registration: number;
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

      // Read and validate the gzip-compressed IGC body. SEC-11: caps
      // both compressed and decompressed size and rejects non-gzip blobs
      // before touching R2.
      const body = await c.req.arrayBuffer();
      let igcText: string;
      try {
        igcText = await validateAndDecompressIgc(body);
      } catch (err) {
        if (err instanceof IgcValidationException) {
          return c.json({ error: err.detail.message }, 400);
        }
        throw err;
      }

      // Open registration: ensure pilot + comp_pilot. If a previously
      // unlinked admin pre-registration matches this user, the linker
      // will claim that row instead of creating a new one.
      const pilotId = await ensurePilot(c.env.DB, user.id, user.name);
      let ensured;
      try {
        ensured = await ensureCompPilot(
          c.env.DB,
          compId,
          pilotId,
          user.name,
          comp.default_pilot_class,
          !!comp.open_registration
        );
      } catch (err) {
        if (err instanceof RegistrationClosedError) {
          // Name who can fix it: the pilot cannot add themselves, so an answer
          // without a person in it is a dead end.
          const organisers = await c.env.DB.prepare(
            `SELECT u.email, u.name FROM comp_admin ca
             JOIN "user" u ON ca.user_id = u.id WHERE ca.comp_id = ?`
          )
            .bind(compId)
            .all<{ email: string; name: string }>();
          return c.json(
            {
              error: `You are not registered for ${comp.name}, and it does not accept pilots registering themselves. Ask the organiser to add you.`,
              code: "registration_closed",
              comp: { comp_id: encodeId(alphabet, compId), name: comp.name },
              organisers: organisers.results,
            },
            403
          );
        }
        throw err;
      }
      const compPilotId = ensured.compPilotId;
      if (ensured.claimedFromPreReg && ensured.preRegName) {
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "pilot",
          subject_id: compPilotId,
          subject_name: ensured.preRegName,
          description: `Linked pre-registered pilot "${ensured.preRegName}" to GlideComp account on first upload`,
        });
      } else if (ensured.registeredNow) {
        // Open registration just put someone on the roster. Without this the
        // transparency record shows a track uploaded for a pilot it never saw
        // join — and the pilot count feeds launch validity (S7F §9.1), so this
        // is a scoring input arriving unannounced. Mirrors the wording the
        // admin registration routes use, plus how it happened.
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "pilot",
          subject_id: compPilotId,
          subject_name: user.name,
          description: `Registered pilot "${user.name}" (class: ${comp.default_pilot_class}) on first upload`,
        });
      }

      // ONE parse, shared by the header name, the quality assessment and the
      // flight summary.
      const igc = parseUploadedIgc(igcText);
      const igcPilotName = igcPilotNameOf(igc);

      // Data quality (FAI S7A §4.4.2). Never blocks the upload.
      const quality = await assessUploadedTrack(c.env.DB, taskId, igc);

      let stored;
      try {
        stored = await storeUploadedTrack(c.env.DB, c.env.R2, {
          compId,
          taskId,
          compPilotId,
          body,
          igcPilotName,
          uploader: { userId: user.id, name: user.name },
        });
      } catch (err) {
        if (err instanceof TaskPilotLimitError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }

      await bumpAndRevalidateScores(c, [taskId]);
      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: stored.taskTrackId,
        subject_name: user.name,
        description: `${stored.replaced ? "Replaced" : "Uploaded"} IGC for ${user.name} (${formatBytes(stored.fileSize)})`,
      });
      const qualityLine = quality && qualityAuditLine(user.name, quality);
      if (qualityLine) {
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "track",
          subject_id: stored.taskTrackId,
          subject_name: user.name,
          description: qualityLine,
        });
      }

      // A hard-failed file is not evidence that this pilot flew this task,
      // so it must not stamp them "Landed" — and, critically, must not
      // supersede an existing scorekeeper-entered manual flight, which
      // would destroy a real result on the strength of a rejected upload.
      if (!quality?.hardFailed) {
        await applyStatusOnTrackUpload(
          c.env.DB,
          user,
          compId,
          taskId,
          compPilotId,
          user.name
        );
      }

      return c.json(
        {
          task_track_id: encodeId(alphabet, stored.taskTrackId),
          comp_pilot_id: encodeId(alphabet, compPilotId),
          igc_filename: stored.r2Key,
          uploaded_at: stored.uploadedAt,
          file_size: stored.fileSize,
          replaced: stored.replaced,
          track_quality: toUploadResult(quality),
          flight_summary: flightSummaryOf(igc),
        },
        stored.replaced ? 200 : 201
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
      const isAdmin = await isCompAdmin(c.env.DB, compId, user);
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

      // Read and validate the gzip-compressed IGC body. SEC-11 mitigation
      // — same constraints as the self-upload route.
      const body = await c.req.arrayBuffer();
      let igcText: string;
      try {
        igcText = await validateAndDecompressIgc(body);
      } catch (err) {
        if (err instanceof IgcValidationException) {
          return c.json({ error: err.detail.message }, 400);
        }
        throw err;
      }

      // ONE parse, shared by the header name, the quality assessment and the
      // flight summary.
      const igc = parseUploadedIgc(igcText);
      const igcPilotName = igcPilotNameOf(igc);

      // Data quality (FAI S7A §4.4.2). Never blocks the upload.
      const quality = await assessUploadedTrack(c.env.DB, taskId, igc);

      let stored;
      try {
        stored = await storeUploadedTrack(c.env.DB, c.env.R2, {
          compId,
          taskId,
          compPilotId,
          body,
          igcPilotName,
          uploader: { userId: user.id, name: user.name },
        });
      } catch (err) {
        if (err instanceof TaskPilotLimitError) {
          return c.json({ error: err.message }, 400);
        }
        throw err;
      }

      await bumpAndRevalidateScores(c, [taskId]);
      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: stored.taskTrackId,
        subject_name: targetPilotName,
        description: `${stored.replaced ? "Replaced" : "Uploaded"} IGC for ${targetPilotName} on behalf (${formatBytes(stored.fileSize)})`,
      });
      const qualityLine = quality && qualityAuditLine(targetPilotName, quality);
      if (qualityLine) {
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "track",
          subject_id: stored.taskTrackId,
          subject_name: targetPilotName,
          description: qualityLine,
        });
      }

      // See the note in the self-upload route: a hard-failed file must not
      // stamp the pilot "Landed" or supersede a manual flight.
      if (!quality?.hardFailed) {
        await applyStatusOnTrackUpload(
          c.env.DB,
          user,
          compId,
          taskId,
          compPilotId,
          targetPilotName
        );
      }

      return c.json(
        {
          task_track_id: encodeId(alphabet, stored.taskTrackId),
          comp_pilot_id: encodeId(alphabet, compPilotId),
          igc_filename: stored.r2Key,
          uploaded_at: stored.uploadedAt,
          file_size: stored.fileSize,
          replaced: stored.replaced,
          track_quality: toUploadResult(quality),
          flight_summary: flightSummaryOf(igc),
        },
        stored.replaced ? 200 : 201
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
        if (!(await isCompAdmin(c.env.DB, compId, user))) {
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
                tt.active,
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
          active: number;
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
          /** False when superseded by DNF/Absent/Present or a manual flight
           * (retained, not scored, restorable). */
          active: !!t.active,
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
        if (!(await isCompAdmin(c.env.DB, compId, user))) {
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
    validated("json", updatePenaltySchema),
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

      await bumpAndRevalidateScores(c, [taskId]);

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

  // ── PATCH …/igc/:comp_pilot_id/quality-override ── Scorekeeper's ruling on
  // a tracklog that an automatic data-quality check withheld from scoring.
  //
  // FAI S7A §4.4.6 (Rejection of Track Log) makes this the ORGANISER's
  // judgement, not the software's — the automatic verdict is a default, and
  // this is how a scorekeeper overrules it. Setting the override scores and
  // analyses the track normally; its findings still show on the pilot's page.
  .patch(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/quality-override",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", trackQualityOverrideSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const { quality_override } = c.req.valid("json");

      const track = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.quality_override AS old_override,
                cp.registered_pilot_name
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?
           AND tt.active = 1`
      )
        .bind(taskId, compPilotId, compId)
        .first<{
          task_track_id: number;
          old_override: number;
          registered_pilot_name: string;
        }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }

      await c.env.DB.prepare(
        "UPDATE task_track SET quality_override = ? WHERE task_track_id = ?"
      )
        .bind(quality_override ? 1 : 0, track.task_track_id)
        .run();

      await bumpAndRevalidateScores(c, [taskId]);

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: track.task_track_id,
        subject_name: track.registered_pilot_name,
        description: quality_override
          ? `Accepted ${track.registered_pilot_name}'s tracklog despite a failed ` +
            `data-quality check — it is scored and analysed normally (FAI S7A §4.4.6)`
          : `Withdrew the data-quality acceptance of ${track.registered_pilot_name}'s ` +
            `tracklog — it returns to being withheld from scoring`,
      });

      return c.json({ success: true, quality_override });
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

      await bumpAndRevalidateScores(c, [taskId]);
      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: track.task_track_id,
        subject_name: track.registered_pilot_name,
        description: `Deleted IGC for ${track.registered_pilot_name}`,
      });

      return c.json({ success: true });
    }
  )

  // ── POST /api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/restore ──
  // Reactivate a pilot's superseded track (e.g. after they were marked DNF,
  // which deactivated it). Makes the track the active evidence again,
  // supersedes any active manual flight, and resolves the outcome to Landed.
  // Admin-only — this overrides a status an admin set.
  .post(
    "/api/comp/:comp_id/task/:task_id/igc/:comp_pilot_id/restore",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;

      const track = await c.env.DB.prepare(
        `SELECT tt.task_track_id, tt.active, cp.registered_pilot_name
         FROM task_track tt
         JOIN task t ON tt.task_id = t.task_id
         JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
         WHERE tt.task_id = ? AND tt.comp_pilot_id = ? AND t.comp_id = ?`
      )
        .bind(taskId, compPilotId, compId)
        .first<{
          task_track_id: number;
          active: number;
          registered_pilot_name: string;
        }>();

      if (!track) {
        return c.json({ error: "Track not found" }, 404);
      }
      if (track.active) {
        return c.json({ error: "Track is already active" }, 400);
      }

      const manualSuperseded = await supersedeActiveManualFlights(
        c.env.DB,
        taskId,
        compPilotId
      );
      await c.env.DB.prepare(
        `UPDATE task_track SET active = 1 WHERE task_track_id = ?`
      )
        .bind(track.task_track_id)
        .run();
      await markLandedFromEvidence(c.env.DB, user, compId, taskId, compPilotId);

      await bumpAndRevalidateScores(c, [taskId]);
      const supersededNote = manualSuperseded
        ? " (superseded their manual flight)"
        : "";
      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "track",
        subject_id: track.task_track_id,
        subject_name: track.registered_pilot_name,
        description: `Restored track for ${track.registered_pilot_name} (back to Landed)${supersededNote}`,
      });

      return c.json({ success: true });
    }
  );
