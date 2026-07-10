/**
 * Manual flight evidence + outcome reconciliation (issue #306).
 *
 * A pilot has at most ONE active flight record per task — a track XOR a manual
 * flight — and the materialized outcome (present | absent | dnf | landed) is
 * kept consistent with it:
 *
 *   - Recording a manual flight, or uploading a track, makes that record the
 *     active evidence, supersedes the other kind, and resolves to `landed`.
 *   - Setting Absent / DNF / Present supersedes BOTH kinds of evidence (kept,
 *     not scored) — this is the fix for the bug where a DNF left a still-scoring
 *     track on disk.
 *
 * Superseded rows are retained (`active = 0`) so they stay viewable and
 * restorable. Scoring reads only active records (see scoring.ts).
 *
 * The made-good geometry all runs through the engine (web/engine/src/
 * manual-flight.ts) — no inline geo here.
 */

import {
  parseXCTask,
  taskForDistanceOrigin,
  distanceMadeGoodTo,
  manualFlightScoringData,
  getGoalIndex,
  DEFAULT_GAP_PARAMETERS,
  type XCTask,
  type GAPParameters,
  type FlightScoringData,
} from "@glidecomp/engine";
import type { AuthUser } from "./env";

/** Synthetic `trackFile` key that pairs a manual flight's score back to its
 * pilot in scoreFlights — mirrors a track's igc_filename, but never collides
 * with an R2 key (which is `c/…/….igc`). */
export function manualFlightKey(compPilotId: number): string {
  return `manual:${compPilotId}`;
}

/** True when a score's `trackFile` identifies a manual flight, not a track. */
export function isManualFlightKey(trackFile: string): boolean {
  return trackFile.startsWith("manual:");
}

/**
 * The distance-origin offset between the full task turnpoints[] (the frame the
 * UI dropdown and the stored `last_reached_tp_index` use) and the trimmed
 * scoring task. `taskForDistanceOrigin('start')` drops the leading take-off/
 * pre-SSS turnpoints, so a full-task index maps to `fullIndex - offset` in the
 * scoring frame.
 */
function distanceOriginOffset(xcTask: XCTask, scoringTask: XCTask): number {
  return xcTask.turnpoints.length - scoringTask.turnpoints.length;
}

/** Resolve a task's xctsk + distance origin into a scoring task once. */
export function scoringContext(
  xctsk: string,
  gapParamsJson: string | null
): { xcTask: XCTask; scoringTask: XCTask; offset: number } {
  const xcTask = parseXCTask(xctsk);
  const gapParams: Partial<GAPParameters> = gapParamsJson
    ? JSON.parse(gapParamsJson)
    : {};
  const distanceOrigin =
    gapParams.distanceOrigin ?? DEFAULT_GAP_PARAMETERS.distanceOrigin;
  const scoringTask = taskForDistanceOrigin(xcTask, distanceOrigin);
  return { xcTask, scoringTask, offset: distanceOriginOffset(xcTask, scoringTask) };
}

/** The raw, per-pilot manual flight inputs stored in `task_manual_flight`. */
export interface ManualFlightInput {
  lastReachedTpIndex: number;
  landingLat: number;
  landingLon: number;
  durationSeconds: number | null;
}

/** Made-good + goal for a manual flight, computed by the engine against the
 * task's current geometry. `madeGoal` is true iff the last reached turnpoint
 * is the goal (the last turnpoint). */
export function computeManualMadeGood(
  xcTask: XCTask,
  scoringTask: XCTask,
  offset: number,
  input: ManualFlightInput
): { madeGood: number; madeGoal: boolean } {
  const scoringIndex = input.lastReachedTpIndex - offset;
  const madeGood = distanceMadeGoodTo(scoringTask, scoringIndex, {
    lat: input.landingLat,
    lon: input.landingLon,
  });
  const madeGoal = input.lastReachedTpIndex >= getGoalIndex(xcTask);
  return { madeGood, madeGoal };
}

/** Build the synthetic scoring input for one manual flight, mapped into the
 * scoring-task frame. Pairs back by {@link manualFlightKey}. */
export function manualFlightToScoringData(
  scoringTask: XCTask,
  offset: number,
  pilotName: string,
  compPilotId: number,
  input: ManualFlightInput
): FlightScoringData {
  return manualFlightScoringData(scoringTask, {
    pilotName,
    trackFile: manualFlightKey(compPilotId),
    lastReachedIndex: input.lastReachedTpIndex - offset,
    landing: { lat: input.landingLat, lon: input.landingLon },
    durationSeconds: input.durationSeconds,
  });
}

// ---------------------------------------------------------------------------
// Evidence reconciliation
// ---------------------------------------------------------------------------

/** Deactivate the pilot's active track (kept, not scored). Returns true when a
 * row was actually superseded. */
export async function supersedeActiveTrack(
  db: D1Database,
  taskId: number,
  compPilotId: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE task_track SET active = 0
       WHERE task_id = ? AND comp_pilot_id = ? AND active = 1`
    )
    .bind(taskId, compPilotId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Deactivate the pilot's active manual flight(s) (kept, not scored). Returns
 * true when a row was superseded. */
export async function supersedeActiveManualFlights(
  db: D1Database,
  taskId: number,
  compPilotId: number
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE task_manual_flight SET active = 0
       WHERE task_id = ? AND comp_pilot_id = ? AND active = 1`
    )
    .bind(taskId, compPilotId)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/**
 * Resolve a pilot's outcome to `landed` because a flight record just became
 * the active evidence. Upserts the `task_pilot_status` row to `landed` (note
 * cleared), mirroring applyStatusOnTrackUpload. Returns the previous status
 * key (or null when Present) so the caller can shape its audit line.
 */
export async function markLandedFromEvidence(
  db: D1Database,
  user: AuthUser,
  compId: number,
  taskId: number,
  compPilotId: number
): Promise<string | null> {
  const prev = await db
    .prepare(
      `SELECT status_key FROM task_pilot_status
       WHERE task_id = ? AND comp_pilot_id = ?`
    )
    .bind(taskId, compPilotId)
    .first<{ status_key: string }>();

  if (prev?.status_key === "landed") return "landed";

  const now = new Date().toISOString();
  if (prev) {
    await db
      .prepare(
        `UPDATE task_pilot_status
         SET status_key = 'landed', note = NULL, set_by_user_id = ?, set_by_name = ?, set_at = ?
         WHERE task_id = ? AND comp_pilot_id = ?`
      )
      .bind(user.id, user.name, now, taskId, compPilotId)
      .run();
  } else {
    await db
      .prepare(
        `INSERT INTO task_pilot_status
           (comp_id, task_id, comp_pilot_id, status_key, note, set_by_user_id, set_by_name, set_at)
         VALUES (?, ?, ?, 'landed', NULL, ?, ?, ?)`
      )
      .bind(compId, taskId, compPilotId, user.id, user.name, now)
      .run();
  }
  return prev?.status_key ?? null;
}
