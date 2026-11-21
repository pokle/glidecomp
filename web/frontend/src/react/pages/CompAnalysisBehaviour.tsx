/**
 * One behaviour across a competition's tasks.
 *
 * /comp/:compId/analysis/behaviour/:metric — what a row of the comp analysis
 * ranking opens. The row draws every task as a badge on one track, and
 * badges that agree overlap; this page is where each task's figure is read
 * exactly, and each links to that task's own chart of the behaviour.
 *
 * A PAGE with its own URL, never an overlay (docs/interaction-guide.md, "No full-screen
 * overlays"). Nothing is handed over from the page underneath: the report
 * comes from use-comp-analysis.ts like the comp analysis itself (seeded by
 * SSR on a hard load), the behaviour is named by the URL and the class rides
 * in the query, so a reload and a shared link open the same page.
 *
 * PUBLIC and SSR'd through the comp analysis loader, and always noindexed:
 * it is a closer look at one row of a page the index already holds.
 */
import { Link as AriaLink } from "react-aria-components";
import { useParams, useSearchParams } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { Card, cardSurface } from "@/react/rac/card";
import { RowContent } from "@/react/rac/grid-list";
import { DotMeterAxis, MultiDotMeter } from "@/react/rac/meter";
import { navRowClass } from "@/react/rac/nav-list";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { cn } from "@/react/lib/utils";
import { NotFound } from "../components/NotFound";
import { ConsistencyChip } from "../analysis/ConsistencyChip";
import { taskInformative, taskReadings, taskReadingsWords } from "../analysis/comp-behaviour";
import { formatShownRho, verdictWords } from "../analysis/units";
import { useCompAnalysis } from "../analysis/use-comp-analysis";
import { COMP_ANALYSIS_LABEL, underCompAnalysis } from "../lib/crumbs";
import {
  compAnalysisBehaviourPath,
  compUrlId,
  metricSegment,
  taskAnalysisMetricPath,
} from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";

export function CompAnalysisBehaviour() {
  const { metric: segment } = useParams<{ metric: string }>();
  const [searchParams] = useSearchParams();
  const { compId, data, comp, status, canonicalName } = useCompAnalysis();

  const classes = data?.classes ?? [];
  const wanted = searchParams.get("class");
  const active =
    classes.find((c) => c.pilot_class === wanted) ??
    // No class named: the first that carries the behaviour.
    classes.find((c) => c.aggregate.metrics.some((m) => metricSegment(m.id) === segment)) ??
    classes[0];
  const metric = active?.aggregate.metrics.find((m) => metricSegment(m.id) === segment) ?? null;
  const urlCompId = compUrlId(comp, compId);

  // The path only: useCanonicalPath keeps the query the URL already has, and
  // a `?class=` handed to it as well is appended on every render.
  useCanonicalPath(
    canonicalName && metric
      ? compAnalysisBehaviourPath(urlCompId, canonicalName, metric.id)
      : null
  );

  if (status === "notFound") return <NotFound title="Comp analysis not found" />;
  // A report in hand with no such behaviour: a dead URL, not an empty page.
  if (status === "ready" && classes.length > 0 && !metric) {
    return <NotFound title="Behaviour not found" />;
  }

  const bar = (
    <PageBar
      title={metric?.label ?? COMP_ANALYSIS_LABEL}
      trail={underCompAnalysis(urlCompId, canonicalName)}
    />
  );

  if (status !== "ready" || !active || !metric) {
    return (
      <Page width="wide" bar={bar} className="font-hyperlegible">
        {status === "loading" || status === "ready" ? (
          <Loading className="text-sm">Loading the comp analysis…</Loading>
        ) : (
          <Alert>
            <AlertTitle>
              {status === "forbidden" ? "Not available" : "Could not load the comp analysis"}
            </AlertTitle>
            <AlertDescription>
              {status === "error"
                ? "Please try again in a moment."
                : "This comp analysis is not available. The competition is possibly not published yet."}
            </AlertDescription>
          </Alert>
        )}
      </Page>
    );
  }

  const { aggregate } = active;
  const taskLabels = aggregate.taskLabels;
  const fieldSize = aggregate.pilots.length;
  // The class's own tasks, parallel to its labels; an older body has none,
  // and its rows then name the task by label alone and link nowhere.
  const byId = new Map(data!.tasks.map((t) => [t.task_id, t]));
  const tasks = (active.tasks ?? []).map((t) => byId.get(t.task_id));

  return (
    <Page width="wide" bar={bar} className="font-hyperlegible">
      <p className="text-sm text-muted-foreground">
        {canonicalName ?? "This competition"}
        {classes.length > 1 ? `, ${active.pilot_class}` : ""} — this behaviour on each task.
      </p>

      <div className="mt-4 flex flex-col gap-6">
        <Card className="gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ConsistencyChip metric={metric} />
            {metric.compRho ? (
              <span className="text-sm text-muted-foreground">
                Against comp scores: {verdictWords(metric.compRho.verdict)}, ρ{" "}
                <span className="tabular-nums">{formatShownRho(metric.compRho.rho)}</span>,{" "}
                {metric.compRho.n} of {fieldSize} pilots
              </span>
            ) : null}
          </div>
          <div>
            <DotMeterAxis lower="less of it did well" higher="more of it did well" />
            <MultiDotMeter
              readings={taskReadings(metric, taskLabels)}
              label={`${metric.label}: Spearman correlation with doing well, on each task`}
              valueLabel={taskReadingsWords(metric, taskLabels)}
            />
          </div>
        </Card>

        <section aria-labelledby="by-task-heading">
          <h2 id="by-task-heading" className="mb-2 text-lg font-semibold">
            Task by task
          </h2>
          <ul
            aria-label="This behaviour on each task"
            className={cn(cardSurface, "divide-y divide-border overflow-hidden")}
          >
            {metric.perTaskRho.map((rho, i) => {
              const label = taskLabels[i] ?? `Task ${i + 1}`;
              const task = tasks[i];
              const c = metric.perTaskCorrelation[i];
              const leading = (
                <span className="w-10 shrink-0 font-medium tabular-nums text-muted-foreground">
                  {label}
                </span>
              );
              const title = task?.task_name ?? label;
              if (rho === null || !c) {
                // Nothing behind this row, so it claims nothing: no link,
                // no chevron.
                return (
                  <li key={label} className={cn(navRowClass, "min-h-14")}>
                    <RowContent leading={leading} title={title} detail="not measured on this task" />
                  </li>
                );
              }
              const content = (
                <RowContent
                  leading={leading}
                  title={title}
                  detail={`${
                    taskInformative(metric, i) === false ? "could be chance · " : ""
                  }${c.n} pilots`}
                  action={
                    <span className="shrink-0 text-right font-semibold tabular-nums">
                      {formatShownRho(rho)}
                    </span>
                  }
                  chevron={!!task}
                />
              );
              return (
                <li key={label}>
                  {task ? (
                    <AriaLink
                      href={taskAnalysisMetricPath(
                        urlCompId,
                        canonicalName,
                        task.task_id,
                        task.task_name,
                        metric.id
                      )}
                      className={cn(navRowClass, "min-h-14")}
                    >
                      {content}
                    </AriaLink>
                  ) : (
                    <div className={cn(navRowClass, "min-h-14")}>{content}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </Page>
  );
}
