/**
 * A scoring component's formula, with the field on it and one pilot picked out.
 *
 * Built for the report card, and deliberately NOT the task-analysis
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
import type { ScoreCurveChart, ScoreChartPilot } from "@glidecomp/engine";
import { cn } from "@/react/lib/utils";
import { extent, linearScale, niceTicks } from "./scale";
import {
  curvePilotLabel,
  formatChartX,
  placeCurveLabels,
} from "@glidecomp/client/score-curve-layout";
import { AxisUnit, XAxisTitle } from "./AxisTitle";
import { CHART_LABEL_PX, useChartLabelSize } from "./use-chart-label-size";

const W = 520;
/** The plot area's own height. The viewBox's total height is this plus the
 *  margins, which grow with the type — see {@link chartMargins}. */
const PLOT_H = 168;

/**
 * Margins sized for the type that will actually be painted.
 *
 * Every number below was originally a constant tuned for 10-unit labels, which
 * is why a phone — where the same chart paints its labels at 21 units, see
 * `use-chart-label-size.ts` — clipped the "pts" stamp off the top of the frame
 * and sliced the last x tick in half against the right edge. Margins hold
 * TYPE, so they have to be measured in it:
 *
 *  - `top` holds the unit stamp's line, which sits above the plot.
 *  - `right` holds the half of the last x tick that overhangs the plot's right
 *    edge ("80 km" is centred on its gridline, so half of it is outside).
 *  - `bottom` holds the tick baseline (1.5em below the plot), the tick's own
 *    descender, and the axis title's line beneath it.
 *  - `left` holds the widest y tick — these are points, so four digits — plus
 *    its 0.6em gap from the plot.
 *
 * All four keep a floor at the old constant, so nothing on a desktop, where
 * the type is near 10 units anyway, moves at all.
 */
function chartMargins(fontSize: number) {
  return {
    top: Math.max(14, Math.round(fontSize * 1.15 + 3)),
    right: Math.max(14, Math.round(fontSize * 1.6)),
    bottom: Math.max(28, Math.round(fontSize * 2.95 + 2)),
    left: Math.max(44, Math.round(fontSize * 0.54 * 4 + fontSize * 0.6 + 8)),
  };
}

export function ScoreCurve({ chart }: { chart: ScoreCurveChart }) {
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
  // Footnote rather than body: this chart is small and sits INSIDE the section
  // it explains, under prose that has already stated the arithmetic, and the
  // item list below carries the exact numbers. Its labels are a sighted
  // reader's orientation, not the reading itself.
  const { svgRef, fontSize } = useChartLabelSize(W, CHART_LABEL_PX.footnote);

  if (points.length === 0 || curve.length === 0) return null;

  const margin = chartMargins(fontSize);
  const H = PLOT_H + margin.top + margin.bottom;
  const plot = {
    left: margin.left,
    right: W - margin.right,
    top: margin.top,
    bottom: H - margin.bottom,
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

  // Who gets named, and where: shared with the app's chart.
  const labels = placeCurveLabels({ points, x, y, fontSize, width: W, plot });

  const label = (p: ScoreChartPilot) => curvePilotLabel(xUnit, p);

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
        ref={svgRef}
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
        <g aria-hidden fontSize={fontSize} className="text-muted-foreground">
          {xTicks.map((t) => (
            <text
              key={`tx${t}`}
              x={x(t)}
              y={plot.bottom + fontSize * 1.5}
              textAnchor="middle"
              className="fill-current"
            >
              {formatChartX(xUnit, t)}
            </text>
          ))}
          {yTicks.map((t) => (
            <text
              key={`ty${t}`}
              x={plot.left - fontSize * 0.6}
              y={y(t) + fontSize * 0.35}
              textAnchor="end"
              className="fill-current"
            >
              {Math.round(t)}
            </text>
          ))}
          {/* A unit STAMP on y, an axis TITLE on x — see AxisTitle.tsx for why
              the two are different things. The y axis here is points and
              nothing else, and the section heading above already names the
              component being scored. */}
          <AxisUnit left={plot.left} top={plot.top} fontSize={fontSize}>
            pts
          </AxisUnit>
          <XAxisTitle
            left={plot.left}
            right={plot.right}
            y={H - fontSize * 0.35}
            fontSize={fontSize}
          >
            {xLabel}
          </XAxisTitle>
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
          </g>
        ) : null}

        {/* Direct labels rather than a legend: a legend box would be a whole
            extra element to name five dots that can name themselves. Drawn
            last, over every dot, with a background-coloured stroke halo
            (paint-order) so a name crossing the curve or a neighbouring dot
            still reads.
            The subject wears foreground ink and medium weight; the anchors
            around them stay muted, so the emphasis survives having company.
            aria-hidden throughout — every dot already announces its own
            pilot, name included. */}
        {/* Leader lines for the displaced names, under the text so the halo
            trims them where they meet it. Hairline and muted: they are
            plumbing, and must not read as a second data series. */}
        <g aria-hidden>
          {labels
            .filter((l) => l.leader)
            .map((l) => (
              <line
                key={`lead-${l.key}`}
                x1={l.x}
                y1={l.y + (l.y < l.dotY ? fontSize * 0.3 : fontSize * -0.8)}
                x2={l.dotX}
                y2={l.dotY + (l.y < l.dotY ? -7 : 7)}
                className="stroke-muted-foreground/40"
                strokeWidth={1}
              />
            ))}
        </g>
        <g
          aria-hidden
          fontSize={fontSize}
          className="stroke-background [paint-order:stroke] [stroke-width:3px]"
        >
          {labels.map((l) => (
            <text
              key={l.key}
              x={l.x}
              y={l.y}
              textAnchor="middle"
              className={cn(
                "fill-current",
                l.you ? "font-medium text-foreground" : "text-muted-foreground"
              )}
            >
              {l.name}
            </text>
          ))}
        </g>
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
