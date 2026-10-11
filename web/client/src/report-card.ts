/**
 * The report card's derivation: the four API payloads (comp, task, task
 * score, pilot analysis) in, the narrative the page renders out. Moved here
 * from the website's PilotScoreDetail so the website and the app call ONE
 * function — two report-card implementations would drift (mobile plan,
 * stage 3). Pure: no fetch, no DOM. The engine's explain* functions do the
 * work; this picks the right one and assembles what the page needs.
 */
import {
  explainExcludedTrack,
  explainGapScore,
  explainManualFlightScore,
  explainOpenDistanceScore,
  resolveCompGapParams,
  reviveTurnpointSequenceResult,
  taskForDistanceOrigin,
  type ExplanationAnchor,
  type FlightEvent,
  type FlightEventType,
  type GAPParameters,
  type ScoreExplanation,
  type XCTask,
} from "@glidecomp/engine";
import { formatTimeInZone } from "./time";
import type {
  AltitudeCleaningData,
  ClassScore,
  CompDetailData,
  PilotAnalysisData,
  PilotScoreEntry,
  TaskDetailData,
  TaskScoreData,
  TrackQualityData,
} from "./types";

/** An open-distance pilot's scored straight line, for the map. */
export interface OpenDistanceLine {
  pilotName: string;
  origin: { lat: number; lon: number };
  end: { lat: number; lon: number };
  /** Scored straight-line distance in metres (drawn as the line's label) */
  distance: number;
}

/** A landed-out pilot's routed distance-to-goal line, for the map. */
export interface BestProgressRoute {
  /** Ordered polyline vertices: [best-progress point, …tag points, goal]. */
  coords: { lat: number; lon: number }[];
  /** Remaining routed distance to goal in metres (drawn as the line's label). */
  distanceToGoal: number;
}

export interface ReportCard {
  comp: CompDetailData;
  task: TaskDetailData;
  entry: PilotScoreEntry;
  pilotClass: string;
  /** The published rules edition ("s7f-2026"), or undefined for payloads
   * cached before the field existed — the badge degrades to "FAI S7F". */
  rulesEdition?: "s7f-2026";
  /** This pilot's officially published standing (issue #603), when the
   * import recorded one — display only, never a GlideComp score. */
  official: { rank: number; total: number; source: string; url: string | null } | null;
  /** The official task scores page for the whole task — set whenever the
   * task carries official results, even when THIS pilot has no entry there,
   * so the historical-rules notice can always link the published record. */
  officialTaskUrl: string | null;
  explanation: ScoreExplanation;
  /** The task drawn on the map (the sequence was resolved against it). */
  mapTask: XCTask;
  /** Marker events for every anchored explanation item, keyed by item id. */
  eventsByItem: Map<string, FlightEvent>;
  openDistanceLine: OpenDistanceLine | null;
  /** A landed-out pilot's routed distance-to-goal line, when applicable. */
  bestProgressRoute: BestProgressRoute | null;
  /** When the published score this narrative explains was computed. */
  scoreComputedAt: string;
  /** True when a re-score is in flight — the narrative may soon change. */
  scoreStale: boolean;
  /** What the engine's altitude plausibility pass repaired in this track
   * (null: manual flight, or a payload cached before the field existed). */
  altitudeCleaning: AltitudeCleaningData | null;
  /** What the data-quality checks made of this tracklog — soft findings show
   * on an otherwise normal page, so this is set on every path. */
  trackQuality: TrackQualityData | null;
}

/**
 * The pilot has a track on this task but the served scores predate it.
 *
 * Scores are stale-first: a read never computes, so straight after an upload
 * the stored blob is still the pre-upload one and does not contain this pilot.
 * That is a WAIT, not a 404 — and telling a pilot who has just submitted that
 * their score cannot be found is the worst possible answer, since it reads as
 * "your track did not go in".
 */
export class ScorePendingError extends Error {
  readonly pending = true;
}

