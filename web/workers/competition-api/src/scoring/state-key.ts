/**
 * The score state key — the identity of a task's served score body.
 */

import { SCORING_ENGINE_VERSION } from "@glidecomp/engine";

/**
 * Compute a deterministic SHA-256 key identifying the current scoring state
 * of a task. The key changes whenever any input to scoring changes: xctsk
 * content, track uploads/deletions, penalty updates, roster edits, or an
 * engine-version bump.
 *
 * Stored on the task's `task_scores` row at write time, it is the identity
 * of the served body — the score endpoints use it as the ETag — and doubles
 * as a drift detector: a row whose stored key no longer matches a freshly
 * computed one means some mutation path forgot to bump `inputs_rev`.
 */
export async function computeScoreStateKey(
  taskId: number,
  db: D1Database
): Promise<string> {
  const task = await db
    .prepare(
      `SELECT t.xctsk, t.task_date, t.stop_announcement_time,
              c.scoring_format, c.category, c.timezone
       FROM task t JOIN comp c ON c.comp_id = t.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{
      xctsk: string | null;
      task_date: string | null;
      stop_announcement_time: string | null;
      scoring_format: string | null;
      category: string | null;
      timezone: string | null;
    }>();

  // Include the pilot roster (comp_pilot_id, name, class) in the hashed state.
  // The scored output embeds these fields, so a roster change — a rename, a
  // class change, or a re-seed that remaps comp_pilot IDs — must invalidate the
  // cache. Hashing only track-file identity let stale results (with the wrong
  // pilot names/IDs) survive a re-seed. See scores stale-cache investigation.
  const tracks = await db
    .prepare(
      `SELECT tt.task_track_id, tt.uploaded_at, tt.penalty_points,
              tt.quality_override, tt.comp_pilot_id,
              cp.registered_pilot_name, cp.pilot_class
       FROM task_track tt
       JOIN comp_pilot cp ON cp.comp_pilot_id = tt.comp_pilot_id
       WHERE tt.task_id = ? AND tt.active = 1 ORDER BY tt.task_track_id`
    )
    .bind(taskId)
    .all<{
      task_track_id: number;
      uploaded_at: string;
      penalty_points: number;
      quality_override: number;
      comp_pilot_id: number;
      registered_pilot_name: string;
      pilot_class: string;
    }>();

  // Manual flights (issue #306) are scoring inputs too: an active manual flight
  // is scored as numFlying and its made-good depends on its inputs + the route.
  // Hash the geometric inputs + made_goal/duration so recording, editing, or
  // superseding one invalidates the served body. Only active rows count.
  const manualFlights = await db
    .prepare(
      `SELECT mf.comp_pilot_id, mf.last_reached_tp_index, mf.landing_lat,
              mf.landing_lon, mf.made_goal, mf.duration_seconds, cp.pilot_class
       FROM task_manual_flight mf
       JOIN comp_pilot cp ON cp.comp_pilot_id = mf.comp_pilot_id
       WHERE mf.task_id = ? AND mf.active = 1 ORDER BY mf.comp_pilot_id`
    )
    .bind(taskId)
    .all<{
      comp_pilot_id: number;
      last_reached_tp_index: number;
      landing_lat: number;
      landing_lon: number;
      made_goal: number;
      duration_seconds: number | null;
      pilot_class: string;
    }>();

  // Pilot statuses feed launch validity now (non-absent = present, FAI S7F
  // §10.1), so a status change must alter the served body's identity. Hash the
  // per-task statuses with the pilot's class (the count that matters is
  // per-class). Absent/DNF pilots typically have no track, so this is the
  // only place they enter the key.
  const statuses = await db
    .prepare(
      `SELECT tps.comp_pilot_id, tps.status_key, cp.pilot_class
       FROM task_pilot_status tps
       JOIN comp_pilot cp ON cp.comp_pilot_id = tps.comp_pilot_id
       WHERE tps.task_id = ? ORDER BY tps.comp_pilot_id`
    )
    .bind(taskId)
    .all<{ comp_pilot_id: number; status_key: string; pilot_class: string }>();

  const stateString = [
    // Engine generation: rolls every scoring cache key when scoring
    // behaviour changes (see engine scoring-version.ts), so a cached score
    // and a cached per-pilot analysis can never come from different engine
    // versions — the guarantee behind the exact score-details narrative.
    `engine:${SCORING_ENGINE_VERSION}`,
    task?.scoring_format ?? "gap",
    task?.xctsk ?? "",
    // Stopped tasks (S7F §13.4): the stop announcement reshapes every score.
    `stop:${task?.stop_announcement_time ?? ""}`,
    // The task's day, the comp's zone and the category became scoring inputs
    // with track-quality.ts: together they decide whether a tracklog is
    // scored at all (a mistyped date is the likeliest cause of a wrongly
    // withheld pilot, so correcting it must invalidate the served body), and
    // the category sets both the GAP defaults and the speed ceiling.
    `day:${task?.task_date ?? ""}@${task?.timezone ?? ""}`,
    `cat:${task?.category ?? ""}`,
    // A scorekeeper's S7A §4.4.6 override puts a withheld track back into
    // the scored field.
    ...tracks.results
      .filter((t) => t.quality_override)
      .map((t) => `qo:${t.task_track_id}`),
    ...tracks.results.map(
      (t) =>
        `${t.task_track_id}:${t.uploaded_at}:${t.penalty_points}:${t.comp_pilot_id}:${t.registered_pilot_name}:${t.pilot_class}`
    ),
    ...statuses.results.map(
      (s) => `st:${s.comp_pilot_id}:${s.status_key}:${s.pilot_class}`
    ),
    ...manualFlights.results.map(
      (m) =>
        `mf:${m.comp_pilot_id}:${m.last_reached_tp_index}:${m.landing_lat}:${m.landing_lon}:${m.made_goal}:${m.duration_seconds ?? ""}:${m.pilot_class}`
    ),
  ].join("|");

  const hashBuffer = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stateString)
  );
  const hex = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);

  // v5: added scoring_format to the hashed state (open-distance support).
  // v6: added per-task pilot statuses (they now feed launch validity).
  // v7: only active tracks count; added active manual flights (issue #306).
  // v8: added the task stop announcement time (stopped tasks, issue #264).
  // v9: added the task date, comp zone, category and per-track quality
  //     overrides — all became scoring inputs with track-quality.ts.
  return `score:v9:${taskId}:${hex}`;
}
