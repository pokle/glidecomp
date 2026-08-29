/**
 * One task's field-analysis report, fetched once and shared by every page that
 * shows a piece of it.
 *
 * The summary page (pages/TaskFieldAnalysis.tsx) and each of its sub-pages
 * (pages/TaskAnalysisSection.tsx) need exactly the same three requests, the
 * same class selection, the same unit conversion and the same pending poll.
 * They used to be one page, so all of it lived inline; splitting the page
 * without extracting this first would have meant five copies of the trickiest
 * fetch logic in the app — the retry rule, the 422 branch, the SSR seed.
 *
 * SSR-safe: no browser globals at module scope, and the first render is
 * seeded from useInitialData so the server and the client agree.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../../comp/api";
import { fetchWithRetry, type CompDetailData, type TaskDetailData } from "../comp/types";
import { useInitialData } from "../lib/initial-data";
import { toast } from "../lib/toast";
import { useUnits } from "../lib/units";
import { useAdminView, useUser } from "../lib/user";
import { idFromSegment } from "../lib/slug";
import { usePollWhile } from "../lib/use-poll-while";
import type { TaskFieldAnalysisLoaderData } from "../loaders";
import { useTaskWeather } from "../weather/use-task-weather";
import { metricsByFamily } from "./MetricFamilySection";
import {
  clusterPilotStyles,
  type MetricReport,
  type TaskFieldAnalysisData,
} from "./types";
import { displayReport } from "./units";

export type TaskReportStatus =
  | "loading"
  | "ready"
  | "notFound"
  | "forbidden"
  | "error";

export interface TaskReportBundle {
  compId: string;
  taskId: string;
  status: TaskReportStatus;
  /** The stored report body, including its `error` and `pending` branches. */
  data: TaskFieldAnalysisData | null;
  etag: string | null;
  /** The report endpoint, for ScoreFreshness's ETag poll. Null without ids. */
  analysisUrl: string | null;
  comp: CompDetailData | null;
  task: TaskDetailData | null;
  classes: TaskFieldAnalysisData["classes"];
  selectedClass: string;
  selectClass: (pilotClass: string) => void;
  /** The selected class's slice of the report — null while loading. */
  active: TaskFieldAnalysisData["classes"][number] | undefined;
  /** `active.report` with metric values in the viewer's units. Render from
   *  this, never from active.report. */
  report: ReturnType<typeof displayReport> | null;
  grouped: Map<string, MetricReport[]>;
  /** The day family. Its series render on the day page's shared time axis,
   *  composed with the modelled charts, rather than in its own family block. */
  dayMetrics: MetricReport[];
  styleClusters: ReturnType<typeof clusterPilotStyles> | null;
  weather: ReturnType<typeof useTaskWeather>;
  weatherNotes: string;
  weatherPending: boolean;
  /** Whether the day page has — or may yet have — anything to say. */
  hasWeatherSection: boolean;
  /** Reconstructed thermals: absent on reports stored before v20, and on
   *  tasks where no thermal was shared by two pilots. */
  hasThermalsSection: boolean;
  isAdmin: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
}

export function useTaskFieldAnalysis(): TaskReportBundle {
  const { compId: compParam, taskId: taskParam } = useParams<{
    compId: string;
    taskId: string;
  }>();
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
  const [status, setStatus] = useState<TaskReportStatus>(
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
    if (initial && refetchTick === 0) return;
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

  // Task + comp names for the headings and breadcrumbs. Non-critical: every
  // page here renders fine without them.
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
          if (!cancelled) setTask(t);
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
  const classParam = searchParams.get("class");
  const selectedClass =
    classParam && classes.some((c) => c.pilot_class === classParam)
      ? classParam
      : (classes[0]?.pilot_class ?? "");
  const active = classes.find((c) => c.pilot_class === selectedClass);

  // In the URL so a link to a specific class is shareable, and so it survives
  // the walk out to a sub-page and back.
  const selectClass = (pilotClass: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("class", pilotClass);
    setSearchParams(next, { replace: true });
  };

  // The report with metric values converted to the viewer's preferred units
  // (display-only: ρ, percentiles and ranks are invariant under the linear
  // conversion). Everything renders from this, never active.report.
  const units = useUnits();
  const report = useMemo(
    () => (active ? displayReport(active.report, units) : null),
    [active, units]
  );

  const styleClusters = useMemo(
    () => (report ? clusterPilotStyles(report) : null),
    [report]
  );

  const grouped = useMemo(
    () => (report ? metricsByFamily(report.metrics) : new Map<string, MetricReport[]>()),
    [report]
  );

  const dayMetrics: MetricReport[] = grouped.get("day") ?? [];
  const hasWeatherSection =
    dayMetrics.some((m) => (m.extraSeries?.length ?? 0) > 0) ||
    weatherNotes.trim().length > 0 ||
    weatherPending ||
    weather.data?.weather != null;
  const hasThermalsSection = (report?.thermals?.shapes.length ?? 0) > 0;

  async function refresh() {
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

  return {
    compId,
    taskId,
    status,
    data,
    etag,
    analysisUrl,
    comp,
    task,
    classes,
    selectedClass,
    selectClass,
    active,
    report,
    grouped,
    dayMetrics,
    styleClusters,
    weather,
    weatherNotes,
    weatherPending,
    hasWeatherSection,
    hasThermalsSection,
    isAdmin,
    refreshing,
    refresh,
  };
}
