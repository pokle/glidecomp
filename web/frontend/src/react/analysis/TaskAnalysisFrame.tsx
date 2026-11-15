/**
 * The chrome every task-analysis page wears: the bar (trail, title, the
 * pages beside this one, ⋯), the class select and the pilot highlight stuck
 * under it, the freshness line, and the four states the report can be in
 * before there is anything to show.
 *
 * The summary page and its six sections (and their leaf pages) are the same report seen from
 * different angles, so they must agree about all of that — a sub-page that
 * showed a different class, or forgot the stale-first freshness poll, would be
 * a different report wearing the same name. The body is a render prop, called
 * only once the selected class actually resolved, so no page repeats the
 * `active && report` guard.
 *
 * SSR-safe: `document` is touched only inside an effect.
 */
import { ChartColumnIcon, RefreshCwIcon } from "lucide-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Page, PageBar, type BarAction } from "@/react/rac/page-bar";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { Loading, Spinner } from "@/react/rac/progress";
import { SimpleSelect } from "@/react/rac/select";
import { cn } from "@/react/lib/utils";
import { NotFound } from "../components/NotFound";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import {
  COMP_ANALYSIS_LABEL,
  TASK_ANALYSIS_LABEL,
  underTask,
  underTaskAnalysis,
  type Crumb,
  type RelatedPages,
} from "../lib/crumbs";
import {
  compAnalysisPath,
  compUrlId,
  taskAnalysisSectionPath,
  taskSimilarityPath,
} from "../lib/slug";
import { PilotHighlightProvider } from "./PilotHighlightContext";
import { PILOT_PARAM, PilotPicker } from "./PilotPicker";
import { TASK_ANALYSIS_SECTIONS, type TaskAnalysisSectionSlug } from "./sections";
import { CLASS_PARAM, type TaskReportBundle } from "./use-task-report";
import type { displayReport } from "./units";

/** The similarity tool's name in a list of the report's pages. */
export const SIMILAR_PILOTS_LABEL = "Similar pilots";

export interface TaskAnalysisFrameProps {
  bundle: TaskReportBundle;
  /**
   * The sub-page this frame is wearing. Omit on the summary page, which is the
   * chapter itself: it takes the task as its parent crumb and "Task analysis"
   * as its title, where a sub-page takes the chapter as its parent. A section
   * of the report names its `slug`, and the title's menu then lists the
   * sections beside it; a leaf page (one metric, one thermal) does not.
   */
  section?: { label: string; lede: string; slug?: TaskAnalysisSectionSlug };
  /**
   * The section a page one level further down hangs off — "Metric details"
   * for one metric's full-size chart. It becomes the trail's last crumb, and
   * so where the bar's Back goes. It takes the report's view state with it,
   * as the chapter does for a section — or, given `search`, that query
   * instead: the thermal map knows which of its own parameters the Thermals
   * section reads.
   */
  parent?: { slug: TaskAnalysisSectionSlug; label: string; search?: string };
  /** Shown beside the class select. Only pages with per-pilot rows want it. */
  pilotPicker?: boolean;
  /**
   * A page that is one thing with the screen to itself (the thermal map): the
   * body gets the rest of the screen under the bar, and the page does not
   * scroll. It has no second layer: the class rides in the URL.
   */
  fill?: boolean;
  children: (ctx: {
    active: NonNullable<TaskReportBundle["active"]>;
    report: NonNullable<ReturnType<typeof displayReport>>;
  }) => React.ReactNode;
}

/** A section the day left nothing in: no box on the contents page, no row in the menu. */
export function isEmptySection(
  bundle: Pick<TaskReportBundle, "styleClusters" | "hasWeatherSection" | "hasThermalsSection">,
  slug: TaskAnalysisSectionSlug
): boolean {
  return (
    (slug === "style" && !bundle.styleClusters) ||
    (slug === "weather" && !bundle.hasWeatherSection) ||
    (slug === "thermals" && !bundle.hasThermalsSection)
  );
}

