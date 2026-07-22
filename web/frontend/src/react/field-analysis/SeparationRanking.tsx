/**
 * The metric separation ranking — which behaviours actually separate the
 * leaderboard, sorted by |ρ|.
 *
 * This leads every field-analysis surface, exactly as it leads the CLI's
 * text report. That ordering is the point of the whole exercise: the per-
 * family tables below are only worth reading in the light of which metrics
 * have any explanatory power at all on this day.
 *
 * When given the full report, the table is single-selectable and the
 * selected metric renders as a rank scatter below it — the coefficient says
 * a metric separated the field; the scatter shows whether that is a clean
 * trend, two clusters, or one outlier. The top-ranked metric starts
 * selected, so the strongest finding is visualized on first paint.
 */
import { useState } from "react";
import type { Key, Selection } from "react-aria-components";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { DivergingMeter } from "@/react/rac/meter";
import { Badge } from "@/react/rac/badge";
import { cn } from "@/react/lib/utils";
import { MetricExplanation } from "./MetricExplanation";
import { MetricDetailPanel } from "./charts/MetricDetailPanel";
import {
  FAMILY_LABELS,
  MIN_CORRELATION_N,
  type FieldAnalysisReport,
  type MetricReport,
  type MetricCorrelation,
} from "./types";

/** A metric paired with the correlation it earned. */
interface RankedMetric {
  metric: Pick<
    MetricReport,
    "id" | "label" | "unit" | "family" | "direction" | "explanation" | "perPilot"
  >;
  correlation: MetricCorrelation;
}

/**
 * The behavioural ranking. Outcome-derived metrics (time behind the leader,
 * …) correlate with rank by construction, so they are excluded here — from
 * the headline table, the top-3 family auto-open, and the auto-selected
 * scatter — and presented apart as eval sanity checks.
 */
export function rankMetrics(metrics: MetricReport[]): RankedMetric[] {
  return metrics
    .filter((m) => !m.outcome)
    .flatMap((m) => (m.correlation ? [{ metric: m, correlation: m.correlation }] : []))
    .sort((a, b) => b.correlation.absRho - a.correlation.absRho);
}

/** The strongest |ρ| among a set of metrics — the badge on each family.
 * Outcome-derived metrics don't count: a family must not owe its headline
 * number to a metric that correlates by construction. */
export function bestAbsRho(metrics: MetricReport[]): number | null {
  const values = metrics.flatMap((m) =>
    m.correlation && !m.outcome ? [m.correlation.absRho] : []
  );
  return values.length > 0 ? Math.max(...values) : null;
}

/** Shared verdict chip (also used by the comp page). "within noise" and
 * "n too small" deliberately wear the quietest style — they are warnings
 * that the number may be luck, not findings. */
export function VerdictBadge({ correlation }: { correlation: MetricCorrelation }) {
  const variant =
    correlation.verdict === "strong"
      ? "default"
      : correlation.verdict === "moderate"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{correlation.verdict}</Badge>;
}

/** The one-sentence basis for every verdict badge — rendered under both the
 * task ranking and the comp aggregate so the thresholds are never undefined
 * jargon. */
export function VerdictLegend() {
  return (
    <p className="text-xs text-muted-foreground">
      Verdicts: <strong>strong</strong> |ρ| ≥ 0.5, <strong>moderate</strong> ≥ 0.3,{" "}
      <strong>weak</strong> below — but only after clearing the noise floor for that
      metric's n. <strong>within noise</strong> means shuffled ranks produce a
      coefficient that size more than 5% of the time, so it is indistinguishable from
      luck whatever its magnitude.
    </p>
  );
}

