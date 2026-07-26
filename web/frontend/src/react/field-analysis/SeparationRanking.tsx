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
import { DivergingMeter, ProportionMeter } from "@/react/rac/meter";
import { Badge } from "@/react/rac/badge";
import { cn } from "@/react/lib/utils";
import { MetricExplanation } from "./MetricExplanation";
import { verdictWords } from "./units";
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

/** Shared verdict chip (also used by the comp page). "could be chance" and
 * "too few pilots" deliberately wear the quietest style — they are warnings
 * that the number may be luck, not findings. */
export function VerdictBadge({ correlation }: { correlation: MetricCorrelation }) {
  const variant =
    correlation.verdict === "strong"
      ? "default"
      : correlation.verdict === "moderate"
        ? "secondary"
        : "outline";
  return <Badge variant={variant}>{verdictWords(correlation.verdict)}</Badge>;
}

/** What every verdict chip means, in the thresholds behind it — rendered
 * under both the task ranking and the comp aggregate. The chips read as plain
 * English ("could be chance"); this is where the statistics they stand for are
 * spelled out, so the plain words are never the whole story a curious reader
 * can get. */
export function VerdictLegend() {
  return (
    <p className="text-xs text-muted-foreground">
      <strong>clear pattern</strong> is |ρ| ≥ 0.5, <strong>some pattern</strong> ≥ 0.3
      and <strong>faint pattern</strong> below — each only once |ρ| clears the noise
      floor for that metric's n. <strong>could be chance</strong> (in the statistics:
      within noise) means shuffled ranks produce a coefficient that size more than 5%
      of the time, so it is indistinguishable from luck whatever its magnitude.{" "}
      <strong>too few pilots</strong> is fewer than {MIN_CORRELATION_N} pilots with a
      value — not enough to tell either way.
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
  // The denominator behind every "19 of 29": the pilots this report analysed.
  // Without the report (metrics-only callers) the widest correlation is the
  // best available stand-in for the field size.
  const fieldSize =
    report?.pilots.length ??
    Math.max(0, ...[...ranked, ...outcomeRanked].map((r) => r.correlation.n));

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {/* Lead with the question the table answers, not with the statistic
            that answers it — the column names promise a reading ("what it
            means"), so the intro has to say a reading of WHAT. */}
        Which behaviours went with better placings, and how much to trust each
        one. Every row correlates one metric against the published rank
        (Spearman ρ); rank 1 is best, so a metric where more is better shows a{" "}
        <strong>negative</strong> ρ. Bigger bars mean the metric separated the
        field more sharply on this task, and{" "}
        <strong>pilots measured</strong> is how much of the analysed field the
        metric applied to — a coefficient drawn from half the field is a
        thinner finding than one drawn from all of it.
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
        <RankingTable
          ranked={ranked}
          ariaLabel="Metric separation ranking"
          fieldSize={fieldSize}
          pilots={report?.pilots}
          selection={
            report
              ? {
                  selectedKeys: effectiveId !== null ? [effectiveId] : [],
                  onSelectionChange: (keys: Selection) => {
                    if (keys !== "all") setSelectedId([...keys][0] ?? null);
                  },
                }
              : undefined
          }
        />
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
          <RankingTable
            ranked={outcomeRanked}
            ariaLabel="Outcome checks"
            fieldSize={fieldSize}
            pilots={report?.pilots}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * One ranking table, shared by the behavioural ranking and the outcome checks
 * so the two can never drift in layout.
 *
 * Four columns, not six. ρ is printed inside the Strength cell it describes —
 * the bar is what carries at a glance, and a column of two-decimal
 * coefficients ahead of it was a wall to get past before reading any of them.
 * n is a bar too, reading "19 of 29": the bare count meant nothing without the
 * field size, which lived far up the page in the analysis basis. And the
 * family column is gone — the metric names say what they measure, and each
 * metric's family is one ⓘ away as well as being the heading of the chapter it
 * belongs to further down the page.
 */
function RankingTable({
  ranked,
  ariaLabel,
  fieldSize,
  pilots,
  selection,
}: {
  ranked: RankedMetric[];
  ariaLabel: string;
  /** Pilots analysed — the denominator of the coverage column. */
  fieldSize: number;
  /** Passed to each ⓘ so it can name the pilots a metric skipped. */
  pilots?: FieldAnalysisReport["pilots"];
  /** When provided, rows are single-selectable (drives the chart below). */
  selection?: {
    selectedKeys: Key[];
    onSelectionChange: (keys: Selection) => void;
  };
}) {
  return (
    <Table
      aria-label={ariaLabel}
      scrollLabel={ariaLabel}
      {...(selection
        ? {
            selectionMode: "single" as const,
            selectionBehavior: "replace" as const,
            disallowEmptySelection: true,
            ...selection,
          }
        : {})}
    >
      <TableHeader>
        <Column isRowHeader className="min-w-56">
          Metric
        </Column>
        {/* No aria-labels on these headers any more: the columns they
            replaced were named "ρ" and "n", symbols a screen reader can only
            spell out. "Strength" and "Pilots measured" say themselves, and an
            aria-label would override the visible name for no gain. */}
        <Column className="w-48">Strength</Column>
        <Column className="w-32">What it means</Column>
        <Column className="w-36">Pilots measured</Column>
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
                  family={FAMILY_LABELS[metric.family]}
                  explanation={metric.explanation}
                  perPilot={metric.perPilot}
                  pilots={pilots}
                />
              </span>
            </Cell>
            <Cell>
              {/* min-w-24 on the bar, not just a column width: a percentage
                  width contributes nothing to a table's min-content, so on a
                  narrow screen the column would squeeze the bar — the actual
                  reading — down to a few pixels instead of letting the table
                  scroll (which its wrapper is set up for). */}
              <div className="flex items-center gap-2">
                <DivergingMeter
                  className="min-w-24 flex-1"
                  value={correlation.rho}
                  label={`${metric.label}: Spearman correlation against rank`}
                  valueLabel={correlation.rho.toFixed(2)}
                />
                {/* aria-hidden: the meter already announces this exact
                    number as its value text. */}
                <span
                  aria-hidden
                  className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
                >
                  {correlation.rho.toFixed(2)}
                </span>
              </div>
            </Cell>
            <Cell>
              <VerdictBadge correlation={correlation} />
            </Cell>
            <Cell>
              <div className="flex items-center gap-2">
                <ProportionMeter
                  className="w-16 shrink-0"
                  value={correlation.n}
                  total={fieldSize}
                  label={`${metric.label}: pilots measured`}
                  valueLabel={`${correlation.n} of ${fieldSize} pilots`}
                />
                <span
                  aria-hidden
                  className="text-xs tabular-nums text-muted-foreground"
                >
                  {correlation.n} of {fieldSize}
                </span>
              </div>
            </Cell>
          </Row>
        ))}
      </TableBody>
    </Table>
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
        Metrics with a clear pattern, plotted against rank
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
