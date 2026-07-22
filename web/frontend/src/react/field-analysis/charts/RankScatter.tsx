/**
 * Metric value against published rank — Spearman ρ made visible.
 *
 * The separation ranking reduces each metric to one coefficient; this scatter
 * is the evidence behind it. A ρ of −0.6 can be a clean monotone trend, two
 * gaggle-shaped clusters, or one outlier doing all the work, and only the
 * dots can tell you which.
 *
 * Rank 1 renders at the TOP so "up is better" everywhere on the page. Hand-
 * rolled SVG, no chart library: see charts/chart-utils.ts for why.
 *
 * Labelling: the best/worst three pilots and the value extremes are named
 * permanently (selective direct labels); the focused dot is named in place
 * while focused (click, tap, or arrow keys); and an opt-in checkbox labels
 * every pilot, growing the chart vertically so the names have room. In
 * label-everyone mode the special labels go bold to stand out of the crowd.
 *
 * Accessibility: the figure carries a caption stating the statistics in
 * words; every dot is a focusable element with the pilot's name/value/rank as
 * its accessible name, arrow keys walk the dots in rank order, and the family
 * tables below the page remain the full data equivalent. A readout line under
 * the plot mirrors hover/focus for sighted users (works on touch, prints).
 */
import { useMemo, useRef, useState } from "react";
import { cn } from "@/react/lib/utils";
import { Checkbox } from "@/react/rac/checkbox";
import {
  formatMetricValue,
  type FieldAnalysisReport,
  type MetricReport,
} from "../types";
import { unitWords } from "../units";
import { usePilotHighlight } from "../PilotHighlightContext";
import {
  extent,
  formatTickValue,
  linearScale,
  niceTicks,
  spreadLabels,
} from "./chart-utils";

const W = 560;
const BASE_H = 300;
const MARGIN = { top: 10, right: 16, bottom: 26, left: 40 };
/** Vertical room per label when naming every pilot (labels spread at 11). */
const LABEL_ROW = 12;

interface ScatterPoint {
  trackFile: string;
  name: string;
  rank: number;
  value: number;
}

/** The caption's statistics-in-words, shared with the accessible name.
 * Exported for tests. */
export function captionText(metric: MetricReport, excluded: number): string {
  const c = metric.correlation;
  const parts: string[] = [];
  if (c) {
    parts.push(`ρ = ${c.rho.toFixed(2)} (${c.verdict}, n = ${c.n}).`);
    if (metric.direction === "neutral") {
      parts.push(
        c.rho === 0
          ? "No expected direction, and no lean either way here."
          : `No expected direction — the sign is the finding: larger values went with ${
              c.rho < 0 ? "better" : "worse"
            } ranks here.`
      );
    } else {
      // Rank 1 is at the top and numerically smallest, so ρ < 0 means larger
      // values went with better ranks — the dots gather top-right. The
      // gathering sentence must follow the OBSERVED sign, not the registry's
      // higher/lower prior: on the day a metric runs against expectation the
      // caption has to say so, not describe the day it expected to see.
      const expected = metric.direction === "higher" ? "More" : "Less";
      if (c.rho === 0) {
        parts.push(`${expected} is expected to be better here, but there was no lean either way.`);
      } else {
        const gatherRight = c.rho < 0;
        const side = gatherRight ? "right" : "left";
        const asExpected = (metric.direction === "higher") === gatherRight;
        parts.push(
          asExpected
            ? `${expected} is expected to be better here, and it was: top ranks gather to the ${side}.`
            : `${expected} is expected to be better here, but this task ran the other way: top ranks gather to the ${side}.`
        );
      }
    }
  } else {
    parts.push("Too few usable values for a correlation — read the dots, not a trend.");
  }
  if (excluded > 0) {
    parts.push(
      `${excluded} pilot${excluded === 1 ? " has" : "s have"} no value and ${
        excluded === 1 ? "is" : "are"
      } not plotted.`
    );
  }
  return parts.join(" ");
}

