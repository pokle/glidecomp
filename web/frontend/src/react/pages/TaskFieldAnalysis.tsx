/**
 * Task field analysis — the behavioural metrics for one task's field, and
 * which of them actually separated the leaderboard.
 *
 * ADMIN-ONLY while the metrics settle (see canViewFieldAnalysis in the
 * worker's routes/field-analysis.ts; the API 404s for everyone else, and
 * this page reflects that rather than second-guessing it).
 *
 * Its own page rather than a section on the task page: it is a long,
 * exploratory read that shouldn't compete with the official standings.
 *
 * NOT SSR'd — admin-gated and private, so functions/comp/[[path]].ts falls
 * through to the plain SPA shell for this URL (with noindex). Everything
 * here fetches on mount.
 *
 * Presentation order mirrors the CLI's text report deliberately: the
 * separation ranking FIRST, then per-family detail. Which metrics have
 * explanatory power is the finding; the per-pilot numbers are the evidence.
 */
import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Badge } from "@/react/rac/badge";
import { Button } from "@/react/rac/button";
import { SimpleSelect } from "@/react/rac/select";
import { RacRouterProvider } from "@/react/rac/router";
import { Alert, AlertDescription, AlertTitle } from "@/react/ui/alert";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { toast } from "../lib/toast";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { SeparationRanking, rankMetrics } from "../field-analysis/SeparationRanking";
import {
  MetricFamilySection,
  metricsByFamily,
} from "../field-analysis/MetricFamilySection";
import { AnalysisBasis } from "../field-analysis/AnalysisBasis";
import {
  FAMILY_ORDER,
  FAMILY_LABELS,
  type TaskFieldAnalysisData,
} from "../field-analysis/types";
import type { CompDetailData, TaskDetailData } from "../comp/types";

export function TaskFieldAnalysis() {
  return (
    <RacRouterProvider>
      <TaskFieldAnalysisContent />
    </RacRouterProvider>
  );
}

function TaskFieldAnalysisContent() {
  const { compId, taskId } = useParams<{ compId: string; taskId: string }>();
  const { user, loading: userLoading } = useUser();
  const [searchParams, setSearchParams] = useSearchParams();

  const [data, setData] = useState<TaskFieldAnalysisData | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [task, setTask] = useState<TaskDetailData | null>(null);
  const [comp, setComp] = useState<CompDetailData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "forbidden" | "error">(
    "loading"
  );
  const [refreshing, setRefreshing] = useState(false);

  const analysisUrl =
    compId && taskId
      ? `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/field-analysis`
      : null;

  useEffect(() => {
    if (!compId || !taskId || !analysisUrl) return;
    let cancelled = false;
    (async () => {
      setStatus("loading");
      try {
        const res = await fetch(analysisUrl, { credentials: "include" });
        if (cancelled) return;
        if (res.status === 404 || res.status === 401) {
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
  }, [compId, taskId, analysisUrl]);

  // Task + comp names for the heading and breadcrumbs. Non-critical: the
  // analysis renders fine without them.
  useEffect(() => {
    if (!compId || !taskId) return;
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

  // Families containing a top-3 metric open by default — the ranking above
  // has just told the reader those are the ones worth opening.
  const topFamilies = useMemo(() => {
    if (!active) return new Set<string>();
    return new Set(
      rankMetrics(active.report.metrics)
        .slice(0, 3)
        .map((r) => r.metric.family)
    );
  }, [active]);

  const grouped = useMemo(
    () => (active ? metricsByFamily(active.report.metrics) : new Map()),
    [active]
  );

  async function handleRefresh() {
    if (!compId || !taskId) return;
    setRefreshing(true);
    try {
      const res = await fetch(
        `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/field-analysis/refresh`,
        { method: "POST", credentials: "include" }
      );
      if (res.ok) {
        toast.success("Recomputing — reload in a moment to see the new analysis");
      } else {
        toast.error("Could not trigger a recompute");
      }
    } catch {
      toast.error("Could not trigger a recompute");
    } finally {
      setRefreshing(false);
    }
  }

  const crumbs = [
    { label: "Competitions", to: "/comp" },
    { label: comp?.name ?? "Competition", to: `/comp/${compId}` },
    { label: task?.name ?? "Task", to: `/comp/${compId}/task/${taskId}` },
  ];

  if (userLoading || status === "loading") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <p className="text-sm text-muted-foreground">Loading field analysis…</p>
      </div>
    );
  }

  if (status === "forbidden") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <Breadcrumbs items={crumbs} current="Field analysis" />
        <h1 className="mt-3 text-2xl font-bold">Field analysis</h1>
        <Alert className="mt-4">
          <AlertTitle>Not available</AlertTitle>
          <AlertDescription>
            {user
              ? "Field analysis is currently limited to competition admins while the metrics are being validated."
              : "Sign in as a competition admin to view the field analysis."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6">
        <Breadcrumbs items={crumbs} current="Field analysis" />
        <h1 className="mt-3 text-2xl font-bold">Field analysis</h1>
        <Alert className="mt-4">
          <AlertTitle>Could not load the field analysis</AlertTitle>
          <AlertDescription>Please try again in a moment.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <Breadcrumbs items={crumbs} current="Field analysis" />

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Field analysis</h1>
          <p className="text-sm text-muted-foreground">
            {task?.name ?? "This task"} — how the field actually flew, and which
            behaviours separated it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">Admins only</Badge>
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
          noun="Analysis"
          verb="recomputed"
        />
      ) : null}

      {classes.length > 1 ? (
        <div className="mt-4">
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
        </div>
      ) : null}

      {active ? (
        <div className="mt-6 space-y-8">
          <AnalysisBasis basis={active.report.basis} excluded={active.excluded} />

          <section aria-labelledby="separation-heading" className="space-y-3">
            <h2 id="separation-heading" className="text-lg font-semibold">
              What separated the field
            </h2>
            <SeparationRanking metrics={active.report.metrics} />
          </section>

          <section aria-labelledby="families-heading" className="space-y-2">
            <h2 id="families-heading" className="text-lg font-semibold">
              The metrics in detail
            </h2>
            {FAMILY_ORDER.map((family) => {
              const metrics = grouped.get(family) ?? [];
              return (
                <MetricFamilySection
                  key={family}
                  family={family}
                  familyLabel={FAMILY_LABELS[family]}
                  metrics={metrics}
                  report={active.report}
                  defaultExpanded={topFamilies.has(family)}
                />
              );
            })}
          </section>
        </div>
      ) : null}
    </div>
  );
}
