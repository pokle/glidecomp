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
 * selected metric renders as a rank scatter beside it — the coefficient says
 * a metric separated the field; the scatter shows whether that is a clean
 * trend, two clusters, or one outlier. The top-ranked metric starts
 * selected, so the strongest finding is visualized on first paint.
 *
 * Table and chart are a MASTER/DETAIL PAIR (issue #455), laid out by the
 * shared {@link MasterDetail}: the chart pins to the top of the viewport on a
 * narrow screen and sits beside the table on a wide one. Everything that used
 * to sit between them — the verdict legend, the caveat paragraphs — is below
 * the pair now, because a row and the chart it selects have to be readable
 * without scrolling between them. The component's doc carries the whys (the
 * container query, the pinning, the WCAG 2.4.11 debts).
 */
import { useId, useState } from "react";
import type { Key, Selection } from "react-aria-components";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { DivergingMeter, ProportionMeter } from "@/react/rac/meter";
import { Badge } from "@/react/rac/badge";
import { MasterDetail } from "@/react/components/MasterDetail";
import { cn } from "@/react/lib/utils";
import { Explain } from "@/react/rac/explain";
import { MetricExplanation } from "./MetricExplanation";
import {
  OutcomeChecksNote,
  PilotsMeasuredNote,
  StrengthNote,
  VerdictLegend,
} from "./ReadingNotes";
import { verdictWords } from "./units";
import { MetricDetailPanel } from "./charts/MetricDetailPanel";
import { MetricChartOverlay } from "./charts/MetricChartOverlay";
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

/** The strongest correlation among a set of metrics — the badge on each
 * family, which needs the whole correlation (not just |ρ|) to name its
 * verdict. Outcome-derived metrics don't count: a family must not owe its
 * headline to a metric that correlates by construction. */
export function bestCorrelation(metrics: MetricReport[]): MetricCorrelation | null {
  return metrics.reduce<MetricCorrelation | null>((best, m) => {
    if (!m.correlation || m.outcome) return best;
    return best === null || m.correlation.absRho > best.absRho ? m.correlation : best;
  }, null);
}

