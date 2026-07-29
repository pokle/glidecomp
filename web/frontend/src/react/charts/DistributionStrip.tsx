/**
 * How far the field got, as one dot per pilot on a single lane.
 *
 * The same encoding as the takeoff lane on the field-analysis day profile
 * (`day-profile/ClimbHourlyChart.tsx`), and for the same reason: with a few
 * dozen values on one axis, individual marks read better than bins. A
 * histogram has to choose a bucket width, and at this size the buckets read as
 * an arbitrary grid laid over the data rather than as the shape of it — you
 * end up looking at the container. Dots have no such parameter. Where the
 * field bunched they overlap and darken, and "how many pilots are near me" is
 * answered by looking rather than by reading bar heights.
 *
 * The one chart on the report card that is not a scoring function. Distance
 * validity's ratio is used as-is once computed, so its "curve" is the identity
 * line and drawing it would explain nothing; what a reader needs is the shape
 * the ratio comes FROM.
 *
 * The markers are what make it an explanation rather than a picture: the
 * minimum distance below which a flight is scored as the minimum anyway, the
 * nominal distance the day is measured against, and the reader's own distance.
 * Seeing your own line sitting in a dense clump well short of nominal is the
 * whole story of a low-validity day in one glance.
 *
 * Accessibility: `role="img"` with the caption as its accessible name — the
 * caption states the field size, this pilot's distance and how many they beat,
 * which are the readings the picture carries. The section's own item rows
 * remain the exact figures. Non-interactive by design, matching the
 * field-analysis strip it is modelled on.
 */
import type { ScoreDistributionChart } from "@glidecomp/engine";
import { cn } from "@/react/lib/utils";
import { linearScale } from "./scale";

const W = 520;
const H = 100;
const MARGIN = { right: 14, left: 14 };
/** The lane the dots sit on. */
const LANE_Y = 58;
/** Dot radius, matching the day profile's takeoff lane. */
const DOT_R = 3;
/**
 * Baselines for marker labels, nearest the lane first.
 *
 * Two rows because the markers genuinely collide: on a devalued day the
 * field's best distance sits right on top of the nominal distance, which is
 * precisely WHY the day was devalued — so the one chart that explains it must
 * not be the one that becomes unreadable. Overprinted labels ("nyounal") are
 * worse than a second row.
 */
const LABEL_ROWS = [26, 12];
/** Rough label width for collision testing, at the 10px label size. */
const labelWidth = (t: string) => t.length * 5.4;

export function DistributionStrip({ chart }: { chart: ScoreDistributionChart }) {
  const { points, markers, xLabel, caption } = chart;
  if (points.length === 0) return null;

  const plot = { left: MARGIN.left, right: W - MARGIN.right };
  const xMax = Math.max(...points.map((p) => p.x), ...markers.map((m) => m.x));
  // From zero, always: distance is a magnitude, and a strip that started at
  // the shortest flight of the day would exaggerate the spread and put the
  // minimum-distance threshold off the left edge.
  const x = linearScale([0, xMax || 1], [plot.left + DOT_R, plot.right - DOT_R]);

  const km = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`;

  // Lay the marker labels out, most important first, dropping each to the next
  // row when it would overprint one already placed. Centred and clamped by its
  // own width so the box is trivial to compute and nothing runs off an edge.
  const placedMarkers: Array<{
    label: string;
    x: number;
    you?: boolean;
    labelX: number;
    labelY: number;
  }> = [];
  const rowEnds: number[] = LABEL_ROWS.map(() => -Infinity);
  for (const m of [...markers].sort((a, b) => (b.you ? 1 : 0) - (a.you ? 1 : 0))) {
    const half = labelWidth(m.label) / 2;
    const labelX = Math.min(W - half - 2, Math.max(half + 2, x(m.x)));
    let row = LABEL_ROWS.findIndex((_, i) => labelX - half > rowEnds[i] + 4);
    if (row < 0) row = LABEL_ROWS.length - 1;
    rowEnds[row] = Math.max(rowEnds[row], labelX + half);
    placedMarkers.push({ ...m, labelX, labelY: LABEL_ROWS[row] });
  }

  return (
    <figure className="mt-3 space-y-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="img"
        aria-label={caption}
      >
        {/* The lane, so the dots sit on something rather than float. */}
        <line
          x1={plot.left}
          x2={plot.right}
          y1={LANE_Y}
          y2={LANE_Y}
          className="stroke-border"
          strokeWidth={1}
        />

        {/* Thresholds, under the dots: they are the frame the field is read
            against, and a rule drawn over a dot hides the very pilot the
            reader may be looking for.
            Placed in priority order — the reader's own mark first — so that
            when two rules are close together it is never "you" that gets
            bumped to the far row. */}
        {placedMarkers.map((m) => (
          <g key={m.label}>
            <line
              x1={x(m.x)}
              x2={x(m.x)}
              y1={m.labelY + 4}
              y2={LANE_Y + 12}
              strokeWidth={m.you ? 2 : 1}
              strokeDasharray={m.you ? undefined : "3 3"}
              className={cn(
                m.you ? "stroke-chart-1" : "stroke-muted-foreground/60"
              )}
            />
            <text
              aria-hidden
              x={m.labelX}
              y={m.labelY}
              textAnchor="middle"
              className={cn(
                "fill-current stroke-background text-[10px] [paint-order:stroke] [stroke-width:3px]",
                m.you ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {m.label}
            </text>
          </g>
        ))}

        {/* Every pilot. Partial opacity so overlap darkens — that stacking IS
            the density reading, and is why these are not bars. */}
        <g aria-hidden>
          {points.map((p) =>
            p.you ? null : (
              <circle
                key={p.key}
                cx={x(p.x)}
                cy={LANE_Y}
                r={DOT_R}
                className="fill-foreground/30"
              />
            )
          )}
        </g>

        {/* The reader, drawn last and ringed against the surface so it stays
            findable inside a dense clump of the field. */}
        {points
          .filter((p) => p.you)
          .map((p) => (
            <circle
              key={p.key}
              cx={x(p.x)}
              cy={LANE_Y}
              r={DOT_R + 2}
              className="fill-chart-1 stroke-background stroke-2"
            />
          ))}

        {/* Axis ends only: the markers already label everything that has a
            meaning, and intermediate ticks would compete with them. */}
        <g aria-hidden className="text-[10px] text-muted-foreground">
          <text x={plot.left} y={LANE_Y + 26} className="fill-current">
            0
          </text>
          <text
            x={plot.right}
            y={LANE_Y + 26}
            textAnchor="end"
            className="fill-current"
          >
            {km(xMax)}
          </text>
          <text
            x={(plot.left + plot.right) / 2}
            y={LANE_Y + 26}
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
