/**
 * Pilot score details — the explanation-first view of one pilot's score
 * for one task.
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
import { useParams } from "react-router-dom";
import {
  explainGapScore,
  explainOpenDistanceScore,
  explainManualFlightScore,
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
import { Breadcrumbs } from "../components/Breadcrumbs";
import { Timestamp } from "../components/Timestamp";
import type {
  ClassScore,
  CompDetailData,
  PilotAnalysisData,
  PilotScoreEntry,
  TaskDetailData,
  TaskScoreData,
} from "../comp/types";
import type { MapFocus } from "../comp/ScoreDetailMap";
import { useInitialData } from "../lib/initial-data";
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
  | { kind: "error"; message: string }
  | { kind: "ready"; data: DetailData };

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

  if (!compRes.ok || !taskRes.ok) throw new Error("Task not found");
  if (!scoreRes.ok) throw new Error("Scores are not available for this task");
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
  if (!cls || !entry) throw new Error("No score found for this pilot");

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
    };
  }

  // Resolve the exact parameter set the scorer used, so the explanation names
  // the same formula and time-points exponent (issue #258): the official
  // per-category defaults with the comp's saved gap_params merged over them,
  // keeping the pre-#258 exponent for a comp that saved only a leadingFormula.
  // nominalDistance is left off — the explainer derives points from the class
  // context, not from it, and the stored value may be a nullable "auto".
  const params: Partial<GAPParameters> = (() => {
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
  };
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function PilotScoreDetail() {
  const { compId, taskId, pilotId } = useParams<{
    compId: string;
    taskId: string;
    pilotId: string;
  }>();
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
      return {
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load score details",
      };
    }
  });
  const seededRef = useRef(initial != null);
  const [fixes, setFixes] = useState<IGCFix[] | null>(null);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [selectedItem, setSelectedItem] = useState<string | null>(null);
  const [mapExpanded, setMapExpanded] = useState(false);

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
    setState({ kind: "loading" });
    setFocus(null);
    setSelectedItem(null);
    setMapExpanded(false);
    loadDetail(compId, taskId, pilotId)
      .then((data) => {
        if (!cancelled) setState({ kind: "ready", data });
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : "Failed to load score details",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [compId, taskId, pilotId]);

  // The tracklog is only needed to draw the flight on the map — the
  // explanation renders from the analysis endpoint without it, so load it
  // independently and let the map fill in when it arrives. A failed
  // download degrades to a map without the track (markers still work).
  useEffect(() => {
    if (!compId || !taskId || !pilotId) return;
    let cancelled = false;
    setFixes(null);
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

  if (!compId || !taskId || !pilotId) return null;

  // Generic labels until the data arrives; the links work either way.
  const ready = state.kind === "ready" ? state.data : null;
  const breadcrumbs = (
    <Breadcrumbs
      items={[
        { label: "Competitions", to: "/comp" },
        { label: ready?.comp.name ?? "Competition", to: `/comp/${compId}` },
        { label: ready?.task.name ?? "Task", to: `/comp/${compId}/task/${taskId}` },
      ]}
    />
  );

  if (state.kind === "loading") {
    return (
      <div>
        {breadcrumbs}
        <p className="mt-4 text-muted-foreground">Loading score details...</p>
      </div>
    );
  }

  if (state.kind === "error") {
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
              ? "fixed inset-0 z-50 bg-background"
              : "sticky top-0 z-10 -mx-4 bg-background px-4 pb-2 pt-2 sm:-mx-6 sm:px-6 lg:order-2 lg:top-4 lg:m-0 lg:p-0"
          }
        >
          <div
            className={`relative overflow-hidden ${
              mapExpanded
                ? "h-full w-full"
                : "h-56 rounded-lg border sm:h-72 lg:h-[calc(100vh-6rem)]"
            }`}
          >
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
                openDistanceLine={data.openDistanceLine}
                bestProgressRoute={data.bestProgressRoute}
              />
            </Suspense>
            {/* Styled like the providers' own controls (white regardless of
                theme) and kept clear of them: bottom-right, above the
                attribution line. */}
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
          {mapExpanded ? null : (
            <p className="mt-1 hidden text-xs text-muted-foreground lg:block">
              Click any highlighted step in the explanation to see where it
              happened.
            </p>
          )}
        </div>

        {/* The explanation — the primary content. */}
        <div className="space-y-4 lg:order-1">
          {explanation.sections.map((section) => (
            <ExplanationSection
              key={section.id}
              section={section}
              selectedItem={selectedItem}
              hasAnchor={(item) => data.eventsByItem.has(item.id)}
              onItemClick={onItemClick}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explanation rendering
// ---------------------------------------------------------------------------

function ExplanationSection({
  section,
  selectedItem,
  hasAnchor,
  onItemClick,
}: {
  section: ScoreExplanationSection;
  selectedItem: string | null;
  hasAnchor: (item: ScoreExplanationItem) => boolean;
  onItemClick: (item: ScoreExplanationItem) => void;
}) {
  return (
    <section className="rounded-lg border p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="font-semibold">{section.title}</h2>
        {section.points !== undefined ? (
          <span className="shrink-0 font-semibold tabular-nums">
            {Math.round(section.points * 10) / 10} pts
          </span>
        ) : null}
      </div>
      {section.summary ? (
        <p className="mt-1 text-sm text-muted-foreground">{section.summary}</p>
      ) : null}
      <div className="mt-2 space-y-1">
        {section.items.map((item) => (
          <ExplanationItem
            key={item.id}
            item={item}
            anchored={hasAnchor(item)}
            selected={selectedItem === item.id}
            onClick={() => onItemClick(item)}
          />
        ))}
      </div>
    </section>
  );
}

function ExplanationItem({
  item,
  anchored,
  selected,
  onClick,
}: {
  item: ScoreExplanationItem;
  anchored: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  const textClass =
    item.emphasis === "warning"
      ? "text-amber-600 dark:text-amber-500"
      : item.emphasis === "muted"
        ? "text-muted-foreground"
        : "";

  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className={`text-sm ${textClass}`}>
          {anchored ? (
            <MapPinIcon className="mr-1 inline-block size-3.5 shrink-0 -translate-y-px text-muted-foreground" />
          ) : null}
          {item.text}
        </span>
        {item.value ? (
          <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
            {item.value}
          </span>
        ) : null}
      </div>
      {item.detail ? (
        <p className="mt-0.5 text-xs text-muted-foreground">{item.detail}</p>
      ) : null}
    </>
  );

  if (!anchored) {
    return <div className="rounded-md px-2 py-1.5">{body}</div>;
  }

  return (
    <button
      type="button"
      onClick={onClick}
      title="Show on map"
      className={`block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/60 ${
        selected ? "bg-muted" : ""
      }`}
    >
      {body}
    </button>
  );
}

function MaximizeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function MinimizeIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4 14 10 14 10 20" />
      <polyline points="20 10 14 10 14 4" />
      <line x1="14" y1="10" x2="21" y2="3" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

function MapPinIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}
