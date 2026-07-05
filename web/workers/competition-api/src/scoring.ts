import {
  parseIGC,
  parseXCTask,
  resolveTurnpointSequence,
  scoreFlights,
  scoreOpenDistanceFlights,
  openDistanceForFlight,
  toFlightScoringData,
  taskForDistanceOrigin,
  computeLeadingAggregate,
  calculateOptimizedTaskDistance,
  DEFAULT_GAP_PARAMETERS,
  type GAPParameters,
  type FlightScoringData,
  type OpenDistanceFlightData,
  type TaskScoreCore,
  type LeadingAggregate,
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
  distance_linear_points: number;
  distance_difficulty_points: number;
  time_points: number;
  leading_points: number;
  arrival_points: number;
  penalty_points: number;
  penalty_reason: string | null;
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
  /** How the task was scored — lets the UI pick the right columns. */
  scoring_format: "gap" | "open_distance";
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
       WHERE tt.task_id = ? ORDER BY tt.task_track_id`
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

  const stateString = [
    task?.scoring_format ?? "gap",
    task?.xctsk ?? "",
    ...tracks.results.map(
      (t) =>
        `${t.task_track_id}:${t.uploaded_at}:${t.penalty_points}:${t.comp_pilot_id}:${t.registered_pilot_name}:${t.pilot_class}`
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
  return `score:v5:${taskId}:${hex}`;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Per-track analysis cached in KV — the field-independent result of
 * resolving one pilot's turnpoint sequence. Keyed by task geometry + track
 * identity, so it survives roster/penalty edits and (crucially) new track
 * submissions: only the newly-added track misses the cache, the rest of the
 * field is reused instead of being re-fetched, re-parsed and re-resolved.
 * Plain numbers/booleans only, so JSON round-trips losslessly. */
interface CachedFlightAnalysis {
  flownDistance: number;
  madeGoal: boolean;
  reachedESS: boolean;
  speedSectionTime: number | null;
  sssTimeMs: number | null;
  essTimeMs: number | null;
  /** Present only for leading-enabled comps — the per-track leading scan,
   * cached so a new upload doesn't force a re-scan of the whole field. Its
   * validity is tied to the task geometry + leading formula in the cache key. */
  leadingAggregate?: LeadingAggregate;
}

/** Short SHA-256 hex digest (16 chars) of a string — used for cache keys. */
async function shortHash(input: string): Promise<string> {
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
    return {
      pilotScore: ps,
      comp_pilot_id: pilot.comp_pilot_id,
      penalty_points: pilot.penalty_points,
      penalty_reason: pilot.penalty_reason,
      finalScore: Math.max(0, ps.totalScore - pilot.penalty_points),
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
 * independent of the rest of the field, so it is cached per-track in KV and
 * reused across recomputes; only tracks that are new or changed are fetched
 * from R2, decompressed and re-parsed, and those run with bounded concurrency.
 * When leading points are enabled the tracklog is needed for the
 * leading-coefficient calculation, so that path always fetches/parses and
 * skips the per-track cache.
 *
 * Penalties are applied after scoring — deducted from totalScore, floored at 0,
 * then pilots are re-ranked within their class.
 */
export async function computeTaskScore(
  taskId: number,
  db: D1Database,
  r2: R2Bucket,
  alphabet: string,
  kv?: KVNamespace,
  waitUntil?: (promise: Promise<unknown>) => void
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

  // Load all tracks joined with pilot info, grouped by class
  const tracks = await db
    .prepare(
      `SELECT tt.task_track_id, tt.comp_pilot_id, tt.igc_filename, tt.uploaded_at,
              tt.penalty_points, tt.penalty_reason,
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

  // Open distance: score each pilot on how far they flew from the take-off
  // exit. Each pilot's open distance is field-independent, so — like the GAP
  // path — it is cached per track in KV and reused across recomputes; only new
  // or changed tracks are fetched from R2, decompressed and re-parsed. Open
  // distance needs the raw fixes (not the GAP turnpoint analysis), so it uses
  // its own cache holding just the computed distance.
  if (scoringFormat === "open_distance") {
    // Per-track cache key prefix: any change to the task geometry (xctsk, which
    // holds the take-off cylinder) invalidates every cached distance.
    const geomHash = kv ? await shortHash(taskRow.xctsk) : "";

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
        const cacheKey = geomHash
          ? `od:v1:${geomHash}:${track.task_track_id}:${track.uploaded_at}`
          : "";

        let distance: number | null = null;
        if (cacheKey && kv) {
          const cached = (await kv.get(cacheKey, "json")) as { distance: number } | null;
          if (cached) distance = cached.distance;
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

          if (cacheKey && kv) {
            const put = kv.put(cacheKey, JSON.stringify({ distance }), {
              expirationTtl: 604800,
            });
            if (waitUntil) waitUntil(put);
            else await put;
          }
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
      const result = scoreOpenDistanceFlights(classPilots.map((p) => p.flight));
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

  // Per-track analysis cache key prefix: any change to the task geometry
  // (xctsk) or distance origin invalidates every cached analysis. Leading
  // comps also cache — but the leading aggregate depends on the formula, so
  // it is folded into the key (and the payload carries the aggregate). The
  // leading vs no-leading variants use distinct keys so a hit always has the
  // shape it needs.
  const geomKey = useLeading
    ? `${taskRow.xctsk} ${distanceOrigin} lead:${leadingFormula}`
    : `${taskRow.xctsk} ${distanceOrigin} nolead`;
  const geomHash = kv ? await shortHash(geomKey) : "";

  type AnalyzedPilot = {
    flight: FlightScoringData;
    comp_pilot_id: number;
    pilot_class: string;
    penalty_points: number;
    penalty_reason: string | null;
  };

  // Gather each pilot's scoring inputs — from the per-track KV cache when
  // possible, otherwise by fetching + decompressing + parsing the IGC from R2
  // and resolving its turnpoint sequence. Bounded concurrency overlaps R2
  // latency while capping peak memory from decompressed tracklogs.
  const analyzed = await mapWithConcurrency(
    scoredTracks,
    TRACK_FETCH_CONCURRENCY,
    async (track): Promise<AnalyzedPilot | null> => {
      // v2: engine gained the no-SSS start fallback — v1 entries for tasks
      // without an SSS turnpoint hold zero distances for the same geometry.
      const cacheKey = geomHash
        ? `pa:v2:${geomHash}:${track.task_track_id}:${track.uploaded_at}`
        : "";

      let flight: FlightScoringData | null = null;

      if (cacheKey && kv) {
        const cached = (await kv.get(cacheKey, "json")) as CachedFlightAnalysis | null;
        if (cached) {
          flight = {
            pilotName: track.pilot_name,
            trackFile: track.igc_filename,
            ...cached,
          };
        }
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

        // Cache the compact, field-independent analysis for reuse. Store only
        // the geometric fields (+ leading aggregate) — the pilot name/id come
        // fresh from the DB each run, so renames and penalties never
        // invalidate this entry.
        if (cacheKey && kv) {
          const compact: CachedFlightAnalysis = {
            flownDistance: base.flownDistance,
            madeGoal: base.madeGoal,
            reachedESS: base.reachedESS,
            speedSectionTime: base.speedSectionTime,
            sssTimeMs: base.sssTimeMs,
            essTimeMs: base.essTimeMs,
            ...(leadingAggregate ? { leadingAggregate } : {}),
          };
          const put = kv.put(cacheKey, JSON.stringify(compact), {
            expirationTtl: 604800,
          });
          if (waitUntil) waitUntil(put);
          else await put;
        }
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

  const analyzedPilots = analyzed.filter((p): p is AnalyzedPilot => p !== null);

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

    const result = scoreFlights(
      scoringTask,
      classPilots.map((p) => p.flight),
      gapParams
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
