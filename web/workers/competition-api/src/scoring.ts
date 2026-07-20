import {
  parseIGC,
  parseXCTask,
  resolveTurnpointSequence,
  scoreFlights,
  scoreOpenDistanceFlights,
  openDistanceForFlight,
  openDistanceGeometryForFlight,
  toFlightScoringData,
  taskForDistanceOrigin,
  manualFlightGeometry,
  manualOpenDistanceGeometry,
  computeLeadingAggregate,
  calculateOptimizedTaskDistance,
  DEFAULT_GAP_PARAMETERS,
  resolveCompGapParams,
  resolveTaskStop,
  resolveScoredWindowEnds,
  stoppedGlideRatio,
  resolveGoalAltitude,
  SCORING_ENGINE_VERSION,
  scoreTask,
  buildFieldContext,
  evaluateField,
  type XCTask,
  type IGCFix,
  type PilotFlight,
  type FieldAnalysisReport,
  type GAPParameters,
  type FlightScoringData,
  type OpenDistanceFlightData,
  type TaskScoreCore,
  type LeadingAggregate,
  type StoppedTaskScore,
  type StopResolutionOptions,
  type TurnpointSequenceResultJSON,
} from "@glidecomp/engine";
import { encodeId } from "./sqids";
import { manualFlightToScoringData, manualFlightKey } from "./manual-flight-store";

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
  distance_linear_points: number;
  distance_difficulty_points: number;
  time_points: number;
  leading_points: number;
  arrival_points: number;
  penalty_points: number;
  penalty_reason: string | null;
  total_score: number;
  /** Seconds started before the first start gate (S7F §12.2), when early. */
  early_start_seconds: number | null;
  /** How the early start reshaped the score — see engine PilotScore. */
  early_start_outcome: "pg_launch_to_sss" | "hg_penalty" | "hg_min_distance" | null;
  /** Automatic jump-the-gun penalty points deducted (HG early starts). */
  jump_the_gun_penalty: number | null;
  /** Stopped tasks (S7F §12.3.6): altitude-bonus metres folded into
   * flown_distance for a pilot still flying at the stop. Null otherwise. */
  stopped_altitude_bonus: number | null;
}

/** Whole-class stopped-task outcome (S7F §12.3) — see engine StoppedTaskScore. */
export interface ClassStoppedInfo {
  stop_time_ms: number;
  scored_window_seconds: number | null;
  minimum_run_seconds: number;
  requirement_met: boolean;
  stopped_validity: number;
  time_points_reduction: number;
  num_landed_before_stop: number;
}

export interface ClassScore {
  pilot_class: string;
  task_validity: { launch: number; distance: number; time: number; task: number; stopped?: number };
  available_points: { distance: number; time: number; leading: number; arrival: number; total: number };
  pilots: PilotScoreEntry[];
  /** Present when the task was scored as stopped (S7F §12.3). */
  stopped?: ClassStoppedInfo;
}

export interface TaskScoreResponse {
  task_id: string;
  comp_id: string;
  task_date: string;
  /** How the task was scored — lets the UI pick the right columns. */
  scoring_format: "gap" | "open_distance";
  classes: ClassScore[];
}

