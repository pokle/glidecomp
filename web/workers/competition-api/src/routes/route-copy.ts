/**
 * GET /api/comp/:comp_id/task/:task_id/route-sources?q=…
 *
 * The routes an organiser may copy into this task's route editor: every
 * task with a saved route in a competition the caller can see (public ones,
 * and hidden ones they administer — `visibleCompsFilter`, so the list is
 * never how anyone finds a hidden comp), other than this task itself. This
 * competition's own routes are included: "the same route as Tuesday" is a
 * copy too.
 *
 * Ordered nearest-first to what this competition already knows about (its
 * waypoints and its routes), newest-first when it knows nothing yet; see
 * route-sources.ts. `q` narrows the list by words in the competition's or the
 * task's name, for a route from somewhere else.
 *
 * Admin-only, because it serves the route editor. It writes nothing: the
 * editor loads the chosen route as unsaved work, and Save is the ordinary
 * PATCH, with its own validation, audit entry and score bump.
 */
import { Hono } from "hono";
import type { AuthedEnv } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, requireCompAdmin } from "../middleware/auth";
import { visibleCompsFilter } from "../comp-visibility";
import { routeSourcesQuerySchema, validated } from "../validators";
import { asLatLon, orderCandidates, type LatLon } from "../route-sources";
import { likePattern } from "./lookup";

/** How many routes one answer lists. */
const ROUTE_SOURCES_LIMIT = 50;
/** Words of `q` that count, and the longest word. */
const MAX_TOKENS = 5;
const MAX_TOKEN_LENGTH = 64;

/** "both" | "waypoints" | "routes" | "none": what the order was measured from. */
type Reference = "both" | "waypoints" | "routes" | "none";

export const routeCopyRoutes = new Hono<AuthedEnv>().get(
  "/api/comp/:comp_id/task/:task_id/route-sources",
  requireAuth,
  sqidsMiddleware,
  requireCompAdmin,
  validated("query", routeSourcesQuerySchema),
  async (c) => {
    const db = c.env.DB;
    const alphabet = c.env.SQIDS_ALPHABET;
    const compId = c.var.ids.comp_id!;
    const taskId = c.var.ids.task_id!;

    const task = await db
      .prepare("SELECT task_id FROM task WHERE task_id = ? AND comp_id = ?")
      .bind(taskId, compId)
      .first();
    if (!task) return c.json({ error: "Task not found" }, 404);

    // ── What this competition already knows about ──
    const wpRow = await db
      .prepare("SELECT waypoints FROM comp_waypoints WHERE comp_id = ?")
      .bind(compId)
      .first<{ waypoints: string }>();
    const waypointRefs: LatLon[] = [];
    if (wpRow) {
      try {
        for (const w of JSON.parse(wpRow.waypoints) as Array<{
          latitude?: unknown;
          longitude?: unknown;
        }>) {
          const p = asLatLon(w.latitude, w.longitude);
          if (p) waypointRefs.push(p);
        }
      } catch {
        /* an unreadable set knows nothing */
      }
    }
    // Every turnpoint of every route in this competition, read inside the
    // database so the routes themselves never travel.
    const turnpointRows = await db
      .prepare(
        `SELECT json_extract(tp.value, '$.waypoint.lat') AS lat,
                json_extract(tp.value, '$.waypoint.lon') AS lon
           FROM task t, json_each(t.xctsk, '$.turnpoints') tp
          WHERE t.comp_id = ? AND t.xctsk IS NOT NULL AND json_valid(t.xctsk)`
      )
      .bind(compId)
      .all<{ lat: unknown; lon: unknown }>();
    const routeRefs = turnpointRows.results
      .map((r) => asLatLon(r.lat, r.lon))
      .filter((p): p is LatLon => p !== null);
    const reference: Reference =
      waypointRefs.length > 0 && routeRefs.length > 0
        ? "both"
        : waypointRefs.length > 0
          ? "waypoints"
          : routeRefs.length > 0
            ? "routes"
            : "none";

    // ── Every route the caller may see ──
    const visible = await visibleCompsFilter(db, c.var.user, "c");
    const tokens = (c.req.valid("query").q ?? "")
      .split(/\s+/)
      .map((t) => t.slice(0, MAX_TOKEN_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_TOKENS);
    const nameSql = tokens
      .map(() => `AND (c.name || ' ' || t.name) LIKE ? ESCAPE '\\'`)
      .join(" ");
    const rows = await db
      .prepare(
        `SELECT t.task_id, t.name AS task_name, t.task_date, t.comp_id, c.name AS comp_name,
                json_extract(t.xctsk, '$.turnpoints[0].waypoint.lat') AS lat,
                json_extract(t.xctsk, '$.turnpoints[0].waypoint.lon') AS lon
           FROM task t
           JOIN comp c ON c.comp_id = t.comp_id
          WHERE t.xctsk IS NOT NULL AND json_valid(t.xctsk)
            AND t.task_id != ?
            AND ${visible.sql}
            ${nameSql}`
      )
      .bind(taskId, ...visible.binds, ...tokens.map(likePattern))
      .all<{
        task_id: number;
        task_name: string;
        task_date: string;
        comp_id: number;
        comp_name: string;
        lat: unknown;
        lon: unknown;
      }>();

    const ordered = orderCandidates(
      rows.results.map((r) => ({ ...r, start: asLatLon(r.lat, r.lon) })),
      [...waypointRefs, ...routeRefs]
    );
    const shown = ordered.slice(0, ROUTE_SOURCES_LIMIT);

    // The turnpoint names, for the shown routes only.
    const names = new Map<number, string[]>();
    if (shown.length > 0) {
      const routes = await db
        .prepare(
          `SELECT task_id, xctsk FROM task WHERE task_id IN (${shown.map(() => "?").join(",")})`
        )
        .bind(...shown.map((r) => r.task_id))
        .all<{ task_id: number; xctsk: string }>();
      for (const r of routes.results) {
        try {
          const parsed = JSON.parse(r.xctsk) as {
            turnpoints?: Array<{ waypoint?: { name?: unknown } }>;
          };
          names.set(
            r.task_id,
            (parsed.turnpoints ?? []).map((tp) =>
              typeof tp.waypoint?.name === "string" ? tp.waypoint.name : "?"
            )
          );
        } catch {
          names.set(r.task_id, []);
        }
      }
    }

    return c.json({
      reference,
      more: ordered.length > shown.length,
      routes: shown.map((r) => ({
        comp_id: encodeId(alphabet, r.comp_id),
        comp_name: r.comp_name,
        this_comp: r.comp_id === compId,
        task_id: encodeId(alphabet, r.task_id),
        task_name: r.task_name,
        task_date: r.task_date,
        turnpoints: names.get(r.task_id) ?? [],
        distance_m: r.distance_m === null ? null : Math.round(r.distance_m),
      })),
    });
  }
);
