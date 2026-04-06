import {
  parseIGC,
  parseXCTask,
  scoreTask,
  calculateOptimizedTaskDistance,
  type GAPParameters,
  type PilotFlight,
} from "@glidecomp/engine";
import { encodeId } from "./sqids";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PilotScoreEntry {
  rank: number;
  comp_pilot_id: string;
  pilot_name: string;
  made_goal: boolean;
  reached_ess: boolean;
  flown_distance: number;
  speed_section_time: number | null;
  distance_points: number;
  time_points: number;
  leading_points: number;
  arrival_points: number;
  penalty_points: number;
  total_score: number;
}

export interface ClassScore {
  pilot_class: string;
  task_validity: { launch: number; distance: number; time: number; task: number };
  available_points: { distance: number; time: number; leading: number; arrival: number; total: number };
  pilots: PilotScoreEntry[];
}

export interface TaskScoreResponse {
  task_id: string;
  comp_id: string;
  task_date: string;
  classes: ClassScore[];
}

// ---------------------------------------------------------------------------
// Cache key
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic SHA-256 cache key from the current task state.
 * The key changes automatically whenever any input to scoring changes:
 * xctsk content, track uploads/deletions, or penalty updates.
 */
export async function computeScoreCacheKey(
  taskId: number,
  db: D1Database
): Promise<string> {
  const task = await db
    .prepare("SELECT xctsk FROM task WHERE task_id = ?")
    .bind(taskId)
    .first<{ xctsk: string | null }>();

  const tracks = await db
    .prepare(
      `SELECT task_track_id, uploaded_at, penalty_points
       FROM task_track WHERE task_id = ? ORDER BY task_track_id`
    )
    .bind(taskId)
    .all<{ task_track_id: number; uploaded_at: string; penalty_points: number }>();

  const stateString = [
    task?.xctsk ?? "",
    ...tracks.results.map(
      (t) => `${t.task_track_id}:${t.uploaded_at}:${t.penalty_points}`
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

  return `score:${taskId}:${hex}`;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Compute scores for a task by fetching IGC files from R2 sequentially,
 * parsing them, and running the GAP formula per pilot class.
 *
 * Penalties are applied after scoreTask() — deducted from totalScore,
 * floored at 0, then pilots are re-ranked within their class.
 */
export async function computeTaskScore(
  taskId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string
): Promise<TaskScoreResponse> {
  // Load task + comp gap_params
  const taskRow = await db
    .prepare(
      `SELECT t.task_id, t.comp_id, t.task_date, t.xctsk,
              c.gap_params
       FROM task t
       JOIN comp c ON t.comp_id = c.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{
      task_id: number;
      comp_id: number;
      task_date: string;
      xctsk: string;
      gap_params: string | null;
    }>();

  if (!taskRow) throw new Error("Task not found");

  const xcTask = parseXCTask(taskRow.xctsk);
  const gapParams: Partial<GAPParameters> = taskRow.gap_params
    ? JSON.parse(taskRow.gap_params)
    : {};

  // Default nominalDistance to 70% of task distance if not set
  if (!gapParams.nominalDistance) {
    gapParams.nominalDistance =
      calculateOptimizedTaskDistance(xcTask) * 0.7;
  }

  // Load all tracks joined with pilot info, grouped by class
  const tracks = await db
    .prepare(
      `SELECT tt.task_track_id, tt.comp_pilot_id, tt.igc_filename,
              tt.penalty_points,
              cp.registered_pilot_name AS pilot_name,
              cp.pilot_class
       FROM task_track tt
       JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
       WHERE tt.task_id = ?
       ORDER BY tt.task_track_id`
    )
    .bind(taskId)
    .all<{
      task_track_id: number;
      comp_pilot_id: number;
      igc_filename: string;
      penalty_points: number;
      pilot_name: string;
      pilot_class: string;
    }>();

  // Load task classes
  const taskClasses = await db
    .prepare("SELECT pilot_class FROM task_class WHERE task_id = ?")
    .bind(taskId)
    .all<{ pilot_class: string }>();

  const scoredClasses = new Set(taskClasses.results.map((r) => r.pilot_class));

  // Fetch and parse IGC files sequentially to keep peak memory manageable.
  // Only include pilots whose class is scored by this task.
  type ParsedPilot = {
    flight: PilotFlight;
    comp_pilot_id: number;
    pilot_class: string;
    penalty_points: number;
  };

  const parsedPilots: ParsedPilot[] = [];

  for (const track of tracks.results) {
    if (!scoredClasses.has(track.pilot_class)) continue;

    const object = await r2.get(track.igc_filename);
    if (!object) continue;

    const compressed = await object.arrayBuffer();
    const decompressedStream = new Response(compressed).body!.pipeThrough(
      new DecompressionStream("gzip")
    );
    const decompressed = await new Response(decompressedStream).arrayBuffer();
    const igcText = new TextDecoder().decode(decompressed);

    let igc;
    try {
      igc = parseIGC(igcText);
    } catch {
      // Skip unparseable tracks — admin can delete and ask pilot to re-upload
      console.warn(`Skipping unparseable IGC: ${track.igc_filename}`);
      continue;
    }

    if (igc.fixes.length === 0) continue;

    const pilotName =
      igc.header.pilot || igc.header.competitionId || track.pilot_name;

    parsedPilots.push({
      flight: { pilotName, trackFile: track.igc_filename, fixes: igc.fixes },
      comp_pilot_id: track.comp_pilot_id,
      pilot_class: track.pilot_class,
      penalty_points: track.penalty_points,
    });
  }

  // Score each class separately
  const classScores: ClassScore[] = [];

  for (const pilotClass of scoredClasses) {
    const classPilots = parsedPilots.filter(
      (p) => p.pilot_class === pilotClass
    );

    if (classPilots.length === 0) {
      classScores.push({
        pilot_class: pilotClass,
        task_validity: { launch: 0, distance: 0, time: 0, task: 0 },
        available_points: { distance: 0, time: 0, leading: 0, arrival: 0, total: 0 },
        pilots: [],
      });
      continue;
    }

    const result = scoreTask(
      xcTask,
      classPilots.map((p) => p.flight),
      gapParams
    );

    // Apply penalties and re-rank
    const withPenalties = result.pilotScores.map((ps, idx) => {
      const pilot = classPilots[idx];
      const penalised = Math.max(0, ps.totalScore - pilot.penalty_points);
      return {
        pilotScore: ps,
        comp_pilot_id: pilot.comp_pilot_id,
        penalty_points: pilot.penalty_points,
        finalScore: penalised,
      };
    });

    withPenalties.sort((a, b) => b.finalScore - a.finalScore);

    const pilotEntries: PilotScoreEntry[] = withPenalties.map((p, i) => ({
      rank: i + 1,
      comp_pilot_id: encodeId(alphabet, p.comp_pilot_id),
      pilot_name: p.pilotScore.pilotName,
      made_goal: p.pilotScore.madeGoal,
      reached_ess: p.pilotScore.reachedESS,
      flown_distance: p.pilotScore.flownDistance,
      speed_section_time: p.pilotScore.speedSectionTime,
      distance_points: p.pilotScore.distancePoints,
      time_points: p.pilotScore.timePoints,
      leading_points: p.pilotScore.leadingPoints,
      arrival_points: p.pilotScore.arrivalPoints,
      penalty_points: p.penalty_points,
      total_score: p.finalScore,
    }));

    classScores.push({
      pilot_class: pilotClass,
      task_validity: result.taskValidity,
      available_points: result.availablePoints,
      pilots: pilotEntries,
    });
  }

  return {
    task_id: encodeId(alphabet, taskRow.task_id),
    comp_id: encodeId(alphabet, taskRow.comp_id),
    task_date: taskRow.task_date,
    classes: classScores,
  };
}
