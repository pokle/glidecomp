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

export function rankMetrics(metrics: MetricReport[]): RankedMetric[] {
  return metrics
    .flatMap((m) => (m.correlation ? [{ metric: m, correlation: m.correlation }] : []))
    .sort((a, b) => b.correlation.absRho - a.correlation.absRho);
}

/** The strongest |ρ| among a set of metrics — the badge on each family. */
export function bestAbsRho(metrics: MetricReport[]): number | null {
  const values = metrics.flatMap((m) => (m.correlation ? [m.correlation.absRho] : []));
  return values.length > 0 ? Math.max(...values) : null;
}

function VerdictBadge({ correlation }: { correlation: MetricCorrelation }) {
  const variant =
    correlation.verdict === "strong"
      ? "default"
      : correlation.verdict === "moderate"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{correlation.verdict}</Badge>;
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

  if (ranked.length === 0) {
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
        {report ? " Select a row to see that metric plotted against rank." : null}
      </p>

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
                    label={metric.label}
                    unit={metric.unit}
                    direction={metric.direction}
                    explanation={metric.explanation}
                    perPilot={metric.perPilot}
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

      {underpowered.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {underpowered.length} metric{underpowered.length === 1 ? "" : "s"}{" "}
          correlated fewer than {MIN_CORRELATION_N} pilots — treat those rows as
          indicative only.
        </p>
      ) : null}

      {report && selectedMetric ? (
        <MetricDetailPanel
          metric={selectedMetric}
          report={report}
          showAllLabels={showAllLabels}
          onShowAllLabelsChange={setShowAllLabels}
        />
      ) : null}
    </div>
  );
}
