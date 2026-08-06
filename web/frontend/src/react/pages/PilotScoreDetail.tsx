/**
 * Pilot score details — the explanation-first view of one pilot's score
 * for one task.
 *
 * TERMINOLOGY (July 2026): the owner has started calling this page a
 * pilot's "report card", and the homepage hero now shows the whole page
 * scaled down under that name. Nothing in the code or the UI has been
 * renamed — treat "report card" as the emerging user-facing term for
 * this page and prefer it in new copy; if it sticks, the rename to make
 * is the visible wording, not the route or the component.
 *
 * Clicking a score anywhere in the app lands here. The page leads with
 * the explanation (the flight narrative and every step of the points
 * calculation) and treats the map as supporting evidence: clicking any
 * explanation item pans the map to where it happened.
 *
 * The published point values come from the score API (authoritative).
 * The narrative (start crossings incl. re-entries, turnpoint reachings,
 * best progress) comes from the per-pilot analysis endpoint — computed
 * server-side by the same engine code the scorer runs, from the same
 * inputs — so the page renders without downloading the tracklog. The
 * IGC is fetched separately, only to draw the track on the map.
 */
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useInView } from "../lib/use-in-view";
import { useParams } from "react-router-dom";
import {
  explainGapScore,
  explainOpenDistanceScore,
  explainManualFlightScore,
  explainExcludedTrack,
  parseIGC,
  resolveCompGapParams,
  reviveTurnpointSequenceResult,
  taskForDistanceOrigin,
  type ExplanationAnchor,
  type FlightEvent,
  type FlightEventType,
  type GAPParameters,
  type IGCFix,
  type ScoreExplanation,
  type ScoreExplanationItem,
  type ScoreExplanationSection,
  type XCTask,
} from "@glidecomp/engine";
import { api } from "../../comp/api";
import { gunzipResponse } from "../../analysis/storage";
import type { BestProgressRoute, OpenDistanceLine } from "../../analysis/map-provider";
import { formatTaskDate } from "../lib/format";
import { formatTimeInZone, zoneNameWithOffset } from "../lib/time";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { underTask } from "../lib/crumbs";
import { retry } from "../lib/retry";
import { idFromSegment, pilotPath, taskPath } from "../lib/slug";
import { LinkButton } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { Timestamp } from "../components/Timestamp";
import { NotFound } from "../components/NotFound";
import type {
  AltitudeCleaningData,
  ClassScore,
  CompDetailData,
  PilotAnalysisData,
  PilotScoreEntry,
  TaskDetailData,
  TaskScoreData,
  TrackQualityData,
} from "../comp/types";
import { TrackScrubber, nearestFixIndexByTime } from "../score-detail/TrackScrubber";
import {
  TrackDataCleaningNote,
  TrackQualityNote,
  TrackValidityDocLink,
} from "../score-detail/TrackNotes";
import { ExplanationSection } from "../score-detail/Explanation";
import {
  AnalysisMapIcon,
  MaximizeIcon,
  MinimizeIcon,
} from "../score-detail/icons";
import { ScoringGlossary } from "../components/ScoringGlossary";
import { TaskInStandings } from "../comp/TaskInStandings";
import type { MapFocus } from "../comp/ScoreDetailMap";
import { useInitialData } from "../lib/initial-data";
import { useUser } from "../lib/user";
import type { PilotScoreLoaderData } from "../loaders";

// Lazy so mapbox (and its CSS) loads only with this page's map.
const ScoreDetailMap = lazy(() => import("../comp/ScoreDetailMap"));

// ---------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------

