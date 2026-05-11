/**
 * Routes for per-user IGC tracks, XCTSK tasks, and map annotations.
 *
 * Tracks live in R2 under `u/{user_id}/track/{sha256}.igc.gz`; metadata is in
 * D1 (`user_track`). Tasks are stored entirely in D1 (`user_task.xctsk_json`)
 * — same shape as comp `task.xctsk`. Annotations are scoped to a (user, track)
 * pair so anyone viewing a track sees the owner's strokes.
 *
 * Public read access is by-link only. There is intentionally NO list endpoint
 * under `/api/u/:username/`; that would make every user's library discoverable.
 *
 * Quotas (per user) are enforced server-side:
 *   - 500 tracks
 *   - 200 tasks
 *   - 200 MiB total track storage (gzipped)
 */
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { parseIGC, parseXCTask, type XCTask, type IGCFile } from "@glidecomp/engine";
import type { Env, AuthUser } from "../env";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { xctskSchema } from "../validators";
import {
  validateAndDecompressIgc,
  IgcValidationException,
} from "../igc-validation";

type Variables = { user: AuthUser | null };
type HonoEnv = { Bindings: Env; Variables: Variables };

// ── Quotas ──────────────────────────────────────────────────────────────────

export const MAX_USER_TRACKS = 500;
export const MAX_USER_TASKS = 200;
export const MAX_USER_BYTES = 200 * 1024 * 1024; // 200 MiB gzipped

// ── Validators ──────────────────────────────────────────────────────────────

const SHA256_HEX_REGEX = /^[0-9a-f]{64}$/;
const TASK_CODE_REGEX = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const STROKE_ID_REGEX = /^[A-Za-z0-9_-]{1,64}$/;
const USERNAME_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9-]{1,18}[a-zA-Z0-9]$/;

const createTaskSchema = z.object({
  task_code: z.string().min(1).max(64).regex(TASK_CODE_REGEX, {
    message: "task_code must be lowercase alphanumeric (hyphens/underscores allowed)",
  }),
  xctsk: xctskSchema,
});

