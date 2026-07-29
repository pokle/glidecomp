/**
 * One validity factor's curve, with the day's single point on it.
 *
 * Sparkline scale, drawn inline beside the row it explains rather than as a
 * figure. That is a deliberate difference from the component charts: a
 * validity factor is a fact about the TASK — it has exactly one point, the
 * day's — so it is an annotation on a number, not a chart the reader studies.
 * Giving it figure furniture (axes, ticks, a hover layer) would make it look
 * like somewhere to find yourself, which is the one thing it is not.
 *
 * What it earns its space with is shape. "Time validity 90.17%" tells you
 * where the day landed but not whether that was nearly full value or a steep
 * penalty; the curve shows that the S7F relationship is neither linear nor
 * intuitive, and where on it this day fell.
 *
 * Accessibility: `role="img"` with the caption as its accessible name — the
 * row beside it already carries the exact percentage, so this adds shape for
 * sighted readers and repeats nothing for anyone else.
 */
import type { ScoreValidityChart } from "@glidecomp/engine";
import { linearScale } from "./scale";

const W = 116;
const H = 34;
const PAD = 4;

export function ValiditySparkline({ chart }: { chart: ScoreValidityChart }) {
  const { curve, point, caption } = chart;
  if (curve.length < 2) return null;

  // Both axes are fixed [0, 1] fractions, so the sparkline's shape is
  // comparable between factors and between tasks — a scale fitted to each
  // day's data would make every day look the same.
  const x = linearScale([0, 1], [PAD, W - PAD]);
  const y = linearScale([0, 1], [H - PAD, PAD]);
  const path = `M${curve
    .map((c) => `${x(c.x).toFixed(1)},${y(c.y).toFixed(1)}`)
    .join("L")}`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      role="img"
      aria-label={caption}
      className="shrink-0"
    >
      {/* Droplines to both axes: they are what turn "a dot on a line" into a
          reading, by tying the day's ratio and its validity to the edges. */}
      <line
        x1={x(point.x)}
        y1={y(point.y)}
        x2={x(point.x)}
        y2={H - PAD}
        className="stroke-muted-foreground/40"
        strokeWidth={1}
        strokeDasharray="2 2"
      />
      <line
        x1={PAD}
        y1={y(point.y)}
        x2={x(point.x)}
        y2={y(point.y)}
        className="stroke-muted-foreground/40"
        strokeWidth={1}
        strokeDasharray="2 2"
      />
      <path
        d={path}
        fill="none"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="stroke-foreground/70"
      />
      <circle
        cx={x(point.x)}
        cy={y(point.y)}
        r={3}
        className="fill-chart-1 stroke-background stroke-1"
      />
    </svg>
  );
}
