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
import {
  ClipboardPenIcon,
  FocusIcon,
  MapIcon,
  Maximize2Icon,
  Minimize2Icon,
} from "lucide-react";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { useInView } from "../lib/use-in-view";
import { Link, useParams } from "react-router-dom";
import {
  parseIGC,
  type IGCFix,
  type ScoreExplanationItem,
} from "@glidecomp/engine";
import { api } from "../../comp/api";
import { gunzipResponse } from "../../analysis/storage";
import { formatTaskDate, ordinal } from "../lib/format";
import { zoneNameWithOffset } from "../lib/time";
import { Page, PageBar, type BarAction } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { underPilot, underTask } from "../lib/crumbs";
import { retry } from "../lib/retry";
import {
  compUrlId,
  idFromSegment,
  manualFlightPath,
  pilotMapPath,
  pilotPath,
  taskPath,
  taskPilotsPath,
} from "../lib/slug";
import { useAdminView } from "../lib/user";
import { LinkButton } from "@/react/rac/button";
import { Card } from "@/react/rac/card";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { Timestamp } from "../components/Timestamp";
import { NotFound } from "../components/NotFound";
import type {
  CompDetailData,
  PilotAnalysisData,
  TaskDetailData,
  TaskScoreData,
} from "../comp/types";
import { FloatSlot, FloatingContent, useFloatingDetail } from "../components/FloatingWindow";
import { cn } from "@/react/lib/utils";
import { TrackScrubber, nearestFixIndexByTime } from "../score-detail/TrackScrubber";
import {
  TrackDataCleaningNote,
  TrackQualityNote,
  TrackValidityDocLink,
} from "../score-detail/TrackNotes";
import { ExplanationSection } from "../score-detail/Explanation";
import { useLeave } from "../lib/leave";
import { ScoringGlossary } from "../components/ScoringGlossary";
import { MasterDetail } from "../components/MasterDetail";
import { TaskInCompScores } from "../comp/TaskInCompScores";
import { HistoricalRulesNotice, RulesEditionBadge } from "../comp/RulesEdition";
import type { MapFocus } from "../comp/ScoreDetailMap";
import { useInitialData } from "../lib/initial-data";
// The derivation lives in score-detail/report-card.ts, pure and unit-tested.
import {
  buildReportCard,
  ScorePendingError,
  type ReportCard,
} from "../score-detail/report-card";
import type { PilotScoreLoaderData } from "../loaders";

// Lazy so mapbox (and its CSS) loads only with this page's map.
const ScoreDetailMap = lazy(() => import("../comp/ScoreDetailMap"));

// ---------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------



/**
 * The report card, plus the pilots it sits among: everyone scored in this
 * pilot's class, in the order the scores publish them. They are the rows of
 * the title's menu, the way from one pilot's card to the next. Read off the
 * score payload the page fetched anyway, so it costs no request.
 */
type DetailData = ReportCard & { field: Array<{ id: string; name: string }> };