// ---------------------------------------------------------------------------
// State key
// ---------------------------------------------------------------------------

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
      `SELECT t.xctsk, t.stop_announcement_time, c.scoring_format
       FROM task t JOIN comp c ON c.comp_id = t.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{
      xctsk: string | null;
      stop_announcement_time: string | null;
      scoring_format: string | null;
    }>();

  // Include the pilot roster (comp_pilot_id, name, class) in the hashed state.
  // The scored output embeds these fields, so a roster change — a rename, a
  // class change, or a re-seed that remaps comp_pilot IDs — must invalidate the
  // cache. Hashing only track-file identity let stale results (with the wrong
  // pilot names/IDs) survive a re-seed. See scores stale-cache investigation.
  const tracks = await db
    .prepare(
      `SELECT tt.task_track_id, tt.uploaded_at, tt.penalty_points,
              tt.comp_pilot_id, cp.registered_pilot_name, cp.pilot_class
       FROM task_track tt
       JOIN comp_pilot cp ON cp.comp_pilot_id = tt.comp_pilot_id
       WHERE tt.task_id = ? AND tt.active = 1 ORDER BY tt.task_track_id`
    )
    .bind(taskId)
    .all<{
      task_track_id: number;
      uploaded_at: string;
      penalty_points: number;
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
  // §9.1), so a status change must alter the served body's identity. Hash the
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
    // Stopped tasks (S7F §12.3): the stop announcement reshapes every score.
    `stop:${task?.stop_announcement_time ?? ""}`,
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
  return `score:v8:${taskId}:${hex}`;
}

// ---------------------------------------------------------------------------
// Per-track analysis store (the `track_analysis` D1 table)
// ---------------------------------------------------------------------------

/** The kinds of per-track analysis rows `track_analysis` holds. */
type AnalysisVariant = "gap" | "od" | "pilot-detail";

/**
 * Load every stored analysis of one variant for a task's tracks that was
 * computed from the given task geometry, keyed by task_track_id. Callers
 * must still check the entry's uploaded_at against the track's current
 * uploaded_at — a re-uploaded track invalidates only its own row.
 */
async function loadTrackAnalyses(
  db: D1Database,
  taskId: number,
  variant: AnalysisVariant,
  geomHash: string
): Promise<Map<number, { uploaded_at: string; payload_json: string }>> {
  const rows = await db
    .prepare(
      `SELECT ta.task_track_id, ta.uploaded_at, ta.payload_json
       FROM track_analysis ta
       JOIN task_track tt ON tt.task_track_id = ta.task_track_id
       WHERE tt.task_id = ? AND ta.variant = ? AND ta.geom_hash = ?`
    )
    .bind(taskId, variant, geomHash)
    .all<{ task_track_id: number; uploaded_at: string; payload_json: string }>();
  return new Map(
    rows.results.map((r) => [
      r.task_track_id,
      { uploaded_at: r.uploaded_at, payload_json: r.payload_json },
    ])
  );
}

interface TrackAnalysisWrite {
  task_track_id: number;
  variant: AnalysisVariant;
  geom_hash: string;
  uploaded_at: string;
  payload_json: string;
}

/**
 * Persist freshly computed per-track analyses in one transactional batch.
 * The conflict guard keeps an out-of-order writer (a slow compute finishing
 * after the track was re-uploaded and re-analyzed) from replacing a newer
 * analysis with an older one for the same geometry. Best-effort: a failure
 * (e.g. a track deleted mid-compute) only costs a recompute next time.
 */
async function saveTrackAnalyses(
  db: D1Database,
  writes: TrackAnalysisWrite[]
): Promise<void> {
  if (writes.length === 0) return;
  try {
    await db.batch(
      writes.map((w) =>
        db
          .prepare(
            `INSERT INTO track_analysis (task_track_id, variant, geom_hash, uploaded_at, payload_json)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(task_track_id, variant) DO UPDATE SET
               geom_hash = excluded.geom_hash,
               uploaded_at = excluded.uploaded_at,
               payload_json = excluded.payload_json
             WHERE excluded.uploaded_at > track_analysis.uploaded_at
                OR excluded.geom_hash != track_analysis.geom_hash`
          )
          .bind(w.task_track_id, w.variant, w.geom_hash, w.uploaded_at, w.payload_json)
      )
    );
  } catch (err) {
    console.error("track_analysis batch write failed", err);
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Per-track analysis stored in D1 (`track_analysis`, variant "gap") — the
 * field-independent result of resolving one pilot's turnpoint sequence.
 * Keyed by task geometry + track identity, so it survives roster/penalty
 * edits and (crucially) new track submissions: only the newly-added track
 * misses the store, the rest of the field is reused instead of being
 * re-fetched, re-parsed and re-resolved.
 * Plain numbers/booleans only, so JSON round-trips losslessly. */
interface CachedFlightAnalysis {
  flownDistance: number;
  madeGoal: boolean;
  reachedESS: boolean;
  speedSectionTime: number | null;
  sssTimeMs: number | null;
  essTimeMs: number | null;
  /** Seconds started before the first gate (S7F §12.2), when early. */
  earlyStartSeconds?: number;
  /** Official start time (gate-snapped in a gated race), epoch ms. Feeds the
   * stopped-task scored-window arithmetic (S7F §12.3.4). Absent in rows
   * cached before stopped tasks shipped — sssTimeMs is the fallback. */
  startTimeMs?: number | null;
  /** Stopped tasks: pilot landed before the stop (feeds §12.3.3 validity). */
  landedBeforeStop?: boolean;
  /** Stopped tasks: §12.3.6 altitude bonus folded into flownDistance (m). */
  stoppedAltitudeBonus?: number;
  /** Present only for leading-enabled comps — the per-track leading scan,
   * cached so a new upload doesn't force a re-scan of the whole field. Its
   * validity is tied to the task geometry + leading formula in the cache key. */
  leadingAggregate?: LeadingAggregate;
}

/** Short SHA-256 hex digest (16 chars) of a string — used for state keys
 * and the track_analysis geometry hashes. */
export async function shortHash(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/** Map over items with bounded concurrency, preserving input order. Keeps peak
 * memory (decompressed tracklogs) and outbound concurrency in check on a
 * Worker while still overlapping R2 latency across many tracks. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

/** How many tracks to fetch/parse from R2 at once on a cache miss. */
const TRACK_FETCH_CONCURRENCY = 10;

/** An empty class result — used when a class has no scored tracks. */
function emptyClassScore(pilotClass: string): ClassScore {
  return {
    pilot_class: pilotClass,
    task_validity: { launch: 0, distance: 0, time: 0, task: 0 },
    available_points: { distance: 0, time: 0, leading: 0, arrival: 0, total: 0 },
    pilots: [],
  };
}

/**
 * Apply penalties, re-rank, and shape one class's engine result into the API
 * response. Shared by the GAP and open-distance paths — both produce a result
 * with the same taskValidity / availablePoints / pilotScores shape.
 *
 * scoreFlights()/scoreOpenDistanceFlights() sort pilotScores by rank, so the
 * output order does NOT match the input order — pair each score back to its
 * pilot by trackFile (the unique igc_filename), never by array index.
 */
function buildClassScore(
  pilotClass: string,
  result: Pick<TaskScoreCore, "taskValidity" | "availablePoints" | "pilotScores"> & {
    stopped?: StoppedTaskScore;
  },
  pilotMeta: Map<
    string,
    { comp_pilot_id: number; penalty_points: number; penalty_reason: string | null }
  >,
  alphabet: string
): ClassScore {
  const withPenalties = result.pilotScores.map((ps) => {
    const pilot = pilotMeta.get(ps.trackFile)!;
    // FAI S7F §12.4: apply the scorekeeper's absolute penalty, then round to
    // one decimal place (rounding is done after penalties), floored at zero
    // (the lowest score a pilot can attain is 0). ps.totalScore is already the
    // §11 one-decimal total; re-rounding keeps the final clean when the
    // penalty itself carries more precision.
    const penalised = ps.totalScore - pilot.penalty_points;
    return {
      pilotScore: ps,
      comp_pilot_id: pilot.comp_pilot_id,
      penalty_points: pilot.penalty_points,
      penalty_reason: pilot.penalty_reason,
      finalScore: Math.max(0, Math.round(penalised * 10) / 10),
    };
  });

  withPenalties.sort((a, b) => b.finalScore - a.finalScore);

  const pilots: PilotScoreEntry[] = withPenalties.map((p, i) => ({
    rank: i + 1,
    comp_pilot_id: encodeId(alphabet, p.comp_pilot_id),
    pilot_name: p.pilotScore.pilotName,
    made_goal: p.pilotScore.madeGoal,
    reached_ess: p.pilotScore.reachedESS,
    flown_distance: p.pilotScore.flownDistance,
    speed_section_time: p.pilotScore.speedSectionTime,
    distance_points: p.pilotScore.distancePoints,
    distance_linear_points: p.pilotScore.distanceLinearPoints,
    distance_difficulty_points: p.pilotScore.distanceDifficultyPoints,
    time_points: p.pilotScore.timePoints,
    leading_points: p.pilotScore.leadingPoints,
    arrival_points: p.pilotScore.arrivalPoints,
    penalty_points: p.penalty_points,
    penalty_reason: p.penalty_reason,
    total_score: p.finalScore,
    early_start_seconds: p.pilotScore.earlyStartSeconds ?? null,
    early_start_outcome: p.pilotScore.earlyStartOutcome ?? null,
    jump_the_gun_penalty: p.pilotScore.jumpTheGunPenalty ?? null,
    stopped_altitude_bonus: p.pilotScore.stoppedAltitudeBonus ?? null,
  }));

  return {
    pilot_class: pilotClass,
    task_validity: result.taskValidity,
    available_points: result.availablePoints,
    pilots,
    ...(result.stopped
      ? {
          stopped: {
            stop_time_ms: result.stopped.stopTimeMs,
            scored_window_seconds: result.stopped.scoredWindowSeconds,
            minimum_run_seconds: result.stopped.minimumRunSeconds,
            requirement_met: result.stopped.requirementMet,
            stopped_validity: result.stopped.stoppedValidity,
            time_points_reduction: result.stopped.timePointsReduction,
            num_landed_before_stop: result.stopped.numLandedBeforeStop,
          },
        }
      : {}),
  };
}

/** One active, scoreable track row joined with its pilot. */
export interface ScoredTrackRow {
  task_track_id: number;
  comp_pilot_id: number;
  igc_filename: string;
  uploaded_at: string;
  penalty_points: number;
  penalty_reason: string | null;
  pilot_name: string;
  pilot_class: string;
}

/**
 * Everything that shapes how a task is scored, resolved from D1 once.
 *
 * Extracted so the field-analysis path (computeTaskFieldAnalysis) provably
 * scores against the SAME parameters as the published scores. Without a
 * shared resolution the two would drift silently the first time someone
 * touched the GAP defaults, and the analysis would correlate its metrics
 * against ranks nobody recognises.
 */
export interface TaskScoringConfig {
  taskRow: {
    task_id: number;
    comp_id: number;
    task_date: string;
    category: string;
    xctsk: string;
    stop_announcement_time: string | null;
    gap_params: string | null;
    scoring_format: string | null;
    creation_date: string;
  };
  xcTask: XCTask;
  /** xcTask trimmed by the distance-origin convention — what scoreFlights sees. */
  scoringTask: XCTask;
  scoringFormat: "gap" | "open_distance";
  category: "hg" | "pg";
  gapParams: Partial<GAPParameters>;
  fullGapParams: GAPParameters;
  distanceOrigin: GAPParameters["distanceOrigin"];
  useLeading: boolean;
  leadingFormula: GAPParameters["leadingFormula"];
  stopCtx: ReturnType<typeof resolveTaskStop> | null;
  stopBase: StopResolutionOptions | null;
  scoredClasses: Set<string>;
  scoredTracks: ScoredTrackRow[];
  /** Per class: pilots marked DNF with neither a track nor a manual flight. */
  dnfByClass: Map<string, number>;
  /** Comp IANA zone (presentational; null when unset). Labels field-analysis
   * times of day; never affects scoring, which is UTC. */
  timezone: string | null;
}

/** Resolve a task's scoring parameters, roster and tracks. Throws when the
 * task doesn't exist. */
export async function resolveTaskScoringConfig(
  taskId: number,
  db: D1Database
): Promise<TaskScoringConfig> {
  // Load task + comp gap_params
  const taskRow = await db
    .prepare(
      `SELECT t.task_id, t.comp_id, t.task_date, t.xctsk, t.stop_announcement_time,
              c.category, c.gap_params, c.scoring_format, c.creation_date, c.timezone
       FROM task t
       JOIN comp c ON t.comp_id = c.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{
      task_id: number;
      comp_id: number;
      task_date: string;
      category: string;
      xctsk: string;
      stop_announcement_time: string | null;
      gap_params: string | null;
      scoring_format: string | null;
      creation_date: string;
      timezone: string | null;
    }>();

  if (!taskRow) throw new Error("Task not found");

  const scoringFormat: "gap" | "open_distance" =
    taskRow.scoring_format === "open_distance" ? "open_distance" : "gap";

  const xcTask = parseXCTask(taskRow.xctsk);
  const storedGapParams: Partial<GAPParameters> | null = taskRow.gap_params
    ? JSON.parse(taskRow.gap_params)
    : null;
  // A comp that hasn't saved its scoring settings falls back to the official
  // per-category FAI defaults (leading/arrival/difficulty as the S7F formula
  // uses them) rather than the raw HG-shaped engine baseline (issue #343).
  // resolveCompGapParams also keeps the pre-#258 time-points exponent for a
  // comp that saved a leadingFormula before the exponent was decoupled.
  const category = taskRow.category === "pg" ? "pg" : "hg";
  // Pass the comp's creation time so a PG comp with no pinned leading-weight
  // formula defaults to S7F-2024 when created on/after the cutoff, and to
  // GAP2020/AirScore parity when created before it (issue #257).
  const compCreatedAtMs = Date.parse(taskRow.creation_date);
  const gapParams: Partial<GAPParameters> = resolveCompGapParams(
    category,
    storedGapParams,
    Number.isNaN(compCreatedAtMs) ? null : compCreatedAtMs
  );

  // Default nominalDistance to 70% of task distance when the comp hasn't
  // pinned one (the per-category defaults carry the engine baseline, so key
  // off the *stored* value's absence). Only relevant to GAP — open distance
  // ignores GAP parameters entirely.
  if (scoringFormat === "gap" && storedGapParams?.nominalDistance == null) {
    gapParams.nominalDistance =
      calculateOptimizedTaskDistance(xcTask) * 0.7;
  }

  // Resolve the parameters that shape per-pilot analysis. distanceOrigin trims
  // the task; useLeading + leadingFormula shape the cached leading aggregate.
  const distanceOrigin = gapParams.distanceOrigin ?? DEFAULT_GAP_PARAMETERS.distanceOrigin;
  const useLeading = gapParams.useLeading ?? DEFAULT_GAP_PARAMETERS.useLeading;
  const leadingFormula = gapParams.leadingFormula ?? DEFAULT_GAP_PARAMETERS.leadingFormula;
  const scoringTask = taskForDistanceOrigin(xcTask, distanceOrigin);

  // Stopped tasks (issue #264, S7F §12.3): derive the task stop time from
  // the recorded announcement (PG: minus scoreBackTime; HG: minus one gate
  // interval) and the per-flight stop context. GAP only — open distance has
  // no stopped-task concept in the spec.
  const fullGapParams: GAPParameters = { ...DEFAULT_GAP_PARAMETERS, ...gapParams };
  const stopAnnouncementMs = taskRow.stop_announcement_time
    ? Date.parse(taskRow.stop_announcement_time)
    : NaN;
  const stopCtx =
    scoringFormat === "gap" && Number.isFinite(stopAnnouncementMs)
      ? resolveTaskStop(scoringTask, stopAnnouncementMs, fullGapParams)
      : null;
  const stopBase: StopResolutionOptions | null = stopCtx
    ? {
        stopTimeMs: stopCtx.stopTimeMs,
        glideRatio: stoppedGlideRatio(fullGapParams.scoring),
        goalAltitude: resolveGoalAltitude(scoringTask),
      }
    : null;

  // Load all active tracks joined with pilot info, grouped by class. A
  // superseded track (active = 0 — e.g. a pilot later marked DNF, or replaced
  // by a manual flight) is retained but NOT scored (issue #306).
  const tracks = await db
    .prepare(
      `SELECT tt.task_track_id, tt.comp_pilot_id, tt.igc_filename, tt.uploaded_at,
              tt.penalty_points, tt.penalty_reason,
              cp.registered_pilot_name AS pilot_name,
              cp.pilot_class
       FROM task_track tt
       JOIN comp_pilot cp ON tt.comp_pilot_id = cp.comp_pilot_id
       WHERE tt.task_id = ? AND tt.active = 1
       ORDER BY tt.task_track_id`
    )
    .bind(taskId)
    .all<ScoredTrackRow>();

  // Load task classes
  const taskClasses = await db
    .prepare("SELECT pilot_class FROM task_class WHERE task_id = ?")
    .bind(taskId)
    .all<{ pilot_class: string }>();

  const scoredClasses = new Set(taskClasses.results.map((r) => r.pilot_class));
  const scoredTracks = tracks.results.filter((t) => scoredClasses.has(t.pilot_class));

  // Launch validity (FAI S7F §9.1): "pilots present" = pilots who took off
  // (have a track = numFlying) + pilots present who did not fly ("Did Not
  // Fly"). Absent and Present-default pilots without a track are excluded, so
  // numPresent per class = numFlying + numDNF. Count DNF pilots WITHOUT a
  // track — a pilot with a track already counts as flying and never carries a
  // DNF status (uploading a track sets them to Landed).
  const dnfRows = await db
    .prepare(
      `SELECT cp.pilot_class, COUNT(*) AS n
       FROM task_pilot_status tps
       JOIN comp_pilot cp ON cp.comp_pilot_id = tps.comp_pilot_id
       WHERE tps.task_id = ? AND tps.status_key = 'dnf'
         AND NOT EXISTS (
           SELECT 1 FROM task_track tt
           WHERE tt.task_id = tps.task_id
             AND tt.comp_pilot_id = tps.comp_pilot_id
             AND tt.active = 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM task_manual_flight mf
           WHERE mf.task_id = tps.task_id
             AND mf.comp_pilot_id = tps.comp_pilot_id
             AND mf.active = 1
         )
       GROUP BY cp.pilot_class`
    )
    .bind(taskId)
    .all<{ pilot_class: string; n: number }>();
  const dnfByClass = new Map(dnfRows.results.map((r) => [r.pilot_class, r.n]));

  return {
    taskRow,
    xcTask,
    scoringTask,
    scoringFormat,
    category,
    gapParams,
    fullGapParams,
    distanceOrigin,
    useLeading,
    leadingFormula,
    stopCtx,
    stopBase,
    scoredClasses,
    scoredTracks,
    dnfByClass,
    timezone: taskRow.timezone,
  };
}

