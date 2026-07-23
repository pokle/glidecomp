import { Hono } from "hono";
import { z } from "zod";
import {
  cleanWaypointCodes,
  getWaypointExportFormat,
  swapCodeName,
  toXctskJSON,
  xctaskTurnpointsToRecords,
  type WaypointFileRecord,
  type XCTask,
} from "@glidecomp/engine";
import type { Env, AuthUser } from "../env";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { validated } from "../validators";
import { audit } from "../audit";

/** Filename-safe slug from a comp/task name (mirrors the frontend's slugify). */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "competition"
  );
}

/**
 * Load a comp, applying the public-visibility rule: a missing comp, or a hidden
 * `test` comp viewed by a non-admin, is treated as not-found. Returns the comp
 * row on success or a 404 `Response` to return directly — so every waypoints
 * endpoint gates identically instead of hand-copying the check.
 */
async function loadVisibleComp(
  c: {
    env: Env;
    var: { user: AuthUser | null };
    json: (body: unknown, status: 404) => Response;
  },
  compId: number
): Promise<{ name: string } | Response> {
  const comp = await c.env.DB.prepare("SELECT test, name FROM comp WHERE comp_id = ?")
    .bind(compId)
    .first<{ test: number; name: string }>();
  if (!comp) return c.json({ error: "Not found" }, 404);
  if (comp.test && (!c.var.user || !(await isCompAdmin(c.env.DB, compId, c.var.user)))) {
    return c.json({ error: "Not found" }, 404);
  }
  return { name: comp.name };
}

/**
 * Serve a waypoint set as a downloadable file. `inline` disposition (not
 * `attachment`) so a phone hands the file straight to a flight app (XCTrack,
 * Flyskyhy, SeeYou Navigator) instead of only saving it; the extension in the
 * filename plus the format's Content-Type drive which app the OS offers.
 */
function fileResponse(
  c: { body: (data: string, status: 200, headers: Record<string, string>) => Response },
  records: WaypointFileRecord[],
  formatId: string,
  swap: boolean,
  baseName: string,
  suffix: string
): Response {
  const format = getWaypointExportFormat(formatId);
  if (!format) throw new Error("unknown format");
  const out = swap ? swapCodeName(records) : records;
  const filename = `${slugify(baseName)}-${suffix}.${format.extension}`;
  return c.body(format.serialize(out), 200, {
    "Content-Type": format.mimeType,
    "Content-Disposition": `inline; filename="${filename}"`,
    "Cache-Control": "no-store",
  });
}

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

// No control characters in the identifiers: a newline or tab in code/name
// would corrupt every line- and whitespace-delimited export format at the
// source, so reject them on write rather than sanitising on every read.
const noControlChars = z.string().regex(/^[^\p{Cc}]*$/u, "no control characters");

const waypointSchema = z.object({
  code: noControlChars.min(1).max(MAX_TEXT),
  name: noControlChars.max(MAX_TEXT),
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
    const comp = await loadVisibleComp(c, compId);
    if (comp instanceof Response) return comp;

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

  // ── GET file — the comp's waypoints serialized for a flight instrument ──
  // (public, minus hidden test comps). `:format` is an export-format id; the
  // response is an openable file so a phone can hand it to a flight app.
  .get("/api/comp/:comp_id/waypoints/:format", optionalAuth, sqidsMiddleware, async (c) => {
    const compId = c.var.ids.comp_id!;
    const formatId = c.req.param("format");
    if (!getWaypointExportFormat(formatId)) return c.json({ error: "Unknown format" }, 404);

    const comp = await loadVisibleComp(c, compId);
    if (comp instanceof Response) return comp;

    const row = await c.env.DB.prepare("SELECT waypoints FROM comp_waypoints WHERE comp_id = ?")
      .bind(compId)
      .first<{ waypoints: string }>();
    const records = row ? (JSON.parse(row.waypoints) as WaypointFileRecord[]) : [];
    return fileResponse(c, records, formatId, c.req.query("swap") === "1", comp.name, "waypoints");
  })

  // ── GET file — a task's turnpoints serialized for a flight instrument ──
  .get(
    "/api/comp/:comp_id/task/:task_id/waypoints/:format",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const formatId = c.req.param("format");
      // "xctsk" is the native XCTrack task file, not a waypoint export format.
      if (formatId !== "xctsk" && !getWaypointExportFormat(formatId)) {
        return c.json({ error: "Unknown format" }, 404);
      }

      const comp = await loadVisibleComp(c, compId);
      if (comp instanceof Response) return comp;

      const task = await c.env.DB.prepare(
        "SELECT name, xctsk FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first<{ name: string; xctsk: string | null }>();
      if (!task) return c.json({ error: "Not found" }, 404);

      const xctsk = task.xctsk ? (JSON.parse(task.xctsk) as XCTask) : null;

      // Native task file — serve the canonical .xctsk that XCTrack imports.
      if (formatId === "xctsk") {
        if (!xctsk) return c.json({ error: "No route defined" }, 404);
        return c.body(JSON.stringify(toXctskJSON(xctsk)), 200, {
          "Content-Type": "application/xctsk",
          "Content-Disposition": `inline; filename="${slugify(task.name)}.xctsk"`,
          "Cache-Control": "no-store",
        });
      }

      const records = xctaskTurnpointsToRecords(xctsk?.turnpoints);
      return fileResponse(c, records, formatId, c.req.query("swap") === "1", task.name, "turnpoints");
    }
  )

  // ── PUT — replace the comp's waypoints (admin only) ──
  .put(
    "/api/comp/:comp_id/waypoints",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", waypointsBodySchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      // Codes can't hold a space or a comma — they separate turnpoints when a
      // route is written as text — and must be unique to name one at all. The
      // UI cleans before it gets here; this is the guarantee for every other
      // path (seed script, direct API use), so the stored set is always usable.
      const { waypoints, changes } = cleanWaypointCodes(c.req.valid("json").waypoints);

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
          (prevCount === waypoints.length
            ? `Edited competition waypoints (${waypoints.length})`
            : `Updated competition waypoints (${prevCount} → ${waypoints.length})`) +
          (changes.length > 0
            ? `; cleaned ${changes.length} code${changes.length === 1 ? "" : "s"} (${changes
                .slice(0, 3)
                .map((ch) => `${ch.from} → ${ch.to}`)
                .join(", ")}${changes.length > 3 ? ", …" : ""})`
            : ""),
      });

      return c.json({ ok: true, count: waypoints.length, updated_at: now, changes });
    }
  );