function buildDetailData(
  comp: CompDetailData,
  task: TaskDetailData,
  score: TaskScoreData,
  analysis: PilotAnalysisData,
  pilotId: string,
): DetailData {
  const card = buildReportCard(comp, task, score, analysis, pilotId);
  const cls = score.class_scores.find((c) =>
    c.pilots.some((p) => p.comp_pilot_id === pilotId),
  );
  return {
    ...card,
    field: (cls?.pilots ?? []).map((p) => ({ id: p.comp_pilot_id, name: p.pilot_name })),
  };
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
  // Not a 404: the task may well exist, and we failed to load it.
  if (!compRes.ok || !taskRes.ok)
    throw new Error("This task could not be loaded. Try again in a moment.");
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


// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * The map's own controls where it is part of a page, styled like the
 * provider's (white regardless of theme). The size button has the top right
 * corner, as the window's own size buttons do (FloatingContent).
 */
const MAP_CONTROL =
  "absolute z-20 flex size-10 pointer-coarse:size-11 items-center justify-center rounded-md border border-black/20 bg-white text-[#333] shadow-md print:hidden";

/**
 * `view="map"` is the same page with the map alone, at full size
 * (`/pilot/:id/map`, #870). It is this component rather than a second one
 * because the map is drawn from what the report card loads: the task, the
 * events its steps are anchored to and the tracklog. It was a fixed layer
 * over the report card until 2026-11; a screen of its own is a page
 * (docs/interaction-guide.md 2.1), left with Back.
 */
export function PilotScoreDetail({ view = "card" }: { view?: "card" | "map" } = {}) {
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
  // Mapbox (764 KB) waits until the map panel nears the viewport — the page's
  // narrative is what the visitor came for. See lib/use-in-view.
  const [mapRef, mapInView] = useInView<HTMLDivElement>();
  // On a phone the map is a floating window (see FloatingWindow.tsx). Held
  // here because the page lays the map out for it, and brings it back when
  // the reader picks a step it had been put away for.
  const float = useFloatingDetail("score-map");
  // Whether the map is on the whole flight, or the reader has moved it, or
  // a step has flown it to a point. Off it, a button puts it back.
  const [mapFramed, setMapFramed] = useState(true);
  const [refitNonce, setRefitNonce] = useState(0);
  const leave = useLeave();
  // Time scrubber: draw the track only up to this fix (null = whole flight).
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  // Deep-link into the standalone analysis viewer. `pilotId` narrows it to
  // this pilot's own track, which is what keeps the viewer's panel in
  // single-track mode with the full Events/Glides/Climbs/Sinks tooling.
  //
  // Offered to everyone. This page is public, and the viewer opens this one
  // shape of link without a session (issue #666, `analysis/public-deep-link`)
  // — so it is also static markup, identical on the server and after
  // hydration, rather than something that appears once /api/auth/me answers.
  //
  // It is the first row of the bar's ⋯ menu (#863). It was a button over the
  // map, where it sat on top of the map's own "Find my location".
  const analysisUrl = `/analysis?compId=${encodeURIComponent(
    compId,
  )}&taskId=${encodeURIComponent(taskId)}&pilotId=${encodeURIComponent(pilotId)}`;

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
      ? (view === "map" ? pilotMapPath : pilotPath)(
          compUrlId(readyData.comp, compId),
          readyData.comp.name,
          taskId,
          readyData.task.name,
          pilotId,
          readyData.entry.pilot_name
        )
      : null
  );

  // Organisers' actions appear once the user resolves, as the page's admin
  // controls always have: the server and the first client render agree.
  const isAdmin = useAdminView(!!readyData?.comp.is_admin);

  if (!compId || !taskId || !pilotId) return null;

  // Generic labels until the data arrives; the links work either way. The
  // bar is there in every state, so the page does not jump when it loads.
  const ready = state.kind === "ready" ? state.data : null;
  // The id every link carries: a hidden comp's share key rides along.
  const urlId = ready ? compUrlId(ready.comp, compId) : compId;
  const actions: BarAction[] = [
    // Plain links out of the SPA, to the vanilla analysis and replay entries.
    { id: "track", label: "Climbs and glides", icon: MapIcon, to: analysisUrl, target: "_blank" },
    {
      id: "replay",
      label: "Replay the task in 3D",
      icon: MapIcon,
      to: `/replay?comp=${encodeURIComponent(compId)}&task=${encodeURIComponent(taskId)}`,
    },
  ];
  if (isAdmin && ready) {
    actions.push({
      id: "manual",
      icon: ClipboardPenIcon,
      label: "Record a manual flight",
      group: true,
      to: manualFlightPath(
        urlId,
        ready.comp.name,
        taskId,
        ready.task.name,
        pilotId,
        ready.entry.pilot_name
      ),
    });
  }
  const bar =
    view === "map" ? (
      // The map's own page: Back returns to the report card.
      <PageBar
        title="Map"
        fullTitle={ready ? `Map of ${ready.entry.pilot_name}'s flight` : "Map of the flight"}
        trail={underPilot(
          urlId,
          ready?.comp.name,
          taskId,
          ready?.task.name,
          pilotId,
          ready?.entry.pilot_name
        )}
      />
    ) : (
      <PageBar
        title={ready?.entry.pilot_name ?? "Pilot"}
        trail={underTask(compId, ready?.comp.name, taskId, ready?.task.name)}
        related={
          // One row for every other pilot, which opens a page with a search
          // field. The menu listed them all, one row each: 43 on the sample
          // task (#870).
          ready && ready.field.length > 1
            ? {
                as: "siblings",
                items: [
                  {
                    label: ready.entry.pilot_name,
                    to: pilotPath(
                      urlId,
                      ready.comp.name,
                      taskId,
                      ready.task.name,
                      pilotId,
                      ready.entry.pilot_name
                    ),
                    current: true,
                  },
                  {
                    label: "Another pilot…",
                    to: taskPilotsPath(urlId, ready.comp.name, taskId, ready.task.name, pilotId),
                  },
                ],
              }
            : undefined
        }
        actions={actions}
      />
    );

  if (state.kind === "loading") {
    return (
      <>
        {/* The map's place in the tree, empty here: see `floatingContent`.
            Keeping the place keeps the PAGE at its own place, so the bar
            is not mounted again when the data arrives. */}
        {null}
      <Page width="wide" bar={bar}>
        <Loading>Loading score card…</Loading>
      </Page>
      </>
    );
  }

  if (state.kind === "pending") {
    // The pilot's track is in, but the served scores predate it — a wait, not
    // a 404. This page is where the submit flow sends someone the moment they
    // upload, so "no score found" would read as "your track did not go in".
    const gaveUp = pendingAttempt >= PENDING_MAX_ATTEMPTS;
    return (
      <>
        {/* The map's place in the tree, empty here: see `floatingContent`.
            Keeping the place keeps the PAGE at its own place, so the bar
            is not mounted again when the data arrives. */}
        {null}
      <Page width="wide" bar={bar}>
        <div>
          {gaveUp ? (
            <p role="status" className="text-muted-foreground">
              Your track is in. Scores are slow to update — reload in a minute.
            </p>
          ) : (
            <Loading>
              Your track is in. Updating scores…
            </Loading>
          )}
          <p className="mt-4">
            <LinkButton variant="outline" href={taskPath(compId, null, taskId, null)}>
              Go to the task
            </LinkButton>
          </p>
        </div>
      </Page>
      </>
    );
  }

  if (state.kind === "error") {
    // A dead id gets the 404 page, which searches the URL's own slugs for the
    // pilot/task/comp that exist now. Any other failure is a failure, not a
    // wrong address, so it says what went wrong and keeps the bar.
    if (state.notFound) {
      return <NotFound title="Page not found" message={`${state.message}.`} />;
    }
    return (
      <>
        {/* The map's place in the tree, empty here: see `floatingContent`.
            Keeping the place keeps the PAGE at its own place, so the bar
            is not mounted again when the data arrives. */}
        {null}
      <Page width="wide" bar={bar}>
        <p className="text-muted-foreground">{state.message}</p>
      </Page>
      </>
    );
  }

  const { data } = state;
  const { entry, explanation } = data;

  const onItemClick = (item: ScoreExplanationItem, pressed: Element) => {
    const event = data.eventsByItem.get(item.id);
    if (!event) return;
    setSelectedItem(item.id);
    // A step is a question put to the map. If the map was put away, this is
    // the moment it is wanted, and away from the step that was pressed.
    float.reveal(pressed);
    setFocus((prev) => ({ event, nonce: (prev?.nonce ?? 0) + 1 }));
    // Show the flight only up to the clicked moment — when a pilot crosses
    // the same cylinder repeatedly, the clipped track is what makes the
    // sequence readable. Items without a real time (manual flights, derived
    // points) leave the scrub where it was.
    if (fixes && fixes.length > 1 && event.time.getTime() > 0) {
      setScrubIndex(nearestFixIndexByTime(fixes, event.time.getTime()));
    }
  };

  const mapFallback = (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  );
  const map = (
    <Suspense fallback={mapFallback}>
      <ScoreDetailMap
        task={data.mapTask}
        fixes={fixes}
        events={markerEvents}
        focus={focus}
        scrubIndex={scrubIndex}
        openDistanceLine={data.openDistanceLine}
        bestProgressRoute={data.bestProgressRoute}
        refitNonce={refitNonce}
        onFramingChange={setMapFramed}
      />
    </Suspense>
  );
  const scrubber =
    fixes && fixes.length > 1 ? (
      <TrackScrubber
        fixes={fixes}
        scrubIndex={scrubIndex}
        timezone={data.comp.timezone}
        onScrub={setScrubIndex}
      />
    ) : null;

  const mapPath = pilotMapPath(
    urlId,
    data.comp.name,
    taskId,
    data.task.name,
    pilotId,
    entry.pilot_name
  );
  const cardPath = pilotPath(
    urlId,
    data.comp.name,
    taskId,
    data.task.name,
    pilotId,
    entry.pilot_name
  );
  // The map and its slider: ONE subtree for the report card's column, the
  // floating window and the full-size page, so the map (its camera, what the
  // reader drew on it) is the same map in all three. `float.mode` says which
  // it is in, and the layout follows.
  const mode = float.mode;
  const detail = (
    <>
      <div
        ref={mapRef}
        className={
          mode == null
            ? "relative h-56 overflow-hidden rounded-lg border sm:h-72 @5xl:h-[calc(100vh-8rem)] [&_.mapboxgl-ctrl-top-right]:top-11! pointer-coarse:[&_.mapboxgl-ctrl-top-right]:top-12!"
            : cn(
                // The window, or the page, is the frame: the map fills it.
                "relative min-h-0 flex-1 overflow-hidden",
                // The size buttons have the top right corner at every size,
                // so on the full page the provider's column starts under them.
                mode === "full" &&
                  "[&_.mapboxgl-ctrl-top-right]:top-11! pointer-coarse:[&_.mapboxgl-ctrl-top-right]:top-12!",
                // Large, the window is not large: the provider's zoom,
                // compass, locate and scale are dropped (a map is zoomed
                // with two fingers), and the style and drawing stay.
                mode === "large" &&
                  "[&_.mapboxgl-ctrl-top-right]:hidden [&_.mapboxgl-ctrl-scale]:hidden",
                // Small, it shows the map alone. The provider's logo and
                // attribution stay: it is a picture there, and takes no
                // touch. A popup would not fit, and the step that was picked
                // already says what it says.
                (mode === "small" || mode === "tucked") &&
                  "[&_.mapboxgl-ctrl-top-left]:hidden [&_.mapboxgl-ctrl-top-right]:hidden [&_.mapboxgl-ctrl-bottom-left>*:not(:has(.mapboxgl-ctrl-logo))]:hidden [&_.ann-toggle]:hidden! [&_.mapboxgl-popup]:hidden"
              )
        }
      >
        {mode == null && !mapInView ? mapFallback : map}
        {mode == null ? (
          // Opens the map's own page (#870). Opening this track in the
          // analysis viewer is in the bar's ⋯ menu.
          <Link
            to={mapPath}
            title="Expand map"
            aria-label="Expand map"
            className={cn(MAP_CONTROL, "top-1.5 right-1.5")}
          >
            <Maximize2Icon aria-hidden className="size-5" />
          </Link>
        ) : mode === "full" ? (
          // One step smaller, in the same corner. It leaves the page as the
          // bar's Back does: the full-size map is a page (guide 2.1).
          <button
            type="button"
            title="Shrink map"
            aria-label="Shrink map"
            onClick={() => leave(cardPath)}
            className={cn(MAP_CONTROL, "top-1.5 right-1.5")}
          >
            <Minimize2Icon aria-hidden className="size-5" />
          </button>
        ) : null}
        {/* Off the flight: one press puts the whole of it back in view. Not
            on the small window, whose map takes no touch. */}
        {mapFramed || mode === "small" || mode === "tucked" ? null : (
          <button
            type="button"
            title="Show the whole flight"
            aria-label="Show the whole flight"
            onClick={() => setRefitNonce((n) => n + 1)}
            className={cn(
              MAP_CONTROL,
              mode === "large"
                ? // Under the window's own buttons.
                  "top-12 right-1.5 pointer-coarse:top-14"
                : // In the foot's right corner, above the attribution.
                  "right-2 bottom-8"
            )}
          >
            <FocusIcon aria-hidden className="size-5" />
          </button>
        )}
      </div>
      {!scrubber || mode === "small" || mode === "tucked" ? null : mode === "large" ? (
        // The window can be held by its last row, as by its grabber:
        // anywhere but the slider (FloatingContent reads the mark).
        <div
          data-float-drag=""
          className="min-h-11 shrink-0 cursor-grab touch-none px-3 select-none"
        >
          {scrubber}
        </div>
      ) : mode === "full" ? (
        // The page's last row, in its flow: nothing is fixed to the bottom.
        <div className="shrink-0 px-4 py-2">{scrubber}</div>
      ) : (
        <div className="mt-1.5">{scrubber}</div>
      )}
      {mode == null ? (
        <p className="mt-1 hidden text-xs text-muted-foreground @5xl:block">
          Click any highlighted step in the explanation to see where it
          happened.
          {fixes && fixes.length > 1
            ? " Drag the slider to trace the flight up to any moment."
            : ""}
        </p>
      ) : null}
    </>
  );
  // First in the tree on the report card AND on the map's page, so the
  // router keeps it, and the map in it, when the reader goes between them.
  const floatingContent = (
    <FloatingContent float={float} label="map" ariaLabel="Track map" fullTo={mapPath}>
      {detail}
    </FloatingContent>
  );

  if (view === "map") {
    return (
      <>
        {floatingContent}
        {/* The map under the bar, as wide and as tall as the screen. */}
        <Page fill="viewport" bar={bar}>
          <FloatSlot
            float={float}
            kind="full"
            role="region"
            aria-label="Track map"
            className="flex min-h-0 w-full flex-1 flex-col overflow-hidden border-t border-border"
          />
        </Page>
      </>
    );
  }

  // The map answers the steps that are anchored to it, which today are all in
  // the Flight section. Those sections stay beside the map; the rest of the
  // page follows in MasterDetail's `after`, so on a phone the pinned map
  // scrolls away once the reader is past the last step it can show. Found
  // from the data rather than by section id, so a later section that gains an
  // anchor keeps the map with it. The first section (Flight, or "Why this
  // tracklog was excluded") always stays, anchors or not.
  const lastAnchored = explanation.sections.reduce(
    (last, section, i) =>
      section.items.some((item) => data.eventsByItem.has(item.id)) ? i : last,
    0,
  );
  const mapSections = explanation.sections.slice(0, lastAnchored + 1);
  const restSections = explanation.sections.slice(lastAnchored + 1);
  const renderSection = (section: (typeof explanation.sections)[number]) => (
    <ExplanationSection
      key={section.id}
      section={section}
      selectedItem={selectedItem}
      hasAnchor={(item) => data.eventsByItem.has(item.id)}
      onItemClick={onItemClick}
    />
  );

  return (
    <>
    {floatingContent}
    <Page width="wide" bar={bar}>
      {/* The pilot's name is the bar's title, and the page's <h1>. */}
      <div>
        <p className="text-sm text-muted-foreground">
          {data.comp.name} · {data.task.name} ({formatTaskDate(data.task.task_date)}) ·{" "}
          {data.pilotClass} · ranked #{entry.rank} · times in{" "}
          {zoneNameWithOffset(
            new Date(data.task.task_date + "T12:00:00Z"),
            data.comp.timezone ?? undefined
          )}
        </p>
        {/* The officially published standing (issue #603) — display only,
            never a GlideComp score, so it sits as an annotation under the
            rank rather than inside the explanation. */}
        {data.official ? (
          <p className="text-sm text-muted-foreground">
            Officially: {ordinal(data.official.rank)} · {Math.round(data.official.total)} pts (
            {data.official.url ? (
              <a
                href={data.official.url}
                target="_blank"
                rel="noopener"
                className="underline underline-offset-4 hover:text-foreground"
              >
                {data.official.source}
              </a>
            ) : (
              data.official.source
            )}
            )
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Scores computed{" "}
          <Timestamp value={data.scoreComputedAt} compTimezone={data.comp.timezone} />
          {data.scoreStale ? " — a re-score is in progress" : ""}
          {" · "}
          <RulesEditionBadge edition={data.rulesEdition} />
        </p>
        <div className="mt-2 empty:hidden">
          <HistoricalRulesNotice
            edition={data.rulesEdition}
            taskDate={data.task.task_date}
            officialUrl={data.officialTaskUrl}
          />
        </div>
        <p className="mt-1 font-medium">{explanation.headline}</p>
        {/* The winner's bridging sentence — why the top score is still short
            of the points on offer. The one question the day's leader arrives
            with, answered before any scrolling. */}
        {explanation.headlineNote ? (
          <p className="mt-0.5 text-sm text-muted-foreground">
            {explanation.headlineNote}
          </p>
        ) : null}
      </div>

      {/* Explanation and map, paired by the shared MasterDetail: the map is
          evidence read ALONGSIDE the explanation, so a step must change a map
          that is on screen, never navigate to one.

          Side by side the map is the sticky right-hand column. On a phone it
          FLOATS (`floating`): a pinned map held half the screen for the whole
          read, and the fold that replaced that was all or nothing. The window
          covers a corner the reader chooses, and can be put away.

          The sections whose steps the map can show are the `master`; the
          rest of the page is `after`.

          `storageKey`: the noun is "map" here and on the waypoints page, and
          those are different decisions on very different pages. */}
      <div className="mt-4">
        <MasterDetail
          detailLabel="map"
          detailAriaLabel="Track map"
          storageKey="score-map"
          floating={float}
          bleed="page"
          // 11fr/9fr, the split this page has always opened on.
          defaultMasterShare={11 / 20}
          // A map wants the whole line, not the chart pane's 35rem cap.
          paneWidthClassName="w-full"
          // The pane's content is deliberately fixed-height (the map sizes
          // itself, the scrubber is one row), so it needs neither the pane's
          // stacked cap nor a scrollbar of its own — exactly as before.
          // No card chrome: the map div carries its own rounded border, and
          // a pane border around it would double it. The wrapper's bleed
          // still paints the background the stuck pane needs.
          paneClassName="rounded-none border-0 bg-transparent max-h-none @5xl:max-h-none overflow-y-visible"
          // The pane's place, side by side. The map itself is rendered
          // once, below, and is moved here, into its window or onto its own
          // page (FloatingContent).
          detail={<FloatSlot float={float} kind="flow" />}
          master={
            <div className="space-y-4">
              <TrackQualityNote
                quality={data.trackQuality}
                inExplanation={data.entry.track_excluded != null}
              />
              {mapSections.map(renderSection)}
            </div>
          }
          // Read on from the explanation, but nothing here moves the map: on
          // a phone the map lets go before this (see MasterDetail's `after`).
          after={
            <div className="mt-4 space-y-4">
              {restSections.map(renderSection)}
              {data.entry.track_excluded ? <TrackValidityDocLink /> : null}
              {/* Closes the loop from this task back to the competition. Loads
                  after hydration — see TaskInCompScores for why it is not in the
                  SSR payload. */}
              <TaskInCompScores
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
          }
        />
      </div>
    </Page>
    </>
  );
}