/** Fetch, decompress and parse one track's IGC from R2 (null on failure —
 * missing object, unparseable file, or no fixes). */
export async function fetchIgcFixes(
  r2: R2Bucket,
  igcFilename: string
): Promise<IGCFix[] | null> {
  const object = await r2.get(igcFilename);
  if (!object) return null;
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
    console.warn(`Skipping unparseable IGC: ${igcFilename}`);
    return null;
  }
  if (igc.fixes.length === 0) return null;
  return igc.fixes;
}

/**
 * Compute scores for a task by gathering each pilot's flight analysis, then
 * running the GAP formula per pilot class.
 *
 * Each pilot's turnpoint-sequence resolution (the expensive tracklog scan) is
 * independent of the rest of the field, so it is stored per-track in the
 * track_analysis table and reused across recomputes; only tracks that are new
 * or changed are fetched from R2, decompressed and re-parsed, and those run
 * with bounded concurrency. Leading comps store the per-track leading
 * aggregate alongside, so a new upload doesn't force a re-scan of the field.
 *
 * Penalties are applied after scoring — deducted from totalScore, floored at 0,
 * then pilots are re-ranked within their class.
 */
export async function computeTaskScore(
  taskId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string,
  // A pre-resolved config, when the caller already has one. Field analysis
  // passes its own so the official ranks it overlays are guaranteed to come
  // from the SAME parameters/geometry as its re-score — two independent
  // resolutions could straddle a concurrent task edit — and so the compute
  // doesn't pay the 4 D1 queries twice.
  cfg?: TaskScoringConfig
): Promise<TaskScoreResponse> {
  const {
    taskRow,
    xcTask,
    scoringTask,
    scoringFormat,
    gapParams,
    distanceOrigin,
    useLeading,
    leadingFormula,
    stopCtx,
    stopBase,
    scoredClasses,
    scoredTracks,
    dnfByClass,
  } = cfg ?? (await resolveTaskScoringConfig(taskId, db));

  // Open distance: score each pilot on how far they flew from the take-off
  // exit. Each pilot's open distance is field-independent, so — like the GAP
  // path — it is stored per track in track_analysis and reused across
  // recomputes; only new or changed tracks are fetched from R2, decompressed
  // and re-parsed. Open distance needs the raw fixes (not the GAP turnpoint
  // analysis), so it uses its own variant holding just the computed distance.
  if (scoringFormat === "open_distance") {
    // Any change to the task geometry (xctsk, which holds the take-off
    // cylinder) invalidates every stored distance.
    const geomHash = await shortHash(
      `${taskRow.xctsk} engine:${SCORING_ENGINE_VERSION}`
    );
    const stored = await loadTrackAnalyses(db, taskId, "od", geomHash);
    const analysisWrites: TrackAnalysisWrite[] = [];

    type AnalyzedOpenPilot = {
      flight: OpenDistanceFlightData;
      comp_pilot_id: number;
      pilot_class: string;
      penalty_points: number;
      penalty_reason: string | null;
    };
    const analyzed = await mapWithConcurrency(
      scoredTracks,
      TRACK_FETCH_CONCURRENCY,
      async (track): Promise<AnalyzedOpenPilot | null> => {
        let distance: number | null = null;
        const hit = stored.get(track.task_track_id);
        if (hit && hit.uploaded_at === track.uploaded_at) {
          distance = (JSON.parse(hit.payload_json) as { distance: number }).distance;
        }

        if (distance === null) {
          const fixes = await fetchIgcFixes(r2, track.igc_filename);
          if (!fixes) return null;

          distance = openDistanceForFlight(xcTask, {
            pilotName: track.pilot_name,
            trackFile: track.igc_filename,
            fixes,
          });

          analysisWrites.push({
            task_track_id: track.task_track_id,
            variant: "od",
            geom_hash: geomHash,
            uploaded_at: track.uploaded_at,
            payload_json: JSON.stringify({ distance }),
          });
        }

        return {
          flight: {
            pilotName: track.pilot_name,
            trackFile: track.igc_filename,
            distance,
          },
          comp_pilot_id: track.comp_pilot_id,
          pilot_class: track.pilot_class,
          penalty_points: track.penalty_points,
          penalty_reason: track.penalty_reason,
        };
      }
    );
    await saveTrackAnalyses(db, analysisWrites);
    const analyzedPilots = analyzed.filter(
      (p): p is AnalyzedOpenPilot => p !== null
    );

    // Manual flights (issue #306) on an open-distance task: the made-good is
    // the straight-line distance from the take-off cylinder edge to the landing
    // point. Cheap to compute (no R2 / tracklog), inline and uncached; only
    // active rows in scored classes, scored as numFlying.
    const odManualRows = await db
      .prepare(
        `SELECT mf.comp_pilot_id, mf.landing_lat, mf.landing_lon,
                cp.registered_pilot_name AS pilot_name, cp.pilot_class
         FROM task_manual_flight mf
         JOIN comp_pilot cp ON cp.comp_pilot_id = mf.comp_pilot_id
         WHERE mf.task_id = ? AND mf.active = 1`
      )
      .bind(taskId)
      .all<{
        comp_pilot_id: number;
        landing_lat: number;
        landing_lon: number;
        pilot_name: string;
        pilot_class: string;
      }>();
    for (const m of odManualRows.results) {
      if (!scoredClasses.has(m.pilot_class)) continue;
      const od = manualOpenDistanceGeometry(xcTask, {
        lat: m.landing_lat,
        lon: m.landing_lon,
      });
      analyzedPilots.push({
        flight: {
          pilotName: m.pilot_name,
          trackFile: manualFlightKey(m.comp_pilot_id),
          distance: od.distance,
        },
        comp_pilot_id: m.comp_pilot_id,
        pilot_class: m.pilot_class,
        penalty_points: 0,
        penalty_reason: null,
      });
    }

    const classScores: ClassScore[] = [];
    for (const pilotClass of scoredClasses) {
      const classPilots = analyzedPilots.filter((p) => p.pilot_class === pilotClass);
      if (classPilots.length === 0) {
        classScores.push(emptyClassScore(pilotClass));
        continue;
      }
      const numPresent =
        classPilots.length + (dnfByClass.get(pilotClass) ?? 0);
      const result = scoreOpenDistanceFlights(
        classPilots.map((p) => p.flight),
        numPresent
      );
      const pilotMeta = new Map(
        classPilots.map((p) => [
          p.flight.trackFile,
          {
            comp_pilot_id: p.comp_pilot_id,
            penalty_points: p.penalty_points,
            penalty_reason: p.penalty_reason,
          },
        ])
      );
      classScores.push(buildClassScore(pilotClass, result, pilotMeta, alphabet));
    }

    return {
      task_id: encodeId(alphabet, taskRow.task_id),
      comp_id: encodeId(alphabet, taskRow.comp_id),
      task_date: taskRow.task_date,
      scoring_format: "open_distance",
      classes: classScores,
    };
  }

  // Per-track analysis geometry hash: any change to the task geometry
  // (xctsk) or distance origin invalidates every stored analysis. Leading
  // comps also reuse rows — but the leading aggregate depends on the formula,
  // so it is folded into the hash (and the payload carries the aggregate).
  // The leading vs no-leading variants hash differently so a hit always has
  // the shape it needs. A task stop reshapes every per-track result (window
  // clip + altitude bonus), so the resolved stop time and glide ratio fold
  // in too (the goal altitude comes from the xctsk, already in the key).
  const stopKey = stopBase
    ? ` stop:${stopBase.stopTimeMs}:${stopBase.glideRatio}`
    : "";
  const geomKey = useLeading
    ? `${taskRow.xctsk} ${distanceOrigin} lead:${leadingFormula}${stopKey}`
    : `${taskRow.xctsk} ${distanceOrigin} nolead${stopKey}`;
  const geomHash = await shortHash(`${geomKey} engine:${SCORING_ENGINE_VERSION}`);
  const stored = await loadTrackAnalyses(db, taskId, "gap", geomHash);
  const analysisWrites: TrackAnalysisWrite[] = [];

  type AnalyzedPilot = {
    flight: FlightScoringData;
    comp_pilot_id: number;
    pilot_class: string;
    penalty_points: number;
    penalty_reason: string | null;
    /** The underlying track row — null for manual (track-less) flights. */
    track: ScoredTrackRow | null;
  };

  /** Resolve one track's scoring inputs against the task (stop-aware). */
  const resolveGapFlight = (
    track: ScoredTrackRow,
    fixes: IGCFix[],
    stop: StopResolutionOptions | null
  ): FlightScoringData => {
    const result = resolveTurnpointSequence(
      scoringTask, fixes, stop ? { stop } : undefined,
    );
    // Base (field-independent) analysis, without retaining the heavy
    // tracklog. Leading comps additionally capture the per-track leading
    // scan as an aggregate, so a later upload doesn't re-scan the field.
    const base = toFlightScoringData(
      { pilotName: track.pilot_name, trackFile: track.igc_filename, fixes },
      result,
      false
    );
    const leadingAggregate = useLeading
      ? computeLeadingAggregate(
          fixes, scoringTask, result.sequence,
          base.sssTimeMs, base.essTimeMs, leadingFormula
        )
      : undefined;
    return leadingAggregate ? { ...base, leadingAggregate } : base;
  };

  // Gather each pilot's scoring inputs — from the per-track analysis store
  // when possible, otherwise by fetching + decompressing + parsing the IGC
  // from R2 and resolving its turnpoint sequence. Bounded concurrency
  // overlaps R2 latency while capping peak memory from decompressed
  // tracklogs. For a stopped task this pass scores every pilot against the
  // stop-time window — exact for single-start-gate races; the multi-gate
  // per-pilot equalization happens in the class loop below (§12.3.4).
  const analyzed = await mapWithConcurrency(
    scoredTracks,
    TRACK_FETCH_CONCURRENCY,
    async (track): Promise<AnalyzedPilot | null> => {
      let flight: FlightScoringData | null = null;

      const hit = stored.get(track.task_track_id);
      if (hit && hit.uploaded_at === track.uploaded_at) {
        const cached = JSON.parse(hit.payload_json) as CachedFlightAnalysis;
        flight = {
          pilotName: track.pilot_name,
          trackFile: track.igc_filename,
          ...cached,
        };
      }

      if (!flight) {
        const fixes = await fetchIgcFixes(r2, track.igc_filename);
        if (!fixes) return null;
        flight = resolveGapFlight(track, fixes, stopBase);

        // Store the compact, field-independent analysis for reuse. Only the
        // geometric fields (+ leading aggregate) — the pilot name/id come
        // fresh from the DB each run, so renames and penalties never
        // invalidate this entry.
        const compact: CachedFlightAnalysis = {
          flownDistance: flight.flownDistance,
          madeGoal: flight.madeGoal,
          reachedESS: flight.reachedESS,
          speedSectionTime: flight.speedSectionTime,
          sssTimeMs: flight.sssTimeMs,
          essTimeMs: flight.essTimeMs,
          startTimeMs: flight.startTimeMs ?? null,
          ...(flight.earlyStartSeconds !== undefined
            ? { earlyStartSeconds: flight.earlyStartSeconds }
            : {}),
          ...(flight.landedBeforeStop !== undefined
            ? { landedBeforeStop: flight.landedBeforeStop }
            : {}),
          ...(flight.stoppedAltitudeBonus !== undefined
            ? { stoppedAltitudeBonus: flight.stoppedAltitudeBonus }
            : {}),
          ...(flight.leadingAggregate
            ? { leadingAggregate: flight.leadingAggregate }
            : {}),
        };
        analysisWrites.push({
          task_track_id: track.task_track_id,
          variant: "gap",
          geom_hash: geomHash,
          uploaded_at: track.uploaded_at,
          payload_json: JSON.stringify(compact),
        });
      }

      return {
        flight,
        comp_pilot_id: track.comp_pilot_id,
        pilot_class: track.pilot_class,
        penalty_points: track.penalty_points,
        penalty_reason: track.penalty_reason,
        track,
      };
    }
  );
  await saveTrackAnalyses(db, analysisWrites);

  const analyzedPilots = analyzed.filter((p): p is AnalyzedPilot => p !== null);

  // Manual flights (issue #306): track-less pilots recorded by an admin.
  // Their made-good is cheap to compute (no R2 fetch, no tracklog scan), so
  // build the synthetic scoring inputs inline against the same scoring task —
  // recomputed live so a later route edit rescales them. Only active rows in
  // scored classes count; they score as numFlying like any tracked pilot.
  const offset = xcTask.turnpoints.length - scoringTask.turnpoints.length;
  const manualRows = await db
    .prepare(
      `SELECT mf.comp_pilot_id, mf.last_reached_tp_index, mf.landing_lat,
              mf.landing_lon, mf.duration_seconds,
              cp.registered_pilot_name AS pilot_name, cp.pilot_class
       FROM task_manual_flight mf
       JOIN comp_pilot cp ON cp.comp_pilot_id = mf.comp_pilot_id
       WHERE mf.task_id = ? AND mf.active = 1`
    )
    .bind(taskId)
    .all<{
      comp_pilot_id: number;
      last_reached_tp_index: number;
      landing_lat: number;
      landing_lon: number;
      duration_seconds: number | null;
      pilot_name: string;
      pilot_class: string;
    }>();
  for (const m of manualRows.results) {
    if (!scoredClasses.has(m.pilot_class)) continue;
    analyzedPilots.push({
      flight: manualFlightToScoringData(
        scoringTask,
        offset,
        m.pilot_name,
        m.comp_pilot_id,
        {
          lastReachedTpIndex: m.last_reached_tp_index,
          landingLat: m.landing_lat,
          landingLon: m.landing_lon,
          durationSeconds: m.duration_seconds,
        }
      ),
      comp_pilot_id: m.comp_pilot_id,
      pilot_class: m.pilot_class,
      penalty_points: 0,
      penalty_reason: null,
      track: null,
    });
  }

  // Score each class separately
  const classScores: ClassScore[] = [];

  for (const pilotClass of scoredClasses) {
    const classPilots = analyzedPilots.filter(
      (p) => p.pilot_class === pilotClass
    );

    if (classPilots.length === 0) {
      classScores.push(emptyClassScore(pilotClass));
      continue;
    }

    let classFlights = classPilots.map((p) => p.flight);

    // Stopped multi-gate / elapsed-time tasks (§12.3.4): every pilot in the
    // class is scored for the duration the LAST-started pilot had. The
    // equalized windows come from the stop-clipped first pass; affected
    // tracks are re-resolved live against their own window end. This path
    // is rare (a stopped task with multiple gates), so it deliberately does
    // NOT write to the per-track cache — overwriting the single-row-per-
    // variant store with per-window rows would thrash the common cache.
    if (stopBase) {
      const starts = classFlights.map(
        (f) => f.startTimeMs ?? f.sssTimeMs ?? null
      );
      const windowEnds = resolveScoredWindowEnds(
        scoringTask, starts, stopBase.stopTimeMs
      );
      if (windowEnds) {
        classFlights = await mapWithConcurrency(
          classFlights,
          TRACK_FETCH_CONCURRENCY,
          async (flight, idx) => {
            const track = classPilots[idx].track;
            if (!track || windowEnds[idx] >= stopBase.stopTimeMs) return flight;
            const fixes = await fetchIgcFixes(r2, track.igc_filename);
            if (!fixes) return flight; // keep the stop-time-clipped pass 1
            return resolveGapFlight(track, fixes, {
              ...stopBase,
              windowEndMs: windowEnds[idx],
            });
          }
        );
      }
    }

    const numPresent =
      classPilots.length + (dnfByClass.get(pilotClass) ?? 0);
    const result = scoreFlights(
      scoringTask,
      classFlights,
      gapParams,
      numPresent,
      stopCtx ? { stopTimeMs: stopCtx.stopTimeMs } : undefined
    );
    const pilotMeta = new Map(
      classPilots.map((p) => [
        p.flight.trackFile,
        {
          comp_pilot_id: p.comp_pilot_id,
          penalty_points: p.penalty_points,
          penalty_reason: p.penalty_reason,
        },
      ])
    );
    classScores.push(buildClassScore(pilotClass, result, pilotMeta, alphabet));
  }

  return {
    task_id: encodeId(alphabet, taskRow.task_id),
    comp_id: encodeId(alphabet, taskRow.comp_id),
    task_date: taskRow.task_date,
    scoring_format: scoringFormat,
    classes: classScores,
  };
}

