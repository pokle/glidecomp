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
 * ADMIN-ONLY and NOT SSR'd, same as the task page.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Badge } from "@/react/rac/badge";
import { SimpleSelect } from "@/react/rac/select";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { DivergingMeter } from "@/react/rac/meter";
import { Alert, AlertDescription, AlertTitle } from "@/react/ui/alert";
import { RhoSparkline } from "../field-analysis/charts/RhoSparkline";
import { MetricGlossary, type GlossaryEntry } from "../field-analysis/MetricGlossary";
import { underComp } from "../lib/crumbs";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";
import { ScoreFreshness } from "../comp/ScoreFreshness";
import { ALL_METRICS, type CompFieldAnalysisData } from "../field-analysis/types";
import type { CompDetailData } from "../comp/types";

export function CompFieldAnalysis() {
  const { compId } = useParams<{ compId: string }>();
  const { user, loading: userLoading } = useUser();
  const [searchParams, setSearchParams] = useSearchParams();

  const [data, setData] = useState<CompFieldAnalysisData | null>(null);
  const [etag, setEtag] = useState<string | null>(null);
  const [comp, setComp] = useState<CompDetailData | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "forbidden" | "error">(
    "loading"
  );

  const analysisUrl = compId
    ? `/api/comp/${encodeURIComponent(compId)}/field-analysis`
    : null;

  // refetchTick > 0 re-runs the fetch without flashing the loading state —
  // the pending-poll effect below bumps it while tasks compute in the
  // background.
  const [refetchTick, setRefetchTick] = useState(0);

  useEffect(() => {
    if (!compId || !analysisUrl) return;
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
  }, [compId]);

  const classes = data?.classes ?? [];
  const selectedClass =
    searchParams.get("class") &&
    classes.some((c) => c.pilot_class === searchParams.get("class"))
      ? searchParams.get("class")!
      : (classes[0]?.pilot_class ?? "");
  const active = classes.find((c) => c.pilot_class === selectedClass);

  const rankedMetrics = useMemo(() => {
    if (!active) return [];
    return [...active.aggregate.metrics].sort(
      (a, b) => (b.meanAbsRho ?? -1) - (a.meanAbsRho ?? -1)
    );
  }, [active]);

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

  if (userLoading || status === "loading") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-6 font-hyperlegible">
        <p className="text-sm text-muted-foreground">Loading field analysis…</p>
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
              : user
                ? "Field analysis is currently limited to competition admins while the metrics are being validated."
                : "Sign in as a competition admin to view the field analysis."}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 font-hyperlegible">
      <Breadcrumbs items={crumbs} current="Field analysis" />

      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold">Field analysis</h1>
          <p className="text-sm text-muted-foreground">
            {data?.comp_name ?? "This competition"} — which behaviours separated
            the field, task by task.
          </p>
        </div>
        <Badge variant="outline" className="print:hidden">
          Admins only
        </Badge>
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
              to={`/comp/${compId}/analysis/task/${t.task_id}`}
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
              What separated the field, across tasks
            </h2>
            <p className="text-sm text-muted-foreground">
              A metric that holds its sign and magnitude across every task is
              telling you about flying. One that swings between tasks is telling
              you about the weather on those days. Rank 1 is best, so a metric
              where more is better shows a <strong>negative</strong> ρ.
            </p>
            <Table
              aria-label="Metric separation across tasks"
              scrollLabel="Metric separation across tasks"
            >
              <TableHeader>
                <Column isRowHeader className="min-w-56">
                  Metric
                </Column>
                <Column
                  className="w-28"
                  aria-label="Per-task correlation trend, visual"
                >
                  Trend
                </Column>
                {active.aggregate.taskLabels.map((label) => (
                  <Column
                    key={label}
                    className="w-20 text-right"
                    aria-label={`${label}, Spearman rho for that task`}
                  >
                    {label}
                  </Column>
                ))}
                <Column className="w-24 text-right" aria-label="Mean absolute rho across tasks">
                  mean |ρ|
                </Column>
                <Column className="w-40" aria-label="Overall correlation, visual">
                  Overall
                </Column>
                <Column className="w-24 text-right" aria-label="Comp-level rho">
                  comp ρ
                </Column>
              </TableHeader>
              <TableBody>
                {rankedMetrics.map((m) => (
                  <Row key={m.id}>
                    {/* No ⓘ here: the comp aggregate carries no method
                        descriptions (they live on the per-task reports and,
                        for this page, in the glossary at the bottom). */}
                    <Cell className="whitespace-normal">{m.label}</Cell>
                    <Cell>
                      <RhoSparkline
                        perTaskRho={m.perTaskRho}
                        taskLabels={active.aggregate.taskLabels}
                        metricLabel={m.label}
                      />
                    </Cell>
                    {m.perTaskRho.map((rho, i) => (
                      <Cell key={i} className="text-right tabular-nums">
                        {rho === null ? (
                          <span aria-label="not applicable" className="text-muted-foreground">
                            —
                          </span>
                        ) : (
                          rho.toFixed(2)
                        )}
                      </Cell>
                    ))}
                    <Cell className="text-right tabular-nums">
                      {m.meanAbsRho === null ? (
                        <span aria-label="not applicable" className="text-muted-foreground">
                          —
                        </span>
                      ) : (
                        m.meanAbsRho.toFixed(2)
                      )}
                    </Cell>
                    <Cell>
                      {m.compRho ? (
                        <DivergingMeter
                          value={m.compRho.rho}
                          label={`${m.label}: correlation against competition rank`}
                          valueLabel={m.compRho.rho.toFixed(2)}
                        />
                      ) : null}
                    </Cell>
                    <Cell className="text-right tabular-nums">
                      {m.compRho ? (
                        m.compRho.rho.toFixed(2)
                      ) : (
                        <span aria-label="not applicable" className="text-muted-foreground">
                          —
                        </span>
                      )}
                    </Cell>
                  </Row>
                ))}
              </TableBody>
            </Table>
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