/**
 * The pages of one task's analysis, for the bar's title menu: its sections,
 * and the similarity tool where the contents page lists it (ahead of the
 * method note). With `current` they are drawn BESIDE the page that is open;
 * without it, UNDER the contents page.
 *
 * `search` is the report's view state (the class, the pinned pilot), which
 * goes with the reader from page to page.
 */
export function taskAnalysisPages(
  compId: string | undefined,
  compName: string | null | undefined,
  taskId: string | undefined,
  taskName: string | null | undefined,
  search: string,
  current?: TaskAnalysisSectionSlug | "similar",
  isEmpty: (slug: TaskAnalysisSectionSlug) => boolean = () => false
): RelatedPages | undefined {
  if (!compId || !taskId) return undefined;
  const query = search ? `?${search}` : "";
  const items: RelatedPages["items"] = [];
  const similar = {
    label: SIMILAR_PILOTS_LABEL,
    to: taskSimilarityPath(compId, compName, taskId, taskName) + query,
    current: current === "similar",
  };
  let placed = false;
  for (const s of TASK_ANALYSIS_SECTIONS) {
    if (s.slug !== current && isEmpty(s.slug)) continue;
    // Ahead of the method note, which stays last: it is consulted once.
    if (s.slug === "method") {
      items.push(similar);
      placed = true;
    }
    items.push({
      label: s.label,
      to: taskAnalysisSectionPath(compId, compName, taskId, taskName, s.slug) + query,
      current: s.slug === current,
    });
  }
  if (!placed) items.push(similar);
  return { as: current ? "siblings" : "children", items };
}