// ---------------------------------------------------------------------------
// Field analysis (behavioural metrics across the whole field)
// ---------------------------------------------------------------------------

/**
 * How many tracks one field analysis may hold in memory at once.
 *
 * Unlike scoring, field analysis needs EVERY pilot's raw fixes simultaneously
 * (the detectors plus a cross-pilot time grid), and a Worker isolate that
 * exceeds its 128 MB budget is killed with no useful error. This cap turns
 * that silent death into an explicit, explainable message on the row. Raise
 * it only with a measurement; the escape hatch for very large fields is to
 * move the compute off the request path entirely (queue consumer/container).
 */
export const MAX_FIELD_ANALYSIS_TRACKS = 80;

/** A task shape field analysis cannot describe — surfaced as a 422, not a 500. */
export class FieldAnalysisUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldAnalysisUnsupported";
  }
}

/** One pilot class's field-analysis report plus what the comp aggregate needs. */
export interface FieldAnalysisClass {
  pilot_class: string;
  report: FieldAnalysisReport;
  /** trackFile → cross-task pilot key (`cp:<comp_pilot_id>`). Exact, unlike
   * the CLI's filename heuristic, and survives pilot renames. */
  pilot_key_by_track_file: Record<string, string>;
  /** Per-pilot official totals — feeds aggregateComp's comp standings. */
  totals: { trackFile: string; pilotName: string; totalScore: number }[];
  /** Pilots in this class the analysis could not include, and why. Shown in
   * the UI so nobody reads the correlations as covering the whole field. */
  excluded: { pilot_name: string; reason: string }[];
}

