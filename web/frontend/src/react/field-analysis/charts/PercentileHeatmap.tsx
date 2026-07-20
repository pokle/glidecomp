/**
 * Pilots × metrics percentile heatmap — do the top pilots' strengths
 * cluster, or does everyone win differently?
 *
 * Pilots run down the side in published-rank order; all metrics run across,
 * grouped by family. Each cell is the pilot's DIRECTION-ADJUSTED percentile
 * in the field for that metric (100 = best), painted as a single-hue
 * luminance ramp — light to dark survives colour-blindness where a hue ramp
 * would not. Neutral-direction metrics (†) show raw position instead:
 * orienting them would claim a good/bad direction the metric doesn't have.
 *
 * This is the one view the per-family tables can't give: if climbing is
 * what separated this field, the top rows run dark through the climbing
 * columns and pale elsewhere — visible from across the room.
 *
 * Accessibility: the grid is one `role="img"` figure; its data equivalent
 * is the family tables below (which are keyboard-navigable and carry every
 * value), named via the caption. Hovering a cell writes the full reading
 * into a readout line; hovering a row highlights that pilot page-wide.
 */
import { useMemo, useState } from "react";
import { cn } from "@/react/lib/utils";
import {
  FAMILY_LABELS,
  FAMILY_ORDER,
  formatMetricValue,
  type FieldAnalysisReport,
  type MetricReport,
} from "../types";
import { unitWords } from "../units";
import { usePilotHighlight } from "../PilotHighlightContext";
import { directionAdjustedPercentile } from "./chart-utils";

interface HeatCell {
  metric: MetricReport;
  value: number | null;
  /** Direction-adjusted (or raw, for neutral) percentile, 0–100. */
  pct: number | null;
}

interface HeatRow {
  trackFile: string;
  name: string;
  rank: number;
  cells: HeatCell[];
}

