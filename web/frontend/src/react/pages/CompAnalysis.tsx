/**
 * Comp analysis — the same separation question asked across
 * every task, which is the only way to tell a real signal from one day's
 * weather.
 *
 * A metric that correlates strongly on one task may just have suited that
 * day's conditions. The per-task ρ row is therefore the substance here: a
 * metric that holds its sign and magnitude across tasks is telling you
 * something about flying; one that swings is telling you about the day.
 *
 * Public and SSR'd, same as the task page (loadCompAnalysis +
 * functions/comp/[[path]].ts): the server seeds the most-recently-cached
 * report, or a pending placeholder while the first compute runs.
 */
import { compAnalysisRows, hasAnyCorrelation } from "../analysis/types";
import { formatShownRho, verdictWords } from "../analysis/units";
import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { Link as AriaLink } from "react-aria-components";
import { ChevronRightIcon } from "lucide-react";
import { useCompAnalysis } from "../analysis/use-comp-analysis";
import { taskReadings, taskReadingsWords } from "../analysis/comp-behaviour";
import { openedHereFrom } from "../lib/leave";
import { NotFound } from "../components/NotFound";
import { Page, PageBar } from "@/react/rac/page-bar";
import { Loading } from "@/react/rac/progress";
import { ClassPicker } from "../analysis/ClassPicker";
import { TaskAnalysisList, type TaskAnalysisLink } from "../analysis/TaskAnalysisList";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { DotMeterAxis, MultiDotMeter } from "@/react/rac/meter";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { cn } from "@/react/lib/utils";
import { Card } from "@/react/rac/card";
import { Explain } from "@/react/rac/explain";
import { VerdictBadge } from "../analysis/SeparationRanking";
import {
  AcrossTasksNote,
  AgainstCompScoresNote,
  DayToDayNote,
  HowToReadFootnote,
  OutcomeChecksNote,
  VerdictLegend,
} from "../analysis/ReadingNotes";
import { ConsistencyChip } from "../analysis/ConsistencyChip";
import { ConsistencyMap } from "../analysis/charts/ConsistencyMap";
import { MetricGlossary, type GlossaryEntry } from "../analysis/MetricGlossary";
import { underComp, compPages, COMP_ANALYSIS_LABEL } from "../lib/crumbs";
import {
  compUrlId,
  compAnalysisBehaviourPath,
  compAnalysisPath,
  taskAnalysisPath,
} from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { usePollWhile } from "../lib/use-poll-while";
import { api } from "../../comp/api";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { useInitialData } from "../lib/initial-data";
import type { CompAnalysisLoaderData } from "../loaders";
import {
  ALL_METRICS,
  type CompAnalysisData,
  type CompMetricAggregate,
} from "../analysis/types";
import { useAdminView } from "../lib/user";
import { fetchWithRetry, type CompDetailData } from "../comp/types";