export function RankScatter({
  metric,
  pilots,
  showAllLabels = false,
  onShowAllLabelsChange,
}: {
  metric: MetricReport;
  pilots: FieldAnalysisReport["pilots"];
  /** Name every dot (bolding the special ones). Owned by the caller so the
   * choice survives switching metrics. */
  showAllLabels?: boolean;
  onShowAllLabelsChange?: (value: boolean) => void;
}) {
  // Join by trackFile, never by array index (project rule) — and sort by
  // rank so arrow keys read the leaderboard top-down.
  const points = useMemo<ScatterPoint[]>(() => {
    const valueByTrack = new Map(metric.perPilot.map((p) => [p.trackFile, p.value]));
    return pilots
      .flatMap((p) => {
        const value = valueByTrack.get(p.trackFile);
        return value === null || value === undefined || !Number.isFinite(value)
          ? []
          : [{ trackFile: p.trackFile, name: p.pilotName, rank: p.rank, value }];
      })
      .sort((a, b) => a.rank - b.rank);
  }, [metric, pilots]);

  const [focusIndex, setFocusIndex] = useState(0);
  const [focusedTrack, setFocusedTrack] = useState<string | null>(null);
  const [readout, setReadout] = useState<ScatterPoint | null>(null);
  const dotRefs = useRef<(SVGGElement | null)[]>([]);
  // Page-wide pilot highlight (no-op outside the provider): hovering a dot
  // lights the pilot up in the heatmap and tables, and vice versa.
  const { highlight, setHighlight } = usePilotHighlight();

  const excluded = pilots.length - points.length;
  const caption = captionText(metric, excluded);

  if (points.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No pilot has a usable value for this metric, so there is nothing to plot.
      </p>
    );
  }

  // Naming everyone needs a row of vertical space per pilot, so the chart
  // grows instead of the labels compressing into an unreadable pile.
  const height = showAllLabels
    ? Math.max(BASE_H, MARGIN.top + MARGIN.bottom + points.length * LABEL_ROW + 16)
    : BASE_H;
  const plot = {
    left: MARGIN.left,
    right: W - MARGIN.right,
    top: MARGIN.top,
    bottom: height - MARGIN.bottom,
  };

  const xDomain = extent(points.map((p) => p.value))!;
  const x = linearScale(xDomain, [plot.left + 10, plot.right - 10]);
  const maxRank = Math.max(...pilots.map((p) => p.rank), 1);
  const y = linearScale([1, maxRank], [plot.top + 8, plot.bottom - 8]);

  const xTicks = niceTicks(xDomain, 5);
  // Rank ticks: always show 1 (it is the whole point of the axis), then
  // whatever whole-number steps fit.
  const yTicks = [
    1,
    ...niceTicks([1, maxRank], 4).filter((t) => Number.isInteger(t) && t !== 1),
  ];

  // The always-on labels: the best and worst three plotted pilots, plus the
  // value extremes regardless of rank — "flew the fastest, still ranked
  // 15th" is exactly the kind of outlier the scatter exists to surface.
  // Points are rank-sorted, so the strict comparisons resolve a tied extreme
  // to its best-ranked pilot, and the Set dedupes overlaps.
  let minIdx = 0;
  let maxIdx = 0;
  points.forEach((p, i) => {
    if (p.value < points[minIdx].value) minIdx = i;
    if (p.value > points[maxIdx].value) maxIdx = i;
  });
  const specialIndices = new Set([
    ...points.slice(0, 3).keys(),
    ...points.map((_, i) => i).slice(-3),
    minIdx,
    maxIdx,
  ]);

  // What actually gets a label: everyone (opt-in), or the specials plus the
  // focused dot — naming the dot you just clicked in place beats making you
  // glance down at the readout line.
  const focusedIdx =
    focusedTrack !== null ? points.findIndex((p) => p.trackFile === focusedTrack) : -1;
  const labelIndices = showAllLabels
    ? points.map((_, i) => i)
    : [...new Set([...specialIndices, ...(focusedIdx >= 0 ? [focusedIdx] : [])])];
  // Adjacent ranks sit only a few pixels apart vertically, so the label
  // baselines are spread to at least a line-height apart.
  const labelYs = spreadLabels(
    labelIndices.map((i) => y(points[i].rank) + 3),
    11,
    plot.top + 8,
    plot.bottom - 2
  );

  function pointLabel(p: ScatterPoint): string {
    return `${p.name}, ${formatMetricValue(metric.unit, p.value)} ${unitWords(
      metric.unit
    )}, rank ${p.rank}`;
  }

  function onDotKeyDown(e: React.KeyboardEvent, i: number) {
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = Math.min(i + 1, points.length - 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = Math.max(i - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = points.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next !== i) {
      setFocusIndex(next);
      dotRefs.current[next]?.focus();
    }
  }

  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="h-auto w-full"
        role="group"
        aria-label={`${metric.label} against rank, scatter plot. ${caption}`}
        onMouseLeave={() => {
          setReadout(null);
          setHighlight(null);
        }}
      >
        {/* Gridlines first, so dots draw over them. */}
        {xTicks.map((t) => (
          <line
            key={`gx${t}`}
            x1={x(t)}
            x2={x(t)}
            y1={plot.top}
            y2={plot.bottom}
            className="stroke-border"
            strokeWidth={1}
          />
        ))}
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

        {/* Tick labels. aria-hidden: the caption and dot labels carry the
            information; stray "20"s only add noise to a screen reader. */}
        <g aria-hidden className="text-[10px] text-muted-foreground">
          {xTicks.map((t) => (
            <text
              key={`tx${t}`}
              x={x(t)}
              y={plot.bottom + 14}
              textAnchor="middle"
              className="fill-current"
            >
              {formatTickValue(metric.unit, t)}
            </text>
          ))}
          {yTicks.map((t) => (
            <text
              key={`ty${t}`}
              x={plot.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-current"
            >
              {t}
            </text>
          ))}
          <text x={plot.left - 6} y={plot.top - 1} textAnchor="end" className="fill-current">
            rank
          </text>
        </g>

        {points.map((p, i) => (
          <g
            key={p.trackFile}
            ref={(el) => {
              dotRefs.current[i] = el;
            }}
            role="img"
            aria-label={pointLabel(p)}
            tabIndex={i === focusIndex ? 0 : -1}
            className="cursor-default outline-none"
            onKeyDown={(e) => onDotKeyDown(e, i)}
            onFocus={() => {
              setFocusIndex(i);
              setFocusedTrack(p.trackFile);
              setReadout(p);
              setHighlight(p.trackFile);
            }}
            onBlur={() => {
              setFocusedTrack(null);
              setHighlight(null);
            }}
            onMouseEnter={() => {
              setReadout(p);
              setHighlight(p.trackFile);
            }}
          >
            {/* Invisible halo: a 24px pointer/focus target over a 10px dot
                (accessibility standard §4.5, WCAG 2.5.8). */}
            <circle cx={x(p.value)} cy={y(p.rank)} r={12} className="fill-transparent" />
            <circle
              cx={x(p.value)}
              cy={y(p.rank)}
              r={5}
              className={cn(
                "fill-chart-1/70",
                (focusedTrack === p.trackFile || highlight === p.trackFile) &&
                  "stroke-ring stroke-2"
              )}
            />
          </g>
        ))}

        {/* Direct labels, drawn over the dots so names stay legible — plus a
            background-coloured stroke halo (paint-order) so a name crossing a
            dot or gridline still reads. Text wears muted ink, not the series
            colour — the dot beside it carries identity. aria-hidden: every
            dot already announces its pilot. */}
        <g
          aria-hidden
          className="stroke-background text-[10px] text-muted-foreground [paint-order:stroke] [stroke-width:3px]"
        >
          {labelIndices.map((pi, k) => {
            const p = points[pi];
            const px = x(p.value);
            // Anchor away from the nearer plot edge so names never run off.
            const onRight = px > (plot.left + plot.right) / 2;
            return (
              <text
                key={p.trackFile}
                x={onRight ? px - 9 : px + 9}
                y={labelYs[k]}
                textAnchor={onRight ? "end" : "start"}
                className={cn(
                  "fill-current",
                  // In label-everyone mode the special pilots go bold to
                  // stand out of the crowd.
                  showAllLabels && specialIndices.has(pi) && "font-semibold"
                )}
              >
                {p.rank}. {p.name}
              </text>
            );
          })}
        </g>
      </svg>

      {onShowAllLabelsChange ? (
        <Checkbox
          isSelected={showAllLabels}
          onChange={onShowAllLabelsChange}
          className="print:hidden"
        >
          Label every pilot
        </Checkbox>
      ) : null}

      {/* Visual mirror of hover/focus — the dots' aria-labels serve screen
          readers, so no aria-live here (it would double-announce). Hidden in
          print: an invitation to hover is meaningless on paper. */}
      <p aria-hidden className="min-h-4 text-xs text-muted-foreground print:hidden">
        {readout ? pointLabel(readout) : "Hover or focus a dot to name the pilot behind it."}
      </p>

      <figcaption className="text-xs text-muted-foreground">
        Each dot is a pilot: across is the metric's value, up is a better rank.{" "}
        {caption}
      </figcaption>
    </figure>
  );
}
