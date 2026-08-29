/**
 * Task field analysis — the behavioural metrics for one task's field, and
 * which of them actually separated the leaderboard.
 *
 * PUBLIC (admin-only only for a hidden `test` comp — see canViewFieldAnalysis
 * in the worker's routes/field-analysis.ts; the API 404s a hidden comp for
 * non-admins, and this page reflects that rather than second-guessing it).
 *
 * Its own page rather than a section on the task page: it is a long,
 * exploratory read that shouldn't compete with the official scores.
 *
 * Lives at /comp/:compId/analysis/task/:taskId — a chapter of the comp's
 * field analysis, NOT a leaf of the task page, so the breadcrumb's parent is
 * that report and the H1 is the task's name (the section name is already in
 * the trail). The task page is a sibling link in the header.
 *
 * SSR'd via loadTaskFieldAnalysis + functions/comp/[[path]].ts: the server
 * seeds the most-recently-cached report from `useInitialData()`, or a pending
 * placeholder while the first compute runs; the client hydrates from the same
 * data and takes over polling.
 *
 * Presentation order mirrors the CLI's text report deliberately: the
 * separation ranking FIRST, then per-family detail. Which metrics have
 * explanatory power is the finding; the per-pilot numbers are the evidence.
 */
import { Card } from "@/react/rac/card";
import { useEffect, useMemo, useState } from "react";
import type { Key } from "react-aria-components";
import { useParams, useSearchParams } from "react-router-dom";
import { NotFound } from "../components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { Button, LinkButton } from "@/react/rac/button";
import { SimpleSelect } from "@/react/rac/select";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { underCompAnalysis } from "../lib/crumbs";
import {
  idFromSegment,
  taskPath,
  taskAnalysisPath,
  taskSimilarityPath,
} from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { usePollWhile } from "../lib/use-poll-while";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { toast } from "../lib/toast";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { TaskDiagram } from "../comp/TaskDiagram";
import { useInitialData } from "../lib/initial-data";
import type { TaskFieldAnalysisLoaderData } from "../loaders";
import { SeparationRanking, rankMetrics } from "../field-analysis/SeparationRanking";
import { Explain } from "@/react/rac/explain";
import {
  HowToReadFootnote,
  OneDayCaveatNote,
} from "../field-analysis/ReadingNotes";
import {
  MetricFamilySection,
  familySectionId,
  hasMetricBlock,
  metricBlockId,
  metricsByFamily,
} from "../field-analysis/MetricFamilySection";
import { PageToc, type PageTocItem } from "../components/PageToc";
import { metricTocLabel } from "../field-analysis/toc-labels";
import { cn } from "../lib/utils";
import { AnalysisBasis } from "../field-analysis/AnalysisBasis";
import { OverviewBlock } from "../field-analysis/OverviewBlock";
import { TaskDebrief } from "../field-analysis/TaskDebrief";
import { MetricGlossary } from "../field-analysis/MetricGlossary";
import {
  ExcludedPilots,
  Footnotes,
  MethodNote,
  EXCLUDED_PILOTS_ID,
  METHOD_NOTE_ID,
} from "../field-analysis/Footnotes";
import { PilotHighlightProvider } from "../field-analysis/PilotHighlightContext";
import { PilotPicker } from "../field-analysis/PilotPicker";
import { PercentileHeatmap } from "../field-analysis/charts/PercentileHeatmap";
import { StyleClusters } from "../field-analysis/StyleClusters";
import { ThermalsPanel } from "../field-analysis/thermals/ThermalsPanel";
import { displayReport } from "../field-analysis/units";
import { useTaskWeather } from "../weather/use-task-weather";
import { DayProfilePanel } from "../field-analysis/charts/day-profile/DayProfilePanel";
import { WeatherNotesBlock } from "../weather/WeatherNotesBlock";
import { useUnits } from "../lib/units";
import {
  FAMILY_ORDER,
  FAMILY_LABELS,
  clusterPilotStyles,
  type MetricReport,
  type TaskFieldAnalysisData,
} from "../field-analysis/types";
import {
  fetchWithRetry,
  type CompDetailData,
  type TaskDetailData,
} from "../comp/types";

