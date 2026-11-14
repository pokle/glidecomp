/**
 * Starting the next competition from one that exists.
 *
 *   POST /api/comp/:comp_id/clone
 *     A new HIDDEN competition with this one's settings and, at the
 *     organiser's choice, its waypoints, its pilots and its other organisers.
 *     Never its tasks: a task is set on the day.
 *
 *   GET  /api/comp/:comp_id/pilot/copy-sources
 *   GET  /api/comp/:comp_id/pilot/copy?from=…
 *   POST /api/comp/:comp_id/pilot/copy
 *     The pilots page's "Copy from another competition": the competitions the
 *     organiser could copy a roster from, what copying one would do, and the
 *     copy itself. Pilots are ADDED; nobody already on the roster is changed
 *     or removed (roster-copy.ts).
 *
 * Every route is admin-only on the competition it writes to AND on the one it
 * reads from. A roster holds emails and phone numbers, so being able to see a
 * competition is not enough to copy its pilots; a competition the caller does
 * not administer answers as missing, hidden or not.
 *
 * Nothing here is a scoring input: a new competition has no tasks, and a
 * copied pilot has no tracks. So nothing is marked stale. Every write is
 * audit-logged in the competition it writes to.
 */
import { Hono } from "hono";
import type { AuthedEnv } from "../env";
import { decodeId, encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { newShareKey, splitCompRef } from "../share-key";
import {
  cloneCompSchema,
  copyPilotsPreviewSchema,
  copyPilotsSchema,
  validated,
} from "../validators";
import { auditAll, type AuditEntry } from "../audit";
import {
  planRosterCopy,
  rosterCopyAudits,
  rosterCopyStatements,
  serializeRosterCopyPlan,
} from "../roster-copy";
import { MAX_COMPS_PER_ACCOUNT } from "./comp";

/** The settings a clone copies, as stored. */
interface CompSettingsRow {
  name: string;
  category: string;
  pilot_classes: string;
  default_pilot_class: string;
  gap_params: string | null;
  scoring_format: string;
  series_scoring: string;
  ftv_factor: number | null;
  timezone: string | null;
  open_igc_upload: number;
  open_registration: number;
}

/**
 * A competition id from a body or a query (with or without a hidden comp's
 * share key after it), decoded — or null when it names no competition the
 * caller administers. One answer for both: a roster is the organisers' to
 * copy, and "not yours" must not tell anyone a hidden comp exists.
 */
async function adminCompFromRef(
  db: D1Database,
  alphabet: string,
  ref: string,
  user: AuthedEnv["Variables"]["user"]
): Promise<{ comp_id: number; name: string } | null> {
  const split = splitCompRef(ref);
  if (!split) return null;
  const compId = decodeId(alphabet, split.sqid);
  if (compId === null) return null;
  if (!(await isCompAdmin(db, compId, user))) return null;
  const row = await db
    .prepare("SELECT comp_id, name FROM comp WHERE comp_id = ?")
    .bind(compId)
    .first<{ comp_id: number; name: string }>();
  return row ?? null;
}

/** The target competition's classes, for the roster plan. */
async function compClasses(
  db: D1Database,
  compId: number
): Promise<{ name: string; classes: string[]; defaultClass: string } | null> {
  const row = await db
    .prepare("SELECT name, pilot_classes, default_pilot_class FROM comp WHERE comp_id = ?")
    .bind(compId)
    .first<{ name: string; pilot_classes: string; default_pilot_class: string }>();
  if (!row) return null;
  return {
    name: row.name,
    classes: JSON.parse(row.pilot_classes) as string[],
    defaultClass: row.default_pilot_class,
  };
}

/** "143 waypoints", "1 pilot". */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export const compCopyRoutes = new Hono<AuthedEnv>()
  // ── POST /api/comp/:comp_id/clone ── A new competition from this one
  .post(
    "/api/comp/:comp_id/clone",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", cloneCompSchema),
    async (c) => {
      const db = c.env.DB;
      const user = c.var.user;
      const fromId = c.var.ids.comp_id!;
      const body = c.req.valid("json");
      const bring = {
        waypoints: body.waypoints !== false,
        pilots: body.pilots !== false,
        admins: body.admins !== false,
      };

      const from = await db
        .prepare(
          `SELECT name, category, pilot_classes, default_pilot_class, gap_params,
                  scoring_format, series_scoring, ftv_factor, timezone,
                  open_igc_upload, open_registration
             FROM comp WHERE comp_id = ?`
        )
        .bind(fromId)
        .first<CompSettingsRow>();
      if (!from) return c.json({ error: "Competition not found" }, 404);

      // The same per-account limit as starting a competition from nothing.
      const owned = await db
        .prepare("SELECT COUNT(*) AS cnt FROM comp_admin WHERE user_id = ?")
        .bind(user.id)
        .first<{ cnt: number }>();
      if (owned && owned.cnt >= MAX_COMPS_PER_ACCOUNT) {
        return c.json(
          { error: `Maximum ${MAX_COMPS_PER_ACCOUNT} competitions per account` },
          400
        );
      }

      const now = new Date().toISOString();
      // A close date is a fact about one competition, so it is not copied.
      // One month out, as for a new competition, so a forgotten one does not
      // leave the competition open for ever; the setup guide asks the
      // organiser to review the settings, close date included.
      const close = new Date(now);
      close.setUTCMonth(close.getUTCMonth() + 1);
      const closeDate = close.toISOString().split("T")[0];
      const shareKey = newShareKey();

      // Hidden, always: going public is the setup guide's last step, for a
      // copy as for any new competition. settings_reviewed starts at 0 (the
      // column default), so the guide asks for the review.
      const inserted = await db
        .prepare(
          `INSERT INTO comp (name, creation_date, close_date, category, test, share_key,
             pilot_classes, default_pilot_class, gap_params, scoring_format,
             series_scoring, ftv_factor, timezone, open_igc_upload, open_registration)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          body.name,
          now,
          closeDate,
          from.category,
          shareKey,
          from.pilot_classes,
          from.default_pilot_class,
          from.gap_params,
          from.scoring_format,
          from.series_scoring,
          from.ftv_factor,
          from.timezone,
          from.open_igc_upload,
          from.open_registration
        )
        .run();
      const toId = inserted.meta.last_row_id;

      const waypointCount = bring.waypoints
        ? ((
            await db
              .prepare(
                "SELECT json_array_length(waypoints) AS n FROM comp_waypoints WHERE comp_id = ?"
              )
              .bind(fromId)
              .first<{ n: number }>()
          )?.n ?? 0)
        : 0;
      const otherAdmins = bring.admins
        ? (
            await db
              .prepare("SELECT user_id FROM comp_admin WHERE comp_id = ? AND user_id != ?")
              .bind(fromId, user.id)
              .all<{ user_id: string }>()
          ).results.map((r) => r.user_id)
        : [];
      const roster = bring.pilots
        ? await planRosterCopy(
            db,
            fromId,
            toId,
            JSON.parse(from.pilot_classes) as string[],
            from.default_pilot_class
          )
        : null;

      // Everything after the competition row in one batch, which D1 runs
      // atomically. If it fails, the competition row goes too, rather than
      // being left with no organiser to see it.
      const statements: D1PreparedStatement[] = [
        db.prepare("INSERT INTO comp_admin (comp_id, user_id) VALUES (?, ?)").bind(toId, user.id),
        ...otherAdmins.map((id) =>
          db.prepare("INSERT INTO comp_admin (comp_id, user_id) VALUES (?, ?)").bind(toId, id)
        ),
        // Copied inside the database, so the blob never travels through the
        // Worker.
        ...(waypointCount > 0
          ? [
              db
                .prepare(
                  `INSERT INTO comp_waypoints (comp_id, waypoints, updated_at)
                   SELECT ?, waypoints, ? FROM comp_waypoints WHERE comp_id = ?`
                )
                .bind(toId, now, fromId),
            ]
          : []),
        ...(roster ? rosterCopyStatements(db, toId, roster) : []),
      ];
      try {
        await db.batch(statements);
      } catch (err) {
        console.error("clone failed", err, { fromId, toId });
        await db.prepare("DELETE FROM comp WHERE comp_id = ?").bind(toId).run();
        return c.json({ error: "Could not copy the competition. Please try again." }, 500);
      }

      const brought = [
        "its settings",
        waypointCount > 0 ? count(waypointCount, "waypoint") : null,
        roster && roster.copy.length > 0 ? count(roster.copy.length, "pilot") : null,
        otherAdmins.length > 0 ? count(otherAdmins.length, "other organiser") : null,
      ].filter((s): s is string => s !== null);
      const listed =
        brought.length === 1
          ? brought[0]
          : `${brought.slice(0, -1).join(", ")} and ${brought[brought.length - 1]}`;
      const entries: AuditEntry[] = [
        {
          subject_type: "comp",
          subject_id: toId,
          subject_name: body.name,
          description:
            `Created competition "${body.name}" as a copy of "${from.name}", ` +
            `with ${listed} (close date set to ${closeDate})`,
        },
        ...(roster ? rosterCopyAudits(roster, from.name) : []),
      ];
      await auditAll(db, user, toId, entries);

      return c.json(
        {
          comp_id: encodeId(c.env.SQIDS_ALPHABET, toId),
          // The creator administers it; a hidden comp's URLs need the key.
          share_key: shareKey,
          name: body.name,
          test: true,
          close_date: closeDate,
          copied: {
            waypoints: waypointCount,
            pilots: roster?.copy.length ?? 0,
            admins: otherAdmins.length,
          },
        },
        201
      );
    }
  )

  // ── GET /api/comp/:comp_id/pilot/copy-sources ── Rosters to copy from
  //
  // The competitions the caller holds an organiser's row for, other than this
  // one, newest first. A site super admin sees their own, not every
  // competition: this is a list to pick from, not a search.
  .get(
    "/api/comp/:comp_id/pilot/copy-sources",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const rows = await c.env.DB.prepare(
        `SELECT c.comp_id, c.name, c.test, c.creation_date,
                (SELECT COUNT(*) FROM comp_pilot cp WHERE cp.comp_id = c.comp_id) AS pilot_count,
                (SELECT MIN(t.task_date) FROM task t WHERE t.comp_id = c.comp_id) AS first_task_date
           FROM comp c
           JOIN comp_admin ca ON ca.comp_id = c.comp_id
          WHERE ca.user_id = ? AND c.comp_id != ?
          ORDER BY c.creation_date DESC`
      )
        .bind(c.var.user.id, compId)
        .all<{
          comp_id: number;
          name: string;
          test: number;
          creation_date: string;
          pilot_count: number;
          first_task_date: string | null;
        }>();
      return c.json({
        comps: rows.results
          // Nothing to copy from an empty roster.
          .filter((r) => r.pilot_count > 0)
          .map((r) => ({
            comp_id: encodeId(c.env.SQIDS_ALPHABET, r.comp_id),
            name: r.name,
            test: !!r.test,
            pilot_count: r.pilot_count,
            first_task_date: r.first_task_date,
          })),
      });
    }
  )

  // ── GET /api/comp/:comp_id/pilot/copy?from=… ── What a copy would do
  //
  // A read: nothing is written. The review page shows it, and the POST below
  // works the plan out again against the rosters as they are then.
  .get(
    "/api/comp/:comp_id/pilot/copy",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("query", copyPilotsPreviewSchema),
    async (c) => {
      const db = c.env.DB;
      const toId = c.var.ids.comp_id!;
      const source = await adminCompFromRef(
        db,
        c.env.SQIDS_ALPHABET,
        c.req.valid("query").from,
        c.var.user
      );
      if (!source) return c.json({ error: "Competition not found", field: "from" }, 404);
      if (source.comp_id === toId) {
        return c.json({ error: "Choose a different competition", field: "from" }, 400);
      }
      const target = await compClasses(db, toId);
      if (!target) return c.json({ error: "Competition not found" }, 404);
      const plan = await planRosterCopy(
        db,
        source.comp_id,
        toId,
        target.classes,
        target.defaultClass
      );
      return c.json({
        from: { comp_id: encodeId(c.env.SQIDS_ALPHABET, source.comp_id), name: source.name },
        ...serializeRosterCopyPlan(plan),
      });
    }
  )

  // ── POST /api/comp/:comp_id/pilot/copy ── Copy another roster's pilots in
  .post(
    "/api/comp/:comp_id/pilot/copy",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", copyPilotsSchema),
    async (c) => {
      const db = c.env.DB;
      const toId = c.var.ids.comp_id!;
      const source = await adminCompFromRef(
        db,
        c.env.SQIDS_ALPHABET,
        c.req.valid("json").from_comp_id,
        c.var.user
      );
      if (!source) {
        return c.json({ error: "Competition not found", field: "from_comp_id" }, 404);
      }
      if (source.comp_id === toId) {
        return c.json({ error: "Choose a different competition", field: "from_comp_id" }, 400);
      }
      const target = await compClasses(db, toId);
      if (!target) return c.json({ error: "Competition not found" }, 404);

      const plan = await planRosterCopy(
        db,
        source.comp_id,
        toId,
        target.classes,
        target.defaultClass
      );
      if (plan.error) return c.json({ error: plan.error }, 400);

      const statements = rosterCopyStatements(db, toId, plan);
      if (statements.length > 0) await db.batch(statements);
      await auditAll(db, c.var.user, toId, rosterCopyAudits(plan, source.name));

      return c.json({
        from: { comp_id: encodeId(c.env.SQIDS_ALPHABET, source.comp_id), name: source.name },
        copied: plan.copy.length,
        skipped: plan.skip.length,
        ...serializeRosterCopyPlan(plan),
      });
    }
  );
