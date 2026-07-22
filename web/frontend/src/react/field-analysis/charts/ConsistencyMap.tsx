/**
 * Consistency map — one dot per behavioural metric: per-day power (mean |ρ|,
 * across) against consistent separation (|mean signed ρ|, up).
 *
 * |mean ρ| ≤ mean|ρ| always, so every dot sits on or below the diagonal.
 * The position IS the finding: on the diagonal, the metric pulls the same
 * way every task (a trait signal); far below it, the per-task coefficients
 * are strong but cancel (the payoff depended on the day); near the origin,
 * little signal either way.
 *
 * Axes are FIXED [0, 1] — both statistics are bounded, and a fixed frame
 * keeps maps comparable across comps instead of zooming noise into drama.
 * The separation table's "mean ρ" and "mean |ρ|" columns are the exact
 * reading behind every dot. Hand-rolled SVG per charts/chart-utils.ts.
 */
import { useRef, useState } from "react";
import { cn } from "@/react/lib/utils";
import type { CompMetricAggregate } from "../types";
import { linearScale, spreadLabels } from "./chart-utils";

const W = 560;
const H = 340;
const M = { top: 14, right: 150, bottom: 40, left: 56 };

interface MapPoint {
  metric: CompMetricAggregate;
  x: number; // mean |ρ|
  y: number; // |mean signed ρ|
}

function pointLabel(p: MapPoint): string {
  return (
    `${p.metric.label}: per-day power ${p.x.toFixed(2)}, ` +
    `consistent separation ${p.y.toFixed(2)}, ${p.metric.consistency}`
  );
}

export function ConsistencyMap({ metrics }: { metrics: CompMetricAggregate[] }) {
  const points: MapPoint[] = metrics
    .filter((m) => m.meanAbsRho !== null && m.meanSignedRho !== null)
    .map((m) => ({ metric: m, x: m.meanAbsRho!, y: Math.abs(m.meanSignedRho!) }));

  const [focusIndex, setFocusIndex] = useState(0);
  const [readout, setReadout] = useState<MapPoint | null>(null);
  const dotRefs = useRef<(SVGGElement | null)[]>([]);

  if (points.length === 0) return null;

  const x = linearScale([0, 1], [M.left, W - M.right]);
  const y = linearScale([0, 1], [H - M.bottom, M.top]);
  const ticks = [0, 0.25, 0.5, 0.75, 1];

  // Direct labels for the dots worth naming: real per-day power, or a real
  // consistency gap. The readout line names any dot on hover/focus.
  const labelled = points
    .map((p, i) => ({ p, i }))
    .filter(({ p }) => p.x >= 0.3 || p.x - p.y >= 0.15);
  const labelYs = spreadLabels(
    labelled.map(({ p }) => y(p.y) + 3),
    11,
    M.top + 8,
    H - M.bottom - 2,
  );

  const caption =
    "Dots on the diagonal separate the field the same way every task; dots far " +
    "below it are strong per day but flip direction — the payoff depended on the " +
    "day. The table's mean ρ and mean |ρ| columns are the exact values.";

  return (
    <figure className="max-w-xl space-y-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="group"
        aria-label={`Consistency map, scatter plot. ${caption}`}
        onMouseLeave={() => setReadout(null)}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line
              x1={x(t)}
              x2={x(t)}
              y1={M.top}
              y2={H - M.bottom}
              className="stroke-border"
              strokeWidth={1}
            />
            <line
              x1={M.left}
              x2={W - M.right}
              y1={y(t)}
              y2={y(t)}
              className="stroke-border"
              strokeWidth={1}
            />
          </g>
        ))}

        {/* The diagonal — the "same direction every task" reference. */}
        <line
          x1={x(0)}
          y1={y(0)}
          x2={x(1)}
          y2={y(1)}
          className="stroke-muted-foreground/50"
          strokeWidth={1}
          strokeDasharray="4 3"
        />

        <g aria-hidden className="text-[10px] text-muted-foreground">
          {ticks.map((t) => (
            <text
              key={`tx${t}`}
              x={x(t)}
              y={H - M.bottom + 14}
              textAnchor="middle"
              className="fill-current"
            >
              {t}
            </text>
          ))}
          {ticks.map((t) => (
            <text
              key={`ty${t}`}
              x={M.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-current"
            >
              {t}
            </text>
          ))}
          <text
            x={(M.left + W - M.right) / 2}
            y={H - 6}
            textAnchor="middle"
            className="fill-current"
          >
            per-day power — mean |ρ|
          </text>
          <text
            x={12}
            y={(M.top + H - M.bottom) / 2}
            textAnchor="middle"
            transform={`rotate(-90 12 ${(M.top + H - M.bottom) / 2})`}
            className="fill-current"
          >
            consistent separation — |mean ρ|
          </text>
          <text
            x={x(0.97)}
            y={y(0.97) - 5}
            textAnchor="end"
            className="fill-current"
          >
            same direction every task
          </text>
          <text x={x(0.97)} y={y(0.05)} textAnchor="end" className="fill-current">
            strong but day-dependent
          </text>
        </g>

        {points.map((p, i) => (
          <g
            key={p.metric.id}
            ref={(el) => {
              dotRefs.current[i] = el;
            }}
            role="img"
            aria-label={pointLabel(p)}
            tabIndex={i === focusIndex ? 0 : -1}
            className="cursor-default outline-none"
            onKeyDown={(e) => {
              const next =
                e.key === "ArrowRight" || e.key === "ArrowDown"
                  ? Math.min(i + 1, points.length - 1)
                  : e.key === "ArrowLeft" || e.key === "ArrowUp"
                    ? Math.max(i - 1, 0)
                    : null;
              if (next === null) return;
              e.preventDefault();
              setFocusIndex(next);
              dotRefs.current[next]?.focus();
            }}
            onFocus={() => {
              setFocusIndex(i);
              setReadout(p);
            }}
            onBlur={() => setReadout(null)}
            onMouseEnter={() => setReadout(p)}
          >
            {/* Invisible halo: pointer/focus target over a small dot. */}
            <circle cx={x(p.x)} cy={y(p.y)} r={12} className="fill-transparent" />
            <circle
              cx={x(p.x)}
              cy={y(p.y)}
              r={4.5}
              className={cn(
                "fill-chart-1/70",
                readout?.metric.id === p.metric.id && "stroke-ring stroke-2",
              )}
            />
          </g>
        ))}

        <g
          aria-hidden
          className="stroke-background text-[10px] text-muted-foreground [paint-order:stroke] [stroke-width:3px]"
        >
          {labelled.map(({ p }, k) => (
            <text
              key={p.metric.id}
              x={x(p.x) + 8}
              y={labelYs[k]}
              className="fill-current"
            >
              {p.metric.id}
            </text>
          ))}
        </g>
      </svg>

      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout ? pointLabel(readout) : "Hover or focus a dot to name the metric."}
      </p>

      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
