/**
 * How far the field got, as a histogram, with the thresholds that judge it.
 *
 * The one chart on the report card that is not a scoring function. Distance
 * validity's ratio is used as-is once computed, so its "curve" is the identity
 * line and drawing it would explain nothing; what a reader needs is the shape
 * the ratio comes FROM. Bars, not dots, because the question here is "how many
 * pilots landed around there" — a count per bucket — and not "where is my
 * value on a function".
 *
 * The markers are what make it an explanation rather than a picture: the
 * minimum distance below which a flight is scored as the minimum anyway, the
 * nominal distance the day is measured against, and the reader's own distance.
 * Seeing your own line sitting inside the big bar at 20 km, well short of
 * nominal, is the whole story of a low-validity day in one glance.
 *
 * Accessibility: `role="img"` with the caption as its accessible name (the
 * caption states the field size, this pilot's distance, and how many they beat
 * — the readings the picture carries). The section's own item rows remain the
 * exact figures.
 */
import type { ScoreDistributionChart } from "@glidecomp/engine";
import { cn } from "@/react/lib/utils";
import { linearScale } from "./scale";

const W = 520;
const H = 130;
const MARGIN = { top: 22, right: 14, bottom: 26, left: 14 };
/** Surface gap between adjacent bars, so counts read as separate buckets. */
const BAR_GAP = 2;

export function DistributionBars({ chart }: { chart: ScoreDistributionChart }) {
  const { bins, markers, xLabel, caption } = chart;
  if (bins.length === 0) return null;

  const plot = {
    left: MARGIN.left,
    right: W - MARGIN.right,
    top: MARGIN.top,
    bottom: H - MARGIN.bottom,
  };
  const xMax = bins[bins.length - 1].x1;
  const maxCount = Math.max(...bins.map((b) => b.count), 1);
  const x = linearScale([0, xMax], [plot.left, plot.right]);
  const y = linearScale([0, maxCount], [plot.bottom, plot.top]);

  const km = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

  return (
    <figure className="mt-3 space-y-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={caption}
      >
        {/* Baseline: the bars stand on it, and it is the x axis. */}
        <line
          x1={plot.left}
          x2={plot.right}
          y1={plot.bottom}
          y2={plot.bottom}
          className="stroke-border"
          strokeWidth={1}
        />

        {bins.map((b) =>
          b.count > 0 ? (
            <rect
              key={b.x0}
              x={x(b.x0) + BAR_GAP / 2}
              y={y(b.count)}
              width={Math.max(1, x(b.x1) - x(b.x0) - BAR_GAP)}
              height={plot.bottom - y(b.count)}
              rx={2}
              className="fill-muted-foreground/35"
            />
          ) : null
        )}

        {/* Thresholds. The reader's own distance wears the accent and a label
            above the plot; the spec's two parameters stay muted, because they
            are context for the bars rather than things to find yourself in. */}
        {markers.map((m) => (
          <g key={m.label}>
            <line
              x1={x(m.x)}
              x2={x(m.x)}
              y1={plot.top - 6}
              y2={plot.bottom}
              strokeWidth={m.you ? 2 : 1}
              strokeDasharray={m.you ? undefined : "3 3"}
              className={cn(
                m.you ? "stroke-chart-1" : "stroke-muted-foreground/60"
              )}
            />
            <text
              aria-hidden
              x={Math.min(plot.right, Math.max(plot.left, x(m.x)))}
              y={plot.top - 10}
              textAnchor={
                x(m.x) > (plot.left + plot.right) / 2 ? "end" : "start"
              }
              className={cn(
                "fill-current stroke-background text-[10px] [paint-order:stroke] [stroke-width:3px]",
                m.you ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {m.label}
            </text>
          </g>
        ))}

        {/* Just the ends of the axis: with bars this wide, intermediate ticks
            add ink without adding a reading the caption does not already give. */}
        <g aria-hidden className="text-[10px] text-muted-foreground">
          <text x={plot.left} y={plot.bottom + 14} className="fill-current">
            0
          </text>
          <text
            x={plot.right}
            y={plot.bottom + 14}
            textAnchor="end"
            className="fill-current"
          >
            {km(xMax)}
          </text>
          <text
            x={(plot.left + plot.right) / 2}
            y={H - 2}
            textAnchor="middle"
            className="fill-current"
          >
            {xLabel}
          </text>
        </g>
      </svg>
      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
