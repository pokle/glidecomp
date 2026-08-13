/**
 * Competition field analysis — the same separation question asked across
 * every task, which is the only way to tell a real signal from one day's
 * weather.
 *
 * A metric that correlates strongly on one task may just have suited that
 * day's conditions. The per-task ρ row is therefore the substance here: a
 * metric that holds its sign and magnitude across tasks is telling you
 * something about flying; one that swings is telling you about the day.
 *
 * Public and SSR'd, same as the task page (loadCompFieldAnalysis +
 * functions/comp/[[path]].ts): the server seeds the most-recently-cached
 * report, or a pending placeholder while the first compute runs.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { NotFound } from "../components/NotFound";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { SimpleSelect } from "@/react/rac/select";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { DivergingMeter } from "@/react/rac/meter";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { cn } from "@/react/lib/utils";
import { Card } from "@/react/rac/card";
import { Explain } from "@/react/rac/explain";
import { VerdictBadge } from "../field-analysis/SeparationRanking";
import {
  AcrossTasksNote,
  AgainstCompScoresNote,
  DayToDayNote,
  HowToReadFootnote,
  OutcomeChecksNote,
  VerdictLegend,
} from "../field-analysis/ReadingNotes";
import { ConsistencyChip } from "../field-analysis/ConsistencyChip";
import { ConsistencyMap } from "../field-analysis/charts/ConsistencyMap";
import { MetricGlossary, type GlossaryEntry } from "../field-analysis/MetricGlossary";
import { underComp } from "../lib/crumbs";
import { idFromSegment, compAnalysisPath, taskAnalysisPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { usePollWhile } from "../lib/use-poll-while";
import { api } from "../../comp/api";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { useInitialData } from "../lib/initial-data";
import type { CompFieldAnalysisLoaderData } from "../loaders";
import {
  ALL_METRICS,
  type CompFieldAnalysisData,
  type CompMetricAggregate,
} from "../field-analysis/types";
import { fetchWithRetry, type CompDetailData } from "../comp/types";

export function CompFieldAnalysis() {
  const { compId: compParam } = useParams<{ compId: string }>();
  const compId = idFromSegment(compParam ?? "");
  const [searchParams, setSearchParams] = useSearchParams();

  // SSR seed: the server ran loadCompFieldAnalysis for this URL and embedded
  // the result. Null on client boot / SPA navigations, where the effect fetches.
  const initial = useInitialData<CompFieldAnalysisLoaderData>();
  const [data, setData] = useState<CompFieldAnalysisData | null>(
    initial?.analysis ?? null
  );
  const [etag, setEtag] = useState<string | null>(initial?.analysisEtag ?? null);
  const [comp, setComp] = useState<CompDetailData | null>(initial?.comp ?? null);
  const [status, setStatus] = useState<"loading" | "ready" | "notFound" | "forbidden" | "error">(
    initial ? "ready" : "loading"
  );

  // Settle the address bar on the canonical `${slug}-${id}` once a name is
  // known (the analysis body carries comp_name even before the comp fetch).
  const canonicalName = comp?.name ?? data?.comp_name;
  useCanonicalPath(canonicalName ? compAnalysisPath(compId, canonicalName) : null);

  const analysisUrl = compId
    ? `/api/comp/${encodeURIComponent(compId)}/field-analysis`
    : null;

  // refetchTick > 0 re-runs the fetch without flashing the loading state —
  // the pending-poll effect below bumps it while tasks compute in the
  // background.
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    if (!compId || !analysisUrl) return;
    // Seeded by SSR for the first render — don't refetch on mount, but the
    // pending-poll effect below still drives refetches (refetchTick > 0).
    if (initial && refetchTick === 0) {
      document.title = `GlideComp - Field analysis: ${initial.analysis.comp_name}`;
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
        if (!res.ok) {
          setStatus("error");
          return;
        }
        setEtag(res.headers.get("ETag"));
        const body = (await res.json()) as CompFieldAnalysisData;
        setData(body);
        document.title = `GlideComp - Field analysis: ${body.comp_name}`;
        setStatus("ready");
      } catch {
        if (!cancelled) setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initial` is stable for the life of the SSR'd URL; compId is the real key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId, analysisUrl, refetchTick]);

  // While any task's first analysis computes in the background, refetch so
  // the aggregate fills in as reports land — same poll the task page runs.
  const pendingTasks = status === "ready" && (data?.pending_task_count ?? 0) > 0;
  usePollWhile(pendingTasks, () => setRefetchTick((t) => t + 1), refetchTick);

  useEffect(() => {
    if (!compId) return;
    // SSR already seeded the comp (name + timezone); skip the cosmetic fetch.
    if (initial?.comp) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.api.comp[":comp_id"].$get({ param: { comp_id: compId } });
        if (!cancelled && res.ok) {
          setComp((await res.json()) as unknown as CompDetailData);
        }
      } catch {
        // Cosmetic only.
      }
    })();
    return () => {
      cancelled = true;
    };
    // `initial` is stable for the life of the SSR'd URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compId]);

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
  const signedStrength = (m: CompMetricAggregate) =>
    m.meanSignedRho === null ? -1 : Math.abs(m.meanSignedRho);
  const rankedMetrics = useMemo(() => {
    if (!active) return [];
    return active.aggregate.metrics
      .filter((m) => !m.outcome && hasAnyCorrelation(m))
      .sort((a, b) => signedStrength(b) - signedStrength(a));
  }, [active]);
  const outcomeMetrics = useMemo(() => {
    if (!active) return [];
    return active.aggregate.metrics
      .filter((m) => m.outcome && hasAnyCorrelation(m))
      .sort((a, b) => signedStrength(b) - signedStrength(a));
  }, [active]);
  // The day-describing metrics (wind by hour, climb strength by hour) have no
  // per-pilot value, so every cell of their row was an em dash — a row of
  // nothing to read, three deep at the bottom of the table. They are counted
  // in a footnote instead and still carry their full method prose in the
  // glossary below.
  const uncorrelated = useMemo(
    () => (active ? active.aggregate.metrics.filter((m) => !hasAnyCorrelation(m)) : []),
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

  const crumbs = underComp(compId, comp?.name ?? data?.comp_name);

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
        <Breadcrumbs items={crumbs} current="Field analysis" />
        <h1 className="mt-3 text-2xl font-bold">Field analysis</h1>
        <Alert className="mt-4">
          <AlertTitle>
            {status === "forbidden" ? "Not available" : "Could not load the field analysis"}
          </AlertTitle>
          <AlertDescription>
            {status === "error"
              ? "Please try again in a moment."
              : "The field analysis of this competition is not available. The competition is possibly not published yet."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    // No gutter of its own — Shell's <main> already pays px-4 pt-6, same as
    // every other page under it (see TaskFieldAnalysis).
    <div className="font-hyperlegible">
      <Breadcrumbs items={crumbs} current="Field analysis" />

      <div className="mt-3 min-w-0">
        <h1 className="text-2xl font-bold">Field analysis</h1>
        <p className="text-sm text-muted-foreground">
          {data?.comp_name ?? "This competition"} — which behaviours separated
          the field, task by task.
        </p>
      </div>

      {/* The report's masthead: when it was computed, which chapters it has,
          and which class it is showing. These belong together in one panel —
          the class select filters the WHOLE report rather than any single
          table, so it is page furniture and not a table's own control. */}
      {data ? (
        <Card className="mt-4 gap-3">
          <ScoreFreshness
            computedAt={data.computed_at}
            stale={data.stale}
            timezone={comp?.timezone ?? null}
            etag={etag}
            pollUrl={analysisUrl}
            variant="analysis"
          />

          {data.pending_task_count > 0 ? (
            <Alert role="status">
              <AlertTitle>
                {data.pending_task_count} of {data.total_task_count} task
                {data.total_task_count === 1 ? "" : "s"} not analysed yet
              </AlertTitle>
              <AlertDescription>
                GlideComp is computing them in the background, and the figures
                below leave them out. This page refreshes itself as each one
                arrives.
              </AlertDescription>
            </Alert>
          ) : null}

          {/* The per-task reports are chapters of this page, so they get a real
              nav landmark rather than a prose footnote — this is the only way
              in to them, and each is now a child URL of this one. */}
          {data.tasks.length > 0 ? (
            <nav
              aria-label="Per-task field analysis"
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
            >
              <span className="text-muted-foreground">Per task:</span>
              {data.tasks.map((t) => (
                <Link
                  key={t.task_id}
                  to={taskAnalysisPath(compId, canonicalName, t.task_id, t.task_name)}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  {t.label} {t.task_name}
                </Link>
              ))}
            </nav>
          ) : null}

          {classes.length > 1 ? (
            <div>
              {/* The select is a control, so print swaps it for a plain
                  statement of which class this printout covers. */}
              <div className="print:hidden">
                <SimpleSelect
                  ariaLabel="Pilot class"
                  value={selectedClass}
                  onChange={(value) => {
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
        </Card>
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
            No task in this competition has a stored field analysis. To
            compute one, open the field analysis of a task.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Whether a metric produced any coefficient at all — comp-level or on a
 * single task. The day-describing metrics (wind, climb strength) never do:
 * they have no per-pilot value. */
function hasAnyCorrelation(m: CompMetricAggregate): boolean {
  return m.compRho !== null || m.perTaskRho.some((rho) => rho !== null);
}

/** Did this task's coefficient clear its own noise floor? Null when the task
 * produced no coefficient at all. */
function taskInformative(m: CompMetricAggregate, i: number): boolean | null {
  const c = m.perTaskCorrelation[i];
  return c === null || c === undefined ? null : Math.abs(c.rho) >= c.noiseFloor;
}

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
}: {
  metrics: CompMetricAggregate[];
  taskLabels: string[];
  ariaLabel: string;
  /** First column's header — "Behaviour" for the ranking, "Outcome" for the
   * checks, same distinction the task page draws. */
  subjectLabel: string;
  /** Pilots in the comp scores — the denominator for "39 of 44 pilots". */
  fieldSize: number;
}) {
  return (
    <Table aria-label={ariaLabel} scrollLabel={ariaLabel}>
      <TableHeader>
        <Column isRowHeader className="min-w-56">
          {subjectLabel}
        </Column>
        {/* Each header carries the paragraph that used to sit under the table
            explaining it — the place the reader's question actually arises.
            Every one is mirrored in HowToReadFootnote for print. */}
        <Column className="w-44">
          <HeaderWithNote label="Across tasks">
            <AcrossTasksNote />
          </HeaderWithNote>
        </Column>
        <Column className="w-40">
          <HeaderWithNote label="Day to day">
            <DayToDayNote />
          </HeaderWithNote>
        </Column>
        {/* The verdict chip lives in this cell, so the thresholds behind it
            belong on this header — the comp table has no separate "What it
            means" column for them the way the task ranking does. */}
        <Column className="w-44">
          <HeaderWithNote label="Against comp scores">
            <AgainstCompScoresNote />
            <VerdictLegend />
          </HeaderWithNote>
        </Column>
        {taskLabels.map((label, i) => (
          <Column
            key={label}
            // The border groups everything from here right as "one column per
            // task", without a colspan header row the grid semantics would
            // have to carry.
            className={cn("w-20 text-right", i === 0 && "border-l")}
            aria-label={`${label}, coefficient for that task`}
          >
            {label}
          </Column>
        ))}
      </TableHeader>
      <TableBody>
        {metrics.map((m) => (
          <Row key={m.id}>
            {/* No ⓘ here: the comp aggregate carries no method
                descriptions (they live on the per-task reports and,
                for this page, in the glossary at the bottom). */}
            <Cell className="whitespace-normal">{m.label}</Cell>
            <Cell>
              {m.meanSignedRho === null ? (
                <Dash />
              ) : (
                <div className="flex items-center gap-2">
                  <DivergingMeter
                    className="min-w-20 flex-1"
                    value={m.meanSignedRho}
                    label={`${m.label}: average coefficient across tasks`}
                    valueLabel={m.meanSignedRho.toFixed(2)}
                  />
                  <span
                    aria-hidden
                    className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                  >
                    {m.meanSignedRho.toFixed(2)}
                  </span>
                </div>
              )}
            </Cell>
            <Cell>
              <ConsistencyChip metric={m} />
            </Cell>
            <Cell>
              {m.compRho ? (
                <div className="space-y-0.5">
                  <VerdictBadge correlation={m.compRho} />
                  <p className="text-xs tabular-nums text-muted-foreground">
                    ρ {m.compRho.rho.toFixed(2)} · {m.compRho.n} of {fieldSize}{" "}
                    pilots
                  </p>
                </div>
              ) : (
                <Dash />
              )}
            </Cell>
            {m.perTaskRho.map((rho, i) => {
              const informative = taskInformative(m, i);
              const label = taskLabels[i] ?? `task ${i + 1}`;
              return (
                <Cell key={i} className={i === 0 ? "border-l" : undefined}>
                  {rho === null ? (
                    <div className="text-right">
                      <Dash label={`${label}: not applicable`} />
                    </div>
                  ) : (
                    <div className="space-y-1">
                      <p
                        aria-hidden
                        className={cn(
                          "text-right text-xs tabular-nums",
                          informative === false && "text-muted-foreground"
                        )}
                      >
                        {rho.toFixed(2)}
                      </p>
                      <DivergingMeter
                        value={rho}
                        hollow={informative === false}
                        label={`${m.label}, ${label}`}
                        valueLabel={
                          informative === false
                            ? `${rho.toFixed(2)}, could be chance`
                            : rho.toFixed(2)
                        }
                      />
                    </div>
                  )}
                </Cell>
              );
            })}
          </Row>
        ))}
      </TableBody>
    </Table>
  );
}

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