interface DetailData {
  comp: CompDetailData;
  task: TaskDetailData;
  entry: PilotScoreEntry;
  pilotClass: string;
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

type DetailState =
  | { kind: "loading" }
  | { kind: "pending" }
  | { kind: "error"; message: string; notFound?: boolean }
  | { kind: "ready"; data: DetailData };

/**
 * The comp, task or pilot in the URL doesn't resolve — as opposed to the page
 * failing to load for some other reason. Worth separating, because a dead id is
 * the one failure the 404 page can do something about: its slug still names what
 * the visitor wanted, so it can offer the ids that exist now.
 */
class DetailNotFoundError extends Error {
  readonly notFound = true;
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
class ScorePendingError extends Error {
  readonly pending = true;
}

/**
 * How hard to chase a score that has not landed yet. Same shape as the rescore
 * poll in comp/ScoreFreshness.tsx: quick at first, backing off, and giving up
 * rather than hammering a task whose revalidation has genuinely failed.
 */
const PENDING_INITIAL_MS = 2_000;
const PENDING_BACKOFF = 1.6;
const PENDING_MAX_MS = 15_000;
const PENDING_MAX_ATTEMPTS = 8;

/** True for the statuses that mean "no such thing": a real 404, or a 400 from
 *  an id sqid that doesn't decode at all. */
function isMissing(status: number): boolean {
  return status === 404 || status === 400;
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

async function loadDetail(
  compId: string,
  taskId: string,
  pilotId: string,
): Promise<DetailData> {
  const [compRes, taskRes, scoreRes, analysisRes] = await Promise.all([
    api.api.comp[":comp_id"].$get({ param: { comp_id: compId } }),
    api.api.comp[":comp_id"].task[":task_id"].$get({
      param: { comp_id: compId, task_id: taskId },
    }),
    api.api.comp[":comp_id"].task[":task_id"].score.$get({
      param: { comp_id: compId, task_id: taskId },
    }),
    api.api.comp[":comp_id"].task[":task_id"].pilot[":comp_pilot_id"].analysis.$get({
      param: { comp_id: compId, task_id: taskId, comp_pilot_id: pilotId },
    }),
  ]);

  if (isMissing(compRes.status) || isMissing(taskRes.status))
    throw new DetailNotFoundError("Task not found");
  if (!compRes.ok || !taskRes.ok) throw new Error("Task not found");
  if (!scoreRes.ok) throw new Error("Scores are not available for this task");
  // A missing analysis means this pilot has no result on this task — either the
  // id is dead or they never flew it. Both are "no such page", not a failure.
  if (isMissing(analysisRes.status))
    throw new DetailNotFoundError("No score for this pilot on this task");
  if (!analysisRes.ok)
    throw new Error("The analysis of the pilot's track is not available");

  const comp = (await compRes.json()) as unknown as CompDetailData;
  const task = (await taskRes.json()) as unknown as TaskDetailData;
  const score = (await scoreRes.json()) as unknown as TaskScoreData;
  const analysis = (await analysisRes.json()) as unknown as PilotAnalysisData;

  return buildDetailData(comp, task, score, analysis, pilotId);
}

/**
 * Pure derivation of the narrative from the four API payloads — no fetch, no
 * DOM — so it runs both after a client fetch (loadDetail) and synchronously
 * when seeding from SSR data. The engine's explain* functions do the work.
 */
function buildDetailData(
  comp: CompDetailData,
  task: TaskDetailData,
  score: TaskScoreData,
  analysis: PilotAnalysisData,
  pilotId: string,
): DetailData {
  if (!task.xctsk) throw new Error("This task has no route defined");

  let cls: ClassScore | undefined;
  let entry: PilotScoreEntry | undefined;
  for (const c of score.classes) {
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
    // Pass the comp's creation time so the PG leading-weight default matches the
    // scorer's date-based choice (S7F-2024 for new comps, GAP2020 for older
    // ones — issue #257).
    const createdAtMs = Date.parse(comp.creation_date);
    return resolveCompGapParams(
      comp.category === "pg" ? "pg" : "hg",
      comp.gap_params ? stored : null,
      Number.isNaN(createdAtMs) ? null : createdAtMs,
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

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PilotScoreDetail() {
  const { compId: compParam, taskId: taskParam, pilotId: pilotParam } = useParams<{
    compId: string;
    taskId: string;
    pilotId: string;
  }>();
  // Route segments may be `${slug}-${id}`; the id is what the API + lookups need.
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const pilotId = idFromSegment(pilotParam ?? "");
  // SSR seed: the server fetched comp+task+score+analysis for this URL, so
  // derive the narrative synchronously and render it in the first paint (this
  // is the SEO centerpiece). The map + tracklog still load client-side.
  const initial = useInitialData<PilotScoreLoaderData>();
  const [state, setState] = useState<DetailState>(() => {
    if (!initial || !pilotId) return { kind: "loading" };
    try {
      return {
        kind: "ready",
        data: buildDetailData(
          initial.comp,
          initial.task,
          initial.score,
          initial.analysis,
          pilotId,
        ),
      };
    } catch (err) {
      if (err instanceof ScorePendingError) return { kind: "pending" };
      return {
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load score details",
        notFound: err instanceof DetailNotFoundError,
      };
    }
  });
  const seededRef = useRef(initial != null);
  // Bumped by the pending poll below; re-runs the load effect.
  const [pendingAttempt, setPendingAttempt] = useState(0);
  const [fixes, setFixes] = useState<IGCFix[] | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);
  // Mapbox (764 KB) waits until the map panel nears the viewport — the page's
  // narrative is what the visitor came for. See lib/use-in-view.
  const [mapRef, mapInView] = useInView<HTMLDivElement>();
  // Time scrubber: draw the track only up to this fix (null = whole flight).
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  // Deep-link into the standalone analysis viewer, which loads the whole
  // field's tracks (this pilot pre-focused) with the full glide/thermal tools.
  const analysisUrl = `/analysis?compId=${encodeURIComponent(
    compId,
  )}&taskId=${encodeURIComponent(taskId)}&pilotId=${encodeURIComponent(pilotId)}`;
  // The analysis viewer is sign-in gated (it's the personal-library tool), so
  // only offer the link to signed-in visitors — an anonymous reader of this
  // public page would just hit the login wall. `user` is null during SSR and
  // the first client paint (loading), so this stays hydration-safe: the button
  // appears only after /api/auth/me resolves, matching TaskDetail's admin gate.
  const { user } = useUser();

  // While the map is expanded to fill the viewport: Esc restores it, and the
  // page behind it must not scroll.
  useEffect(() => {
    if (!mapExpanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMapExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [mapExpanded]);

  useEffect(() => {
    if (!compId || !taskId || !pilotId) return;
    // Seeded from SSR on the first render — skip the redundant fetch.
    if (seededRef.current) {
      seededRef.current = false;
      return;
    }
    let cancelled = false;
    // A poll re-entry keeps the "scores are being recomputed" panel up rather
    // than flashing the spinner every few seconds.
    if (pendingAttempt === 0) {
      setState({ kind: "loading" });
      setFocus(null);
      setSelectedItem(null);
      setMapExpanded(false);
    }
    // Retry through a transient D1 blip (the 4 concurrent reads can 404 one
    // spuriously on a cold DB) so we don't flash a false "not found".
    retry(() => loadDetail(compId, taskId, pilotId))
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ScorePendingError) {
          setState({ kind: "pending" });
          return;
        }
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : "Failed to load score details",
          notFound: err instanceof DetailNotFoundError,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [compId, taskId, pilotId, pendingAttempt]);

  // While the scores are catching up with a just-uploaded track, keep asking.
  // Backoff and give-up match ScoreFreshness's rescore poll: a revalidation is
  // usually under a second, but it queues behind whatever else the task is
  // doing. Pauses with the tab, because nobody is reading a hidden page.
  useEffect(() => {
    if (state.kind !== "pending") return;
    if (pendingAttempt >= PENDING_MAX_ATTEMPTS) return;
    const delay = Math.min(
      PENDING_INITIAL_MS * Math.pow(PENDING_BACKOFF, pendingAttempt),
      PENDING_MAX_MS,
    );
    let onVisible: (() => void) | null = null;
    const again = () => setPendingAttempt((n) => n + 1);
    const timer = window.setTimeout(() => {
      if (!document.hidden) return again();
      // Hidden when the timer fired: wait for the reader to come back rather
      // than dropping the poll, which would leave the page saying "recomputing"
      // forever.
      onVisible = () => {
        if (!document.hidden) again();
      };
      document.addEventListener("visibilitychange", onVisible);
    }, delay);
    return () => {
      window.clearTimeout(timer);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, [state.kind, pendingAttempt]);

  // The tracklog is only needed to draw the flight on the map — the
  // explanation renders from the analysis endpoint without it, so load it
  // independently and let the map fill in when it arrives. A failed
  // download degrades to a map without the track (markers still work).
  useEffect(() => {
    if (!compId || !taskId || !pilotId) return;
    let cancelled = false;
    setFixes(null);
    setScrubIndex(null);
    (async () => {
      try {
        const res = await fetch(
          `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(pilotId)}/download`,
          { credentials: "include" },
        );
        if (!res.ok) return;
        const igc = parseIGC(await gunzipResponse(res));
        if (!cancelled && igc.fixes.length > 0) setFixes(igc.fixes);
      } catch (err) {
        console.warn("Track unavailable for the map:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, taskId, pilotId]);

  const markerEvents = useMemo(
    () =>
      state.kind === "ready" ? [...state.data.eventsByItem.values()] : [],
    [state],
  );

  // Settle the address bar on the canonical `${slug}-${id}` once the names are
  // known. Must run before the early returns below (hooks are unconditional).
  const readyData = state.kind === "ready" ? state.data : null;
  useCanonicalPath(
    readyData && compId && taskId && pilotId
      ? pilotPath(
          compId,
          readyData.comp.name,
          taskId,
          readyData.task.name,
          pilotId,
          readyData.entry.pilot_name
        )
      : null
  );

  if (!compId || !taskId || !pilotId) return null;

  // Generic labels until the data arrives; the links work either way.
  const ready = state.kind === "ready" ? state.data : null;
  const breadcrumbs = (
    <Breadcrumbs
      items={underTask(compId, ready?.comp.name, taskId, ready?.task.name)}
      current={ready?.entry.pilot_name ?? "Pilot"}
    />
  );

  if (state.kind === "loading") {
    return (
      <div>
        {breadcrumbs}
        <Loading className="mt-4">Loading score details…</Loading>
      </div>
    );
  }

  if (state.kind === "pending") {
    // The pilot's track is in, but the served scores predate it — a wait, not
    // a 404. This page is where the submit flow sends someone the moment they
    // upload, so "no score found" would read as "your track did not go in".
    const gaveUp = pendingAttempt >= PENDING_MAX_ATTEMPTS;
    return (
      <div>
        {breadcrumbs}
        <div className="mt-4">
          {gaveUp ? (
            <p role="status" className="text-muted-foreground">
              Your track is in, but the scores are taking longer than usual to
              recompute. Reload in a minute, or open the task to see the field.
            </p>
          ) : (
            <Loading>
              Your track is in. Working out the scores — they depend on
              everyone else's tracks too…
            </Loading>
          )}
          <p className="mt-4">
            <LinkButton variant="outline" href={taskPath(compId, null, taskId, null)}>
              Go to the task
            </LinkButton>
          </p>
        </div>
      </div>
    );
  }

  if (state.kind === "error") {
    // A dead id gets the 404 page, which searches the URL's own slugs for the
    // pilot/task/comp that exist now. Any other failure is a failure, not a
    // wrong address, so it says what went wrong and keeps the breadcrumbs.
    if (state.notFound) {
      return <NotFound title="Page not found" message={`${state.message}.`} />;
    }
    return (
      <div>
        {breadcrumbs}
        <p className="mt-4 text-muted-foreground">{state.message}</p>
      </div>
    );
  }

  const { data } = state;
  const { entry, explanation } = data;

  const onItemClick = (item: ScoreExplanationItem) => {
    const event = data.eventsByItem.get(item.id);
    if (!event) return;
    setSelectedItem(item.id);
    setFocus((prev) => ({ event, nonce: (prev?.nonce ?? 0) + 1 }));
    // Show the flight only up to the clicked moment — when a pilot crosses
    // the same cylinder repeatedly, the clipped track is what makes the
    // sequence readable. Items without a real time (manual flights, derived
    // points) leave the scrub where it was.
    if (fixes && fixes.length > 1 && event.time.getTime() > 0) {
      setScrubIndex(nearestFixIndexByTime(fixes, event.time.getTime()));
    }
  };

  return (
    <div>
      {breadcrumbs}
      <header className="mt-2">
        <h1 className="text-xl font-bold">{entry.pilot_name}</h1>
        <p className="text-sm text-muted-foreground">
          {data.comp.name} · {data.task.name} ({formatTaskDate(data.task.task_date)}) ·{" "}
          {data.pilotClass} · ranked #{entry.rank} · times in{" "}
          {zoneNameWithOffset(
            new Date(data.task.task_date + "T12:00:00Z"),
            data.comp.timezone ?? undefined
          )}
        </p>
        <p className="text-sm text-muted-foreground">
          Scores computed{" "}
          <Timestamp value={data.scoreComputedAt} compTimezone={data.comp.timezone} />
          {data.scoreStale ? " — a re-score is in progress" : ""}
        </p>
        <p className="mt-1 font-medium">{explanation.headline}</p>
        {/* The winner's bridging sentence — why the top score is still short
            of the points on offer. The one question the day's leader arrives
            with, answered before any scrolling. */}
        {explanation.headlineNote ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {explanation.headlineNote}
          </p>
        ) : null}
      </header>

      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(0,11fr)_minmax(0,9fr)] lg:gap-6">
        {/* Map — supporting evidence. Sticky so it stays in view while the
            explanation scrolls (top of the page on mobile, right column on
            desktop). The expand toggle fills the viewport and restores on a
            second tap — done in CSS rather than the Fullscreen API so it
            works on iOS too. */}
        <div
          className={
            mapExpanded
              ? "fixed inset-0 z-50 flex flex-col bg-background"
              : "sticky top-0 z-10 -mx-4 bg-background px-4 pb-2 pt-2 sm:-mx-6 sm:px-6 lg:order-2 lg:top-4 lg:m-0 lg:p-0"
          }
        >
          <div
            ref={mapRef}
            className={`relative overflow-hidden ${
              mapExpanded
                ? "min-h-0 w-full flex-1"
                : "h-56 rounded-lg border sm:h-72 lg:h-[calc(100vh-8rem)]"
            }`}
          >
            {!mapInView ? (
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading map...
              </div>
            ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  Loading map...
                </div>
              }
            >
              <ScoreDetailMap
                task={data.mapTask}
                fixes={fixes}
                events={markerEvents}
                focus={focus}
                scrubIndex={scrubIndex}
                openDistanceLine={data.openDistanceLine}
                bestProgressRoute={data.bestProgressRoute}
              />
            </Suspense>
            )}
            {/* Map controls, styled like the providers' own controls (white
                regardless of theme) and kept clear of them: bottom-right, above
                the attribution line. The analysis link opens the full track in
                the standalone analysis viewer (`/analysis?compId=…`), which
                loads the whole field's tracks with the deeper glide/thermal
                tooling. */}
            {user != null ? (
              <a
                href={analysisUrl}
                target="_blank"
                rel="noopener"
                title="Open full track in the analysis map"
                aria-label="Open full track in the analysis map (opens in a new tab)"
                className="absolute bottom-20 right-2 z-20 flex size-10 items-center justify-center rounded-md border border-black/20 bg-white text-[#333] shadow-md"
              >
                <AnalysisMapIcon />
              </a>
            ) : null}
            <button
              type="button"
              onClick={() => setMapExpanded((v) => !v)}
              title={mapExpanded ? "Restore map (Esc)" : "Expand map"}
              aria-label={mapExpanded ? "Restore map" : "Expand map"}
              className="absolute bottom-8 right-2 z-20 flex size-10 items-center justify-center rounded-md border border-black/20 bg-white text-[#333] shadow-md"
            >
              {mapExpanded ? <MinimizeIcon /> : <MaximizeIcon />}
            </button>
          </div>
          {fixes && fixes.length > 1 ? (
            <div className={mapExpanded ? "border-t px-4 py-2" : "mt-1.5"}>
              <TrackScrubber
                fixes={fixes}
                scrubIndex={scrubIndex}
                timezone={data.comp.timezone}
                onScrub={setScrubIndex}
              />
            </div>
          ) : null}
          {mapExpanded ? null : (
            <p className="mt-1 hidden text-xs text-muted-foreground lg:block">
              Click any highlighted step in the explanation to see where it
              happened.
              {fixes && fixes.length > 1
                ? " Drag the slider to trace the flight up to any moment."
                : ""}
            </p>
          )}
        </div>

        {/* The explanation — the primary content. */}
        <div className="space-y-4 lg:order-1">
          <TrackQualityNote
            quality={data.trackQuality}
            inExplanation={data.entry.track_excluded != null}
          />
          {explanation.sections.map((section) => (
            <ExplanationSection
              key={section.id}
              section={section}
              selectedItem={selectedItem}
              hasAnchor={(item) => data.eventsByItem.has(item.id)}
              onItemClick={onItemClick}
            />
          ))}
          {data.entry.track_excluded ? <TrackValidityDocLink /> : null}
          {/* Closes the loop from this task back to the competition. Loads
              after hydration — see TaskInStandings for why it is not in the
              SSR payload. */}
          <TaskInStandings
            compId={compId}
            compName={data.comp.name}
            taskId={taskId}
            compPilotId={pilotId}
          />
          <TrackDataCleaningNote
            cleaning={data.altitudeCleaning}
            timezone={data.comp.timezone}
            fixes={fixes}
          />
          {/* Last on the page: a reader who needed a definition has met every
              term by now, and one who didn't never has to see it. */}
          <ScoringGlossary />
        </div>
      </div>
    </div>
  );
}

