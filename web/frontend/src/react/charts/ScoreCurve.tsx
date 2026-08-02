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
import type { ScoreCurveChart, ScoreChartPilot } from "@glidecomp/engine";
import { cn } from "@/react/lib/utils";
import { extent, linearScale, niceTicks } from "./scale";
import { AxisUnit, XAxisTitle } from "./AxisTitle";

const W = 520;
const H = 210;
const MARGIN = { top: 14, right: 14, bottom: 28, left: 44 };

/**
 * Below this many plotted pilots the median is not worth naming: with a small
 * field the best three and the last are most of it already, and "the middle
 * one of five" is a label, not a finding.
 */
const MEDIAN_MIN_FIELD = 7;

/** Rough width of a label, for collision testing. The names are proportional
 *  text at 10px; 5.4px per character over-estimates slightly, which is the
 *  safe direction — it drops a marginal label rather than overlapping one. */
function labelWidth(name: string): number {
  return name.length * 5.4;
}

/**
 * Vertical offsets from a dot to try for its label, in order.
 *
 * These curves are steep at one end, which is exactly where the best pilots
 * bunch — on a real task the three fastest sat within four minutes and twenty
 * points of each other, so their labels cannot all sit above their own dots.
 * Rather than drop two of the three, walk outwards until one fits and draw a
 * leader line back to the dot.
 */
const LABEL_OFFSETS = [-12, 19, -27, 34, -42, 49];

/** Beyond this displacement a label no longer obviously belongs to the dot
 *  under it, so it earns a leader line. */
const LEADER_THRESHOLD = 22;

/**
 * Two dots closer than this are one dot to the eye, so only the first of them
 * is named.
 *
 * Not a nicety: on the distance chart every pilot who made goal sits at the
 * same (best distance, full points), so "the best three" are one point. Three
 * names stacked beside it, with three leader lines into the same pixel, says
 * there are three things there when there is one.
 */
const SAME_DOT_PX = 6;

interface PlacedLabel {
  key: string;
  name: string;
  x: number;
  y: number;
  /** The dot this names, for the leader line. */
  dotX: number;
  dotY: number;
  you: boolean;
  box: { x0: number; x1: number; y0: number; y1: number };
}

function overlaps(a: PlacedLabel["box"], b: PlacedLabel["box"]): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

/** Format an x value for a tick or a readout, by what the axis measures. */
function formatX(unit: ScoreCurveChart["xUnit"], v: number): string {
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

  // Who gets named. A lone accent dot tells you where you are but not what
  // that is worth — the field needs anchors, so the best three, the last and
  // (in a field big enough for it to mean anything) the median are named too.
  //
  // Ranked by THIS component's points — the y axis — not by the class
  // standings. That is what "the best three" means on a chart about one
  // component, and it is the reading that makes the arrival chart's story
  // legible: the pilot who won the day is not necessarily among the three
  // named at the top of it.
  const byPoints = [...points].sort((a, b) => b.y - a.y);
  const candidates: ScoreChartPilot[] = [];
  const consider = (p: ScoreChartPilot | undefined) => {
    if (p && !candidates.includes(p)) candidates.push(p);
  };
  // Priority order, because collisions are resolved by dropping the later
  // label: the subject of the page can never be the one that gets dropped.
  if (you) consider(you);
  byPoints.slice(0, 3).forEach(consider);
  consider(byPoints[byPoints.length - 1]);
  if (byPoints.length >= MEDIAN_MIN_FIELD) {
    consider(byPoints[Math.floor(byPoints.length / 2)]);
  }

  // Greedy placement: each name takes the first offset that collides with
  // nothing already placed, so a bunched leader board stacks outwards instead
  // of losing everyone after the first. A name that fits nowhere is dropped
  // rather than drawn over another — an unreadable pile helps no one — and
  // the priority order above means the subject is never the one dropped.
  const labels: PlacedLabel[] = [];
  for (const p of candidates) {
    const dotX = x(p.x);
    const dotY = y(p.y);
    // One name per visible dot — see SAME_DOT_PX.
    if (
      labels.some(
        (l) => Math.hypot(l.dotX - dotX, l.dotY - dotY) < SAME_DOT_PX
      )
    ) {
      continue;
    }
    const half = labelWidth(p.name) / 2;
    // Clamp by the label's OWN width — a fixed inset lets a long name run off
    // the right edge, which is where the best pilots sit on a rising curve.
    // Asymmetric on purpose: the right margin is empty so a label may use it,
    // but the LEFT margin holds the y-axis numbers, and a name pushed into it
    // sits on top of them. Displacement is what the leader lines are for.
    const cx = Math.min(W - half - 2, Math.max(plot.left + half + 2, dotX));
    for (const dy of LABEL_OFFSETS) {
      const ly = dotY + dy;
      // Keep it inside the plot: a label pushed off the top or bottom is as
      // lost as one that collided.
      if (ly < plot.top + 9 || ly > plot.bottom - 2) continue;
      const box = { x0: cx - half, x1: cx + half, y0: ly - 9, y1: ly + 3 };
      if (labels.some((l) => overlaps(l.box, box))) continue;
      labels.push({ key: p.key, name: p.name, x: cx, y: ly, dotX, dotY, you: p.you, box });
      break;
    }
  }

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
          {/* A unit STAMP on y, an axis TITLE on x — see AxisTitle.tsx for why
              the two are different things. The y axis here is points and
              nothing else, and the section heading above already names the
              component being scored. */}
          <AxisUnit left={plot.left} top={plot.top}>
            pts
          </AxisUnit>
          <XAxisTitle left={plot.left} right={plot.right} y={H - 2}>
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
            .filter((l) => Math.abs(l.y - l.dotY) > LEADER_THRESHOLD)
            .map((l) => (
              <line
                key={`lead-${l.key}`}
                x1={l.x}
                y1={l.y + (l.y < l.dotY ? 3 : -8)}
                x2={l.dotX}
                y2={l.dotY + (l.y < l.dotY ? -7 : 7)}
                className="stroke-muted-foreground/40"
                strokeWidth={1}
              />
            ))}
        </g>
        <g
          aria-hidden
          className="stroke-background text-[10px] [paint-order:stroke] [stroke-width:3px]"
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
