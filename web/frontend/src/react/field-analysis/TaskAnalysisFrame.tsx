/**
 * The chrome every task field-analysis page wears: the trail, the heading, the
 * freshness line, the class select, and the four states the report can be in
 * before there is anything to show.
 *
 * The summary page and its five sub-pages are the same report seen from
 * different angles, so they must agree about all of that — a sub-page that
 * showed a different class, or forgot the stale-first freshness poll, would be
 * a different report wearing the same name. The body is a render prop, called
 * only once the selected class actually resolved, so no page repeats the
 * `active && report` guard.
 *
 * SSR-safe: `document` is touched only inside an effect.
 */
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button, LinkButton } from "@/react/rac/button";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { Loading } from "@/react/rac/progress";
import { SimpleSelect } from "@/react/rac/select";
import { NotFound } from "../components/NotFound";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import {
  FIELD_ANALYSIS_LABEL,
  underTask,
  underTaskAnalysis,
  type Crumb,
} from "../lib/crumbs";
import { compAnalysisPath } from "../lib/slug";
import { PilotHighlightProvider } from "./PilotHighlightContext";
import { PilotPicker } from "./PilotPicker";
import type { TaskReportBundle } from "./use-task-report";
import type { displayReport } from "./units";

export interface TaskAnalysisFrameProps {
  bundle: TaskReportBundle;
  /**
   * The sub-page this frame is wearing. Omit on the summary page, which is the
   * chapter itself: it takes the task as its parent crumb and "Field analysis"
   * as its heading, where a sub-page takes the chapter as its parent.
   */
  section?: { label: string; lede: string };
  /** Shown beside the class select. Only pages with per-pilot rows want it. */
  pilotPicker?: boolean;
  children: (ctx: {
    active: NonNullable<TaskReportBundle["active"]>;
    report: NonNullable<ReturnType<typeof displayReport>>;
  }) => React.ReactNode;
}

export function TaskAnalysisFrame({
  bundle,
  section,
  pilotPicker = false,
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

  const heading = section?.label ?? FIELD_ANALYSIS_LABEL;
  const lede =
    section?.lede ??
    `${task?.name ?? "This task"} — how the field flew it, and which behaviours separated them.`;

  useEffect(() => {
    if (!task) return;
    document.title = section
      ? `GlideComp - ${section.label}: ${task.name}`
      : `GlideComp - Field analysis: ${task.name}`;
  }, [task, section]);

  // A sub-page hangs off the chapter; the chapter hangs off the task. Both
  // trails come from lib/crumbs so they agree crumb for crumb.
  //
  // The chapter crumb carries the query on: which class is being read, and
  // which pilot is pinned, live in the URL and are the same choice on every
  // page of the report. Walking up out of a section and arriving back at the
  // default class would undo a choice the reader made two clicks ago. The
  // crumbs above it are other pages and take none of it.
  const crumbs = section
    ? withQuery(underTaskAnalysis(compId, comp?.name, taskId, task?.name), search)
    : underTask(compId, comp?.name, taskId, task?.name);

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

  if (status === "forbidden" || status === "error") {
    return (
      <div className="font-hyperlegible">
        <Breadcrumbs items={crumbs} current={heading} />
        <h1 className="mt-3 text-2xl font-bold">{heading}</h1>
        <Alert className="mt-4">
          <AlertTitle>
            {status === "forbidden"
              ? "Not available"
              : "Could not load the field analysis"}
          </AlertTitle>
          <AlertDescription>
            {status === "forbidden"
              ? "This field analysis is not available. It is possibly part of a competition that is not published."
              : "Please try again in a moment."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    // No gutter of its own: Shell's <main> already pays px-4 pt-6, and
    // doubling it cost a phone 32px of card width per side.
    <div className="mx-auto max-w-6xl min-w-0 font-hyperlegible">
      <Breadcrumbs items={crumbs} current={heading} />

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">{heading}</h1>
          <p className="text-sm text-muted-foreground">{lede}</p>
        </div>
        {/* Pure navigation/actions. */}
        <div className="flex items-center gap-2">
          {/* The trail goes up to the task, so the whole-comp report — the
              other half of this page's kinship — gets an explicit link here.
              It is also where the other tasks' chapters are listed. */}
          {section ? null : (
            <LinkButton
              variant="outline"
              size="sm"
              href={compAnalysisPath(compId, comp?.name)}
            >
              Comp field analysis
            </LinkButton>
          )}
          {isAdmin && !section ? (
            <Button
              variant="outline"
              size="sm"
              onPress={refresh}
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

      {/* The provider starts here, not at the body: the pilot picker sits on
          the control row beside the class select and pins into the same
          context every chart and table below reads. */}
      <PilotHighlightProvider>
        {classes.length > 1 || (pilotPicker && active && report) ? (
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {classes.length > 1 ? (
              <SimpleSelect
                ariaLabel="Pilot class"
                value={selectedClass}
                onChange={selectClass}
                options={classes.map((c) => ({
                  value: c.pilot_class,
                  label: c.pilot_class,
                }))}
              />
            ) : null}
            {/* Pin one pilot's highlight page-wide — the reader finding
                themselves in the field. URL-backed (?pilot=), like the
                class, so it survives the walk between these pages. */}
            {pilotPicker && active && report ? (
              <PilotPicker pilots={report.pilots} />
            ) : null}
          </div>
        ) : null}

        {active && report ? (
          <div className="mt-6 space-y-6">{children({ active, report })}</div>
        ) : null}
      </PilotHighlightProvider>
    </div>
  );
}

/** The trail's LAST crumb — the chapter — keeps the report's view state. */
function withQuery(crumbs: Crumb[], search: string): Crumb[] {
  if (!search) return crumbs;
  return crumbs.map((c, i) =>
    i === crumbs.length - 1 ? { ...c, to: `${c.to}?${search}` } : c
  );
}