export function PercentileHeatmap({ report }: { report: FieldAnalysisReport }) {
  const { highlight, setHighlight } = usePilotHighlight();
  const [readout, setReadout] = useState<{ row: HeatRow; cell: HeatCell } | null>(null);

  // Metrics in family order, dropping any with no usable values at all
  // (e.g. the per-pilot-null day metrics) — an all-blank column is noise.
  const { groups, rows } = useMemo(() => {
    const groups = FAMILY_ORDER.map((family) => ({
      family,
      label: FAMILY_LABELS[family],
      metrics: report.metrics.filter(
        (m) => m.family === family && m.perPilot.some((p) => p.value !== null)
      ),
    })).filter((g) => g.metrics.length > 0);
    const metrics = groups.flatMap((g) => g.metrics);

    const pctByMetric = new Map(
      metrics.map((m) => {
        const usable = m.perPilot.flatMap((p) =>
          p.value !== null && Number.isFinite(p.value) ? [p.value] : []
        );
        return [
          m.id,
          new Map(
            m.perPilot.map((p) => [
              p.trackFile,
              p.value === null || !Number.isFinite(p.value)
                ? null
                : directionAdjustedPercentile(m.direction, usable, p.value),
            ])
          ),
        ];
      })
    );
    const valueByMetric = new Map(
      metrics.map((m) => [m.id, new Map(m.perPilot.map((p) => [p.trackFile, p.value]))])
    );

    const rows: HeatRow[] = [...report.pilots]
      .sort((a, b) => a.rank - b.rank)
      .map((p) => ({
        trackFile: p.trackFile,
        name: p.pilotName,
        rank: p.rank,
        cells: metrics.map((m) => ({
          metric: m,
          value: valueByMetric.get(m.id)?.get(p.trackFile) ?? null,
          pct: pctByMetric.get(m.id)?.get(p.trackFile) ?? null,
        })),
      }));
    return { groups, rows };
  }, [report]);

  if (rows.length === 0 || groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No usable metric values, so there is nothing to paint.
      </p>
    );
  }

  const metricCount = groups.reduce((n, g) => n + g.metrics.length, 0);
  const hasNeutral = groups.some((g) => g.metrics.some((m) => m.direction === "neutral"));
  const gridTemplate = {
    display: "grid",
    gridTemplateColumns: `minmax(7rem, 10rem) repeat(${metricCount}, minmax(8px, 1fr))`,
    gap: "1px",
  } as const;

  function readoutText({ row, cell }: { row: HeatRow; cell: HeatCell }): string {
    if (cell.value === null || cell.pct === null) {
      return `${row.name} — ${cell.metric.label}: not applicable.`;
    }
    const position =
      cell.metric.direction === "neutral"
        ? `${Math.round(cell.pct)}th percentile by value (no good/bad direction)`
        : `better than ${Math.round(cell.pct)}% of the field`;
    return `${row.name} — ${cell.metric.label}: ${formatMetricValue(
      cell.metric.unit,
      cell.value
    )} ${unitWords(cell.metric.unit)}, ${position}.`;
  }

  return (
    <figure className="space-y-1">
      <div
        role="img"
        aria-label={`Percentile heatmap: ${rows.length} pilots in rank order against ${metricCount} metrics grouped by family. Darker means a better percentile in the field. The family tables below carry every value.`}
        onMouseLeave={() => {
          setReadout(null);
          setHighlight(null);
        }}
      >
        {/* Family group headers. */}
        <div style={gridTemplate} aria-hidden>
          <div />
          {groups.map((g) => (
            <div
              key={g.family}
              style={{ gridColumn: `span ${g.metrics.length}` }}
              className="truncate border-b pb-0.5 text-[10px] font-medium text-muted-foreground"
            >
              {g.label}
            </div>
          ))}
        </div>

        {/* Metric headers, rotated to fit. */}
        <div style={gridTemplate} aria-hidden>
          <div />
          {groups.flatMap((g) =>
            g.metrics.map((m) => (
              <div key={m.id} className="flex h-24 items-end justify-center pb-1">
                <span className="max-h-full truncate text-[10px] text-muted-foreground [writing-mode:vertical-rl] rotate-180">
                  {m.shortLabel ?? m.label}
                  {m.direction === "neutral" ? "†" : ""}
                </span>
              </div>
            ))
          )}
        </div>

        {rows.map((row) => (
          <div
            key={row.trackFile}
            style={gridTemplate}
            className={cn(
              "group",
              highlight === row.trackFile && "bg-accent"
            )}
            onMouseEnter={() => setHighlight(row.trackFile)}
          >
            <div className="truncate pr-2 text-right text-xs leading-4 text-muted-foreground group-hover:text-foreground">
              <span className="tabular-nums">{row.rank}.</span> {row.name}
            </div>
            {row.cells.map((cell) => (
              <div
                key={cell.metric.id}
                // print-color-adjust: the shade IS the data — without it,
                // browsers strip the background and print an empty grid.
                className="h-4 rounded-[2px] [print-color-adjust:exact]"
                style={
                  cell.pct === null
                    ? undefined
                    : {
                        background: `color-mix(in oklab, var(--chart-1) ${Math.round(
                          cell.pct
                        )}%, var(--muted))`,
                      }
                }
                onMouseEnter={() => setReadout({ row, cell })}
              />
            ))}
          </div>
        ))}
      </div>

      {/* Visual mirror of hover; the family tables are the accessible read.
          Hidden in print — an invitation to hover is meaningless on paper. */}
      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout
          ? readoutText(readout)
          : "Hover a cell for the pilot, value, and percentile behind it."}
      </p>

      <figcaption className="text-xs text-muted-foreground">
        Pilots in rank order against every metric: darker = a better percentile
        in this field (empty = not applicable). Column order follows the family
        sections below, which carry the exact values.
        {hasNeutral
          ? " † No good/bad direction — shade is position in the field, not quality."
          : null}
      </figcaption>
    </figure>
  );
}