export function TaskAnalysisFrame({
  bundle,
  section,
  parent,
  pilotPicker = false,
  fill = false,
  children,
}: TaskAnalysisFrameProps) {
  const {
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
    isAdmin,
    refreshing,
    refresh,
  } = bundle;

  // The view state that belongs to the whole report rather than to one page.
  const [searchParams] = useSearchParams();
  const search = searchParams.toString();

  const heading = section?.label ?? TASK_ANALYSIS_LABEL;
  const lede =
    section?.lede ??
    `${task?.name ?? "This task"} — how the field flew it, and which behaviours separated them.`;

  useEffect(() => {
    if (!task) return;
    document.title = section
      ? `GlideComp - ${section.label}: ${task.name}`
      : `GlideComp - Task analysis: ${task.name}`;
  }, [task, section]);

  // A sub-page hangs off the chapter; the chapter hangs off the task. Both
  // trails come from lib/crumbs so they agree crumb for crumb.
  //
  // Every crumb from the chapter down carries the report's view state: which
  // class is being read, and which pilot is pinned, live in the URL and are
  // the same choice on every page of the report. Walking up out of a section
  // and arriving back at the default class would undo a choice the reader
  // made two clicks ago — and a leaf page (one metric's chart, one thermal's
  // map) used to put it only on its parent crumb, so the chapter crumb above
  // that dropped it. The parent crumb also carries what the parent section
  // reads (its own `search`, or this page's query). The crumbs above the
  // chapter are other pages and take none of it.
  const viewState = reportViewState(searchParams);
  const chapterCrumbs = withQuery(
    underTaskAnalysis(compId, comp?.name, taskId, task?.name),
    viewState
  );
  const crumbs = !section
    ? underTask(compId, comp?.name, taskId, task?.name)
    : !parent
      ? chapterCrumbs
      : [
          ...chapterCrumbs,
          withQuery(
            [
              {
                label: parent.label,
                to:
                  compId && taskId
                    ? taskAnalysisSectionPath(compId, comp?.name, taskId, task?.name, parent.slug)
                    : "/comp",
              },
            ],
            parent.search ?? search
          )[0],
        ];

  // The title's menu: the contents page lists its sections under it, a
  // section lists them beside it. This is the only section navigation there
  // is; the boxes on the contents page are information. A leaf page hangs off
  // one section and lists none.
  const related =
    parent || (section && !section.slug)
      ? undefined
      : taskAnalysisPages(
          compId,
          comp?.name,
          taskId,
          task?.name,
          viewState,
          section?.slug,
          (slug) => isEmptySection(bundle, slug)
        );

  // The trail goes up to the task, so the whole-comp report — the other half
  // of this page's kinship, and where the other tasks' chapters are listed —
  // is the first row of ⋯. Recompute is the organiser's.
  const actions: BarAction[] = [];
  if (compId) {
    actions.push({
      id: "comp-analysis",
      label: COMP_ANALYSIS_LABEL,
      icon: ChartColumnIcon,
      to: compAnalysisPath(compUrlId(comp, compId), comp?.name),
    });
  }
  if (isAdmin) {
    actions.push({
      id: "recompute",
      icon: RefreshCwIcon,
      label: "Recompute",
      group: true,
      onAction: refresh,
      disabled: refreshing,
    });
  }

  if (status === "notFound") {
    return <NotFound title="Task analysis not found" />;
  }

  // Gate on `status` only, never on the user session: the content is public,
  // and useUser().loading is true throughout SSR + the first hydration render,
  // so gating on it would make the server emit a skeleton instead of the
  // seeded report.
  const ready = status !== "loading" && status !== "forbidden" && status !== "error";

  // The second layer: which class is being read, and the pilot pinned into
  // every chart and table below. Both are view state of the whole report
  // (URL-backed, `?class=` and `?pilot=`), so they stay in reach as it scrolls.
  const showClasses = classes.length > 1;
  const below =
    ready && !fill && (showClasses || (pilotPicker && active && report)) ? (
      <div className="flex items-center gap-2">
        {showClasses ? (
          <SimpleSelect
            ariaLabel="Pilot class"
            value={selectedClass}
            onChange={selectClass}
            options={classes.map((c) => ({
              value: c.pilot_class,
              label: c.pilot_class,
            }))}
            className="shrink-0"
          />
        ) : null}
        {/* Pin one pilot's highlight page-wide — the reader finding
            themselves in the field. */}
        {pilotPicker && active && report ? <PilotPicker pilots={report.pilots} /> : null}
      </div>
    ) : undefined;

  return (
    // The provider is outside the page, not at the body: the pilot picker is
    // in the bar's second layer and pins into the same context every chart
    // and table below reads.
    <PilotHighlightProvider>
      <Page
        width="wide"
        fill={fill}
        // A filled page has no gutter of its own; this one keeps the app's.
        className={cn("min-w-0 font-hyperlegible", fill && "px-gutter-safe")}
        bar={
          <PageBar
            title={heading}
            trail={crumbs}
            related={related}
            actions={actions}
            status={refreshing ? <Spinner label="Recomputing" /> : undefined}
            below={below}
          />
        }
      >
        {status === "loading" ? (
          <Loading className="text-sm">Loading the task analysis…</Loading>
        ) : status === "forbidden" || status === "error" ? (
          <Alert>
            <AlertTitle>
              {status === "forbidden" ? "Not available" : "Could not load the task analysis"}
            </AlertTitle>
            <AlertDescription>
              {status === "forbidden"
                ? "This task analysis is not available. It is possibly part of a competition that is not published."
                : "Please try again in a moment."}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            {lede ? <p className="text-sm text-muted-foreground">{lede}</p> : null}

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

            {active && report ? (
              <div className={fill ? "mt-2 flex min-h-0 flex-1 flex-col" : "mt-6 space-y-6"}>
                {children({ active, report })}
              </div>
            ) : null}
          </>
        )}
      </Page>
    </PilotHighlightProvider>
  );
}

/** The report's view state alone — the class and the pinned pilot — as a query. */
export function reportViewState(params: URLSearchParams): string {
  const kept = new URLSearchParams();
  for (const key of [CLASS_PARAM, PILOT_PARAM]) {
    const value = params.get(key);
    if (value !== null) kept.set(key, value);
  }
  return kept.toString();
}

/** The trail's LAST crumb, with `search` on it. */
function withQuery(crumbs: Crumb[], search: string): Crumb[] {
  if (!search) return crumbs;
  return crumbs.map((c, i) =>
    i === crumbs.length - 1 ? { ...c, to: `${c.to}?${search}` } : c
  );
}
