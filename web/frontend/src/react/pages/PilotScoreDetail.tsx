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
  parseIGC,
  type IGCFix,
  type ScoreExplanationItem,
} from "@glidecomp/engine";
import { api } from "../../comp/api";
import { gunzipResponse } from "../../analysis/storage";
import { formatTaskDate, ordinal } from "../lib/format";
import { zoneNameWithOffset } from "../lib/time";
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
  CompDetailData,
  PilotAnalysisData,
  TaskDetailData,
  TaskScoreData,
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
import { MasterDetail } from "../components/MasterDetail";
import { TaskInCompScores } from "../comp/TaskInCompScores";
import { HistoricalRulesNotice, RulesEditionBadge } from "../comp/RulesEdition";
import type { MapFocus } from "../comp/ScoreDetailMap";
import { useInitialData } from "../lib/initial-data";
// The derivation lives in score-detail/report-card.ts, pure and unit-tested.
import {
  buildReportCard as buildDetailData,
  ScorePendingError,
  type ReportCard as DetailData,
} from "../score-detail/report-card";
import type { PilotScoreLoaderData } from "../loaders";

// Lazy so mapbox (and its CSS) loads only with this page's map.
const ScoreDetailMap = lazy(() => import("../comp/ScoreDetailMap"));

// ---------------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------------



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
  // Deep-link into the standalone analysis viewer. `pilotId` narrows it to
  // this pilot's own track, which is what keeps the viewer's panel in
  // single-track mode with the full Events/Glides/Climbs/Sinks tooling.
  //
  // Offered to everyone. This page is public, and the viewer opens this one
  // shape of link without a session (issue #666, `analysis/public-deep-link`)
  // — so it is also static markup, identical on the server and after
  // hydration, rather than something that appears once /api/auth/me answers.
  const analysisUrl = `/analysis?compId=${encodeURIComponent(
    compId,
  )}&taskId=${encodeURIComponent(taskId)}&pilotId=${encodeURIComponent(pilotId)}`;

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
      </header>

      {/* Explanation and map, paired by the shared MasterDetail in its PINNED
          mode — the map is evidence read ALONGSIDE the explanation, so a step
          must change a map that is on screen, never navigate to one. What the
          hand-rolled layout this replaces could not do is get out of the way:
          on a phone the map held a third of the viewport for the whole read
          with no way to dismiss it, and a focused step could stop behind it
          (WCAG 2.4.11). The component brings the "Hide map" fold — remembered,
          so a reader who reads the words says so once — and the scroll-margin
          clearance that keeps focus clear of the stuck pane.

          `storageKey`: the noun is "map" here and on the waypoints page, and
          those are different decisions on very different pages. */}
      <div className="mt-4">
        <MasterDetail
          detailLabel="map"
          detailAriaLabel="Track map"
          storageKey="score-map"
          bleed="page"
          // 11fr/9fr, the split this page has always opened on.
          defaultMasterShare={11 / 20}
          // A map wants the whole line, not the chart pane's 35rem cap.
          paneWidthClassName="w-full"
          // The pane's content is deliberately fixed-height (the map sizes
          // itself, the scrubber is one row), so it needs neither the pane's
          // stacked cap nor a scrollbar of its own — exactly as before.
          paneClassName={
            mapExpanded
              ? "fixed inset-0 z-50 flex flex-col rounded-none border-0 bg-background p-0 max-h-none @5xl:max-h-none overflow-y-visible"
              : // No card chrome: the map div carries its own rounded border,
                // and a pane border around it would double it. The wrapper's
                // bleed still paints the background the stuck pane needs.
                "rounded-none border-0 bg-transparent max-h-none @5xl:max-h-none overflow-y-visible"
          }
          // The wrapper is a sticky z-10 stacking context, so the expanded
          // overlay above would be trapped under the Shell's z-40 header
          // without this. Raising the wrapper rather than moving the pane
          // keeps the map mounted — a move would re-initialise Mapbox.
          paneWrapClassName={mapExpanded ? "z-50" : undefined}
          detail={
            <>
              <div
                ref={mapRef}
                className={`relative overflow-hidden ${
                  mapExpanded
                    ? "min-h-0 w-full flex-1"
                    : "h-56 rounded-lg border sm:h-72 @5xl:h-[calc(100vh-8rem)]"
                }`}
              >
                {!mapInView ? (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Loading map…
                  </div>
                ) : (
                <Suspense
                  fallback={
                    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                      Loading map…
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
                    the attribution line. The analysis link opens this pilot's track
                    and the task in the standalone analysis viewer
                    (`/analysis?compId=…&pilotId=…`), with the deeper glide/thermal
                    tooling. */}
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
                <p className="mt-1 hidden text-xs text-muted-foreground @5xl:block">
                  Click any highlighted step in the explanation to see where it
                  happened.
                  {fixes && fixes.length > 1
                    ? " Drag the slider to trace the flight up to any moment."
                    : ""}
                </p>
              )}
            </>
          }
          master={
            <div className="space-y-4">
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
    </div>
  );
}