export function CompAnalysis() {
  const { compId, data, etag, comp, status, analysisUrl, canonicalName } = useCompAnalysis();
  const [searchParams, setSearchParams] = useSearchParams();

  // Settle the address bar on the canonical `${slug}-${id}` once a name is
  // known (the analysis body carries comp_name even before the comp fetch).
  useCanonicalPath(
    canonicalName ? compAnalysisPath(compUrlId(comp, compId), canonicalName) : null
  );

  const classes = data?.classes ?? [];
  const selectedClass =
    searchParams.get("class") &&
    classes.some((c) => c.pilot_class === searchParams.get("class"))
      ? searchParams.get("class")!
      : (classes[0]?.pilot_class ?? "");
  const active = classes.find((c) => c.pilot_class === selectedClass);

  // Outcome-derived metrics (time behind the leader, …) correlate with rank
  // by construction, so they rank apart from the behaviours — same split as
  // the task page and the CLI report.
  // Ranked by |mean signed ρ|: flip-flopping tasks cancel, so CONSISTENT
  // separation leads — matching the intro copy, and matching the CLI's comp
  // report so the two can't disagree about the order. The bar column plots
  // that same mean, so the bars descend with the rows.
  const { ranked: rankedMetrics, outcomes: outcomeMetrics, uncorrelated } = useMemo(
    () =>
      active
        ? compAnalysisRows(active.aggregate)
        : { ranked: [], outcomes: [], uncorrelated: [] },
    [active]
  );

  // The aggregate stores no method descriptions, so the glossary reads them
  // from the engine's registry by metric id — the current definitions, which
  // is what the descriptions describe (the method, not one run's data). An
  // aggregate id absent from the registry (a metric since removed) has no
  // description anywhere and is left out.
  const glossaryEntries = useMemo<GlossaryEntry[]>(() => {
    if (!active) return [];
    const ids = new Set(active.aggregate.metrics.map((m) => m.id));
    return ALL_METRICS.filter((m) => ids.has(m.id));
  }, [active]);

  // The task analyses of the class being read. A comp that sets one task per
  // class per day has an Open and a Floater "T1"; only the class's own list
  // can say which is whose. Without it (an older API), every task.
  const taskLinks = useMemo<TaskAnalysisLink[]>(() => {
    if (!data) return [];
    const byId = new Map(data.tasks.map((t) => [t.task_id, t]));
    const own = active?.tasks;
    const rows = own
      ? own.flatMap((ct) => {
          const t = byId.get(ct.task_id);
          return t ? [{ ...t, pilot_count: ct.pilot_count as number | undefined }] : [];
        })
      : data.tasks.map((t) => ({ ...t, pilot_count: undefined }));
    return rows.map((t) => ({
      taskId: t.task_id,
      label: t.label,
      name: t.task_name,
      date: t.task_date,
      pilotCount: t.pilot_count,
      href: taskAnalysisPath(compId, canonicalName, t.task_id, t.task_name),
    }));
  }, [data, active, compId, canonicalName]);

  // The page one behaviour's row opens, for the class being read.
  const behaviourHref = (metricId: string) =>
    compAnalysisBehaviourPath(
      compUrlId(comp, compId),
      canonicalName,
      metricId,
      selectedClass ? `?class=${encodeURIComponent(selectedClass)}` : ""
    );

  const crumbs = underComp(compId, comp?.name ?? data?.comp_name);
  const isAdmin = useAdminView(!!comp?.is_admin);

  if (status === "notFound") {
    return <NotFound title="Comp analysis not found" />;
  }

  // Gate on `status` only, never on the user session: the content is public,
  // and useUser().loading is true throughout SSR + the first hydration render,
  // so gating on it would make the server emit a skeleton instead of the
  // seeded report.
  const ready = status === "ready";
  const selectClass = (value: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("class", value);
    setSearchParams(next, { replace: true });
  };

  // The bar is there before the report: the competition's other pages are in
  // the title's menu (this one ticked), and the class picker sticks under it —
  // it filters the WHOLE report (the task list, every table and chart) rather
  // than any one section, so it belongs to the page, not to a section.
  const bar = (
    <PageBar
      title={COMP_ANALYSIS_LABEL}
      trail={crumbs}
      related={compPages(
        compId,
        comp ?? (canonicalName ? { name: canonicalName } : null),
        isAdmin,
        COMP_ANALYSIS_LABEL
      )}
      below={
        ready && classes.length > 1 ? (
          <ClassPicker
            classes={classes.map((c) => c.pilot_class)}
            value={selectedClass}
            onChange={selectClass}
          />
        ) : undefined
      }
    />
  );

  if (!ready) {
    return (
      <Page width="wide" bar={bar} className="font-hyperlegible">
        {status === "loading" ? (
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

  return (
    <Page width="wide" bar={bar} className="font-hyperlegible">
      <p className="text-sm text-muted-foreground">
        {data?.comp_name ?? "This competition"} — which behaviours separated
        the field, task by task.
      </p>

      {/* The report's masthead: when it was computed, then its chapters —
          the task analyses of the class being read. Which class that is, is
          the picker stuck under the bar. */}
      {data ? (
        <>
          <div className="mt-2">
            <ScoreFreshness
              computedAt={data.computed_at}
              stale={data.stale}
              timezone={comp?.timezone ?? null}
              etag={etag}
              pollUrl={analysisUrl}
              variant="analysis"
            />
          </div>

          {data.pending_task_count > 0 ? (
            <Alert role="status" className="mt-4">
              <AlertTitle>
                {data.pending_task_count} of {data.total_task_count} task
                {data.total_task_count === 1 ? "" : "s"} not analysed yet
              </AlertTitle>
              <AlertDescription>
                They&rsquo;re computing in the background and are left out below.
                This page updates as each one arrives.
              </AlertDescription>
            </Alert>
          ) : null}

          {/* The class picker is in the bar, which does not print: paper
              gets a plain statement of which class this printout covers. */}
          {classes.length > 1 ? (
            <p className="mt-2 hidden text-sm print:block">
              Pilot class: <strong>{selectedClass}</strong>
            </p>
          ) : null}

          {/* Each task analysis lives under its own task's URL (lib/slug.ts);
              this page collects them, which makes it the only place they can
              be read against each other. */}
          <TaskAnalysisList tasks={taskLinks} className="mt-6" />
        </>
      ) : null}

      {active && rankedMetrics.length > 0 ? (
        // Each reading is its own panel. The order is deliberately unchanged —
        // which behaviours have explanatory power IS the finding, so the
        // separation ranking leads and everything else follows it.
        <div className="mt-6 flex flex-col gap-6">
          <Card aria-labelledby="consistency-heading" className="gap-3">
            <h2 id="consistency-heading" className="text-lg font-semibold">
              Which behaviours went with better ranks, across tasks
            </h2>
            {/* One line, and it says the thing the heading does not: what the
                order means. Everything else this paragraph used to carry is on
                the column headers' ⓘ, where the question is asked. */}
            <p className="text-sm text-muted-foreground">
              Sorted so the behaviours that pulled the same way on every task
              come first.
            </p>
            <SeparationTable
              metrics={rankedMetrics}
              taskLabels={active.aggregate.taskLabels}
              ariaLabel="Behaviour ranking across tasks"
              subjectLabel="Behaviour"
              fieldSize={active.aggregate.pilots.length}
              behaviourHref={behaviourHref}
            />
            {uncorrelated.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {uncorrelated.length} more metric
                {uncorrelated.length === 1 ? "" : "s"} describe the day, not a
                pilot, so they have no row here — see the glossary.
              </p>
            ) : null}
          </Card>

          {/* The map and the outcome checks were h3s nested inside the ranking
              section. They are peer READINGS of the same data, not sub-parts of
              the ranking, so each gets its own panel and its own h2 — nesting a
              panel inside a panel to keep them subordinate would have been the
              wrong way to say it. */}
          <Card aria-labelledby="consistency-map-heading" className="gap-3">
            <h2 id="consistency-map-heading" className="text-lg font-semibold">
              Consistency map
            </h2>
            {/* The second sentence used to read the axes aloud. ConsistencyMap
                is the one chart here that draws proper axis titles — it is the
                model the others were told to copy — so the chart says it. */}
            <p className="text-sm text-muted-foreground">
              The same table as a picture.
            </p>
            <ConsistencyMap metrics={rankedMetrics} />
          </Card>

          {outcomeMetrics.length > 0 ? (
            <Card aria-labelledby="outcome-heading" className="gap-3">
              <h2
                id="outcome-heading"
                className="flex items-center gap-1 text-lg font-semibold"
              >
                Outcome checks
                <Explain label="Outcome checks">
                  <OutcomeChecksNote />
                </Explain>
              </h2>
              <p className="text-sm text-muted-foreground">
                These measure the result, not a behaviour, so they always follow
                the ranks.
              </p>
              <SeparationTable
                metrics={outcomeMetrics}
                taskLabels={active.aggregate.taskLabels}
                ariaLabel="Outcome checks across tasks"
                subjectLabel="Outcome"
                fieldSize={active.aggregate.pilots.length}
                behaviourHref={behaviourHref}
              />
            </Card>
          ) : null}

          <Card aria-labelledby="comp-scores-heading" className="gap-3">
            <h2 id="comp-scores-heading" className="text-lg font-semibold">
              Scores behind these figures
            </h2>
            <Table aria-label="Competition scores used for the analysis">
              <TableHeader>
                <Column className="w-14 text-right">#</Column>
                <Column isRowHeader className="min-w-40">
                  Pilot
                </Column>
                <Column className="w-20 text-right">Tasks</Column>
                <Column className="w-24 text-right">Points</Column>
              </TableHeader>
              <TableBody>
                {active.aggregate.pilots.map((p) => (
                  <Row key={p.key}>
                    <Cell className="text-right tabular-nums text-muted-foreground">
                      {p.rank}
                    </Cell>
                    <Cell className="font-medium">{p.name}</Cell>
                    <Cell className="text-right tabular-nums">{p.taskCount}</Cell>
                    <Cell className="text-right tabular-nums">
                      {Math.round(p.totalScore)}
                    </Cell>
                  </Row>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/* The static form of every column header's ⓘ — popovers are
              print:hidden and cannot exist on paper, so without this the prose
              that left the reading flow would have left the page. Print-only:
              on screen the ⓘs already carry it, and rendering it here as well
              would put the paragraphs straight back under the table. */}
          <HowToReadFootnote page="comp" />

          {/* Method descriptions for every metric named above. Visible, unlike
              the note above: 26 entries a reader may want in bulk, and the one
              place this page states them at all. */}
          <MetricGlossary
            entries={glossaryEntries}
            intro="How GlideComp measures every metric named above. These are the current method descriptions of the engine. The report of each task carries the same text beside its numbers."
          />
        </div>
      ) : (
        <Alert className="mt-6">
          <AlertTitle>Nothing to aggregate yet</AlertTitle>
          <AlertDescription>
            No task in this competition has been analysed yet. To compute
            one, open a task’s analysis.
          </AlertDescription>
        </Alert>
      )}
    </Page>
  );
}

/** Whether a metric produced any coefficient at all — comp-level or on a
 * single task. The day-describing metrics (wind, climb strength) never do:
 * they have no per-pilot value. */

/**
 * One separation table — rendered once for the behavioural ranking and once
 * for the outcome checks, so the two can never drift in layout.
 *
 * Every coefficient here is a bar with its number, the way the task page's
 * ranking reads (#453): five columns of bare signed decimals — three tasks
 * plus two different means — was a wall, and the one thing a reader wants from
 * it (did this behaviour pull the same way every day?) was the hardest thing
 * to see in it.
 *
 * What changed, and why:
 *  - the per-task cells carry the bars this table was missing, so the row
 *    reads left to right as the competition unfolded. A HOLLOW bar is a task
 *    whose coefficient did not clear its noise floor — the same fill/outline
 *    vocabulary the old sparkline used;
 *  - that sparkline is gone: it existed to give a shape to a row of decimals,
 *    and the per-task bars are now that shape, at full precision;
 *  - "mean |ρ|" is gone too. It equals |mean ρ| except where the per-task
 *    signs disagree, which is exactly what the "Day to day" chip reports in
 *    words — and the consistency map below plots both to the pixel;
 *  - comp ρ, its n and its verdict were three columns describing ONE reading.
 *    They are one cell now, and the cell says whose reading it is: the
 *    coefficient against the comp scores, not the average of the tasks.
 *
 * The bar column is the n-weighted signed mean, which is also the sort key, so
 * the bars descend with the rows. Ranking by comp ρ instead would have let a
 * strong comp-level row sit low with a long bar and read as a sorting bug.
 */
function SeparationTable({
  metrics,
  taskLabels,
  ariaLabel,
  subjectLabel,
  fieldSize,
  behaviourHref,
}: {
  metrics: CompMetricAggregate[];
  taskLabels: string[];
  ariaLabel: string;
  /** First column's header — "Behaviour" for the ranking, "Outcome" for the
   * checks, same distinction the task page draws. */
  subjectLabel: string;
  /** Pilots in the comp scores — the denominator for "39 of 44 pilots". */
  fieldSize: number;
  /** The page of one behaviour: what a row opens. */
  behaviourHref: (metricId: string) => string;
}) {
  return (
    <Table
      aria-label={ariaLabel}
      scrollLabel={ariaLabel}
      // A LIST of rows on one shared axis, at every width (issues #804,
      // #860), the shape the task page's ranking has. It was a table 793px
      // wide in a phone's 319px window: the name filled the screen and every
      // figure was off to the right. A row is now the behaviour's name, how
      // the days compared and how it stood against the comp scores, over one
      // track with a badge for each task (rac/meter.tsx, MultiDotMeter).
      className={LIST.table}
      viewportClassName="-mx-5 w-auto border-y"
    >
      <TableHeader className={LIST.header}>
        {/* A row's first line is plainly its name; a screen reader keeps
            the heading. */}
        <Column isRowHeader className="sr-only">
          {subjectLabel}
        </Column>
        {/* Each heading carries the paragraph that explains it; every one is
            mirrored in HowToReadFootnote for print. "Each task" is last and
            takes the full width, because the axis hangs under it. */}
        <Column className={cn(LIST.heading, "order-last w-full")}>
          <HeaderWithNote label="Each task">
            <AcrossTasksNote />
          </HeaderWithNote>
          <DotMeterAxis className="mt-1" lower="less of it did well" higher="more of it did well" />
        </Column>
        <Column className={LIST.heading}>
          <HeaderWithNote label="Day to day">
            <DayToDayNote />
          </HeaderWithNote>
        </Column>
        {/* The verdict's words live in this line of a row, so the thresholds
            behind them belong on this heading. */}
        <Column className={LIST.heading}>
          <HeaderWithNote label="Against comp scores">
            <AgainstCompScoresNote />
            <VerdictLegend />
          </HeaderWithNote>
        </Column>
      </TableHeader>
      <TableBody>
        {metrics.map((m) => (
          <Row key={m.id} className={LIST.row}>
            <Cell className={cn(LIST.cell, "[grid-area:name] whitespace-normal text-base")}>
              {/* The row's one link, stretched over the whole row: a real
                  anchor, so it works with JavaScript off (docs/ssr.md), and
                  the row is the target, not the name. It opens the
                  behaviour's own page, which lists each task's figure. */}
              <AriaLink
                href={behaviourHref(m.id)}
                routerOptions={openedHereFrom(COMP_ANALYSIS_LABEL)}
                // `after:z-10`: the track's own boxes are positioned and come later
                // in the row, so without it they sit over the link and a tap
                // on the track opened nothing.
                className="outline-none after:absolute after:inset-0 after:z-10 data-focus-visible:after:ring-2 data-focus-visible:after:ring-ring/50 data-focus-visible:after:ring-inset"
              >
                {m.label}
                <ChevronRightIcon
                  aria-hidden="true"
                  className="ml-1 inline size-4 align-[-0.125em] text-muted-foreground"
                />
              </AriaLink>
            </Cell>
            <Cell className={cn(LIST.cell, "[grid-area:plot]")}>
              <MultiDotMeter
                readings={taskReadings(m, taskLabels)}
                label={`${m.label}: Spearman correlation with doing well, on each task`}
                valueLabel={taskReadingsWords(m, taskLabels)}
              />
            </Cell>
            <Cell className={cn(LIST.cell, "[grid-area:days] justify-self-end")}>
              <ConsistencyChip metric={m} />
            </Cell>
            <Cell
              className={cn(
                LIST.cell,
                "[grid-area:comp] justify-self-end text-xs tabular-nums text-muted-foreground"
              )}
            >
              {m.compRho ? (
                <>
                  {verdictWords(m.compRho.verdict)} · {m.compRho.n} of {fieldSize}
                  <span className="sr-only"> pilots, ρ {formatShownRho(m.compRho.rho)}</span>
                </>
              ) : (
                <Dash />
              )}
            </Cell>
          </Row>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * The comp ranking's boxes, laid out as a list. The same grid as the task
 * page's ranking (analysis/SeparationRanking.tsx): the name beside how the
 * days compared and how it stood against the comp scores, and the track under
 * all three. A row is `relative`, for the link stretched over it.
 */
const LIST = {
  table: "block [&_tbody]:block [&_thead]:block",
  header:
    "[&_tr]:flex [&_tr]:flex-wrap [&_tr]:items-center [&_tr]:gap-x-4 [&_tr]:px-5 [&_tr]:py-2",
  heading: "block h-auto p-0 text-muted-foreground",
  row: "relative grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-5 py-3 [grid-template-areas:'name_days'_'name_comp'_'plot_plot']",
  cell: "block p-0",
};

/**
 * A column header with its ⓘ. `whitespace-normal` because the kit's Column is
 * `whitespace-nowrap` by default and "Against comp scores" plus a 24px
 * button does not fit a 11rem column on one line.
 */
function HeaderWithNote({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-normal">
      {label}
      <Explain label={label}>
        {children}
      </Explain>
    </span>
  );
}

/** The "no reading here" cell — never a blank, which reads as a rendering
 * failure rather than as an absence. */
function Dash({ label = "not applicable" }: { label?: string }) {
  return (
    <span aria-label={label} className="text-muted-foreground">
      —
    </span>
  );
}
