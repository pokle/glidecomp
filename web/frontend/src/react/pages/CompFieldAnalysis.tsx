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
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Loading } from "@/react/rac/progress";
import { SimpleSelect } from "@/react/rac/select";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { DivergingMeter } from "@/react/rac/meter";
import { Alert, AlertDescription, AlertTitle } from "@/react/rac/alert";
import { cn } from "@/react/lib/utils";
import { VerdictBadge, VerdictLegend } from "../field-analysis/SeparationRanking";
import { ConsistencyChip } from "../field-analysis/ConsistencyChip";
import { ConsistencyMap } from "../field-analysis/charts/ConsistencyMap";
import { MetricGlossary, type GlossaryEntry } from "../field-analysis/MetricGlossary";
import { underComp } from "../lib/crumbs";
import { idFromSegment, compAnalysisPath, taskAnalysisPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { api } from "../../comp/api";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { useInitialData } from "../lib/initial-data";
import type { CompFieldAnalysisLoaderData } from "../loaders";
import {
  ALL_METRICS,
  type CompFieldAnalysisData,
  type CompMetricAggregate,
} from "../field-analysis/types";
import type { CompDetailData } from "../comp/types";

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
  const [status, setStatus] = useState<"loading" | "ready" | "forbidden" | "error">(
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
        const res = await fetch(analysisUrl, { credentials: "include" });
        if (cancelled) return;
        if (res.status === 404 || res.status === 401) {
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
  // the aggregate fills in as reports land — mirrors the task page's pending
  // poll. Backs off 3s → 10s, gives up after ~2 minutes.
  const pendingTasks = status === "ready" && (data?.pending_task_count ?? 0) > 0;
  useEffect(() => {
    if (!pendingTasks) return;
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
  }, [pendingTasks, refetchTick]);

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
      <div className="mx-auto max-w-6xl px-4 py-6 font-hyperlegible">
        <Loading className="text-sm">Loading field analysis…</Loading>
      </div>
    );
  }

  if (status === "forbidden" || status === "error") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 font-hyperlegible">
        <Breadcrumbs items={crumbs} current="Field analysis" />
        <h1 className="mt-3 text-2xl font-bold">Field analysis</h1>
        <Alert className="mt-4">
          <AlertTitle>
            {status === "forbidden" ? "Not available" : "Could not load the field analysis"}
          </AlertTitle>
          <AlertDescription>
            {status === "error"
              ? "Please try again in a moment."
              : "This competition's field analysis isn't available — it may not be published yet."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 font-hyperlegible">
      <Breadcrumbs items={crumbs} current="Field analysis" />

      <div className="mt-3 min-w-0">
        <h1 className="text-2xl font-bold">Field analysis</h1>
        <p className="text-sm text-muted-foreground">
          {data?.comp_name ?? "This competition"} — which behaviours separated
          the field, task by task.
        </p>
      </div>

      {data ? (
        <ScoreFreshness
          computedAt={data.computed_at}
          stale={data.stale}
          timezone={comp?.timezone ?? null}
          etag={etag}
          pollUrl={analysisUrl}
          variant="analysis"
        />
      ) : null}

      {data && data.pending_task_count > 0 ? (
        <Alert className="mt-3" role="status">
          <AlertTitle>
            {data.pending_task_count} of {data.total_task_count} task
            {data.total_task_count === 1 ? "" : "s"} not analysed yet
          </AlertTitle>
          <AlertDescription>
            They're being computed in the background and are left out of the
            figures below; this page refreshes itself as they land.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* The per-task reports are chapters of this page, so they get a real
          nav landmark rather than a prose footnote — this is the only way in
          to them, and each is now a child URL of this one. */}
      {data && data.tasks.length > 0 ? (
        <nav
          aria-label="Per-task field analysis"
          className="mt-4 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm"
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
        <div className="mt-4">
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

      {active && rankedMetrics.length > 0 ? (
        <div className="mt-6 space-y-8">
          <section aria-labelledby="consistency-heading" className="space-y-3">
            <h2 id="consistency-heading" className="text-lg font-semibold">
              Which behaviours went with better results, across tasks
            </h2>
            <p className="text-sm text-muted-foreground">
              A behaviour that holds its sign and size across every task is
              telling you about flying. One that swings between tasks is telling
              you about the weather on those days. Rank 1 is best, so a
              behaviour where more is better shows a <strong>negative</strong> ρ
              — bars left of centre. Each row reads left to right: how the
              behaviour averaged over the tasks, whether it held day to day,
              how it looks against the overall standings, then task by task.
            </p>
            <SeparationTable
              metrics={rankedMetrics}
              taskLabels={active.aggregate.taskLabels}
              ariaLabel="Behaviour ranking across tasks"
              subjectLabel="Behaviour"
              fieldSize={active.aggregate.pilots.length}
            />
            <p className="text-xs text-muted-foreground">
              <strong>Across tasks</strong> is the average of the per-task
              coefficients (n-weighted, signs kept) and the order of the table:
              a behaviour that pulled the same way every day leads, because days
              that pull opposite ways cancel each other there.{" "}
              <strong>Day to day</strong> reads only the tasks whose coefficient
              cleared its own noise floor — the solid bars; a{" "}
              <strong>hollow bar</strong> is a day whose coefficient could be
              chance. Depending on the day is a finding, not a defect.{" "}
              <strong>Against comp standings</strong> is a separate reading:
              each pilot's own average for that behaviour over the whole
              competition, correlated against their overall placing. The verdict
              and the pilot count belong to that one.
            </p>
            <VerdictLegend />
            {uncorrelated.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {uncorrelated.length} more metric
                {uncorrelated.length === 1 ? "" : "s"} describe the day rather
                than a pilot (the wind, how strong the climbs were), so there is
                no per-pilot value to correlate and no row here — they are in the
                glossary below, and on each task's own analysis.
              </p>
            ) : null}

            <div className="space-y-3 pt-2">
              <h3 className="text-base font-semibold">Consistency map</h3>
              <p className="text-sm text-muted-foreground">
                The same table as a picture: how much each behaviour separated
                the field per day (across) against how consistently it pulled
                one way (up).
              </p>
              <ConsistencyMap metrics={rankedMetrics} />
            </div>

            {outcomeMetrics.length > 0 ? (
              <div className="space-y-3 pt-2">
                <h3 className="text-base font-semibold">Outcome checks</h3>
                <p className="text-sm text-muted-foreground">
                  These are not behaviours — they measure the result itself, so
                  of course they follow the placings. They are here as a check
                  on the analysis: a weak pattern means something is off in the
                  numbers, not in anyone's flying.
                </p>
                <SeparationTable
                  metrics={outcomeMetrics}
                  taskLabels={active.aggregate.taskLabels}
                  ariaLabel="Outcome checks across tasks"
                  subjectLabel="Outcome"
                  fieldSize={active.aggregate.pilots.length}
                />
              </div>
            ) : null}
          </section>

          <section aria-labelledby="standings-heading" className="space-y-3">
            <h2 id="standings-heading" className="text-lg font-semibold">
              Standings behind these figures
            </h2>
            <Table aria-label="Competition standings used for the analysis">
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
          </section>

          {/* Method descriptions for every metric named above — this page has
              no ⓘ popovers, so the glossary is the one place to read them
              (and the printed reference). */}
          <MetricGlossary
            entries={glossaryEntries}
            intro="How every metric named above is measured. These are the engine's current method descriptions; each task's own report carries the same prose next to its numbers."
          />
        </div>
      ) : (
        <Alert className="mt-6">
          <AlertTitle>Nothing to aggregate yet</AlertTitle>
          <AlertDescription>
            No task in this competition has a stored field analysis. Open a
            task's field analysis to have one computed.
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
 *    coefficient against the comp standings, not the average of the tasks.
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
  /** Pilots in the comp standings — the denominator for "39 of 44 pilots". */
  fieldSize: number;
}) {
  return (
    <Table aria-label={ariaLabel} scrollLabel={ariaLabel}>
      <TableHeader>
        <Column isRowHeader className="min-w-56">
          {subjectLabel}
        </Column>
        <Column className="w-44">Across tasks</Column>
        <Column className="w-40">Day to day</Column>
        <Column className="w-44">Against comp standings</Column>
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

/** The "no reading here" cell — never a blank, which reads as a rendering
 * failure rather than as an absence. */
function Dash({ label = "not applicable" }: { label?: string }) {
  return (
    <span aria-label={label} className="text-muted-foreground">
      —
    </span>
  );
}