const annotationSchema = z.object({
  color: z.string().min(1).max(32),
  width: z.number().min(0.1).max(50),
  points: z
    .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
    .min(1)
    .max(2000),
  timestamp: z.number().int().min(0),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function trackR2Key(userId: string, trackId: string): string {
  return `u/${userId}/track/${trackId}.igc.gz`;
}

function deriveTrackName(filename: string, igc: IGCFile): string {
  const pilot = igc.header.pilot;
  const date = igc.header.date;
  if (pilot) {
    if (date) {
      const dateStr = date.toISOString().split("T")[0];
      return `${pilot} - ${dateStr}`;
    }
    return pilot;
  }
  return filename.replace(/\.igc$/i, "");
}

function deriveTaskName(code: string, task: XCTask): string {
  const sss = task.turnpoints.find((tp) => tp.type === "SSS");
  if (sss?.waypoint.name && sss.waypoint.name !== "SSS" && sss.waypoint.name.length > 2) {
    return `${sss.waypoint.name} (${code})`;
  }
  const firstTp = task.turnpoints.find((tp) => tp.type !== "TAKEOFF");
  if (firstTp?.waypoint.name && firstTp.waypoint.name.length > 2) {
    return `${firstTp.waypoint.name} (${code})`;
  }
  return code.toUpperCase();
}

async function resolveUserIdByUsername(
  db: D1Database,
  username: string
): Promise<string | null> {
  if (!USERNAME_REGEX.test(username)) return null;
  const row = await db
    .prepare('SELECT id FROM "user" WHERE username = ?')
    .bind(username)
    .first<{ id: string }>();
  return row?.id ?? null;
}

function quotaError(c: { json: (b: object, status: number) => Response }, kind: "tracks" | "tasks" | "bytes") {
  if (kind === "tracks") {
    return c.json(
      {
        error: `You've reached the ${MAX_USER_TRACKS}-track limit. Delete a track to free up space.`,
        quota: { kind, limit: MAX_USER_TRACKS },
      },
      400
    );
  }
  if (kind === "tasks") {
    return c.json(
      {
        error: `You've reached the ${MAX_USER_TASKS}-task limit. Delete a task to free up space.`,
        quota: { kind, limit: MAX_USER_TASKS },
      },
      400
    );
  }
  return c.json(
    {
      error: `You've used your ${Math.round(MAX_USER_BYTES / (1024 * 1024))} MB storage allowance. Delete tracks to free up space.`,
      quota: { kind, limit: MAX_USER_BYTES },
    },
    400
  );
}

type TrackRow = {
  user_id: string;
  track_id: string;
  r2_key: string;
  filename: string;
  display_name: string;
  pilot: string | null;
  glider: string | null;
  flight_date: string | null;
  file_size: number;
  stored_at: string;
  last_accessed_at: string;
};

function serializeTrackMeta(row: TrackRow) {
  return {
    track_id: row.track_id,
    filename: row.filename,
    display_name: row.display_name,
    pilot: row.pilot,
    glider: row.glider,
    flight_date: row.flight_date,
    file_size: row.file_size,
    stored_at: row.stored_at,
    last_accessed_at: row.last_accessed_at,
  };
}

type TaskRow = {
  user_id: string;
  task_code: string;
  display_name: string;
  xctsk_json: string;
  stored_at: string;
  last_accessed_at: string;
};

function serializeTaskMeta(row: TaskRow, includeBody: boolean) {
  const out: Record<string, unknown> = {
    task_code: row.task_code,
    display_name: row.display_name,
    stored_at: row.stored_at,
    last_accessed_at: row.last_accessed_at,
  };
  if (includeBody) {
    try {
      out.xctsk = JSON.parse(row.xctsk_json);
    } catch {
      out.xctsk = null;
    }
  }
  return out;
}

type AnnotationRow = {
  stroke_id: string;
  color: string;
  width: number;
  points: string;
  timestamp: number;
};

function serializeAnnotation(row: AnnotationRow) {
  let points: unknown = [];
  try {
    points = JSON.parse(row.points);
  } catch {
    /* malformed — surface empty */
  }
  return {
    stroke_id: row.stroke_id,
    color: row.color,
    width: row.width,
    points,
    timestamp: row.timestamp,
  };
}

// ── Routes ──────────────────────────────────────────────────────────────────

export const userFilesRoutes = new Hono<HonoEnv>()
  // ── POST /api/user/tracks ── Upload a track
  .post("/api/user/tracks", requireAuth, async (c) => {
    const user = c.var.user!;

    // Read and validate the gzip-compressed IGC body. Same caps as comp.
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

    const trackId = await sha256Hex(igcText);
    const r2Key = trackR2Key(user.id, trackId);
    const filename = c.req.header("x-filename") || `${trackId.slice(0, 8)}.igc`;

    // Look up any existing row for this user+track — used both for idempotency
    // and to know whether file_size should count against the quota.
    const existing = await c.env.DB.prepare(
      `SELECT user_id, track_id, r2_key, filename, display_name, pilot, glider,
              flight_date, file_size, stored_at, last_accessed_at
         FROM user_track
        WHERE user_id = ? AND track_id = ?`
    )
      .bind(user.id, trackId)
      .first<TrackRow>();

    if (!existing) {
      // Enforce quotas only when the upload would create a *new* row.
      const counts = await c.env.DB.prepare(
        `SELECT COUNT(*) AS cnt, COALESCE(SUM(file_size), 0) AS total_bytes
           FROM user_track WHERE user_id = ?`
      )
        .bind(user.id)
        .first<{ cnt: number; total_bytes: number }>();
      if (counts && counts.cnt >= MAX_USER_TRACKS) {
        return quotaError(c, "tracks");
      }
      if (counts && counts.total_bytes + body.byteLength > MAX_USER_BYTES) {
        return quotaError(c, "bytes");
      }
    }

    // Extract header metadata best-effort. Unparseable IGCs still get stored
    // (validateAndDecompressIgc already enforced format/size).
    let pilot: string | null = null;
    let glider: string | null = null;
    let flightDate: string | null = null;
    let displayName = filename.replace(/\.igc$/i, "");
    try {
      const igc = parseIGC(igcText);
      pilot = igc.header.pilot ?? null;
      glider = igc.header.gliderType ?? null;
      flightDate = igc.header.date
        ? igc.header.date.toISOString().split("T")[0]
        : null;
      displayName = deriveTrackName(filename, igc);
    } catch {
      // Keep filename fallback.
    }

    // R2 PUT comes before D1 so we don't leave a metadata row pointing at a
    // missing object. Idempotent: re-PUTing the same key is fine.
    await c.env.R2.put(r2Key, body, {
      httpMetadata: {
        contentType: "application/octet-stream",
        contentEncoding: "gzip",
      },
    });

    const now = new Date().toISOString();
    if (existing) {
      await c.env.DB.prepare(
        `UPDATE user_track
           SET filename = ?, display_name = ?, pilot = ?, glider = ?,
               flight_date = ?, file_size = ?, last_accessed_at = ?
         WHERE user_id = ? AND track_id = ?`
      )
        .bind(
          filename,
          displayName,
          pilot,
          glider,
          flightDate,
          body.byteLength,
          now,
          user.id,
          trackId
        )
        .run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO user_track
           (user_id, track_id, r2_key, filename, display_name, pilot, glider,
            flight_date, file_size, stored_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          user.id,
          trackId,
          r2Key,
          filename,
          displayName,
          pilot,
          glider,
          flightDate,
          body.byteLength,
          now,
          now
        )
        .run();
    }

    const row: TrackRow = {
      user_id: user.id,
      track_id: trackId,
      r2_key: r2Key,
      filename,
      display_name: displayName,
      pilot,
      glider,
      flight_date: flightDate,
      file_size: body.byteLength,
      stored_at: existing?.stored_at ?? now,
      last_accessed_at: now,
    };
    return c.json({ ...serializeTrackMeta(row), replaced: !!existing }, existing ? 200 : 201);
  })

  // ── GET /api/user/tracks ── List caller's tracks
  .get("/api/user/tracks", requireAuth, async (c) => {
    const user = c.var.user!;
    const res = await c.env.DB.prepare(
      `SELECT user_id, track_id, r2_key, filename, display_name, pilot, glider,
              flight_date, file_size, stored_at, last_accessed_at
         FROM user_track
        WHERE user_id = ?
        ORDER BY last_accessed_at DESC`
    )
      .bind(user.id)
      .all<TrackRow>();
    return c.json({ tracks: res.results.map(serializeTrackMeta) });
  })

  // ── GET /api/user/tracks/:track_id ── Own track download
  .get("/api/user/tracks/:track_id", requireAuth, async (c) => {
    const user = c.var.user!;
    const trackId = c.req.param("track_id");
    if (!SHA256_HEX_REGEX.test(trackId)) {
      return c.json({ error: "Invalid track_id" }, 400);
    }
    const row = await c.env.DB.prepare(
      `SELECT r2_key, filename FROM user_track WHERE user_id = ? AND track_id = ?`
    )
      .bind(user.id, trackId)
      .first<{ r2_key: string; filename: string }>();
    if (!row) return c.json({ error: "Track not found" }, 404);

    const obj = await c.env.R2.get(row.r2_key);
    if (!obj) return c.json({ error: "File missing in storage" }, 404);

    await c.env.DB.prepare(
      `UPDATE user_track SET last_accessed_at = ? WHERE user_id = ? AND track_id = ?`
    )
      .bind(new Date().toISOString(), user.id, trackId)
      .run();

    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${row.filename}"`,
        "X-Filename": row.filename,
        ...(obj.httpMetadata?.contentEncoding
          ? { "Content-Encoding": obj.httpMetadata.contentEncoding }
          : {}),
      },
    });
  })

  // ── DELETE /api/user/tracks/:track_id ── Delete a track
  .delete("/api/user/tracks/:track_id", requireAuth, async (c) => {
    const user = c.var.user!;
    const trackId = c.req.param("track_id");
    if (!SHA256_HEX_REGEX.test(trackId)) {
      return c.json({ error: "Invalid track_id" }, 400);
    }
    const row = await c.env.DB.prepare(
      `SELECT r2_key FROM user_track WHERE user_id = ? AND track_id = ?`
    )
      .bind(user.id, trackId)
      .first<{ r2_key: string }>();
    if (!row) {
      // Idempotent — no row means nothing to do. Annotations would cascade.
      return c.json({ success: true });
    }
    await Promise.all([
      c.env.DB.prepare(
        `DELETE FROM user_track WHERE user_id = ? AND track_id = ?`
      )
        .bind(user.id, trackId)
        .run(),
      c.env.R2.delete(row.r2_key),
    ]);
    return c.json({ success: true });
  })

  // ── POST /api/user/tasks ── Upload a task
  .post(
    "/api/user/tasks",
    requireAuth,
    zValidator("json", createTaskSchema),
    async (c) => {
      const user = c.var.user!;
      const body = c.req.valid("json");
      const taskCode = body.task_code.toLowerCase();

      // Re-parse via engine to obtain a typed XCTask (for derived display name).
      let parsed: XCTask;
      try {
        parsed = parseXCTask(JSON.stringify(body.xctsk));
      } catch (err) {
        return c.json(
          { error: `Invalid xctsk: ${err instanceof Error ? err.message : err}` },
          400
        );
      }

      const existing = await c.env.DB.prepare(
        `SELECT user_id, task_code, display_name, xctsk_json, stored_at, last_accessed_at
           FROM user_task WHERE user_id = ? AND task_code = ?`
      )
        .bind(user.id, taskCode)
        .first<TaskRow>();

      if (!existing) {
        const cnt = await c.env.DB.prepare(
          `SELECT COUNT(*) AS cnt FROM user_task WHERE user_id = ?`
        )
          .bind(user.id)
          .first<{ cnt: number }>();
        if (cnt && cnt.cnt >= MAX_USER_TASKS) {
          return quotaError(c, "tasks");
        }
      }

      const displayName = deriveTaskName(taskCode, parsed);
      const xctskJson = JSON.stringify(body.xctsk);
      const now = new Date().toISOString();

      if (existing) {
        await c.env.DB.prepare(
          `UPDATE user_task
             SET display_name = ?, xctsk_json = ?, last_accessed_at = ?
           WHERE user_id = ? AND task_code = ?`
        )
          .bind(displayName, xctskJson, now, user.id, taskCode)
          .run();
      } else {
        await c.env.DB.prepare(
          `INSERT INTO user_task
             (user_id, task_code, display_name, xctsk_json, stored_at, last_accessed_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
          .bind(user.id, taskCode, displayName, xctskJson, now, now)
          .run();
      }

      const row: TaskRow = {
        user_id: user.id,
        task_code: taskCode,
        display_name: displayName,
        xctsk_json: xctskJson,
        stored_at: existing?.stored_at ?? now,
        last_accessed_at: now,
      };
      return c.json(
        { ...serializeTaskMeta(row, true), replaced: !!existing },
        existing ? 200 : 201
      );
    }
  )

  // ── GET /api/user/tasks ── List own tasks
  .get("/api/user/tasks", requireAuth, async (c) => {
    const user = c.var.user!;
    const res = await c.env.DB.prepare(
      `SELECT user_id, task_code, display_name, xctsk_json, stored_at, last_accessed_at
         FROM user_task
        WHERE user_id = ?
        ORDER BY last_accessed_at DESC`
    )
      .bind(user.id)
      .all<TaskRow>();
    return c.json({ tasks: res.results.map((r) => serializeTaskMeta(r, false)) });
  })

  // ── GET /api/user/tasks/:task_code ── Own task fetch
  .get("/api/user/tasks/:task_code", requireAuth, async (c) => {
    const user = c.var.user!;
    const code = c.req.param("task_code").toLowerCase();
    if (!TASK_CODE_REGEX.test(code)) {
      return c.json({ error: "Invalid task_code" }, 400);
    }
    const row = await c.env.DB.prepare(
      `SELECT user_id, task_code, display_name, xctsk_json, stored_at, last_accessed_at
         FROM user_task WHERE user_id = ? AND task_code = ?`
    )
      .bind(user.id, code)
      .first<TaskRow>();
    if (!row) return c.json({ error: "Task not found" }, 404);

    await c.env.DB.prepare(
      `UPDATE user_task SET last_accessed_at = ? WHERE user_id = ? AND task_code = ?`
    )
      .bind(new Date().toISOString(), user.id, code)
      .run();

    return c.json(serializeTaskMeta(row, true));
  })

  // ── DELETE /api/user/tasks/:task_code ──
  .delete("/api/user/tasks/:task_code", requireAuth, async (c) => {
    const user = c.var.user!;
    const code = c.req.param("task_code").toLowerCase();
    if (!TASK_CODE_REGEX.test(code)) {
      return c.json({ error: "Invalid task_code" }, 400);
    }
    await c.env.DB.prepare(
      `DELETE FROM user_task WHERE user_id = ? AND task_code = ?`
    )
      .bind(user.id, code)
      .run();
    return c.json({ success: true });
  })

  // ── GET /api/user/tracks/:track_id/annotations ── List own annotations
  .get("/api/user/tracks/:track_id/annotations", requireAuth, async (c) => {
    const user = c.var.user!;
    const trackId = c.req.param("track_id");
    if (!SHA256_HEX_REGEX.test(trackId)) {
      return c.json({ error: "Invalid track_id" }, 400);
    }
    // Ensure track ownership before exposing strokes.
    const track = await c.env.DB.prepare(
      `SELECT 1 FROM user_track WHERE user_id = ? AND track_id = ?`
    )
      .bind(user.id, trackId)
      .first();
    if (!track) return c.json({ error: "Track not found" }, 404);

    const res = await c.env.DB.prepare(
      `SELECT stroke_id, color, width, points, timestamp
         FROM user_annotation
        WHERE user_id = ? AND track_id = ?
        ORDER BY timestamp ASC`
    )
      .bind(user.id, trackId)
      .all<AnnotationRow>();
    return c.json({ annotations: res.results.map(serializeAnnotation) });
  })

  // ── PUT /api/user/tracks/:track_id/annotations/:stroke_id ── Upsert
  .put(
    "/api/user/tracks/:track_id/annotations/:stroke_id",
    requireAuth,
    zValidator("json", annotationSchema),
    async (c) => {
      const user = c.var.user!;
      const trackId = c.req.param("track_id");
      const strokeId = c.req.param("stroke_id");
      if (!SHA256_HEX_REGEX.test(trackId)) {
        return c.json({ error: "Invalid track_id" }, 400);
      }
      if (!STROKE_ID_REGEX.test(strokeId)) {
        return c.json({ error: "Invalid stroke_id" }, 400);
      }
      const track = await c.env.DB.prepare(
        `SELECT 1 FROM user_track WHERE user_id = ? AND track_id = ?`
      )
        .bind(user.id, trackId)
        .first();
      if (!track) return c.json({ error: "Track not found" }, 404);

      const body = c.req.valid("json");
      const points = JSON.stringify(body.points);
      // Cap the serialised points blob at 64 KB to keep a single row sane.
      if (points.length > 64 * 1024) {
        return c.json({ error: "Stroke too large (max 64 KB serialised)" }, 400);
      }

      await c.env.DB.prepare(
        `INSERT INTO user_annotation
           (user_id, track_id, stroke_id, color, width, points, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, track_id, stroke_id) DO UPDATE SET
           color = excluded.color,
           width = excluded.width,
           points = excluded.points,
           timestamp = excluded.timestamp`
      )
        .bind(user.id, trackId, strokeId, body.color, body.width, points, body.timestamp)
        .run();

      return c.json({ success: true });
    }
  )

  // ── DELETE /api/user/tracks/:track_id/annotations/:stroke_id ──
  .delete(
    "/api/user/tracks/:track_id/annotations/:stroke_id",
    requireAuth,
    async (c) => {
      const user = c.var.user!;
      const trackId = c.req.param("track_id");
      const strokeId = c.req.param("stroke_id");
      if (!SHA256_HEX_REGEX.test(trackId) || !STROKE_ID_REGEX.test(strokeId)) {
        return c.json({ error: "Invalid id" }, 400);
      }
      await c.env.DB.prepare(
        `DELETE FROM user_annotation
          WHERE user_id = ? AND track_id = ? AND stroke_id = ?`
      )
        .bind(user.id, trackId, strokeId)
        .run();
      return c.json({ success: true });
    }
  )

  // ── DELETE /api/user/tracks/:track_id/annotations ── Clear all
  .delete("/api/user/tracks/:track_id/annotations", requireAuth, async (c) => {
    const user = c.var.user!;
    const trackId = c.req.param("track_id");
    if (!SHA256_HEX_REGEX.test(trackId)) {
      return c.json({ error: "Invalid track_id" }, 400);
    }
    await c.env.DB.prepare(
      `DELETE FROM user_annotation WHERE user_id = ? AND track_id = ?`
    )
      .bind(user.id, trackId)
      .run();
    return c.json({ success: true });
  })

  // ── GET /api/u/:username/track/:track_id ── Public track download
  .get("/api/u/:username/track/:track_id", optionalAuth, async (c) => {
    const username = c.req.param("username");
    const trackId = c.req.param("track_id");
    if (!SHA256_HEX_REGEX.test(trackId)) {
      return c.json({ error: "Invalid track_id" }, 400);
    }
    const ownerId = await resolveUserIdByUsername(c.env.DB, username);
    if (!ownerId) return c.json({ error: "Not found" }, 404);

    const row = await c.env.DB.prepare(
      `SELECT r2_key, filename, display_name, pilot, glider, flight_date,
              file_size, stored_at, last_accessed_at
         FROM user_track WHERE user_id = ? AND track_id = ?`
    )
      .bind(ownerId, trackId)
      .first<TrackRow>();
    if (!row) return c.json({ error: "Not found" }, 404);

    const obj = await c.env.R2.get(row.r2_key);
    if (!obj) return c.json({ error: "Not found" }, 404);

    return new Response(obj.body, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${row.filename}"`,
        "X-Display-Name": row.display_name,
        "X-Filename": row.filename,
        ...(obj.httpMetadata?.contentEncoding
          ? { "Content-Encoding": obj.httpMetadata.contentEncoding }
          : {}),
      },
    });
  })

  // ── GET /api/u/:username/task/:task_code ── Public task fetch
  .get("/api/u/:username/task/:task_code", optionalAuth, async (c) => {
    const username = c.req.param("username");
    const code = c.req.param("task_code").toLowerCase();
    if (!TASK_CODE_REGEX.test(code)) {
      return c.json({ error: "Invalid task_code" }, 400);
    }
    const ownerId = await resolveUserIdByUsername(c.env.DB, username);
    if (!ownerId) return c.json({ error: "Not found" }, 404);

    const row = await c.env.DB.prepare(
      `SELECT user_id, task_code, display_name, xctsk_json, stored_at, last_accessed_at
         FROM user_task WHERE user_id = ? AND task_code = ?`
    )
      .bind(ownerId, code)
      .first<TaskRow>();
    if (!row) return c.json({ error: "Not found" }, 404);
    return c.json(serializeTaskMeta(row, true));
  })

  // ── GET /api/u/:username/track/:track_id/annotations ── Public read
  .get(
    "/api/u/:username/track/:track_id/annotations",
    optionalAuth,
    async (c) => {
      const username = c.req.param("username");
      const trackId = c.req.param("track_id");
      if (!SHA256_HEX_REGEX.test(trackId)) {
        return c.json({ error: "Invalid track_id" }, 400);
      }
      const ownerId = await resolveUserIdByUsername(c.env.DB, username);
      if (!ownerId) return c.json({ error: "Not found" }, 404);

      const track = await c.env.DB.prepare(
        `SELECT 1 FROM user_track WHERE user_id = ? AND track_id = ?`
      )
        .bind(ownerId, trackId)
        .first();
      if (!track) return c.json({ error: "Not found" }, 404);

      const res = await c.env.DB.prepare(
        `SELECT stroke_id, color, width, points, timestamp
           FROM user_annotation
          WHERE user_id = ? AND track_id = ?
          ORDER BY timestamp ASC`
      )
        .bind(ownerId, trackId)
        .all<AnnotationRow>();
      return c.json({ annotations: res.results.map(serializeAnnotation) });
    }
  );