/**
 * Invariant check: the score and the analysis are cached under keys that
 * pin the same inputs AND the same engine version (see the engine's
 * scoring-version.ts), so they must agree. If this ever fires, that
 * cache-versioning guarantee is broken — a bug to fix, not a state to
 * present to the user.
 */
function assertAnalysisMatchesScore(analysedDistance: number, scoredDistance: number) {
  if (Math.abs(analysedDistance - scoredDistance) > 500) {
    console.error(
      `Score/analysis mismatch: analysis says ${analysedDistance} m, published score says ${scoredDistance} m — the scoring cache-versioning guarantee is broken`,
    );
  }
}

const ANCHOR_EVENT_TYPE: Record<ExplanationAnchor["kind"], FlightEventType> = {
  start: "start_reaching",
  start_candidate: "start_crossing",
  turnpoint: "turnpoint_reaching",
  ess: "ess_reaching",
  goal: "goal_reaching",
  best_progress: "landing",
  origin: "start_reaching",
  furthest: "landing",
};

/**
 * Wall-clock time for narrative items (tracklogs are UTC): comp-local when
 * the comp has a timezone set, else the viewer's zone as before.
 */
function narrativeTimeFormatter(timezone: string | null): (d: Date) => string {
  return (d) => formatTimeInZone(d, timezone ?? undefined);
}

function anchoredEvents(
  explanation: ScoreExplanation,
): Map<string, FlightEvent> {
  const events = new Map<string, FlightEvent>();
  for (const section of explanation.sections) {
    for (const item of section.items) {
      if (!item.anchor) continue;
      events.set(item.id, {
        id: `score-detail-${item.id}`,
        type: ANCHOR_EVENT_TYPE[item.anchor.kind],
        time: new Date(item.anchor.timeMs ?? 0),
        latitude: item.anchor.latitude,
        longitude: item.anchor.longitude,
        altitude: item.anchor.altitude ?? 0,
        description: item.text,
      });
    }
  }
  return events;
}

/**
 * Pull the landed-out routed distance-to-goal line off the best-progress
 * anchor (the engine attaches the polyline there), pairing it with the
 * remaining distance the engine measured for the label.
 */
function deriveBestProgressRoute(
  explanation: ScoreExplanation,
  distanceToGoal: number,
): BestProgressRoute | null {
  for (const section of explanation.sections) {
    for (const item of section.items) {
      const path =
        item.anchor?.kind === "best_progress" ? item.anchor.path : undefined;
      if (path && path.length >= 2) {
        return {
          coords: path.map((p) => ({ lat: p.latitude, lon: p.longitude })),
          distanceToGoal,
        };
      }
    }
  }
  return null;
}

/**
 * Pure derivation of the narrative from the four API payloads — no fetch, no
 * DOM — so it runs both after a client fetch (loadDetail) and synchronously
 * when seeding from SSR data. The engine's explain* functions do the work.
 */