/** Just the magnitude of {@link bestCorrelation}. */
export function bestAbsRho(metrics: MetricReport[]): number | null {
  return bestCorrelation(metrics)?.absRho ?? null;
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
  const detailHeadingId = `${useId()}-heading`;
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
        No metric produced a correlation. The field is too small, or too few
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
        {/* The heading already asks the question ("which behaviours went with
            better ranks"), so one clause is enough here. What ρ is, which
            sign is good, and what "pilots measured" is worth are on the
            column headers' ⓘ — and in HowToReadFootnote, for paper. */}
        Each row is one behaviour, compared against the published ranks.
        {report ? (
          // An instruction to interact — meaningless on paper.
          <span className="print:hidden"> Select a row to plot it against rank.</span>
        ) : null}
      </p>

      {ranked.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No behaviour produced a correlation. The field is too small, or too
          few pilots had a usable value.
        </p>
      ) : (
        <MasterDetail
          stackedTop="toc-bar"
          detailLabel="chart"
          master={
            <RankingTable
              ranked={ranked}
              ariaLabel="Behaviour ranking"
              subjectLabel="Behaviour"
              // Stacked, the table spans the panel edge to edge: the card's
              // 20px of side padding is a tenth of a phone's width, and paying
              // it here pushed the Strength column into a sideways scroll the
              // old full-width layout never had. Horizontal rules only, since
              // the box now meets the card's own sides.
              //
              // Side by side the bleed comes off — the column is already
              // inside the grid. w-auto is load-bearing: the viewport is
              // `w-full`, so negative margins alone would slide it left
              // rather than widen it.
              viewportClassName={cn(
                "-mx-5 w-auto border-y",
                "@5xl:mx-0 @5xl:w-full @5xl:border-y-0"
              )}
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
          }
          detail={
            report && selectedMetric ? (
              <MetricDetailPanel
                metric={selectedMetric}
                report={report}
                headingId={detailHeadingId}
                showAllLabels={showAllLabels}
                onShowAllLabelsChange={setShowAllLabels}
                methodClassName="hidden @5xl:block"
                className="rounded-none border-0"
                // The pinned pane is a few hundred pixels on a phone, which
                // is not enough chart to read; this is the way to the whole
                // screen. Useful at every width, so it is not narrow-only.
                headerAction={
                  <MetricChartOverlay
                    metric={selectedMetric}
                    pilots={report.pilots}
                    showAllLabels={showAllLabels}
                    onShowAllLabelsChange={setShowAllLabels}
                  />
                }
              />
            ) : null
          }
          detailHeadingId={detailHeadingId}
          // On paper the print-only strong-metric panels below replace the
          // interactive one — printing both would duplicate a chart. When no
          // metric earned "strong", this pane is all print gets, so it stays.
          hideDetailInPrint={strongMetrics(ranked).length > 0}
        />
      )}

      {/* The verdict legend and the one-day caveat used to sit here as two
          paragraphs of statistics under every ranking. They are on the column
          headers' ⓘ now, and printed in HowToReadFootnote. What stays visible
          is the COUNT below: a fact about this report, not a method note. */}
      {underpowered.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {underpowered.length} behaviour{underpowered.length === 1 ? " was" : "s were"}{" "}
          measured on fewer than {MIN_CORRELATION_N} pilots — too few to tell
          either way.
        </p>
      ) : null}

      {report ? <StrongMetricPrintCharts ranked={ranked} metrics={metrics} report={report} /> : null}

      {outcomeRanked.length > 0 ? (
        <div className="space-y-2 pt-2">
          <h3 className="flex items-center gap-1 text-base font-semibold">
            Outcome checks
            <Explain label="Outcome checks">
              <OutcomeChecksNote />
              <p>
                Their per-pilot tables stay in the Race craft section below.
              </p>
            </Explain>
          </h3>
          <p className="text-sm text-muted-foreground">
            These measure the result, not a behaviour, so they always follow the
            ranks.
          </p>
          <RankingTable
            ranked={outcomeRanked}
            ariaLabel="Outcome checks"
            subjectLabel="Outcome"
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
  subjectLabel,
  fieldSize,
  pilots,
  selection,
  viewportClassName,
}: {
  ranked: RankedMetric[];
  ariaLabel: string;
  /** Classes for the table's scroll viewport — see rac/table's Table. */
  viewportClassName?: string;
  /** First column's header. "Behaviour" for the ranking, "Outcome" for the
   * checks below it — the engine calls both a metric, but the reader is owed
   * the distinction: one is something a pilot did, the other is the result
   * they got. */
  subjectLabel: string;
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
      viewportClassName={viewportClassName}
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
          {subjectLabel}
        </Column>
        {/* No aria-labels on these headers any more: the columns they
            replaced were named "ρ" and "n", symbols a screen reader can only
            spell out. "Strength" and "Pilots measured" say themselves, and an
            aria-label would override the visible name for no gain.
            Each carries the ⓘ holding the paragraph that used to explain it
            below the table; all three are printed in HowToReadFootnote. */}
        <Column className="w-48">
          <HeaderWithNote label="Strength">
            <StrengthNote />
          </HeaderWithNote>
        </Column>
        <Column className="w-32">
          <HeaderWithNote label="What it means">
            <VerdictLegend />
          </HeaderWithNote>
        </Column>
        <Column className="w-36">
          <HeaderWithNote label="Pilots measured">
            <PilotsMeasuredNote />
          </HeaderWithNote>
        </Column>
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

/**
 * A column header with its ⓘ. `whitespace-normal` because the kit's Column is
 * `whitespace-nowrap` and "Pilots measured" plus a 24px button does not fit a
 * 9rem column on one line.
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
            <MetricDetailPanel metric={full} report={report} headingLevel={4} />
          </div>
        );
      })}
    </div>
  );
}
