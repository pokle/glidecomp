/**
 * Pilots × metrics percentile heatmap — do the top pilots' strengths
 * cluster, or does everyone win differently?
 *
 * Pilots run down the side in published-rank order. Behaviours run across,
 * ordered by how strongly each one went with the placings (see
 * {@link heatmapColumns}) — NOT by metric family, which was the old order and
 * carried no information about the question this chart asks: a strong
 * separator and a pure-noise metric sat side by side and the picture was
 * confetti. Each cell is the pilot's DIRECTION-ADJUSTED percentile in the
 * field for that metric (100 = best), painted as a single-hue luminance ramp —
 * light to dark survives colour-blindness where a hue ramp would not.
 * Neutral-direction metrics (†) show raw position instead: orienting them
 * would claim a good/bad direction the metric doesn't have.
 *
 * This is the one view the per-family tables can't give. Sorted, the whole
 * chart has a gradient: a field that was separated by something shades dark in
 * the TOP-LEFT and pales to the right, and the behaviours that ran
 * counter-intuitively (dark at the BOTTOM) collect at the far right — visible
 * from across the room.
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
  formatMetricValue,
  type CorrelationVerdict,
  type FieldAnalysisReport,
  type MetricReport,
} from "../types";
import { unitWords, verdictWords } from "../units";
import { usePilotHighlight } from "../PilotHighlightContext";
import { directionAdjustedPercentile, orientedRho } from "./chart-utils";

/** One run of consecutive columns sharing a verdict — the band across the top. */
export interface HeatmapBand {
  /** Stable within one band row: the same verdict can appear at both ends. */
  key: string;
  /** One word — a band is often only a column or two wide. */
  label: string;
  /** The full verdict phrase, as the badges above say it. */
  title: string;
  span: number;
}

/**
 * The band's one-word form of a verdict. The full phrases ("could be chance")
 * are what the ranking's badges say and stay on each band's title, but a band
 * is frequently ONE column — ~30px — and the full phrases came out as
 * "could be ch… som… could be chance", which is worse than useless.
 *
 * "noise" for `within noise` is not a new coinage: VerdictLegend already
 * glosses "could be chance" as «in the statistics: within noise» on this same
 * page, so the short word has been defined for the reader before they reach it.
 */
function bandWords(verdict: CorrelationVerdict): string {
  switch (verdict) {
    case "strong":
      return "clear";
    case "moderate":
      return "some";
    case "weak":
      return "faint";
    case "within noise":
      return "noise";
    case "n too small":
      return "too few";
    default:
      return verdict;
  }
}

export interface HeatmapColumns {
  metrics: MetricReport[];
  bands: HeatmapBand[];
}

/**
 * The columns, in the order that makes the chart readable, plus the verdict
 * band over them. Pure and exported so the ordering can be tested without a
 * rendering harness.
 *
 * Dropped: metrics with no usable value anywhere (an all-blank column is
 * noise), and OUTCOME-derived metrics — "race time behind the leader" tracks
 * rank by construction, so sorted it would take the leftmost slot with a
 * near-perfect gradient and read as the finding. `rankMetrics()` in
 * SeparationRanking excludes them for that reason; the heatmap was the odd one
 * out. Their values stay in the Race craft tables and the outcome-checks table.
 *
 * Ordered by {@link orientedRho} descending: the behaviours whose better end
 * went with better placings first, the ones that said nothing in the middle,
 * the ones that ran the other way last. Ties break on id so the order is
 * deterministic — these pages are server-rendered, and an unstable sort is a
 * hydration mismatch.
 *
 * The bands are runs of consecutive equal verdict, deliberately not a group-by:
 * signed ordering makes the verdicts non-contiguous, and that IS the reading —
 * the band ramps down from "clear pattern" into "could be chance" and back out
 * the other side. Metrics that earned no coefficient sort at 0, landing amongst
 * the noise where they make the smallest claim, under their own band.
 */
