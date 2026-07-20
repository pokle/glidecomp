/**
 * One metric family, collapsed into a Disclosure: the per-pilot table, then
 * each metric's field-level summary lines and rich extra tables.
 *
 * Disclosure rather than Tabs so several families can be open side by side
 * for comparison (and so the page prints whole). Families that produced a
 * top-3 metric open by default — the separation ranking above just told the
 * reader those are the ones worth opening.
 */
import { useMemo } from "react";
import { Disclosure } from "@/react/rac/disclosure";
import { Badge } from "@/react/rac/badge";
import { PerPilotMetricTable } from "./PerPilotMetricTable";
import { ReportTableView, ReportTableTitle } from "./ReportTableView";
import { SeriesChart } from "./charts/SeriesChart";
import { DayProfilePanel } from "./charts/day-profile/DayProfilePanel";
import { bestAbsRho } from "./SeparationRanking";
import type { FieldAnalysisReport, MetricReport, MetricFamily } from "./types";

/** DOM id of a family's section — the TOC's scroll target. */
export function familySectionId(family: MetricFamily): string {
  return `family-${family}`;
}

/** DOM id of one metric's block (chart/tables) inside its family section. */
export function metricBlockId(metricId: string): string {
  return `metric-${metricId.replace(/\./g, "-")}`;
}

/**
 * Does this metric render a substantial block — a chart or a rich table —
 * worth its own TOC entry? Summary-only metrics stay out of the TOC or it
 * would list nearly every metric twice.
 */
export function hasMetricBlock(m: MetricReport): boolean {
  return (m.extraSeries?.length ?? 0) > 0 || (m.extraTables?.length ?? 0) > 0;
}

export function MetricFamilySection({
  family,
  familyLabel,
  metrics,
  report,
  compTimezone = null,
  defaultExpanded,
  isExpanded,
  onExpandedChange,
}: {
  family: MetricFamily;
  familyLabel: string;
  metrics: MetricReport[];
  report: FieldAnalysisReport;
  /** Competition IANA zone; report time cells render in it. */
  compTimezone?: string | null;
  defaultExpanded?: boolean;
  /** Controlled expansion (the task page owns it so the TOC can open a
   * collapsed family before scrolling to it). */
  isExpanded?: boolean;
  onExpandedChange?: (isExpanded: boolean) => void;
}) {
  // Field-level metrics (wind, climb-by-hour) carry no per-pilot values at
  // all; a column of dashes for them is noise, so they only contribute their
  // summaries and extra tables below. Memoized so PerPilotMetricTable's own
  // useMemos (keyed on this array's identity) survive parent re-renders.
  const perPilotMetrics = useMemo(
    () => metrics.filter((m) => m.perPilot.some((p) => p.value !== null)),
    [metrics]
  );

  if (metrics.length === 0) return null;

  const best = bestAbsRho(metrics);
  const failed = metrics.filter((m) => m.error);

  return (
    // The anchor div, not the Disclosure, carries the DOM id: react-aria
    // consumes `id` for its own wiring rather than forwarding it. scroll-mt
    // keeps the sticky header from covering the section when the TOC
    // scrolls here.
    <div id={familySectionId(family)} className="scroll-mt-20">
    <Disclosure
      title={familyLabel}
      defaultExpanded={defaultExpanded}
      isExpanded={isExpanded}
      onExpandedChange={onExpandedChange}
      badge={
        best !== null ? (
          <Badge variant="outline">strongest |ρ| {best.toFixed(2)}</Badge>
        ) : null
      }
    >
      <div className="space-y-4 py-3">
        {failed.map((m) => (
          <p key={m.id} role="status" className="text-sm text-destructive">
            {m.label} could not be computed: {m.error}
          </p>
        ))}

        {/* The day family opens with its series composed onto one shared
            time axis — the panel is why SeriesChart skips these kinds. */}
        {family === "day" ? (
          <DayProfilePanel metrics={metrics} compTimezone={compTimezone} />
        ) : null}

        {perPilotMetrics.length > 0 ? (
          <PerPilotMetricTable
            report={report}
            metrics={perPilotMetrics}
            familyLabel={familyLabel}
          />
        ) : null}

        {metrics.map((m) =>
          (m.fieldSummary?.length ?? 0) > 0 ||
          (m.extraTables?.length ?? 0) > 0 ||
          (m.extraSeries?.length ?? 0) > 0 ? (
            <section
              key={m.id}
              id={metricBlockId(m.id)}
              className="scroll-mt-20 space-y-1"
              aria-label={m.label}
            >
              <h4 className="text-sm font-medium">{m.label}</h4>
              {m.fieldSummary?.map((line, i) => (
                <p key={i} className="text-sm text-muted-foreground">
                  {line}
                </p>
              ))}
              {/* Charts before their tables: the shape first, the exact
                  numbers (and the accessible reading) right below. */}
              {m.extraSeries?.map((series) => (
                <SeriesChart key={series.id} series={series} report={report} />
              ))}
              {m.extraTables?.map((table) => (
                <div key={`${m.id}-${table.title}`}>
                  <ReportTableTitle table={table} />
                  <ReportTableView table={table} compTimezone={compTimezone} />
                </div>
              ))}
            </section>
          ) : null
        )}
      </div>
    </Disclosure>
    </div>
  );
}

/** Group a report's metrics by family, preserving registry order. */
export function metricsByFamily(
  metrics: MetricReport[]
): Map<MetricFamily, MetricReport[]> {
  const map = new Map<MetricFamily, MetricReport[]>();
  for (const m of metrics) {
    const list = map.get(m.family) ?? [];
    list.push(m);
    map.set(m.family, list);
  }
  return map;
}