/** The stored/served field-analysis blob for one task. */
export interface TaskFieldAnalysisResponse {
  task_id: string;
  comp_id: string;
  task_date: string;
  classes: FieldAnalysisClass[];
}

/**
 * Compute the behavioural field analysis for one task, per pilot class.
 *
 * Two things make this materially different from computeTaskScore:
 *
 * 1. It needs every pilot's RAW fixes at once — buildFieldContext runs the
 *    thermal/glide/circle detectors and builds a cross-pilot time grid — so
 *    the track_analysis cache (which stores scalars, not fixes) is no help
 *    and every track is a cold R2 GET + gunzip + parseIGC.
 *
 * 2. It re-scores through the engine's scoreTask() instead of reusing the
 *    stored scores. buildFieldContext reads PilotScore.turnpointResult, and
 *    the path computeTaskScore takes (scoreFlights) deliberately drops it to
 *    keep the hot scoring path light. Both run from resolveTaskScoringConfig,
 *    so the parameters cannot drift.
 *
 * Correlations are measured against OFFICIAL ranks (from computeTaskScore),
 * not the re-score's tracked-pilots-only ranks: manual flights (issue #306)
 * count toward the published standings but have no fixes to analyse, so
 * ranking within the tracked subset would correlate against a leaderboard
 * nobody recognises. Those pilots land in `excluded` for disclosure.
 */
