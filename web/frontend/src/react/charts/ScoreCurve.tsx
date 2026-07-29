/**
 * A scoring component's formula, with the field on it and one pilot picked out.
 *
 * Built for the report card, and deliberately NOT the field-analysis
 * RankScatter with different data. Three differences drive the design:
 *
 *  1. **This is an emphasis chart, not a field chart.** RankScatter treats
 *     every pilot as equally the subject — one colour for all dots, permanent
 *     labels on the best and worst three. Here exactly one dot is the reason
 *     the reader is on the page: it wears the accent and a ring, everyone else
 *     is context in muted ink. Reusing the scatter would bury the reader in
 *     the crowd they came to locate themselves in.
 *
 *  2. **The curve is the formula, not a fit.** RankScatter fits a LOESS trend
 *     and withholds it below a noise floor, because there a curve is a claim
 *     about data that might be luck. Here the curve IS the scoring function
 *     (sampled in the engine from the scorer's own code) and every dot has
 *     been checked to sit on it, so it is always drawn and the caption says
 *     so. Getting this wording wrong would quietly downgrade a fact to a fit.
 *
 *  3. **It is small and it sits inside the section it explains**, under the
 *     prose that already states the arithmetic. The chart adds shape — how
 *     steeply the points fall away, how bunched the field was, where you sit
 *     in it — which is exactly what prose cannot carry.
 *
 * Hand-rolled inline SVG, so it renders in the SSR bundle: these pages are
 * server-rendered and the chart must be in the first paint, not swapped in
 * after hydration. Geometry comes from charts/scale.ts.
 *
 * Accessibility (docs/accessibility-standard.md): the figure's caption states
 * the reading in words and doubles as the accessible name, so nothing is
 * conveyed by the picture alone; every dot is focusable with a 24px target
 * and an accessible name; arrow keys walk the field in curve order; a readout
 * line mirrors hover/focus for sighted users (and works on touch). The
 * section's own item list remains the exact, complete data.
 */
import { useMemo, useRef, useState } from "react";
import type { ScoreChart, ScoreChartPilot } from "@glidecomp/engine";
import { cn } from "@/react/lib/utils";
import { extent, linearScale, niceTicks } from "./scale";

const W = 520;
const H = 200;
const MARGIN = { top: 12, right: 14, bottom: 28, left: 44 };

