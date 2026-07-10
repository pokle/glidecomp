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
  computeLeadingAggregate,
  calculateOptimizedTaskDistance,
  DEFAULT_GAP_PARAMETERS,
  SCORING_ENGINE_VERSION,
  type GAPParameters,
  type FlightScoringData,
  type OpenDistanceFlightData,
  type TaskScoreCore,
  type LeadingAggregate,
  type TurnpointSequenceResultJSON,
} from "@glidecomp/engine";
import { encodeId } from "./sqids";
import { manualFlightToScoringData } from "./manual-flight-store";

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
      `SELECT t.xctsk, c.scoring_format
       FROM task t JOIN comp c ON c.comp_id = t.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{ xctsk: string | null; scoring_format: string | null }>();

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
  return `score:v7:${taskId}:${hex}`;
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
  result: Pick<TaskScoreCore, "taskValidity" | "availablePoints" | "pilotScores">,
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
  }));

  return {
    pilot_class: pilotClass,
    task_validity: result.taskValidity,
    available_points: result.availablePoints,
    pilots,
  };
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
  alphabet: string
): Promise<TaskScoreResponse> {
  // Load task + comp gap_params
  const taskRow = await db
    .prepare(
      `SELECT t.task_id, t.comp_id, t.task_date, t.xctsk,
              c.gap_params, c.scoring_format
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
      scoring_format: string | null;
    }>();

  if (!taskRow) throw new Error("Task not found");

  const scoringFormat: "gap" | "open_distance" =
    taskRow.scoring_format === "open_distance" ? "open_distance" : "gap";

  const xcTask = parseXCTask(taskRow.xctsk);
  const gapParams: Partial<GAPParameters> = taskRow.gap_params
    ? JSON.parse(taskRow.gap_params)
    : {};

  // Default nominalDistance to 70% of task distance if not set. Only relevant
  // to GAP — open distance ignores GAP parameters entirely.
  if (scoringFormat === "gap" && !gapParams.nominalDistance) {
    gapParams.nominalDistance =
      calculateOptimizedTaskDistance(xcTask) * 0.7;
  }

  // Resolve the parameters that shape per-pilot analysis. distanceOrigin trims
  // the task; useLeading + leadingFormula shape the cached leading aggregate.
  const distanceOrigin = gapParams.distanceOrigin ?? DEFAULT_GAP_PARAMETERS.distanceOrigin;
  const useLeading = gapParams.useLeading ?? DEFAULT_GAP_PARAMETERS.useLeading;
  const leadingFormula = gapParams.leadingFormula ?? DEFAULT_GAP_PARAMETERS.leadingFormula;
  const scoringTask = taskForDistanceOrigin(xcTask, distanceOrigin);

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
    .all<{
      task_track_id: number;
      comp_pilot_id: number;
      igc_filename: string;
      uploaded_at: string;
      penalty_points: number;
      penalty_reason: string | null;
      pilot_name: string;
      pilot_class: string;
    }>();

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
          const object = await r2.get(track.igc_filename);
          if (!object) return null;
          const compressed = await object.arrayBuffer();
          const decompressedStream = new Response(compressed).body!.pipeThrough(
            new DecompressionStream("gzip")
          );
          const igcText = new TextDecoder().decode(
            await new Response(decompressedStream).arrayBuffer()
          );
          let igc;
          try {
            igc = parseIGC(igcText);
          } catch {
            console.warn(`Skipping unparseable IGC: ${track.igc_filename}`);
            return null;
          }
          if (igc.fixes.length === 0) return null;

          distance = openDistanceForFlight(xcTask, {
            pilotName: track.pilot_name,
            trackFile: track.igc_filename,
            fixes: igc.fixes,
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
  // the shape it needs.
  const geomKey = useLeading
    ? `${taskRow.xctsk} ${distanceOrigin} lead:${leadingFormula}`
    : `${taskRow.xctsk} ${distanceOrigin} nolead`;
  const geomHash = await shortHash(`${geomKey} engine:${SCORING_ENGINE_VERSION}`);
  const stored = await loadTrackAnalyses(db, taskId, "gap", geomHash);
  const analysisWrites: TrackAnalysisWrite[] = [];

  type AnalyzedPilot = {
    flight: FlightScoringData;
    comp_pilot_id: number;
    pilot_class: string;
    penalty_points: number;
    penalty_reason: string | null;
  };

  // Gather each pilot's scoring inputs — from the per-track analysis store
  // when possible, otherwise by fetching + decompressing + parsing the IGC
  // from R2 and resolving its turnpoint sequence. Bounded concurrency
  // overlaps R2 latency while capping peak memory from decompressed
  // tracklogs.
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
        const object = await r2.get(track.igc_filename);
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
          console.warn(`Skipping unparseable IGC: ${track.igc_filename}`);
          return null;
        }
        if (igc.fixes.length === 0) return null;

        const result = resolveTurnpointSequence(scoringTask, igc.fixes);
        // Base (field-independent) analysis, without retaining the heavy
        // tracklog. Leading comps additionally capture the per-track leading
        // scan as an aggregate, so a later upload doesn't re-scan the field.
        const base = toFlightScoringData(
          { pilotName: track.pilot_name, trackFile: track.igc_filename, fixes: igc.fixes },
          result,
          false
        );
        const leadingAggregate = useLeading
          ? computeLeadingAggregate(
              igc.fixes, scoringTask, result.sequence,
              base.sssTimeMs, base.essTimeMs, leadingFormula
            )
          : undefined;
        flight = leadingAggregate ? { ...base, leadingAggregate } : base;

        // Store the compact, field-independent analysis for reuse. Only the
        // geometric fields (+ leading aggregate) — the pilot name/id come
        // fresh from the DB each run, so renames and penalties never
        // invalidate this entry.
        const compact: CachedFlightAnalysis = {
          flownDistance: base.flownDistance,
          madeGoal: base.madeGoal,
          reachedESS: base.reachedESS,
          speedSectionTime: base.speedSectionTime,
          sssTimeMs: base.sssTimeMs,
          essTimeMs: base.essTimeMs,
          ...(base.earlyStartSeconds !== undefined
            ? { earlyStartSeconds: base.earlyStartSeconds }
            : {}),
          ...(leadingAggregate ? { leadingAggregate } : {}),
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

    const numPresent =
      classPilots.length + (dnfByClass.get(pilotClass) ?? 0);
    const result = scoreFlights(
      scoringTask,
      classPilots.map((p) => p.flight),
      gapParams,
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
    scoring_format: scoringFormat,
    classes: classScores,
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
}

export interface OpenDistanceAnchorPoint {
  latitude: number;
  longitude: number;
  time_ms: number;
  altitude: number;
}

/** The cacheable (comp-pilot-independent) part of {@link PilotAnalysisResponse}. */
type PilotAnalysisPayload = Pick<
  PilotAnalysisResponse,
  "turnpoint_result" | "open_distance"
>;

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
      `SELECT t.xctsk, c.gap_params, c.scoring_format
       FROM task t
       JOIN comp c ON t.comp_id = c.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{ xctsk: string; gap_params: string | null; scoring_format: string | null }>();
  if (!taskRow || !taskRow.xctsk) return null;

  const track = await db
    .prepare(
      `SELECT task_track_id, igc_filename, uploaded_at
       FROM task_track
       WHERE task_id = ? AND comp_pilot_id = ?`
    )
    .bind(taskId, compPilotId)
    .first<{ task_track_id: number; igc_filename: string; uploaded_at: string }>();
  if (!track) return null;

  const scoringFormat: "gap" | "open_distance" =
    taskRow.scoring_format === "open_distance" ? "open_distance" : "gap";
  const gapParams: Partial<GAPParameters> = taskRow.gap_params
    ? JSON.parse(taskRow.gap_params)
    : {};
  const distanceOrigin =
    gapParams.distanceOrigin ?? DEFAULT_GAP_PARAMETERS.distanceOrigin;

  const geomHash = await shortHash(
    `${taskRow.xctsk} ${scoringFormat} ${distanceOrigin} engine:${SCORING_ENGINE_VERSION}`
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
    const object = await r2.get(track.igc_filename);
    if (!object) return null;
    const compressed = await object.arrayBuffer();
    const decompressedStream = new Response(compressed).body!.pipeThrough(
      new DecompressionStream("gzip")
    );
    const igcText = new TextDecoder().decode(
      await new Response(decompressedStream).arrayBuffer()
    );
    let igc;
    try {
      igc = parseIGC(igcText);
    } catch {
      return null;
    }
    if (igc.fixes.length === 0) return null;

    const xcTask = parseXCTask(taskRow.xctsk);
    if (scoringFormat === "open_distance") {
      const geometry = openDistanceGeometryForFlight(xcTask, {
        pilotName: "",
        trackFile: track.igc_filename,
        fixes: igc.fixes,
      });
      const anchor = (p: { latitude: number; longitude: number; fixIndex: number }) => {
        const fix = igc.fixes[p.fixIndex];
        return {
          latitude: p.latitude,
          longitude: p.longitude,
          time_ms: fix.time.getTime(),
          altitude: fix.gnssAltitude,
        };
      };
      payload = {
        turnpoint_result: null,
        open_distance: geometry
          ? {
              distance: geometry.distance,
              origin: anchor(geometry.origin),
              furthest: anchor(geometry.furthest),
            }
          : { distance: 0, origin: null, furthest: null },
      };
    } else {
      const scoringTask = taskForDistanceOrigin(xcTask, distanceOrigin);
      const result = resolveTurnpointSequence(scoringTask, igc.fixes);
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
  };
}