export function buildReportCard(
  comp: CompDetailData,
  task: TaskDetailData,
  score: TaskScoreData,
  analysis: PilotAnalysisData,
  pilotId: string,
): ReportCard {
  if (!task.xctsk) throw new Error("This task has no route defined");

  let cls: ClassScore | undefined;
  let entry: PilotScoreEntry | undefined;
  for (const c of score.class_scores) {
    const found = c.pilots.find((p) => p.comp_pilot_id === pilotId);
    if (found) {
      cls = c;
      entry = found;
      break;
    }
  }
  if (!cls || !entry) {
    // A stale blob simply has not caught up with this pilot's upload yet.
    if (score.stale) throw new ScorePendingError("Scores are being recomputed");
    throw new Error("No score found for this pilot");
  }

  // The pilot's officially published standing (issue #603) — an annotation
  // from the import, matched by stored id, so no lookup can misattribute it.
  const officialEntry = score.official_results?.ranks?.[pilotId];
  const officialTaskUrl = score.official_results?.task_url ?? null;
  const official = officialEntry
    ? {
        rank: officialEntry.rank,
        total: officialEntry.total,
        source: score.official_results!.source,
        url: officialTaskUrl,
      }
    : null;

  const trackQuality = analysis.track_quality ?? null;

  // A tracklog a HARD check withheld gets its own narrative. Running the
  // normal one would revive a turnpoint sequence from a file that is not this
  // task's flight and state confidently that the pilot "landed out at 0.0 km"
  // — and it would trip assertAnalysisMatchesScore, whose whole job is to
  // shout when the score and the analysis genuinely disagree.
  if (entry.track_excluded) {
    return {
      comp,
      task,
      entry,
      pilotClass: cls.pilot_class,
      rulesEdition: cls.rules_edition,
      official,
      officialTaskUrl,
      explanation: explainExcludedTrack({
        entry,
        findings: (trackQuality?.findings ?? []).filter((f) => f.severity === "hard"),
      }),
      mapTask: task.xctsk,
      eventsByItem: new Map(),
      openDistanceLine: null,
      bestProgressRoute: null,
      scoreComputedAt: score.computed_at,
      scoreStale: score.stale,
      altitudeCleaning: null,
      trackQuality,
    };
  }

  if (score.scoring_format === "open_distance") {
    const od = analysis.open_distance;
    const geometry =
      od && od.origin && od.furthest
        ? {
            origin: {
              latitude: od.origin.latitude,
              longitude: od.origin.longitude,
            },
            furthest: {
              latitude: od.furthest.latitude,
              longitude: od.furthest.longitude,
              fixIndex: -1,
            },
            distance: od.distance,
          }
        : null;
    assertAnalysisMatchesScore(Math.round(od?.distance ?? 0), entry.flown_distance);
    // A manual open-distance flight has no fix times — its furthest point (the
    // recorded landing) carries null time_ms. A tracked flight always has a
    // real fix time there (the origin is a derived edge point either way).
    const manual = od?.furthest != null && od.furthest.time_ms == null;
    const explanation = explainOpenDistanceScore({
      task: task.xctsk,
      geometry,
      anchorInfo: {
        origin: od?.origin
          ? { timeMs: od.origin.time_ms ?? undefined, altitude: od.origin.altitude ?? undefined }
          : undefined,
        furthest: od?.furthest
          ? { timeMs: od.furthest.time_ms ?? undefined, altitude: od.furthest.altitude ?? undefined }
          : undefined,
      },
      entry,
      manual,
      formatTime: narrativeTimeFormatter(comp.timezone),
    });
    return {
      comp,
      task,
      entry,
      pilotClass: cls.pilot_class,
      rulesEdition: cls.rules_edition,
      official,
      officialTaskUrl,
      explanation,
      mapTask: task.xctsk,
      eventsByItem: anchoredEvents(explanation),
      bestProgressRoute: null,
      openDistanceLine: geometry
        ? {
            pilotName: entry.pilot_name,
            origin: { lat: geometry.origin.latitude, lon: geometry.origin.longitude },
            end: { lat: geometry.furthest.latitude, lon: geometry.furthest.longitude },
            distance: geometry.distance,
          }
        : null,
      scoreComputedAt: score.computed_at,
      scoreStale: score.stale,
      altitudeCleaning: analysis.altitude_cleaning ?? null,
      trackQuality,
    };
  }

  // The exact parameter set the scorer used, so the explanation names the same
  // formula, exponent and nominal values.
  //
  // ALWAYS prefer the published `cls.gap_params`: the scorer merges the TASK's
  // own overrides (migration 0021 — imported AirScore comps publish a
  // different formula per task) over the comp's, and it resolves an "auto"
  // nominal distance against the route. Re-deriving from the comp record alone
  // silently disagreed with both, so the page could print prose about a
  // formula the task was not scored with, beside points that were correct.
  //
  // The fallback below is for score rows cached before gap_params was
  // published — same derivation as before, including dropping the nullable
  // "auto" nominalDistance, so those pages render exactly as they used to
  // (the validity detail lines simply stay absent until revalidation).
  const params: Partial<GAPParameters> = (() => {
    if (cls.gap_params) return cls.gap_params;
    const { nominalDistance: _nd, ...stored } = comp.gap_params ?? {};
    void _nd;
    return resolveCompGapParams(
      comp.category === "pg" ? "pg" : "hg",
      comp.gap_params ? stored : null,
    );
  })();

  // Manual flight (issue #306): a track-less pilot scored from the last
  // turnpoint reached + landing point. No tracklog to narrate — the engine
  // explains the made-good, and attaches the routed distance-to-goal line to
  // the landing anchor so the map shows the same evidence as a landed-out
  // track. Same distance-origin trim as the scorer used.
  if (analysis.manual_flight) {
    const mf = analysis.manual_flight;
    const scoringTask = taskForDistanceOrigin(
      task.xctsk,
      params.distanceOrigin ?? "takeoff",
    );
    const explanation = explainManualFlightScore({
      task: scoringTask,
      geometry: {
        madeGood: mf.made_good,
        distanceToGoal: mf.distance_to_goal,
        madeGoal: mf.made_goal,
        landing: mf.landing,
        routeToGoal: mf.route_to_goal,
        lastReachedIndex: mf.last_reached_tp_index,
      },
      entry,
      classContext: cls,
      params,
    });
    const minimumDistance = params.minimumDistance ?? 5000;
    assertAnalysisMatchesScore(
      Math.max(mf.made_good, minimumDistance),
      entry.flown_distance,
    );
    return {
      comp,
      task,
      entry,
      pilotClass: cls.pilot_class,
      rulesEdition: cls.rules_edition,
      official,
      officialTaskUrl,
      explanation,
      mapTask: scoringTask,
      eventsByItem: anchoredEvents(explanation),
      bestProgressRoute: deriveBestProgressRoute(explanation, mf.distance_to_goal),
      openDistanceLine: null,
      scoreComputedAt: score.computed_at,
      scoreStale: score.stale,
      altitudeCleaning: analysis.altitude_cleaning ?? null,
      trackQuality,
    };
  }

  // GAP — the analysis endpoint resolved the sequence with the scorer's
  // exact inputs; mirror the same distance-origin trim here so the task
  // indexes in the result line up with the task drawn on the map.
  if (!analysis.turnpoint_result)
    throw new Error("The analysis of the pilot's track is not available");
  const result = reviveTurnpointSequenceResult(analysis.turnpoint_result);
  const scoringTask = taskForDistanceOrigin(
    task.xctsk,
    params.distanceOrigin ?? "takeoff",
  );
  const explanation = explainGapScore({
    task: scoringTask,
    result,
    entry,
    classContext: cls,
    params,
    formatTime: narrativeTimeFormatter(comp.timezone),
  });

  const minimumDistance = params.minimumDistance ?? 5000;
  assertAnalysisMatchesScore(
    Math.max(result.flownDistance, minimumDistance),
    entry.flown_distance,
  );

  return {
    comp,
    task,
    entry,
    pilotClass: cls.pilot_class,
    // This return — the main GAP path — used to omit rulesEdition, so a
    // tracked pilot's report card degraded the badge to plain "FAI S7F" and
    // never showed the historical-rules notice. The other three paths always
    // carried it.
    rulesEdition: cls.rules_edition,
    official,
    officialTaskUrl,
    explanation,
    mapTask: scoringTask,
    eventsByItem: anchoredEvents(explanation),
    bestProgressRoute: deriveBestProgressRoute(
      explanation,
      result.bestProgress?.distanceToGoal ?? 0,
    ),
    openDistanceLine: null,
    scoreComputedAt: score.computed_at,
    scoreStale: score.stale,
    altitudeCleaning: analysis.altitude_cleaning ?? null,
    trackQuality,
  };
}
