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
 * Lives at /comp/:compId/analysis/task/:taskId — a chapter of the comp's
 * field analysis, NOT a leaf of the task page, so the breadcrumb's parent is
 * that report and the H1 is the task's name (the section name is already in
 * the trail). The task page is a sibling link in the header.
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
import { Button, LinkButton } from "@/react/rac/button";
import { SimpleSelect } from "@/react/rac/select";
import { Alert, AlertDescription, AlertTitle } from "@/react/ui/alert";
import { underCompAnalysis } from "../lib/crumbs";
import { api } from "../../comp/api";
import { useAdminView, useUser } from "../lib/user";
import { toast } from "../lib/toast";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { SeparationRanking, rankMetrics } from "../field-analysis/SeparationRanking";
import {
  MetricFamilySection,
  familySectionId,
  hasMetricBlock,
  metricBlockId,
  metricsByFamily,
} from "../field-analysis/MetricFamilySection";
import { PageToc, type PageTocItem } from "../components/PageToc";
import { cn } from "../lib/utils";
import { AnalysisBasis } from "../field-analysis/AnalysisBasis";
import { TaskDebrief } from "../field-analysis/TaskDebrief";
import { MetricGlossary } from "../field-analysis/MetricGlossary";
import { PilotHighlightProvider } from "../field-analysis/PilotHighlightContext";
import { PercentileHeatmap } from "../field-analysis/charts/PercentileHeatmap";
import {
  FAMILY_ORDER,
  FAMILY_LABELS,
  type MetricReport,
  type TaskFieldAnalysisData,
} from "../field-analysis/types";
import type { CompDetailData, TaskDetailData } from "../comp/types";

export function TaskFieldAnalysis() {
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

  // refetchTick > 0 re-runs the fetch without flashing the loading state —
  // the pending-poll effect below bumps it until the background compute lands.
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    if (!compId || !taskId || !analysisUrl) return;
    let cancelled = false;
    (async () => {
      if (refetchTick === 0) setStatus("loading");
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
  }, [compId, taskId, analysisUrl, refetchTick]);

  // While the first-ever compute runs in the background (the cold path never
  // computes on the request), poll by refetching — the pending banner
  // promises "this page refreshes itself". Backs off 3s → 10s and gives up
  // after ~2 minutes (the banner stays; a manual reload picks up whatever is
  // newest). The ScoreFreshness ETag poll can't cover this: the pending
  // response has no stored body to validate against.
  const pending = status === "ready" && data?.pending === true;
  useEffect(() => {
    if (!pending) return;
    const startedAt = Date.now();
    let delay = 3_000;
    let timer: number | undefined;
    const schedule = () => {
      if (Date.now() - startedAt > 120_000) return;
      timer = window.setTimeout(() => {
        if (!document.hidden) setRefetchTick((t) => t + 1);
        else schedule();
      }, delay);
      delay = Math.min(delay * 1.5, 10_000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [pending, refetchTick]);

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

  // Family expansion is page state (not Disclosure-internal) so the TOC can
  // open a collapsed family before scrolling to it. Until the user touches
  // one, expansion follows the top-3 default; a class switch resets to it.
  const [expandedOverride, setExpandedOverride] = useState<Set<string> | null>(null);
  useEffect(() => setExpandedOverride(null), [selectedClass]);
  const expandedFamilies = expandedOverride ?? topFamilies;
  const expandFamily = (family: string, expanded: boolean) =>
    setExpandedOverride((prev) => {
      const next = new Set(prev ?? topFamilies);
      if (expanded) next.add(family);
      else next.delete(family);
      return next;
    });

  const tocItems = useMemo<PageTocItem[]>(() => {
    if (!active) return [];
    return [
      { id: "analysis-basis", label: "Analysis basis" },
      { id: "separation-heading", label: "What separated the field" },
      { id: "heatmap-heading", label: "The whole field at a glance" },
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
              label: m.label,
              depth: 2,
              onBeforeScroll: () => expandFamily(family, true),
            })
          ),
        ]
      ),
      { id: "glossary-heading", label: "Metric glossary" },
    ];
  }, [active, grouped, topFamilies]);

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

  // Parented on the comp's field analysis, not the task page — this is one
  // chapter of that report, and "up" should return to the other chapters.
  const crumbs = underCompAnalysis(compId, comp?.name);
  const heading = task?.name ?? "Task";

  if (userLoading || status === "loading") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 font-hyperlegible">
        <p className="text-sm text-muted-foreground">Loading field analysis…</p>
      </div>
    );
  }

  if (status === "forbidden") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 font-hyperlegible">
        <Breadcrumbs items={crumbs} current={heading} />
        <h1 className="mt-3 text-2xl font-bold">{heading}</h1>
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
      <div className="mx-auto max-w-6xl px-4 py-6 font-hyperlegible">
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
    <div
      className={cn(
        "mx-auto max-w-6xl px-4 py-6 font-hyperlegible",
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
            How the field actually flew this task, and which behaviours
            separated it.
          </p>
        </div>
        {/* Pure navigation/actions — meaningless on paper. */}
        <div className="flex items-center gap-2 print:hidden">
          <Badge variant="outline">Admins only</Badge>
          {/* The trail now goes up to the comp report, so the task page — a
              genuine sibling relationship — gets an explicit link here. */}
          <LinkButton
            variant="outline"
            size="sm"
            href={`/comp/${compId}/task/${taskId}`}
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

      {classes.length > 1 ? (
        <div className="mt-4">
          {/* The select is a control, so print swaps it for a plain
              statement of which class this printout covers. */}
          <div className="print:hidden">
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
          <p className="hidden text-sm print:block">
            Pilot class: <strong>{selectedClass}</strong>
          </p>
        </div>
      ) : null}

      {active ? (
        <PilotHighlightProvider>
          <div className="mt-6 space-y-8">
            <div id="analysis-basis" className="scroll-mt-20">
              <AnalysisBasis basis={active.report.basis} excluded={active.excluded} />
            </div>

            {compId && taskId ? (
              <TaskDebrief
                compId={compId}
                taskId={taskId}
                pilotClass={active.pilot_class}
              />
            ) : null}

            <section aria-labelledby="separation-heading" className="space-y-3">
              <h2 id="separation-heading" className="scroll-mt-20 text-lg font-semibold">
                What separated the field
              </h2>
              <SeparationRanking metrics={active.report.metrics} report={active.report} />
            </section>

            <section aria-labelledby="heatmap-heading" className="space-y-3">
              <h2 id="heatmap-heading" className="scroll-mt-20 text-lg font-semibold">
                The whole field at a glance
              </h2>
              <PercentileHeatmap report={active.report} />
            </section>

            {/* In print, this whole section starts a fresh page and every
                family after the first breaks onto its own page — the families
                are the report's chapters. The first family stays under the
                heading so the heading is never orphaned at a page's end. */}
            <section
              aria-labelledby="families-heading"
              className="space-y-2 print:break-before-page"
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
                    report={active.report}
                    compTimezone={comp?.timezone ?? null}
                    isExpanded={expandedFamilies.has(family)}
                    onExpandedChange={(expanded) => expandFamily(family, expanded)}
                    printBreakBefore={i > 0}
                  />
                )
              )}
            </section>

            {/* Every ⓘ popover's method prose, as one skimmable reference —
                and the printed form of those explanations. */}
            <MetricGlossary entries={active.report.metrics} />
          </div>
        </PilotHighlightProvider>
      ) : null}
      </div>
    </div>
  );
}