export function heatmapColumns(metrics: MetricReport[]): HeatmapColumns {
  const ordered = metrics
    .filter((m) => !m.outcome && m.perPilot.some((p) => p.value !== null))
    // Plain codepoint compare, not localeCompare: the tie-break exists to make
    // the order reproducible between workerd (SSR) and the browser, and
    // collation is exactly the kind of thing that differs between two ICUs.
    .sort((a, b) => orientedRho(b) - orientedRho(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const bands: HeatmapBand[] = [];
  ordered.forEach((m, i) => {
    const label = m.correlation ? bandWords(m.correlation.verdict) : "no reading";
    const title = m.correlation ? verdictWords(m.correlation.verdict) : "no coefficient";
    const last = bands.at(-1);
    if (last && last.label === label) last.span++;
    else bands.push({ key: `${label}-${i}`, label, title, span: 1 });
  });

  return { metrics: ordered, bands };
}

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

  const { metrics, bands, rows } = useMemo(() => {
    const { metrics, bands } = heatmapColumns(report.metrics);

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
    return { metrics, bands, rows };
  }, [report]);

  if (rows.length === 0 || metrics.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No usable metric values, so there is nothing to paint.
      </p>
    );
  }

  const metricCount = metrics.length;
  const hasNeutral = metrics.some((m) => m.direction === "neutral");
  const gridTemplate = {
    display: "grid",
    gridTemplateColumns: `minmax(7rem, 10rem) repeat(${metricCount}, minmax(8px, 1fr))`,
    gap: "1px",
  } as const;

  function readoutText({ row, cell }: { row: HeatRow; cell: HeatCell }): string {
    // The family used to be the band across the top; with the band saying
    // something more useful, the readout is where a column's family lives.
    const subject = `${row.name} — ${cell.metric.label} (${
      FAMILY_LABELS[cell.metric.family]
    })`;
    if (cell.value === null || cell.pct === null) {
      return `${subject}: not applicable.`;
    }
    const position =
      cell.metric.direction === "neutral"
        ? `${Math.round(cell.pct)}th percentile by value (no good/bad direction)`
        : `better than ${Math.round(cell.pct)}% of the field`;
    return `${subject}: ${formatMetricValue(cell.metric.unit, cell.value)} ${unitWords(
      cell.metric.unit
    )}, ${position}.`;
  }

  return (
    <figure className="space-y-1">
      <div
        role="img"
        aria-label={`Percentile heatmap: ${rows.length} pilots in rank order down the side against ${metricCount} behaviours across, ordered from the behaviours that most went with better placings on the left, through the ones that separated nobody, to the ones that ran the other way on the right. Darker means a better percentile in the field. The family tables below carry every value.`}
        onMouseLeave={() => {
          setReadout(null);
          setHighlight(null);
        }}
      >
        {/* How much pattern each stretch of columns holds — the ruler the
            sorted order needs. Replaced the metric-family band, which grouped
            by something this chart isn't asking about. */}
        <div style={gridTemplate} aria-hidden>
          <div />
          {bands.map((b) => (
            <div
              key={b.key}
              style={{ gridColumn: `span ${b.span}` }}
              title={b.title}
              className="truncate border-b pb-0.5 text-[10px] font-medium text-muted-foreground"
            >
              {b.label}
            </div>
          ))}
        </div>

        {/* Metric headers, rotated to fit. */}
        <div style={gridTemplate} aria-hidden>
          <div />
          {metrics.map((m) => (
            <div key={m.id} className="flex h-24 items-end justify-center pb-1">
              <span className="max-h-full truncate text-[10px] text-muted-foreground [writing-mode:vertical-rl] rotate-180">
                {m.shortLabel ?? m.label}
                {m.direction === "neutral" ? "†" : ""}
              </span>
            </div>
          ))}
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
        The pilots in rank order against every behaviour. A darker cell is a
        better percentile in this field, and an empty cell is a behaviour that
        does not apply. The columns start with the behaviours whose better end
        went with better places, continue through the behaviours that separated
        nobody, and end with the behaviours that ran the other way. A field
        that one behaviour separated therefore shades dark in the top-left
        corner, and a field where each pilot won differently does not. The band
        above rates how much pattern each group of columns holds: a{" "}
        <strong>clear</strong>,{" "}
        <strong>some</strong> or <strong>faint</strong> pattern,{" "}
        <strong>noise</strong> (could be chance), or <strong>too few</strong>{" "}
        pilots to tell. The family sections below carry the exact values.
        {hasNeutral
          ? " † This behaviour has no good or bad direction. The shade is the position in the field, and not the quality."
          : null}
      </figcaption>
    </figure>
  );
}