/** Format an x value for a tick or a readout, by what the axis measures. */
function formatX(unit: ScoreChart["xUnit"], v: number): string {
  switch (unit) {
    case "duration": {
      const s = Math.max(0, Math.round(v));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      return h > 0
        ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
        : `${m}:${String(sec).padStart(2, "0")}`;
    }
    case "distance":
      return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)} km`;
    case "position":
      return String(Math.round(v));
    case "coefficient":
      return v.toFixed(2);
  }
}

export function ScoreCurve({ chart }: { chart: ScoreChart }) {
  const { curve, pilots, xUnit, xLabel, caption } = chart;

  // Dots in curve order, so arrow keys walk left to right the way the eye
  // does — not in rank order, which on these axes is not the reading order.
  const points = useMemo(
    () => [...pilots].sort((a, b) => a.x - b.x),
    [pilots]
  );
  const you = points.find((p) => p.you);

  const [focusIndex, setFocusIndex] = useState(() =>
    Math.max(0, points.findIndex((p) => p.you))
  );
  const [readout, setReadout] = useState<ScoreChartPilot | null>(null);
  const dotRefs = useRef<(SVGGElement | null)[]>([]);

  if (points.length === 0 || curve.length === 0) return null;

  const plot = {
    left: MARGIN.left,
    right: W - MARGIN.right,
    top: MARGIN.top,
    bottom: H - MARGIN.bottom,
  };

  // The curve sets the domain, not the dots: it is the subject, and letting
  // the dots bound it would clip the shape wherever the field is bunched.
  const xDomain = extent([
    ...curve.map((c) => c.x),
    ...points.map((p) => p.x),
  ])!;
  const yMax = Math.max(...curve.map((c) => c.y), ...points.map((p) => p.y));
  // Inset by more than the accent dot's radius: a pilot at either end of the
  // domain (the fastest time, the last arrival) is exactly the pilot most
  // likely to be reading, and mapped flush to the plot edge their dot is
  // sliced in half by it.
  const x = linearScale(xDomain, [plot.left + 10, plot.right - 10]);
  // Same inset at the top: a pilot on full points sits at the very peak of the
  // curve, and flush to plot.top their dot is clipped by the viewBox and their
  // label lands on the axis caption.
  const y = linearScale([0, yMax || 1], [plot.bottom, plot.top + 10]);

  const path = `M${curve.map((c) => `${x(c.x).toFixed(1)},${y(c.y).toFixed(1)}`).join("L")}`;
  const xTicks = niceTicks(xDomain, 4);
  const yTicks = niceTicks([0, yMax || 1], 3);

  const label = (p: ScoreChartPilot) =>
    `${p.name}, ${formatX(xUnit, p.x)}, ${Math.round(p.y * 10) / 10} points`;

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(i + 1, points.length - 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(i - 1, 0);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = points.length - 1;
    else return;
    e.preventDefault();
    if (next !== i) {
      setFocusIndex(next);
      dotRefs.current[next]?.focus();
    }
  }

  return (
    <figure className="mt-3 space-y-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="group"
        aria-label={`${xLabel} against points. ${caption}`}
        onMouseLeave={() => setReadout(null)}
      >
        {/* Gridlines under everything. */}
        {yTicks.map((t) => (
          <line
            key={`gy${t}`}
            x1={plot.left}
            x2={plot.right}
            y1={y(t)}
            y2={y(t)}
            className="stroke-border"
            strokeWidth={1}
          />
        ))}

        {/* aria-hidden: the caption carries the reading; loose axis numbers
            only add noise to a screen reader. */}
        <g aria-hidden className="text-[10px] text-muted-foreground">
          {xTicks.map((t) => (
            <text key={`tx${t}`} x={x(t)} y={plot.bottom + 15} textAnchor="middle" className="fill-current">
              {formatX(xUnit, t)}
            </text>
          ))}
          {yTicks.map((t) => (
            <text key={`ty${t}`} x={plot.left - 6} y={y(t) + 3} textAnchor="end" className="fill-current">
              {Math.round(t)}
            </text>
          ))}
          <text x={plot.left - 6} y={plot.top - 2} textAnchor="end" className="fill-current">
            pts
          </text>
          <text x={(plot.left + plot.right) / 2} y={H - 2} textAnchor="middle" className="fill-current">
            {xLabel}
          </text>
        </g>

        {/* The formula. Foreground ink rather than a chart hue: it is the
            subject the dots are placed ON, not a series alongside them, and
            the chart palette does not clear the 3:1 non-text contrast bar for
            a hairline (accessibility standard §3.1). aria-hidden — the
            caption states what it is. */}
        <path
          aria-hidden
          d={path}
          fill="none"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="stroke-foreground/70"
        />

        {/* The field: context, in muted ink at low opacity so density reads
            through overlap. Drawn before the accent dot so yours is never
            hidden under a neighbour. */}
        {points.map((p, i) =>
          p.you ? null : (
            <g
              key={p.key}
              ref={(el) => {
                dotRefs.current[i] = el;
              }}
              role="img"
              aria-label={label(p)}
              tabIndex={i === focusIndex ? 0 : -1}
              className="cursor-default outline-none"
              onKeyDown={(e) => onKeyDown(e, i)}
              onFocus={() => {
                setFocusIndex(i);
                setReadout(p);
              }}
              onMouseEnter={() => setReadout(p)}
            >
              {/* 24px pointer/focus target over a 7px dot (WCAG 2.5.8). */}
              <circle cx={x(p.x)} cy={y(p.y)} r={12} className="fill-transparent" />
              <circle
                cx={x(p.x)}
                cy={y(p.y)}
                r={3.5}
                className={cn(
                  "fill-muted-foreground/50",
                  readout?.key === p.key && "stroke-ring stroke-2"
                )}
              />
            </g>
          )
        )}

        {/* You. Larger, in the accent, with a surface ring so it separates
            from any dot it overlaps — the one mark the chart exists for. */}
        {you ? (
          <g
            ref={(el) => {
              dotRefs.current[points.indexOf(you)] = el;
            }}
            role="img"
            aria-label={`${label(you)} — this pilot`}
            tabIndex={focusIndex === points.indexOf(you) ? 0 : -1}
            className="cursor-default outline-none"
            onKeyDown={(e) => onKeyDown(e, points.indexOf(you))}
            onFocus={() => {
              setFocusIndex(points.indexOf(you));
              setReadout(you);
            }}
            onMouseEnter={() => setReadout(you)}
          >
            <circle cx={x(you.x)} cy={y(you.y)} r={12} className="fill-transparent" />
            <circle
              cx={x(you.x)}
              cy={y(you.y)}
              r={6}
              className="fill-chart-1 stroke-background stroke-2"
            />
            {/* Direct label rather than a legend: with one highlighted mark a
                legend box would be a whole extra element to name a single dot.
                Centred above the dot and clamped inside the plot — a
                left/right anchor flips at the midpoint and pushes the label
                off the edge for exactly the extreme-value pilots. Cased
                against the background so it stays legible over the curve and
                any neighbouring dots. */}
            <text
              aria-hidden
              x={Math.min(plot.right - 14, Math.max(plot.left + 14, x(you.x)))}
              // Above the dot, or below it when the dot is near the ceiling —
              // clamping "above" against the plot top instead just parks the
              // label on top of the dot it is naming, which is the case for
              // any pilot on full points.
              y={
                y(you.y) - 12 >= plot.top + 9
                  ? y(you.y) - 12
                  : y(you.y) + 19
              }
              textAnchor="middle"
              className="fill-current stroke-background text-[10px] font-medium text-foreground [paint-order:stroke] [stroke-width:3px]"
            >
              You
            </text>
          </g>
        ) : null}
      </svg>

      {/* Mirrors hover/focus for sighted users. No aria-live: every dot
          already announces itself, so a live region would double-speak.
          Hidden in print, where an invitation to hover means nothing. */}
      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout
          ? label(readout)
          : "Hover or focus a dot to name the pilot behind it."}
      </p>

      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
