import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { encodeId, decodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { upsertManualFlightSchema, validated } from "../validators";
import { audit } from "../audit";
import { bumpAndRevalidateScores } from "../score-store";
import { authorizeStatusMutation } from "./pilot-status";
import {
  scoringContext,
  computeManualMadeGood,
  supersedeActiveTrack,
  supersedeActiveManualFlights,
  markLandedFromEvidence,
  type ManualFlightInput,
} from "../manual-flight-store";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

interface ManualFlightRow {
  task_manual_flight_id: number;
  task_id: number;
  comp_pilot_id: number;
  last_reached_tp_index: number;
  landing_lat: number;
  landing_lon: number;
  made_goal: number;
  duration_seconds: number | null;
  computed_distance: number;
  active: number;
  set_by_name: string;
  set_at: string;
}

function serializeManualFlight(
  alphabet: string,
  row: ManualFlightRow & { pilot_name?: string }
) {
  return {
    task_manual_flight_id: encodeId(alphabet, row.task_manual_flight_id),
    task_id: encodeId(alphabet, row.task_id),
    comp_pilot_id: encodeId(alphabet, row.comp_pilot_id),
    ...(row.pilot_name !== undefined ? { pilot_name: row.pilot_name } : {}),
    last_reached_tp_index: row.last_reached_tp_index,
    landing_lat: row.landing_lat,
    landing_lon: row.landing_lon,
    made_goal: !!row.made_goal,
    duration_seconds: row.duration_seconds,
    computed_distance: row.computed_distance,
    active: !!row.active,
    set_by_name: row.set_by_name,
    set_at: row.set_at,
  };
}

/** Format metres as a "12.3 km" string for audit descriptions. */
function formatKm(metres: number): string {
  return `${(metres / 1000).toFixed(1)} km`;
}

/** Load task xctsk + comp gap_params, verifying the task belongs to the comp. */
async function loadScoringTask(
  db: D1Database,
  compId: number,
  taskId: number
): Promise<{ xctsk: string | null; gap_params: string | null } | null> {
  return db
    .prepare(
      `SELECT t.xctsk, c.gap_params
       FROM task t JOIN comp c ON c.comp_id = t.comp_id
       WHERE t.task_id = ? AND t.comp_id = ?`
    )
    .bind(taskId, compId)
    .first<{ xctsk: string | null; gap_params: string | null }>();
}

/** The turnpoint's display name for an audit line ("Goal", or the waypoint
 * name), given the full-task index. */
function turnpointName(
  xctsk: string,
  fullIndex: number,
  madeGoal: boolean
): string {
  if (madeGoal) return "Goal";
  try {
    const parsed = JSON.parse(xctsk) as {
      turnpoints?: Array<{ waypoint?: { name?: string } }>;
    };
    return parsed.turnpoints?.[fullIndex]?.waypoint?.name ?? `TP${fullIndex}`;
  } catch {
    return `TP${fullIndex}`;
  }
}

export const manualFlightRoutes = new Hono<HonoEnv>()
  // ── GET .../manual-flight ── List active manual flights for a task.
  // Public with the same visibility rules as scores/statuses (test comps
  // require admin).
  .get(
    "/api/comp/:comp_id/task/:task_id/manual-flight",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();
      if (!comp) return c.json({ error: "Not found" }, 404);
      if (comp.test) {
        if (!user) return c.json({ error: "Not found" }, 404);
        if (!(await isCompAdmin(c.env.DB, compId, user)))
          return c.json({ error: "Not found" }, 404);
      }

      const task = await c.env.DB.prepare(
        "SELECT task_id FROM task WHERE task_id = ? AND comp_id = ?"
      )
        .bind(taskId, compId)
        .first();
      if (!task) return c.json({ error: "Task not found" }, 404);

      const rows = await c.env.DB.prepare(
        `SELECT mf.*, cp.registered_pilot_name AS pilot_name
         FROM task_manual_flight mf
         JOIN comp_pilot cp ON cp.comp_pilot_id = mf.comp_pilot_id
         WHERE mf.task_id = ? AND mf.active = 1
         ORDER BY cp.registered_pilot_name`
      )
        .bind(taskId)
        .all<ManualFlightRow & { pilot_name: string }>();

      return c.json({
        manual_flights: rows.results.map((r) => serializeManualFlight(alphabet, r)),
      });
    }
  )

  // ── GET .../manual-flight/:comp_pilot_id/history ── All records (active +
  // superseded) for one pilot, newest first — the "view superseded evidence"
  // surface. Same public visibility as the list.
  .get(
    "/api/comp/:comp_id/task/:task_id/manual-flight/:comp_pilot_id/history",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();
      if (!comp) return c.json({ error: "Not found" }, 404);
      if (comp.test) {
        if (!user) return c.json({ error: "Not found" }, 404);
        if (!(await isCompAdmin(c.env.DB, compId, user)))
          return c.json({ error: "Not found" }, 404);
      }

      const rows = await c.env.DB.prepare(
        `SELECT * FROM task_manual_flight
         WHERE task_id = ? AND comp_pilot_id = ?
         ORDER BY task_manual_flight_id DESC`
      )
        .bind(taskId, compPilotId)
        .all<ManualFlightRow>();

      return c.json({
        manual_flights: rows.results.map((r) => serializeManualFlight(alphabet, r)),
      });
    }
  )

  // ── PUT .../manual-flight/:comp_pilot_id ── Record (or replace) a pilot's
  // manual flight. Computes the made-good distance via the engine, supersedes
  // any prior manual flight AND any active track (evidence is track XOR
  // manual), and resolves the pilot's outcome to Landed.
  .put(
    "/api/comp/:comp_id/task/:task_id/manual-flight/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    validated("json", upsertManualFlightSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, open_igc_upload FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; open_igc_upload: number }>();
      if (!comp) return c.json({ error: "Competition not found" }, 404);

      const taskRow = await loadScoringTask(c.env.DB, compId, taskId);
      if (!taskRow) return c.json({ error: "Task not found" }, 404);
      if (!taskRow.xctsk) {
        return c.json(
          { error: "Task has no route, so made-good distance can't be computed" },
          400
        );
      }

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

      // Compute made-good against the task geometry.
      const { xcTask, scoringTask, offset } = scoringContext(
        taskRow.xctsk,
        taskRow.gap_params
      );
      if (body.last_reached_tp_index >= xcTask.turnpoints.length) {
        return c.json(
          { error: "last_reached_tp_index is beyond the task's turnpoints" },
          400
        );
      }
      const flightInput: ManualFlightInput = {
        lastReachedTpIndex: body.last_reached_tp_index,
        landingLat: body.landing_lat,
        landingLon: body.landing_lon,
        durationSeconds: body.duration_seconds ?? null,
      };
      const { madeGood, madeGoal } = computeManualMadeGood(
        xcTask,
        scoringTask,
        offset,
        flightInput
      );
      // A duration is only meaningful in goal.
      const durationSeconds = madeGoal ? flightInput.durationSeconds : null;

      // Supersede any prior active manual flight (retained) so the partial
      // unique index admits the new active row.
      await supersedeActiveManualFlights(c.env.DB, taskId, compPilotId);

      const now = new Date().toISOString();
      const insert = await c.env.DB.prepare(
        `INSERT INTO task_manual_flight
           (task_id, comp_pilot_id, last_reached_tp_index, landing_lat, landing_lon,
            made_goal, duration_seconds, computed_distance, active,
            set_by_user_id, set_by_name, set_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
        .bind(
          taskId,
          compPilotId,
          body.last_reached_tp_index,
          body.landing_lat,
          body.landing_lon,
          madeGoal ? 1 : 0,
          durationSeconds,
          madeGood,
          user.id,
          user.name,
          now
        )
        .run();
      const manualFlightId = insert.meta.last_row_id;

      // Evidence is track XOR manual: recording a manual flight supersedes any
      // active track (kept, not scored), then the outcome resolves to Landed.
      const hadTrack = await supersedeActiveTrack(c.env.DB, taskId, compPilotId);
      await markLandedFromEvidence(c.env.DB, user, compId, taskId, compPilotId);

      // Scoring input changed — bump right after the write, beside audit().
      await bumpAndRevalidateScores(c, [taskId]);

      const tpName = turnpointName(taskRow.xctsk, body.last_reached_tp_index, madeGoal);
      const supersededNote = hadTrack ? "; superseded their track" : "";
      await audit(c.env.DB, user, compId, {
        subject_type: "track",
        subject_id: manualFlightId,
        subject_name: cp.registered_pilot_name,
        description:
          `Recorded manual flight for ${cp.registered_pilot_name}: reached ${tpName}, ` +
          `${formatKm(madeGood)} made good${madeGoal ? " (in goal)" : ""}${supersededNote}`,
      });

      const row = await c.env.DB.prepare(
        `SELECT * FROM task_manual_flight WHERE task_manual_flight_id = ?`
      )
        .bind(manualFlightId)
        .first<ManualFlightRow>();
      return c.json(serializeManualFlight(alphabet, row!));
    }
  )

  // ── DELETE .../manual-flight/:comp_pilot_id ── Supersede the pilot's active
  // manual flight, returning them to Present (the record is retained). No
  // auto-restore of a previously-superseded track.
  .delete(
    "/api/comp/:comp_id/task/:task_id/manual-flight/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, open_igc_upload FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; open_igc_upload: number }>();
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

      const active = await c.env.DB.prepare(
        `SELECT task_manual_flight_id FROM task_manual_flight
         WHERE task_id = ? AND comp_pilot_id = ? AND active = 1`
      )
        .bind(taskId, compPilotId)
        .first<{ task_manual_flight_id: number }>();
      if (!active) {
        return c.json({ error: "No manual flight to remove for this pilot" }, 404);
      }

      await supersedeActiveManualFlights(c.env.DB, taskId, compPilotId);
      // The pilot's outcome was Landed (from this record) — clear it back to
      // Present now that there is no active evidence.
      await c.env.DB.prepare(
        `DELETE FROM task_pilot_status
         WHERE task_id = ? AND comp_pilot_id = ? AND status_key = 'landed'`
      )
        .bind(taskId, compPilotId)
        .run();

      await bumpAndRevalidateScores(c, [taskId]);
      await audit(c.env.DB, user, compId, {
        subject_type: "track",
        subject_id: active.task_manual_flight_id,
        subject_name: cp.registered_pilot_name,
        description: `Removed manual flight for ${cp.registered_pilot_name} (back to Present)`,
      });

      return c.json({ success: true });
    }
  )

  // ── POST .../manual-flight/:comp_pilot_id/restore/:manual_flight_id ──
  // Reactivate a superseded manual flight, re-materializing its made-good
  // against the current route. Supersedes any other active evidence.
  .post(
    "/api/comp/:comp_id/task/:task_id/manual-flight/:comp_pilot_id/restore/:manual_flight_id",
    requireAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const taskId = c.var.ids.task_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      const manualFlightId = decodeId(alphabet, c.req.param("manual_flight_id"));
      if (manualFlightId === null) {
        return c.json({ error: "Invalid manual_flight_id" }, 400);
      }

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, open_igc_upload FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; open_igc_upload: number }>();
      if (!comp) return c.json({ error: "Competition not found" }, 404);

      const taskRow = await loadScoringTask(c.env.DB, compId, taskId);
      if (!taskRow) return c.json({ error: "Task not found" }, 404);
      if (!taskRow.xctsk) {
        return c.json({ error: "Task has no route" }, 400);
      }

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

      const target = await c.env.DB.prepare(
        `SELECT * FROM task_manual_flight
         WHERE task_manual_flight_id = ? AND task_id = ? AND comp_pilot_id = ?`
      )
        .bind(manualFlightId, taskId, compPilotId)
        .first<ManualFlightRow>();
      if (!target) return c.json({ error: "Manual flight not found" }, 404);

      // Recompute made-good against the current route (it may have changed
      // since the record was captured).
      const { xcTask, scoringTask, offset } = scoringContext(
        taskRow.xctsk,
        taskRow.gap_params
      );
      const { madeGood, madeGoal } = computeManualMadeGood(xcTask, scoringTask, offset, {
        lastReachedTpIndex: target.last_reached_tp_index,
        landingLat: target.landing_lat,
        landingLon: target.landing_lon,
        durationSeconds: target.duration_seconds,
      });

      // Supersede all evidence, then activate the target (order keeps the
      // partial unique index satisfied).
      await supersedeActiveManualFlights(c.env.DB, taskId, compPilotId);
      const hadTrack = await supersedeActiveTrack(c.env.DB, taskId, compPilotId);
      await c.env.DB.prepare(
        `UPDATE task_manual_flight
         SET active = 1, computed_distance = ?, made_goal = ?,
             duration_seconds = ?, set_by_user_id = ?, set_by_name = ?, set_at = ?
         WHERE task_manual_flight_id = ?`
      )
        .bind(
          madeGood,
          madeGoal ? 1 : 0,
          madeGoal ? target.duration_seconds : null,
          user.id,
          user.name,
          new Date().toISOString(),
          manualFlightId
        )
        .run();
      await markLandedFromEvidence(c.env.DB, user, compId, taskId, compPilotId);

      await bumpAndRevalidateScores(c, [taskId]);
      const supersededNote = hadTrack ? "; superseded their track" : "";
      await audit(c.env.DB, user, compId, {
        subject_type: "track",
        subject_id: manualFlightId,
        subject_name: cp.registered_pilot_name,
        description:
          `Restored manual flight for ${cp.registered_pilot_name} ` +
          `(${formatKm(madeGood)} made good)${supersededNote}`,
      });

      const row = await c.env.DB.prepare(
        `SELECT * FROM task_manual_flight WHERE task_manual_flight_id = ?`
      )
        .bind(manualFlightId)
        .first<ManualFlightRow>();
      return c.json(serializeManualFlight(alphabet, row!));
    }
  );