export function SeparationRanking({
  metrics,
  report,
}: {
  metrics: MetricReport[];
  /** When provided, rows are selectable and the selected metric is plotted
   * against rank below the table. */
  report?: FieldAnalysisReport;
}) {
  const ranked = rankMetrics(metrics);
  // The outcome checks, ranked the same way but shown apart (below the
  // scatter): they correlate by construction, so a slot in the behavioural
  // ranking would make the headline a non-finding.
  const outcomeRanked = metrics
    .filter((m) => m.outcome)
    .flatMap((m) => (m.correlation ? [{ metric: m, correlation: m.correlation }] : []))
    .sort((a, b) => b.correlation.absRho - a.correlation.absRho);

  // The user's pick, if it still exists in this class's ranking (class
  // switches swap the metric set out from under it); the top-ranked metric
  // otherwise.
  const [selectedId, setSelectedId] = useState<Key | null>(null);
  // Owned here, not in the scatter, so ticking "label every pilot" survives
  // switching metrics (per-session only; a refresh resets it).
  const [showAllLabels, setShowAllLabels] = useState(false);
  const effectiveId =
    report && ranked.length > 0
      ? ranked.some((r) => r.metric.id === selectedId)
        ? selectedId
        : ranked[0].metric.id
      : null;
  const selectedMetric =
    effectiveId !== null ? (metrics.find((m) => m.id === effectiveId) ?? null) : null;

  if (ranked.length === 0 && outcomeRanked.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No metric produced a correlation — the field is too small, or too few
        pilots had a usable value.
      </p>
    );
  }

  const underpowered = ranked.filter((r) => r.correlation.n < MIN_CORRELATION_N);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Each metric's Spearman correlation against the published rank. Rank 1
        is best, so a metric where more is better shows a{" "}
        <strong>negative</strong> ρ. Bigger bars mean the metric separated the
        field more sharply on this task.
        {report ? (
          // An instruction to interact — meaningless on paper.
          <span className="print:hidden">
            {" "}
            Select a row to see that metric plotted against rank.
          </span>
        ) : null}
      </p>

      {ranked.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No behavioural metric produced a correlation — the field is too
          small, or too few pilots had a usable value.
        </p>
      ) : (
      <Table
        aria-label="Metric separation ranking"
        scrollLabel="Metric separation ranking"
        {...(report
          ? {
              selectionMode: "single" as const,
              selectionBehavior: "replace" as const,
              disallowEmptySelection: true,
              selectedKeys: effectiveId !== null ? [effectiveId] : [],
              onSelectionChange: (keys: Selection) => {
                if (keys !== "all") setSelectedId([...keys][0] ?? null);
              },
            }
          : {})}
      >
        <TableHeader>
          <Column isRowHeader className="min-w-56">
            Metric
          </Column>
          <Column className="w-20 text-right">ρ</Column>
          <Column className="w-40" aria-label="Correlation strength, visual">
            Strength
          </Column>
          <Column className="w-16 text-right" aria-label="n, pilots correlated">
            n
          </Column>
          <Column className="w-28">Verdict</Column>
          <Column className="w-40">Family</Column>
        </TableHeader>
        <TableBody>
          {ranked.map(({ metric, correlation }) => (
            <Row key={metric.id} id={metric.id}>
              <Cell className="whitespace-normal">
                <span className="inline-flex items-center gap-1">
                  {metric.label}
                  <MetricExplanation
                    metricId={metric.id}
                    label={metric.label}
                    unit={metric.unit}
                    direction={metric.direction}
                    explanation={metric.explanation}
                    perPilot={metric.perPilot}
                    pilots={report?.pilots}
                  />
                </span>
              </Cell>
              <Cell className="text-right tabular-nums">
                {correlation.rho.toFixed(2)}
              </Cell>
              <Cell>
                <DivergingMeter
                  value={correlation.rho}
                  label={`${metric.label}: Spearman correlation against rank`}
                  valueLabel={correlation.rho.toFixed(2)}
                />
              </Cell>
              <Cell className="text-right tabular-nums">{correlation.n}</Cell>
              <Cell>
                <VerdictBadge correlation={correlation} />
              </Cell>
              <Cell className="text-muted-foreground">
                {FAMILY_LABELS[metric.family]}
              </Cell>
            </Row>
          ))}
        </TableBody>
      </Table>
      )}

      <VerdictLegend />
      <p className="text-xs text-muted-foreground">
        With {ranked.length} metrics ranked on this one task, the top rows are
        partly selection luck — trust the metrics that repeat across tasks in the
        competition-level analysis.
      </p>
      {underpowered.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {underpowered.length} metric{underpowered.length === 1 ? "" : "s"}{" "}
          correlated fewer than {MIN_CORRELATION_N} pilots — treat those rows as
          indicative only.
        </p>
      ) : null}

      {report && selectedMetric ? (
        // On paper the print-only strong-metric panels below replace this
        // interactive one — printing it too would duplicate a chart. When no
        // metric earned "strong", this panel is all print gets, so it stays.
        <div className={strongMetrics(ranked).length > 0 ? "print:hidden" : undefined}>
          <MetricDetailPanel
            metric={selectedMetric}
            report={report}
            showAllLabels={showAllLabels}
            onShowAllLabelsChange={setShowAllLabels}
          />
        </div>
      ) : null}

      {report ? <StrongMetricPrintCharts ranked={ranked} metrics={metrics} report={report} /> : null}

      {outcomeRanked.length > 0 ? (
        <div className="space-y-2 pt-2">
          <h3 className="text-base font-semibold">Outcome checks</h3>
          <p className="text-sm text-muted-foreground">
            These metrics are derived from the race outcome itself, so they
            correlate with rank by construction — a low |ρ| here questions the
            eval, not the flying. Their per-pilot diagnostics stay in the Race
            craft section below.
          </p>
          <Table aria-label="Outcome checks" scrollLabel="Outcome checks">
            <TableHeader>
              <Column isRowHeader className="min-w-56">
                Metric
              </Column>
              <Column className="w-20 text-right">ρ</Column>
              <Column className="w-40" aria-label="Correlation strength, visual">
                Strength
              </Column>
              <Column className="w-16 text-right" aria-label="n, pilots correlated">
                n
              </Column>
              <Column className="w-28">Verdict</Column>
            </TableHeader>
            <TableBody>
              {outcomeRanked.map(({ metric, correlation }) => (
                <Row key={metric.id}>
                  <Cell className="whitespace-normal">
                    <span className="inline-flex items-center gap-1">
                      {metric.label}
                      <MetricExplanation
                        metricId={metric.id}
                        label={metric.label}
                        unit={metric.unit}
                        direction={metric.direction}
                        explanation={metric.explanation}
                        perPilot={metric.perPilot}
                        pilots={report?.pilots}
                      />
                    </span>
                  </Cell>
                  <Cell className="text-right tabular-nums">
                    {correlation.rho.toFixed(2)}
                  </Cell>
                  <Cell>
                    <DivergingMeter
                      value={correlation.rho}
                      label={`${metric.label}: Spearman correlation against rank`}
                      valueLabel={correlation.rho.toFixed(2)}
                    />
                  </Cell>
                  <Cell className="text-right tabular-nums">{correlation.n}</Cell>
                  <Cell>
                    <VerdictBadge correlation={correlation} />
                  </Cell>
                </Row>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}
    </div>
  );
}

function strongMetrics(ranked: RankedMetric[]): RankedMetric[] {
  return ranked.filter((r) => r.correlation.verdict === "strong");
}

/**
 * Print-only: the rank scatter + distribution of EVERY metric the ranking
 * called "strong", two to a page. On screen one chart at a time (row
 * selection) is the right reading; on paper there is no selection, and the
 * strong metrics are exactly the ones whose shape the reader needs to see.
 *
 * display:none on screen also keeps these out of the accessibility tree —
 * they are duplicates of what row selection already offers interactively.
 */
function StrongMetricPrintCharts({
  ranked,
  metrics,
  report,
}: {
  ranked: RankedMetric[];
  metrics: MetricReport[];
  report: FieldAnalysisReport;
}) {
  const strong = strongMetrics(ranked);
  if (strong.length === 0) return null;

  return (
    <div className="hidden print:block print:break-before-page">
      <h3 className="text-base font-semibold">
        Metrics with a strong verdict, plotted against rank
      </h3>
      {strong.map(({ metric }, i) => {
        const full = metrics.find((m) => m.id === metric.id);
        if (!full) return null;
        return (
          <div
            key={metric.id}
            // Two charts per page: never split a panel, force a page break
            // after every second one, and cap the width (the scatter scales
            // with it) so a pair genuinely fits one A4 page.
            className={cn(
              "mx-auto mt-4 max-w-[34rem] break-inside-avoid",
              i % 2 === 1 && "print:break-after-page"
            )}
          >
            <MetricDetailPanel metric={full} report={report} />
          </div>
        );
      })}
    </div>
  );
}
