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
 * This is now the only place mean |ρ| is quoted: the table dropped that
 * column, because it equals |mean ρ| except where the per-task signs disagree
 * — the vertical drop from the diagonal here, and the "depended on the day"
 * chip there. Hand-rolled SVG per charts/chart-utils.ts.
 *
 * **Drawn in CSS pixels** (`charts/use-chart-box.ts`, issue #860). It was a
 * 560-unit drawing scaled to the page, so a phone painted its labels at
 * 5.7px. The dots' names had a 150-unit margin to the right of the plot;
 * at a readable size the names go INSIDE the plot, on either side of the
 * diagonal, each beside its own dot or not drawn (`charts/dot-labels.ts`).
 *
 * **Selecting a dot.** Arrow keys walk the dots. A tap, a click or a finger
 * dragged across chooses the dot nearest the pointer
 * (`charts/use-nearest-pointer.ts`), and a mouse moving near a dot does
 * the same as a hover. The chosen behaviour is ringed, named beside its dot
 * where there is room, and read in full in the line above the plot
 * (`charts/ChartReadout.tsx`).
 */
import { useRef, useState } from "react";
import { ALL_METRICS, type CompMetricAggregate } from "../types";
import { linearScale } from "./chart-utils";
import { XAxisTitle, YAxisTitle } from "@/react/charts/AxisTitle";
import { useChartBox } from "@/react/charts/use-chart-box";
import { approxTextWidth } from "@/react/charts/text-width";
import { nearestPoint } from "@/react/charts/nearest";
import { focusMark, nearestPointerProps } from "@/react/charts/use-nearest-pointer";
import { placeDotLabels, type LabelBox } from "@/react/charts/dot-labels";
import { ChartReadout } from "@/react/charts/ChartReadout";
import { consistencyWords } from "../ConsistencyChip";

/**
 * The compact name for a dot. These labels used to be the engine's metric IDS
 * ("glide.speed", "decision.search_fraction") — internal identifiers, on a
 * public page, for metrics that were deliberately renamed into English. The
 * registry's shortLabel is the same compact vocabulary the metric glossary
 * defines ('"GlideSpd" in tables'), and the full label is in the readout
 * line above the chart for any dot that is selected.
 */
const SHORT_LABELS = new Map(ALL_METRICS.map((m) => [m.id, m.shortLabel ?? m.label]));

const X_TITLE = "per-day power — mean |ρ|";
const Y_TITLE = "consistent separation — |mean ρ|";
const ON_DIAGONAL = "same direction every task";
const BELOW_DIAGONAL = "strong but day-dependent";
const TICKS = [0, 0.25, 0.5, 0.75, 1];
const DOT_RADIUS = 4.5;

interface MapPoint {
  metric: CompMetricAggregate;
  x: number; // mean |ρ|
  y: number; // |mean signed ρ|
}

function pointLabel(p: MapPoint): string {
  const s = p.metric.signSummary;
  return (
    `${p.metric.label}: per-day power ${p.x.toFixed(2)}, ` +
    `consistent separation ${p.y.toFixed(2)}, ` +
    // The table's words, not the engine's token — one vocabulary per page.
    `${consistencyWords(p.metric.consistency, s.negative + s.positive)}`
  );
}

export function ConsistencyMap({ metrics }: { metrics: CompMetricAggregate[] }) {
  const points: MapPoint[] = metrics
    .filter((m) => m.meanAbsRho !== null && m.meanSignedRho !== null)
    .map((m) => ({ metric: m, x: m.meanAbsRho!, y: Math.abs(m.meanSignedRho!) }));

  const [focusIndex, setFocusIndex] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const dotRefs = useRef<(SVGGElement | null)[]>([]);
  const { ref: svgRef, box } = useChartBox();

  if (points.length === 0) return null;

  const W = box.width;
  const em = box.fontSize;

  // Margins hold type, so each is measured in it.
  // - left: the rotated axis title's line, then the widest tick ("0.75").
  // - right: the half of the last tick ("1") that overhangs the plot.
  const tickWidth = Math.max(...TICKS.map((t) => approxTextWidth(String(t), em)));
  const plotLeft = Math.round(em * 2.05 + tickWidth);
  const plotRight = W - Math.round(em * 0.8);
  const plotTop = Math.round(em * 0.8);
  // Near square on a phone; wider than tall once there is width to spare.
  // Never shorter than the rotated title.
  const plotHeight = Math.round(
    Math.max(
      Math.min(em * 26, Math.max(em * 15, (plotRight - plotLeft) * 0.9)),
      approxTextWidth(Y_TITLE, em) + em
    )
  );
  const plotBottom = plotTop + plotHeight;
  const xTitleY = plotBottom + em * 2.55;
  const H = Math.round(xTitleY + em * 0.5);

  const x = linearScale([0, 1], [plotLeft, plotRight]);
  const y = linearScale([0, 1], [plotBottom, plotTop]);
  const dots = points.map((p) => ({ key: p.metric.id, x: x(p.x), y: y(p.y) }));

  // The two notes in the plot. The first sits just left of the diagonal's
  // top end, which it describes; the second in the corner far below it.
  const noteTopBaseline = plotTop + em * 1.15;
  const noteTopRight =
    x(1 - (noteTopBaseline + em * 0.25 - plotTop) / plotHeight) - em * 0.5;
  const noteBottomBaseline = plotBottom - em * 0.55;
  const noteBottomRight = plotRight - em * 0.4;
  const noteBox = (right: number, baseline: number, text: string): LabelBox => ({
    x0: right - approxTextWidth(text, em),
    x1: right,
    y0: baseline - em * 0.8,
    y1: baseline + em * 0.25,
  });

  // The chosen dot: under the mouse, else the one with focus.
  const chosenId = hoveredId ?? focusedId;
  const chosen = points.find((p) => p.metric.id === chosenId) ?? null;

  // Direct labels for the dots worth naming: real per-day power, or a real
  // consistency gap — the strongest first, so that where names compete for
  // room it is the weaker behaviour that goes unnamed. The chosen dot is
  // asked for last: it is named if there is room, and the names already
  // standing do not move for it.
  const standing = points
    .filter((p) => p.x >= 0.3 || p.x - p.y >= 0.15)
    .sort((a, b) => b.x - a.x);
  const labels = placeDotLabels({
    dots,
    wanted: [...standing, ...(chosen && !standing.includes(chosen) ? [chosen] : [])].map((p) => ({
      key: p.metric.id,
      text: SHORT_LABELS.get(p.metric.id) ?? p.metric.label,
    })),
    fontSize: em,
    dotRadius: DOT_RADIUS,
    bounds: { x0: plotLeft + 2, x1: W - 2, y0: plotTop, y1: plotBottom },
    blocked: [
      noteBox(noteTopRight, noteTopBaseline, ON_DIAGONAL),
      noteBox(noteBottomRight, noteBottomBaseline, BELOW_DIAGONAL),
    ],
  });

  const caption =
    "A dot on the diagonal separates the field the same way in every task. A dot " +
    "far below the diagonal is strong on each day, but changes direction, so the " +
    "payoff depended on the day. The table above shows the figure of each task " +
    "for every behaviour.";

  const pointer = nearestPointerProps({
    viewBoxWidth: W,
    nearest: (px, py) => nearestPoint(dots, px, py),
    onHover: (i) => setHoveredId(i === null ? null : points[i].metric.id),
    onPick: (i) => focusMark(dotRefs.current[i]),
  });

  return (
    <figure className="max-w-xl space-y-1" data-chart="consistency-map">
      <ChartReadout prompt="Select a dot to name the behaviour." lines={3}>
        {chosen ? pointLabel(chosen) : null}
      </ChartReadout>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full select-none"
        role="group"
        aria-label={`Consistency map, scatter plot. ${caption}`}
        {...pointer}
      >
        {TICKS.map((t) => (
          <g key={t}>
            <line
              x1={x(t)}
              x2={x(t)}
              y1={plotTop}
              y2={plotBottom}
              className="stroke-border"
              strokeWidth={1}
            />
            <line
              x1={plotLeft}
              x2={plotRight}
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

        <g aria-hidden fontSize={em} className="text-muted-foreground">
          {TICKS.map((t) => (
            <text
              key={`tx${t}`}
              x={x(t)}
              y={plotBottom + em * 1.15}
              textAnchor="middle"
              className="fill-current"
            >
              {t}
            </text>
          ))}
          {TICKS.map((t) => (
            <text
              key={`ty${t}`}
              x={plotLeft - em * 0.5}
              y={y(t) + em * 0.35}
              textAnchor="end"
              className="fill-current"
            >
              {t}
            </text>
          ))}
          {/* These two were hand-rolled here first; XAxisTitle/YAxisTitle are
              that pattern extracted for every other chart, so this chart now
              draws them from the shared helper rather than being a copy the
              others can drift from. */}
          <XAxisTitle left={plotLeft} right={plotRight} y={xTitleY} fontSize={em}>
            {X_TITLE}
          </XAxisTitle>
          <YAxisTitle x={em * 1.05} top={plotTop} bottom={plotBottom} fontSize={em}>
            {Y_TITLE}
          </YAxisTitle>
        </g>
        <g
          aria-hidden
          fontSize={em}
          className="stroke-background text-muted-foreground [paint-order:stroke] [stroke-width:3px]"
        >
          <text x={noteTopRight} y={noteTopBaseline} textAnchor="end" className="fill-current">
            {ON_DIAGONAL}
          </text>
          <text
            x={noteBottomRight}
            y={noteBottomBaseline}
            textAnchor="end"
            className="fill-current"
          >
            {BELOW_DIAGONAL}
          </text>
        </g>

        {/* Each dot is one focusable element. The pointer is answered by the
            <svg>, which finds the nearest dot, so a dot needs no invisible
            halo for a target. */}
        {points.map((p, i) => (
          <g
            key={p.metric.id}
            ref={(el) => {
              dotRefs.current[i] = el;
            }}
            role="img"
            aria-label={pointLabel(p)}
            tabIndex={i === focusIndex ? 0 : -1}
            data-dot={p.metric.id}
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
              setFocusedId(p.metric.id);
            }}
            onBlur={() => setFocusedId(null)}
          >
            <circle cx={dots[i].x} cy={dots[i].y} r={DOT_RADIUS} className="fill-chart-1/70" />
          </g>
        ))}

        {/* The chosen dot, ringed, over the field. Foreground ink: --ring is
            the blue the dots already are, and a blue ring on a blue dot is
            no mark at all. */}
        {chosen ? (
          <circle
            aria-hidden
            data-chosen={chosen.metric.id}
            cx={x(chosen.x)}
            cy={y(chosen.y)}
            r={DOT_RADIUS + 2.5}
            fill="none"
            strokeWidth={2}
            className="pointer-events-none stroke-foreground"
          />
        ) : null}

        <g
          aria-hidden
          fontSize={em}
          className="stroke-background [paint-order:stroke] [stroke-width:3px]"
        >
          {labels.map((l) => (
            <text
              key={l.key}
              data-dot-label={l.key}
              x={l.x}
              y={l.y}
              textAnchor={l.anchor}
              className={
                l.key === chosenId
                  ? "fill-current font-medium text-foreground"
                  : "fill-current text-muted-foreground"
              }
            >
              {l.text}
            </text>
          ))}
        </g>
      </svg>

      <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
    </figure>
  );
}