export function TaskFieldAnalysis() {
  const { compId: compParam, taskId: taskParam } = useParams<{ compId: string; taskId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const taskId = idFromSegment(taskParam ?? "");
  const { user } = useUser();
  const [searchParams, setSearchParams] = useSearchParams();

  // SSR seed: the server ran loadTaskFieldAnalysis for this URL and embedded
  // the result. Null on client boot / SPA navigations, where the effects fetch.
  const initial = useInitialData<TaskFieldAnalysisLoaderData>();
  const [data, setData] = useState<TaskFieldAnalysisData | null>(
    initial?.analysis ?? null
  );
  const [etag, setEtag] = useState<string | null>(initial?.analysisEtag ?? null);
  const [task, setTask] = useState<TaskDetailData | null>(initial?.task ?? null);
  const [comp, setComp] = useState<CompDetailData | null>(initial?.comp ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "notFound" | "forbidden" | "error">(
    initial ? "ready" : "loading"
  );
  const [refreshing, setRefreshing] = useState(false);

  // What the meteorology says the day did — its own request, its own cache,
  // its own failure mode. A weather-provider outage must never stop the
  // behavioural metrics from rendering, so this deliberately does not gate
  // anything below it; the weather section simply disappears when this
  // comes back empty.
  const weather = useTaskWeather(compId || null, taskId || null);
  const weatherNotes = weather.data?.notes ?? task?.weather_notes ?? "";
  const weatherPending = weather.loading || weather.data?.pending === true;

  // Settle the address bar on the canonical `${slug}-${id}` once both names
  // load (the analysis body carries neither, so wait for the name fetches).
  useCanonicalPath(
    comp && task ? taskAnalysisPath(compId, comp.name, taskId, task.name) : null
  );

  const analysisUrl =
    compId && taskId
      ? `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/field-analysis`
      : null;

  // refetchTick > 0 re-runs the fetch without flashing the loading state —
  // the pending-poll effect below bumps it until the background compute lands.
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    if (!compId || !taskId || !analysisUrl) return;
    // Seeded by SSR for the first render — don't refetch on mount, but the
    // pending-poll effect below still drives refetches (refetchTick > 0).
    if (initial && refetchTick === 0) {
      if (initial.task) {
        document.title = `GlideComp - Field analysis: ${initial.task.name}`;
      }
      return;
    }
    let cancelled = false;
    (async () => {
      if (refetchTick === 0) setStatus("loading");
      try {
        // Through fetchWithRetry, not a bare fetch: this page is public and
        // SSR'd, and its "error" branch is a dead end — nothing re-fetches it
        // (the pending poll below only runs once status is "ready"). A dropped
        // request would otherwise turn a millisecond blip into a page that
        // stays broken until someone reloads by hand.
        const res = await fetchWithRetry(() =>
          fetch(analysisUrl, { credentials: "include" })
        );
        if (cancelled) return;
        // 404 = missing (or a test comp hidden from this visitor); 400 = an id
        // sqid that doesn't decode at all. Both mean "no such page", and both
        // are a dead id rather than a permissions verdict — the API never 401s
        // here (routes/field-analysis.ts). Worth telling apart, because the 404
        // page can rebuild the URL from its own slugs and "may not be published
        // yet" cannot. Same rule as loaders.ts and PilotScoreDetail.
        if (res.status === 404 || res.status === 400) {
          setStatus("notFound");
          return;
        }
        if (res.status === 401) {
          setStatus("forbidden");
          return;
        }
        if (res.status === 422) {
          const body = (await res.json()) as { error?: string };
          setData({
            task_id: taskId,
            comp_id: compId,
            classes: [],
            computed_at: null,
            stale: false,
            pending: false,
            error: body.error ?? "This task cannot be analysed",
          });
          setStatus("ready");
          return;
        }
        if (!res.ok) {
          setStatus("error");
          return;
        }
        setEtag(res.headers.get("ETag"));
        setData((await res.json()) as TaskFieldAnalysisData);
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initial` is stable for the life of the SSR'd URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId, taskId, analysisUrl, refetchTick]);

  // While the first-ever compute runs in the background (the cold path never
  // computes on the request), poll by refetching — the pending banner promises
  // "this page refreshes itself". The ScoreFreshness ETag poll can't cover
  // this: the pending response has no stored body to validate against.
  const pending = status === "ready" && data?.pending === true;
  usePollWhile(pending, () => setRefetchTick((t) => t + 1), refetchTick);

  // Task + comp names for the heading and breadcrumbs. Non-critical: the
  // analysis renders fine without them.
  useEffect(() => {
    if (!compId || !taskId) return;
    // SSR already seeded task + comp; skip the cosmetic fetch.
    if (initial) return;
    let cancelled = false;
    (async () => {
      try {
        const [taskRes, compRes] = await Promise.all([
          api.api.comp[":comp_id"].task[":task_id"].$get({
            param: { comp_id: compId, task_id: taskId },
          }),
          api.api.comp[":comp_id"].$get({ param: { comp_id: compId } }),
        ]);
        if (cancelled) return;
        if (taskRes.ok) {
          const t = (await taskRes.json()) as unknown as TaskDetailData;
          if (!cancelled) {
            setTask(t);
            document.title = `GlideComp - Field analysis: ${t.name}`;
          }
        }
        if (compRes.ok) {
          const c = (await compRes.json()) as unknown as CompDetailData;
          if (!cancelled) setComp(c);
        }
      } catch {
        // Names are cosmetic — leave them unset.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initial` is stable for the life of the SSR'd URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId, taskId]);

  const isAdmin = useAdminView(
    user != null && (comp?.admins.some((a) => a.email === user.email) ?? false)
  );

  const classes = data?.classes ?? [];
  const selectedClass =
    searchParams.get("class") && classes.some((c) => c.pilot_class === searchParams.get("class"))
      ? searchParams.get("class")!
      : (classes[0]?.pilot_class ?? "");
  const active = classes.find((c) => c.pilot_class === selectedClass);

  // The report with metric values converted to the viewer's preferred units
  // (display-only: ρ, percentiles and ranks are invariant under the linear
  // conversion). Everything below renders from this, never active.report.
  const units = useUnits();
  const report = useMemo(
    () => (active ? displayReport(active.report, units) : null),
    [active, units]
  );

  const styleClusters = useMemo(
    () => (report ? clusterPilotStyles(report) : null),
    [report]
  );

  // Families containing a top-3 metric open by default — the ranking above
  // has just told the reader those are the ones worth opening.
  const topFamilies = useMemo(() => {
    if (!report) return new Set<string>();
    return new Set(
      rankMetrics(report.metrics)
        .slice(0, 3)
        .map((r) => r.metric.family)
    );
  }, [report]);

  const grouped = useMemo(
    () => (report ? metricsByFamily(report.metrics) : new Map()),
    [report]
  );

  // The day family's charting series render in the weather section (composed
  // with the modelled charts on one axis), not in the family below.
  const dayMetrics: MetricReport[] = grouped.get("day") ?? [];
  // The section leads the report (conditions are the grounding for reading
  // every metric), so it renders whenever there is — or may yet be —
  // something to say: flown charts, notes, modelled charts, or an answer
  // still on its way.
  const hasWeatherSection =
    dayMetrics.some((m) => (m.extraSeries?.length ?? 0) > 0) ||
    weatherNotes.trim().length > 0 ||
    weatherPending ||
    weather.data?.weather != null;

  // Reconstructed thermals: absent on reports stored before v20 (served
  // stale while they revalidate) and on tasks where no thermal was shared
  // by two pilots — the section renders only when there is one to show.
  const hasThermalsSection = (report?.thermals?.shapes.length ?? 0) > 0;

  // Family expansion is page state (not Disclosure-internal) so the TOC can
  // open a collapsed family before scrolling to it. Until the user touches
  // one, expansion follows the top-3 default; a class switch resets to it.
  const [expandedOverride, setExpandedOverride] = useState<Set<string> | null>(null);
  useEffect(() => setExpandedOverride(null), [selectedClass]);

  // The separation ranking's selection lives here (not inside the ranking)
  // so the findings digest at the top of the page can pick a behaviour too.
  // Null = no pick yet, which the ranking resolves to its top row; a class
  // switch resets rather than carrying a stale metric id across metric sets.
  const [selectedBehaviour, setSelectedBehaviour] = useState<Key | null>(null);
  useEffect(() => setSelectedBehaviour(null), [selectedClass]);
  const expandedFamilies = expandedOverride ?? topFamilies;
  const expandFamily = (family: string, expanded: boolean) =>
    setExpandedOverride((prev) => {
      const next = new Set(prev ?? topFamilies);
      if (expanded) next.add(family);
      else next.delete(family);
      return next;
    });

  // TaskDebrief decides for itself whether it has anything to say, so it
  // tells us — see its onRenderedChange.
  const [hasDebrief, setHasDebrief] = useState(false);

  const tocItems = useMemo<PageTocItem[]>(() => {
    if (!active) return [];
    return [
      { id: "analysis-basis", label: "Analysis basis" },
      // TaskDebrief renders only when it has findings; a TOC entry pointing at
      // a missing id would scroll nowhere, so it is conditional on the same
      // data the section is.
      ...(hasDebrief ? [{ id: "debrief-heading", label: "Task debrief" }] : []),
      // Same conditionality as the debrief: only when the section rendered.
      ...(hasWeatherSection
        ? [{ id: "weather-heading", label: "What the weather did" }]
        : []),
      ...(hasThermalsSection
        ? [{ id: "thermals-heading", label: "The day's thermals" }]
        : []),
      // Rail labels are an index, not a copy of the headings — the two long
      // section names shorten to one fixation each; the headings themselves
      // are unchanged.
      { id: "separation-heading", label: "Behaviour ranking" },
      { id: "heatmap-heading", label: "Field at a glance" },
      { id: "clusters-heading", label: "Pilot style clusters" },
      { id: "families-heading", label: "The metrics in detail" },
      ...FAMILY_ORDER.filter((family) => (grouped.get(family) ?? []).length > 0).flatMap(
        (family): PageTocItem[] => [
          {
            id: familySectionId(family),
            label: FAMILY_LABELS[family],
            depth: 1,
            onBeforeScroll: () => expandFamily(family, true),
          },
          // The family's charts and rich tables (h4 blocks inside the
          // disclosure) — the deepest TOC level. Same expand-before-scroll,
          // since the block lives inside the family's drawer.
          ...(grouped.get(family) ?? []).filter(hasMetricBlock).map(
            (m: MetricReport): PageTocItem => ({
              id: metricBlockId(m.id),
              // The index register of the metric's name — the heading the
              // entry scrolls to keeps the full label.
              label: metricTocLabel(m),
              depth: 2,
              onBeforeScroll: () => expandFamily(family, true),
            })
          ),
        ]
      ),
      { id: "footnotes-heading", label: "Footnotes" },
      ...(active.excluded.length > 0
        ? [
            {
              id: EXCLUDED_PILOTS_ID,
              label: "Pilots not analysed",
              depth: 1 as const,
            },
          ]
        : []),
      { id: METHOD_NOTE_ID, label: "How the field is compared", depth: 1 },
      { id: "glossary-heading", label: "Metric glossary", depth: 1 },
    ];
  }, [active, grouped, topFamilies, hasDebrief, hasWeatherSection, hasThermalsSection]);

  async function handleRefresh() {
    if (!compId || !taskId) return;
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/field-analysis/refresh`,
        { method: "POST", credentials: "include" }
      );
      if (res.ok) {
        toast.success("Recomputing. Reload the page in a moment to see the new analysis.");
      } else {
        toast.error("Could not trigger a recompute");
      }
    } catch {
      toast.error("Could not trigger a recompute");
    } finally {
      setRefreshing(false);
    }
  }

  // Parented on the comp's field analysis, not the task page — this is one
  // chapter of that report, and "up" should return to the other chapters.
  const crumbs = underCompAnalysis(compId, comp?.name);
  const heading = task?.name ?? "Task";

  // Gate on `status` only, never on the user session: the content is public,
  // and useUser().loading is true throughout SSR + the first hydration render,
  // so gating on it would make the server emit this skeleton instead of the
  // seeded report.
  if (status === "loading") {
    return (
      <div className="font-hyperlegible">
        <Loading className="text-sm">Loading field analysis…</Loading>
      </div>
    );
  }

  if (status === "notFound") {
    return <NotFound title="Field analysis not found" />;
  }

  if (status === "forbidden") {
    return (
      <div className="font-hyperlegible">
        <Breadcrumbs items={crumbs} current={heading} />
        <h1 className="mt-3 text-2xl font-bold">{heading}</h1>
        <Alert className="mt-4">
          <AlertTitle>Not available</AlertTitle>
          <AlertDescription>
            This field analysis is not available. It is possibly part of a
            competition that is not published.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="font-hyperlegible">
        <Breadcrumbs items={crumbs} current={heading} />
        <h1 className="mt-3 text-2xl font-bold">{heading}</h1>
        <Alert className="mt-4">
          <AlertTitle>Could not load the field analysis</AlertTitle>
          <AlertDescription>Please try again in a moment.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    // With a TOC, wide screens get the docs layout: a narrow left rail
    // column and the content column, centred together. Below xl (and on the
    // TOC-less error/pending states) this is exactly the old single column.
    // `data-wide-page` is what lets the 87rem actually happen — Shell's
    // <main> is 6xl otherwise, which the rail would eat a fifth of.
    <div
      {...(tocItems.length > 0 ? { "data-wide-page": "" } : {})}
      // No gutter of its own: Shell's <main> already pays px-4 pt-6, and
      // doubling it cost a phone 32px of card width per side. The max-w
      // stays: with data-wide-page the main widens to 89rem at EVERY
      // viewport, and below xl (no rail grid) the content must hold to 6xl.
      className={cn(
        "mx-auto max-w-6xl font-hyperlegible",
        tocItems.length > 0 &&
          "xl:grid xl:max-w-[87rem] xl:grid-cols-[12rem_minmax(0,1fr)] xl:gap-10"
      )}
    >
      <PageToc items={tocItems} />
      <div className="min-w-0">
      <Breadcrumbs items={crumbs} current={heading} />

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{heading}</h1>
          <p className="text-sm text-muted-foreground">
            How the field flew this task, and which behaviours separated
            it.
          </p>
        </div>
        {/* Pure navigation/actions — meaningless on paper. */}
        <div className="flex items-center gap-2 print:hidden">
          {/* The trail now goes up to the comp report, so the task page — a
              genuine sibling relationship — gets an explicit link here. */}
          <LinkButton
            variant="outline"
            size="sm"
            href={taskPath(compId, comp?.name, taskId, task?.name)}
          >
            View task
          </LinkButton>
          {isAdmin ? (
            <Button
              variant="outline"
              size="sm"
              onPress={handleRefresh}
              isDisabled={refreshing}
            >
              {refreshing ? "Recomputing…" : "Recompute"}
            </Button>
          ) : null}
        </div>
      </div>

      {/* The overview block — four-second overview of the task analysis and
          single-tap navigation to every section, absorbing the findings digest
          as its centrepiece. Server-rendered with the rest of the page. */}
      {active && report ? (
        <OverviewBlock
          report={report}
          excluded={active.excluded}
          grouped={grouped}
          dayMetrics={dayMetrics}
          weather={weather.data?.weather ?? null}
          weatherPending={weatherPending}
          compTimezone={comp?.timezone ?? null}
          hasWeatherSection={hasWeatherSection}
          hasThermalsSection={hasThermalsSection}
          hasDebrief={hasDebrief}
          styleClusters={styleClusters}
          onPickMetric={setSelectedBehaviour}
        />
      ) : null}

      {/* What the field was asked to fly. Everything below is about how they
          flew it, and none of it means much without the shape in front of
          you — a long final glide into a headwind reads differently from a
          short one. Server-rendered with the rest of the page. */}
      {task?.xctsk && task.xctsk.turnpoints.length > 0 ? (
        <figure className="mt-4 rounded-lg border bg-muted/20 p-3">
          <div className="flex justify-center overflow-x-auto">
            <TaskDiagram task={task.xctsk} size="md" className="shrink-0" />
          </div>
          <figcaption className="mt-1 text-center text-xs text-muted-foreground">
            The optimised route — radii, leg distances and start times are on
            the task page.
          </figcaption>
        </figure>
      ) : null}

      {data?.error ? (
        <Alert className="mt-4">
          <AlertTitle>No analysis for this task</AlertTitle>
          <AlertDescription>{data.error}</AlertDescription>
        </Alert>
      ) : null}

      {data && !data.error ? (
        <ScoreFreshness
          computedAt={data.computed_at}
          stale={data.stale}
          pending={data.pending}
          timezone={comp?.timezone ?? null}
          etag={etag}
          pollUrl={analysisUrl}
          variant="analysis"
        />
      ) : null}

      {/* The provider starts here, not at the report body: the pilot picker
          sits on the control row beside the class select and pins into the
          same context every chart and table below reads. */}
      <PilotHighlightProvider>
      {classes.length > 1 || (active && report) ? (
        <div className="mt-4">
          {/* Controls, so print swaps them for a plain statement of which
              class this printout covers. (A pinned pilot needs no printed
              statement — the tint is on the rows either way.) */}
          <div className="flex flex-wrap items-center gap-3 print:hidden">
            {classes.length > 1 ? (
              <SimpleSelect
                ariaLabel="Pilot class"
                value={selectedClass}
                onChange={(value) => {
                  // In the URL so a link to a specific class is shareable.
                  const next = new URLSearchParams(searchParams);
                  next.set("class", value);
                  setSearchParams(next, { replace: true });
                }}
                options={classes.map((c) => ({
                  value: c.pilot_class,
                  label: c.pilot_class,
                }))}
              />
            ) : null}
            {/* Pin one pilot's highlight page-wide — the reader finding
                themselves in the field. URL-backed (?pilot=), like the
                class. */}
            {active && report ? <PilotPicker pilots={report.pilots} /> : null}
          </div>
          {classes.length > 1 ? (
            <p className="hidden text-sm print:block">
              Pilot class: <strong>{selectedClass}</strong>
            </p>
          ) : null}
        </div>
      ) : null}

      {active && report ? (
          <div className="mt-6 space-y-8">
            <div id="analysis-basis" className="scroll-mt-20">
              <AnalysisBasis
                basis={report.basis}
                excluded={active.excluded}
                timeZone={comp?.timezone ?? undefined}
                // Doors, only where the section actually rendered — an anchor
                // to a missing id would scroll nowhere.
                weatherHref={hasWeatherSection ? "#weather-heading" : undefined}
                thermalsHref={hasThermalsSection ? "#thermals-heading" : undefined}
              />
            </div>

            {compId && taskId ? (
              <TaskDebrief
                compId={compId}
                taskId={taskId}
                pilotClass={active.pilot_class}
                onRenderedChange={setHasDebrief}
              />
            ) : null}

            {/* The conditions BEFORE the findings, deliberately: which
                metrics matter depends on what the day was. On a windy day
                glide speed decides the task; on a weak day it's catching
                every climb. The reader needs this grounding before the
                separation ranking asks them to interpret anything. The panel
                stacks the flown (track-derived) and modelled charts on one
                time axis so the predicted day can be read against the day
                the field actually flew. */}
            {hasWeatherSection ? (
              <Card aria-labelledby="weather-heading" className="gap-3">
                <h2 id="weather-heading" className="scroll-mt-20 text-lg font-semibold">
                  What the weather did
                </h2>
                {/* The organizer's own account first — a human who was there
                    outranks a grid cell. */}
                <WeatherNotesBlock notes={weatherNotes} />
                <DayProfilePanel
                  metrics={dayMetrics}
                  compTimezone={comp?.timezone ?? null}
                  weather={weather.data?.weather ?? null}
                  weatherPending={weatherPending}
                />
              </Card>
            ) : null}

            {/* After the weather, before the metrics: the thermals ARE the
                day, reconstructed — where the lift sat, which way it leaned,
                which side worked. Grounding, like the weather section, for
                everything the metrics then claim about how pilots used it. */}
            {hasThermalsSection && report.thermals ? (
              <Card aria-labelledby="thermals-heading" className="gap-3">
                <h2 id="thermals-heading" className="scroll-mt-20 text-lg font-semibold">
                  The day's thermals
                </h2>
                <ThermalsPanel
                  thermals={report.thermals}
                  compTimezone={comp?.timezone ?? null}
                  weather={weather.data?.weather ?? null}
                  weatherPending={weatherPending}
                  replayHrefFor={(thermalId) =>
                    compId && taskId
                      ? `/replay?comp=${encodeURIComponent(compId)}&task=${encodeURIComponent(taskId)}&thermal=${thermalId}`
                      : null
                  }
                />
              </Card>
            ) : null}

            <Card aria-labelledby="separation-heading" className="gap-3">
              <h2
                id="separation-heading"
                className="flex items-center gap-1 scroll-mt-20 text-lg font-semibold"
              >
                Which behaviours went with better ranks
                {/* Why a strong-looking coefficient on ONE task is not yet a
                    finding — a caveat about the whole section, so it hangs off
                    the section's heading rather than a column. */}
                <Explain
                  label="One task is not a finding"
                 
                >
                  <OneDayCaveatNote
                    behaviourCount={rankMetrics(report.metrics).length}
                  />
                </Explain>
              </h2>
              <SeparationRanking
                metrics={report.metrics}
                report={report}
                selectedMetricId={selectedBehaviour}
                onSelectedMetricIdChange={setSelectedBehaviour}
              />
            </Card>

            <Card aria-labelledby="heatmap-heading" className="gap-3">
              <h2 id="heatmap-heading" className="scroll-mt-20 text-lg font-semibold">
                The whole field at a glance
              </h2>
              <PercentileHeatmap report={report} />
            </Card>

            <Card aria-labelledby="clusters-heading" className="gap-3">
              <h2 id="clusters-heading" className="scroll-mt-20 text-lg font-semibold">
                Pilot style clusters
              </h2>
              <StyleClusters report={report} clusters={styleClusters} />
              {/* Its own page rather than a section: it is an interactive
                  sheet with its own controls, and the reader picks a pilot and
                  a behaviour set rather than reading. */}
              <div className="flex flex-wrap items-center gap-2 border-t pt-3">
                <LinkButton
                  href={taskSimilarityPath(compId, comp?.name, taskId, task?.name)}
                  variant="outline"
                  size="sm"
                >
                  Who flew like me?
                </LinkButton>
                <span className="text-sm text-muted-foreground">
                  Pick a pilot and a set of behaviours, and see which other pilots
                  flew most like them.
                </span>
              </div>
            </Card>

            {/* In print, this whole section starts a fresh page and every
                family after the first breaks onto its own page — the families
                are the report's chapters. The first family stays under the
                heading so the heading is never orphaned at a page's end. */}
            <Card
              aria-labelledby="families-heading"
              className="gap-2 print:break-before-page"
            >
              <h2 id="families-heading" className="scroll-mt-20 text-lg font-semibold">
                The metrics in detail
              </h2>
              {FAMILY_ORDER.filter((family) => (grouped.get(family) ?? []).length > 0).map(
                (family, i) => (
                  <MetricFamilySection
                    key={family}
                    family={family}
                    familyLabel={FAMILY_LABELS[family]}
                    metrics={grouped.get(family) ?? []}
                    report={report}
                    compTimezone={comp?.timezone ?? null}
                    isExpanded={expandedFamilies.has(family)}
                    onExpandedChange={(expanded) => expandFamily(family, expanded)}
                    printBreakBefore={i > 0}
                  />
                )
              )}
            </Card>

            {/* Everything a reader consults once rather than reads: who
                couldn't be analysed, how the field is compared, and every
                ⓘ popover's method prose (which is also the printed form of
                those explanations). */}
            <Footnotes>
              {active.excluded.length > 0 ? (
                <ExcludedPilots excluded={active.excluded} />
              ) : null}
              {/* The static form of the ranking's column ⓘs — popovers are
                  print:hidden and cannot exist on paper. */}
              <HowToReadFootnote
                page="task"
                behaviourCount={rankMetrics(report.metrics).length}
              />
              <MethodNote gridStepSeconds={report.basis.gridStepSeconds} />
              <MetricGlossary entries={report.metrics} nested />
            </Footnotes>
          </div>
      ) : null}
      </PilotHighlightProvider>
      </div>
    </div>
  );
}