export async function computeTaskFieldAnalysis(
  taskId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string
): Promise<TaskFieldAnalysisResponse> {
  const cfg = await resolveTaskScoringConfig(taskId, db);

  if (cfg.scoringFormat === "open_distance") {
    // Field analysis is built around a turnpoint task: legs, speed sections,
    // start gates, ESS. An open-distance task has a single take-off cylinder
    // and none of that structure.
    throw new FieldAnalysisUnsupported(
      "Field analysis is not available for open-distance tasks"
    );
  }
  if (cfg.scoredTracks.length === 0) {
    throw new FieldAnalysisUnsupported(
      "Field analysis needs tracks — none have been submitted for this task yet"
    );
  }
  if (cfg.scoredTracks.length > MAX_FIELD_ANALYSIS_TRACKS) {
    throw new FieldAnalysisUnsupported(
      `Field analysis is limited to ${MAX_FIELD_ANALYSIS_TRACKS} tracks per task ` +
        `(this task has ${cfg.scoredTracks.length}); the whole field must be ` +
        `held in memory at once`
    );
  }

  // Official standings — the ranks every correlation is measured against, and
  // the totals the comp aggregate ranks on. Usually cheap: computeTaskScore
  // reads its per-track analyses from track_analysis rather than R2. Passing
  // cfg through pins both passes to one parameter resolution — a concurrent
  // task edit can't put the overlaid ranks on different geometry than the
  // re-score below.
  const official = await computeTaskScore(taskId, db, r2, alphabet, cfg);
  const trackFileByPilotId = new Map(
    cfg.scoredTracks.map((t) => [encodeId(alphabet, t.comp_pilot_id), t.igc_filename])
  );

  const classes: FieldAnalysisClass[] = [];

  for (const pilotClass of cfg.scoredClasses) {
    const classTracks = cfg.scoredTracks.filter((t) => t.pilot_class === pilotClass);
    if (classTracks.length === 0) continue;

    const officialClass = official.classes.find((c) => c.pilot_class === pilotClass);
    const excluded: { pilot_name: string; reason: string }[] = [];
    // Officially-ranked pilots with no track (manual flight reports). They
    // can't be analysed, but they DID count toward the official launch
    // validity — remembered so the re-score's numPresent matches.
    let trackless = 0;
    for (const entry of officialClass?.pilots ?? []) {
      if (!trackFileByPilotId.has(entry.comp_pilot_id)) {
        trackless++;
        excluded.push({
          pilot_name: entry.pilot_name,
          reason: "scored from a manual flight report — no tracklog to analyse",
        });
      }
    }

    // One class at a time, so a multi-class task never holds two fields'
    // worth of decompressed tracklogs simultaneously.
    const flights: PilotFlight[] = [];
    const fixesPerTrack = await mapWithConcurrency(
      classTracks,
      TRACK_FETCH_CONCURRENCY,
      (track) => fetchIgcFixes(r2, track.igc_filename)
    );
    for (const [i, fixes] of fixesPerTrack.entries()) {
      const track = classTracks[i];
      if (!fixes) {
        excluded.push({
          pilot_name: track.pilot_name,
          reason: "tracklog missing or unreadable",
        });
        continue;
      }
      flights.push({
        pilotName: track.pilot_name,
        trackFile: track.igc_filename,
        fixes,
      });
    }
    if (flights.length === 0) continue;

    // scoreTask applies the distance-origin trim itself, so it takes the
    // untrimmed task — as does buildFieldContext, whose ENU origin is the
    // first turnpoint's waypoint. numPresent includes the trackless
    // (manual-flight) pilots so launch validity matches the official score's.
    const numPresent =
      flights.length + trackless + (cfg.dnfByClass.get(pilotClass) ?? 0);
    const result = scoreTask(
      cfg.xcTask,
      flights,
      cfg.gapParams,
      numPresent,
      cfg.stopCtx ? { stopAnnouncementMs: Date.parse(cfg.taskRow.stop_announcement_time!) } : {}
    );

    // Overlay the official rank/total on each re-scored pilot (paired by
    // trackFile — never by index, the two arrays sort differently), then
    // re-sort so buildFieldContext's rank ordering is the published one.
    // A pilot the OFFICIAL pass didn't score (e.g. its R2 read failed there
    // but succeeded here) is EXCLUDED rather than kept at the re-score's
    // tracked-subset rank — mixing the two scales would collide rank numbers
    // and silently distort every correlation.
    const officialByTrackFile = new Map(
      (officialClass?.pilots ?? []).flatMap((entry) => {
        const trackFile = trackFileByPilotId.get(entry.comp_pilot_id);
        return trackFile ? [[trackFile, entry] as const] : [];
      })
    );
    result.pilotScores = result.pilotScores.filter((ps) => {
      const entry = officialByTrackFile.get(ps.trackFile);
      if (!entry) {
        excluded.push({
          pilot_name: ps.pilotName,
          reason: "not in the official standings for this task",
        });
        return false;
      }
      ps.rank = entry.rank;
      ps.totalScore = entry.total_score;
      return true;
    });
    if (result.pilotScores.length === 0) continue;
    result.pilotScores.sort((a, b) => a.rank - b.rank);

    let report: FieldAnalysisReport;
    try {
      report = evaluateField(
        buildFieldContext(cfg.xcTask, flights, result, cfg.category, {
          // Presentational only: labels the day-profile/climbing hours in the
          // comp's zone. Scoring and every metric value stay UTC.
          timeZone: cfg.timezone ?? undefined,
        })
      );
    } catch (err) {
      // One unanalysable class must not cost the others their report.
      console.error("field analysis failed for class", pilotClass, err);
      excluded.push({
        pilot_name: `(class ${pilotClass})`,
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    classes.push({
      pilot_class: pilotClass,
      report,
      pilot_key_by_track_file: Object.fromEntries(
        classTracks.map((t) => [t.igc_filename, `cp:${t.comp_pilot_id}`])
      ),
      totals: result.pilotScores.map((ps) => ({
        trackFile: ps.trackFile,
        pilotName: ps.pilotName,
        totalScore: ps.totalScore,
      })),
      excluded,
    });
  }

  if (classes.length === 0) {
    throw new FieldAnalysisUnsupported(
      "No pilot class on this task had analysable tracks"
    );
  }

  return {
    task_id: encodeId(alphabet, cfg.taskRow.task_id),
    comp_id: encodeId(alphabet, cfg.taskRow.comp_id),
    task_date: cfg.taskRow.task_date,
    classes,
  };
}

// ---------------------------------------------------------------------------
// Per-pilot analysis (scoring transparency)
// ---------------------------------------------------------------------------

/**
 * The per-pilot scoring-transparency payload behind
 * `GET /api/comp/:comp_id/task/:task_id/pilot/:comp_pilot_id/analysis`.
 *
 * Feeds the score-details page's explanation without the browser having to
 * download and re-analyze the raw tracklog: for GAP it carries the full
 * turnpoint-sequence result (every cylinder crossing with time/coords,
 * selection reasons, legs, best progress); for open distance the scored
 * line's endpoints with times. Computed by the same engine code the scorer
 * runs, from the same inputs, so the narrative always matches the score.
 */
export interface PilotAnalysisResponse {
  comp_pilot_id: string;
  scoring_format: "gap" | "open_distance";
  /** GAP transparency data (dates as ISO strings on the wire). */
  turnpoint_result: TurnpointSequenceResultJSON | null;
  /** Open-distance scored line, endpoints enriched with fix time/altitude. */
  open_distance: {
    /** Scored straight-line distance in metres (0 = never left launch). */
    distance: number;
    origin: OpenDistanceAnchorPoint | null;
    furthest: OpenDistanceAnchorPoint | null;
  } | null;
  /**
   * Manual flight geometry for a track-less pilot (issue #306): the landing
   * point and the routed made-good line to goal, so the score-details page
   * shows the same evidence as a landed-out track. All indices are in the
   * scoring (distance-origin-trimmed) frame. Null for tracked pilots.
   */
  manual_flight: {
    last_reached_tp_index: number;
    landing: { lat: number; lon: number };
    made_good: number;
    distance_to_goal: number;
    made_goal: boolean;
    route_to_goal: Array<{ lat: number; lon: number }>;
  } | null;
}

export interface OpenDistanceAnchorPoint {
  latitude: number;
  longitude: number;
  /** Null for a manual flight (no tracklog → no fix time / altitude). */
  time_ms: number | null;
  altitude: number | null;
}

/** The cacheable (comp-pilot-independent) part of {@link PilotAnalysisResponse}. */
type PilotAnalysisPayload = Pick<
  PilotAnalysisResponse,
  "turnpoint_result" | "open_distance"
>;

/**
 * Recover one pilot's §12.3.4 equalized scored-window end for a stopped
 * multi-gate / elapsed-time task, from the cached per-track analyses
 * computeTaskScore wrote (variant "gap", the stop-aware pass-1 hash) for the
 * pilot's class. Returns null when the common window applies (single-gate
 * race, nobody started) or when the cached field isn't available yet — the
 * caller then clips at the stop time, which is exact for single-gate races.
 */
async function resolvePilotStopWindow(
  db: D1Database,
  args: {
    taskId: number;
    compPilotId: number;
    scoringTask: ReturnType<typeof taskForDistanceOrigin>;
    stopTimeMs: number;
    gapGeomHash: string;
  }
): Promise<number | null> {
  const rows = await db
    .prepare(
      `SELECT tt.comp_pilot_id, ta.payload_json
       FROM track_analysis ta
       JOIN task_track tt ON tt.task_track_id = ta.task_track_id
       JOIN comp_pilot cp ON cp.comp_pilot_id = tt.comp_pilot_id
       WHERE tt.task_id = ? AND tt.active = 1
         AND ta.variant = 'gap' AND ta.geom_hash = ?
         AND ta.uploaded_at = tt.uploaded_at
         AND cp.pilot_class = (
           SELECT pilot_class FROM comp_pilot WHERE comp_pilot_id = ?
         )`
    )
    .bind(args.taskId, args.gapGeomHash, args.compPilotId)
    .all<{ comp_pilot_id: number; payload_json: string }>();
  if (rows.results.length === 0) return null;
  const starts = rows.results.map((r) => {
    const cached = JSON.parse(r.payload_json) as CachedFlightAnalysis;
    return cached.startTimeMs ?? cached.sssTimeMs ?? null;
  });
  const ends = resolveScoredWindowEnds(args.scoringTask, starts, args.stopTimeMs);
  if (!ends) return null;
  const idx = rows.results.findIndex((r) => r.comp_pilot_id === args.compPilotId);
  return idx >= 0 ? ends[idx] : null;
}

/**
 * Compute one pilot's scoring-transparency analysis for a task, mirroring
 * computeTaskScore's inputs exactly (distance-origin trim, task geometry).
 * Stored per track in track_analysis (variant "pilot-detail") — any xctsk /
 * scoring-format / distance-origin change rolls the geometry hash, and a
 * re-upload mismatches on uploaded_at. Returns null when the task or the
 * pilot's track doesn't exist.
 */
export async function computePilotAnalysis(
  taskId: number,
  compPilotId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string
): Promise<PilotAnalysisResponse | null> {
  const taskRow = await db
    .prepare(
      `SELECT t.xctsk, t.stop_announcement_time,
              c.gap_params, c.scoring_format, c.category, c.creation_date
       FROM task t
       JOIN comp c ON t.comp_id = c.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{
      xctsk: string;
      stop_announcement_time: string | null;
      gap_params: string | null;
      scoring_format: string | null;
      category: string;
      creation_date: string;
    }>();
  if (!taskRow || !taskRow.xctsk) return null;

  const track = await db
    .prepare(
      `SELECT task_track_id, igc_filename, uploaded_at
       FROM task_track
       WHERE task_id = ? AND comp_pilot_id = ? AND active = 1`
    )
    .bind(taskId, compPilotId)
    .first<{ task_track_id: number; igc_filename: string; uploaded_at: string }>();
  if (!track) {
    // No active track — the pilot may have a manual flight (issue #306).
    // Manual flights are a GAP made-good concept, so only for GAP tasks; the
    // geometry is cheap (no R2 / tracklog), so compute it inline, uncached.
    const manual = await db
      .prepare(
        `SELECT last_reached_tp_index, landing_lat, landing_lon
         FROM task_manual_flight
         WHERE task_id = ? AND comp_pilot_id = ? AND active = 1`
      )
      .bind(taskId, compPilotId)
      .first<{
        last_reached_tp_index: number;
        landing_lat: number;
        landing_lon: number;
      }>();
    if (!manual) return null;
    const xcTask = parseXCTask(taskRow.xctsk);

    // Open distance: the made-good is measured from the take-off cylinder edge
    // to the landing point. Return the same open_distance line a track does, so
    // the score-details page reuses the open-distance rendering.
    if (taskRow.scoring_format === "open_distance") {
      const od = manualOpenDistanceGeometry(xcTask, {
        lat: manual.landing_lat,
        lon: manual.landing_lon,
      });
      return {
        comp_pilot_id: encodeId(alphabet, compPilotId),
        scoring_format: "open_distance",
        turnpoint_result: null,
        manual_flight: null,
        open_distance: {
          distance: od.distance,
          origin: { latitude: od.origin.lat, longitude: od.origin.lon, time_ms: null, altitude: null },
          furthest: { latitude: od.landing.lat, longitude: od.landing.lon, time_ms: null, altitude: null },
        },
      };
    }

    const gapParams: Partial<GAPParameters> = taskRow.gap_params
      ? JSON.parse(taskRow.gap_params)
      : {};
    const distanceOrigin =
      gapParams.distanceOrigin ?? DEFAULT_GAP_PARAMETERS.distanceOrigin;
    const scoringTask = taskForDistanceOrigin(xcTask, distanceOrigin);
    const offset = xcTask.turnpoints.length - scoringTask.turnpoints.length;
    const scoringIndex = manual.last_reached_tp_index - offset;
    const geom = manualFlightGeometry(scoringTask, scoringIndex, {
      lat: manual.landing_lat,
      lon: manual.landing_lon,
    });
    return {
      comp_pilot_id: encodeId(alphabet, compPilotId),
      scoring_format: "gap",
      turnpoint_result: null,
      open_distance: null,
      manual_flight: {
        last_reached_tp_index: scoringIndex,
        landing: { lat: manual.landing_lat, lon: manual.landing_lon },
        made_good: geom.madeGood,
        distance_to_goal: geom.distanceToGoal,
        made_goal: geom.madeGoal,
        route_to_goal: geom.routeToGoal,
      },
    };
  }

  const scoringFormat: "gap" | "open_distance" =
    taskRow.scoring_format === "open_distance" ? "open_distance" : "gap";
  const gapParams: Partial<GAPParameters> = taskRow.gap_params
    ? JSON.parse(taskRow.gap_params)
    : {};
  const distanceOrigin =
    gapParams.distanceOrigin ?? DEFAULT_GAP_PARAMETERS.distanceOrigin;

  // Stopped tasks (S7F §12.3): mirror computeTaskScore's stop context so the
  // transparency narrative matches the published score exactly. The pilot's
  // §12.3.4 equalized window (multi-gate/elapsed tasks) is recovered from
  // the cached field analyses the scorer wrote — best effort: when they're
  // not available yet the stop time is used (exact for single-gate races).
  let stopOptions: StopResolutionOptions | null = null;
  if (scoringFormat === "gap" && taskRow.stop_announcement_time) {
    const announceMs = Date.parse(taskRow.stop_announcement_time);
    if (Number.isFinite(announceMs)) {
      const category = taskRow.category === "pg" ? "pg" : "hg";
      const compCreatedAtMs = Date.parse(taskRow.creation_date);
      const fullGapParams = resolveCompGapParams(
        category,
        taskRow.gap_params ? (JSON.parse(taskRow.gap_params) as Partial<GAPParameters>) : null,
        Number.isNaN(compCreatedAtMs) ? null : compCreatedAtMs
      );
      const stopScoringTask = taskForDistanceOrigin(
        parseXCTask(taskRow.xctsk),
        fullGapParams.distanceOrigin
      );
      const stopCtx = resolveTaskStop(stopScoringTask, announceMs, fullGapParams);
      stopOptions = {
        stopTimeMs: stopCtx.stopTimeMs,
        glideRatio: stoppedGlideRatio(fullGapParams.scoring),
        goalAltitude: resolveGoalAltitude(stopScoringTask),
      };
      const windowEndMs = await resolvePilotStopWindow(db, {
        taskId,
        compPilotId,
        scoringTask: stopScoringTask,
        stopTimeMs: stopCtx.stopTimeMs,
        // The pass-1 "gap"-variant geometry hash computeTaskScore uses.
        gapGeomHash: await shortHash(
          `${
            fullGapParams.useLeading
              ? `${taskRow.xctsk} ${fullGapParams.distanceOrigin} lead:${fullGapParams.leadingFormula}`
              : `${taskRow.xctsk} ${fullGapParams.distanceOrigin} nolead`
          } stop:${stopCtx.stopTimeMs}:${stopOptions.glideRatio} engine:${SCORING_ENGINE_VERSION}`
        ),
      });
      if (windowEndMs !== null && windowEndMs < stopCtx.stopTimeMs) {
        stopOptions = { ...stopOptions, windowEndMs };
      }
    }
  }

  const geomHash = await shortHash(
    `${taskRow.xctsk} ${scoringFormat} ${distanceOrigin}${
      stopOptions
        ? ` stop:${stopOptions.stopTimeMs}:${stopOptions.glideRatio}:${stopOptions.windowEndMs ?? ""}`
        : ""
    } engine:${SCORING_ENGINE_VERSION}`
  );

  let payload: PilotAnalysisPayload | null = null;
  const hit = await db
    .prepare(
      `SELECT geom_hash, uploaded_at, payload_json FROM track_analysis
       WHERE task_track_id = ? AND variant = 'pilot-detail'`
    )
    .bind(track.task_track_id)
    .first<{ geom_hash: string; uploaded_at: string; payload_json: string }>();
  if (hit && hit.geom_hash === geomHash && hit.uploaded_at === track.uploaded_at) {
    payload = JSON.parse(hit.payload_json) as PilotAnalysisPayload;
  }

  if (!payload) {
    const fixes = await fetchIgcFixes(r2, track.igc_filename);
    if (!fixes) return null;

    const xcTask = parseXCTask(taskRow.xctsk);
    if (scoringFormat === "open_distance") {
      const geometry = openDistanceGeometryForFlight(xcTask, {
        pilotName: "",
        trackFile: track.igc_filename,
        fixes,
      });
      const furthestFix = geometry ? fixes[geometry.furthest.fixIndex] : null;
      payload = {
        turnpoint_result: null,
        open_distance: geometry
          ? {
              distance: geometry.distance,
              // The origin is the cylinder edge toward the furthest fix — a
              // derived point, not a track fix, so it has no time/altitude.
              origin: {
                latitude: geometry.origin.latitude,
                longitude: geometry.origin.longitude,
                time_ms: null,
                altitude: null,
              },
              furthest: {
                latitude: geometry.furthest.latitude,
                longitude: geometry.furthest.longitude,
                time_ms: furthestFix!.time.getTime(),
                altitude: furthestFix!.gnssAltitude,
              },
            }
          : { distance: 0, origin: null, furthest: null },
      };
    } else {
      const scoringTask = taskForDistanceOrigin(xcTask, distanceOrigin);
      const result = resolveTurnpointSequence(
        scoringTask, fixes,
        stopOptions ? { stop: stopOptions } : undefined,
      );
      // Round-trip through JSON so the payload is typed as the wire format
      // (Dates → ISO strings) — exactly what D1 stores and the client revives.
      payload = {
        turnpoint_result: JSON.parse(JSON.stringify(result)) as TurnpointSequenceResultJSON,
        open_distance: null,
      };
    }

    await saveTrackAnalyses(db, [
      {
        task_track_id: track.task_track_id,
        variant: "pilot-detail",
        geom_hash: geomHash,
        uploaded_at: track.uploaded_at,
        payload_json: JSON.stringify(payload),
      },
    ]);
  }

  return {
    comp_pilot_id: encodeId(alphabet, compPilotId),
    scoring_format: scoringFormat,
    ...payload,
    manual_flight: null,
  };
}
