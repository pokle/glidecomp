/**
 * The horserace, drawn: minutes behind the fastest pilot at each speed-
 * section turnpoint, one line per pilot. The leader hugs the top (0 behind);
 * lines that dive show where a race was lost — a bad glide between two
 * turnpoints is a visible cliff in a way no table row can be.
 *
 * The top five pilots are coloured (--chart-1..5, fixed order by rank); the
 * rest are muted context. A line simply stops at the last turnpoint its pilot
 * reached. The horserace table below the chart remains the exact,
 * screen-reader-navigable reading.
 *
 * **Drawn in CSS pixels** (`charts/use-chart-box.ts`, issue #860). It was a
 * 560-unit drawing scaled to the page, so a phone painted its labels at
 * 5.3px. Two things followed from giving the type a real size:
 *
 * - The leaders' names were at the right-hand ends of their lines, in a
 *   margin a fifth of the chart wide. At a readable size that margin is
 *   nearly half a phone. So each coloured line ends in its RANK, and the
 *   names are a legend row of real text above the plot, which wraps. The
 *   number is what ties a line to its name without relying on colour alone.
 * - Seven turnpoint names are wider than a phone, so they step down over two
 *   or three rows (`staggerRows`).
 *
 * **Selecting a line.** Arrow keys walk the lines in rank order. A tap, a
 * click or a finger dragged across chooses the line nearest the pointer
 * (`charts/use-nearest-pointer.ts`), and a mouse moving near a line does
 * the same as a hover. The chosen pilot is named in the line above the plot
 * (`charts/ChartReadout.tsx`) and highlighted page-wide.
 */
import { useMemo, useRef, useState } from "react";
import { cn } from "@/react/lib/utils";
import {
  formatMetricValue,
  type CategoricalReportSeries,
  type TaskAnalysisReport,
} from "../types";
import { usePilotHighlight } from "../PilotHighlightContext";
import { linearScale, niceTicks, spreadLabels, staggerRows } from "./chart-utils";
import { XAxisTitle, YAxisTitle } from "@/react/charts/AxisTitle";
import { useChartBox } from "@/react/charts/use-chart-box";
import { approxTextWidth } from "@/react/charts/text-width";
import { nearestLine, type XY } from "@/react/charts/nearest";
import { focusMark, nearestPointerProps } from "@/react/charts/use-nearest-pointer";
import { ChartReadout } from "@/react/charts/ChartReadout";
import { MetLegend } from "./day-profile/MetLegend";
import { unitWords } from "../units";

/** Fixed rank-order palette for the coloured leaders. */
const LINE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

/** The first and last turnpoints sit this far inside the plot's edges, so a
 * line's end is not drawn on the frame. */
const X_INSET = 6;

interface RaceLine {
  trackFile: string;
  name: string;
  rank: number;
  points: (number | null)[];
}

/** Index of the last non-null point (0 when none — callers pre-filter empties). */
function lastNonNullIndex(points: (number | null)[]): number {
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i] !== null) return i;
  }
  return 0;
}

/** A line as the pieces that are drawn: each a run of joined points, broken
 * where a value is missing. */
function linePieces(
  points: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number
): XY[][] {
  const pieces: XY[][] = [];
  let piece: XY[] | null = null;
  points.forEach((v, i) => {
    if (v === null) {
      piece = null;
      return;
    }
    if (!piece) {
      piece = [];
      pieces.push(piece);
    }
    piece.push({ x: x(i), y: y(v) });
  });
  return pieces;
}

function piecesPath(pieces: XY[][]): string {
  return pieces
    .map((piece) => `M${piece.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("L")}`)
    .join("");
}

export function HorseraceLines({
  series,
  report,
}: {
  series: CategoricalReportSeries;
  report: TaskAnalysisReport;
}) {
  const { highlight, setHighlight } = usePilotHighlight();
  const [focusIndex, setFocusIndex] = useState(0);
  const [focusedTrack, setFocusedTrack] = useState<string | null>(null);
  const [hoveredTrack, setHoveredTrack] = useState<string | null>(null);
  const lineRefs = useRef<(SVGGElement | null)[]>([]);
  const { ref: svgRef, box } = useChartBox();

  // Join by trackFile (never index), rank order so arrows read the leaderboard.
  const lines = useMemo<RaceLine[]>(() => {
    const byTrack = new Map(report.pilots.map((p) => [p.trackFile, p]));
    return series.perPilot
      .flatMap((s) => {
        const pilot = byTrack.get(s.trackFile);
        return pilot && s.points.some((v) => v !== null)
          ? [{ trackFile: s.trackFile, name: pilot.pilotName, rank: pilot.rank, points: s.points }]
          : [];
      })
      .sort((a, b) => a.rank - b.rank);
  }, [series, report]);

  if (lines.length === 0 || series.xLabels.length < 2) {
    return null;
  }

  const W = box.width;
  const em = box.fontSize;
  const count = series.xLabels.length;
  const colored = lines.slice(0, LINE_COLORS.length);

  const yMax = Math.max(
    1,
    ...lines.flatMap((l) => l.points.filter((v): v is number => v !== null))
  );
  const yTicks = niceTicks([0, yMax], 4);
  // Bare numbers: the axis title names the unit in words, and "80 min" on
  // every tick is a margin a phone cannot spare.
  const tickText = (t: number) => formatMetricValue(series.yUnit, t).replace(/\.0+$/, "");
  const yTitle = `behind the leader (${unitWords(series.yUnit)})`;

  // Margins hold type, so each is measured in it.
  // - left: the rotated axis title's line, then the widest tick.
  // - right: the rank at the end of a leader's line, or the half of the last
  //   turnpoint name that overhangs the plot, whichever is wider.
  const labelWidths = series.xLabels.map((label) => approxTextWidth(label, em));
  const tickWidth = Math.max(...yTicks.map((t) => approxTextWidth(tickText(t), em)));
  const rankWidth = Math.max(...colored.map((l) => approxTextWidth(String(l.rank), em)));
  const left = Math.round(em * 2.05 + tickWidth);
  const right = Math.ceil(
    Math.max(em * 0.5 + rankWidth + 2, labelWidths[count - 1] / 2 + 2) - X_INSET
  );
  const plotLeft = left;
  const plotRight = W - Math.max(right, Math.round(em * 0.5));
  const spacing = (plotRight - plotLeft - X_INSET * 2) / (count - 1);
  const rows = staggerRows(labelWidths, spacing, em * 0.6);
  const top = Math.round(em * 0.8);
  // Tall enough for the rotated title, whatever the width.
  const plotHeight = Math.round(
    Math.max(Math.min(em * 24, Math.max(em * 15, W * 0.5)), approxTextWidth(yTitle, em) + em)
  );
  const plotTop = top;
  const plotBottom = top + plotHeight;
  const rowHeight = em * 1.25;
  const xTitleY = plotBottom + em * 1.4 + rowHeight * rows;
  const H = Math.round(xTitleY + em * 0.5);

  const x = linearScale([0, count - 1], [plotLeft + X_INSET, plotRight - X_INSET]);
  // 0 behind (the leader) at the TOP: up is better, everywhere on the page.
  const y = linearScale([0, yMax], [plotTop + 4, plotBottom - 6]);

  const geometry = lines.map((l) => linePieces(l.points, x, y));
  const rankLabelYs = spreadLabels(
    colored.map((l) => y(l.points[lastNonNullIndex(l.points)] ?? 0) + em * 0.35),
    em * 1.05,
    plotTop + em * 0.8,
    plotBottom
  );

  function lineLabel(l: RaceLine): string {
    const lastIdx = lastNonNullIndex(l.points);
    const behind = l.points[lastIdx]!;
    const where = series.xLabels[lastIdx];
    return `${l.rank}. ${l.name} — ${
      behind === 0 ? "level with the leader" : `${behind.toFixed(1)} min behind`
    } at ${where}${lastIdx < series.xLabels.length - 1 ? ", then stopped" : ""}`;
  }

  function onLineKeyDown(e: React.KeyboardEvent, i: number) {
    let next: number | null = null;
    switch (e.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = Math.min(i + 1, lines.length - 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = Math.max(i - 1, 0);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = lines.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next !== i) {
      setFocusIndex(next);
      lineRefs.current[next]?.focus();
    }
  }

  const pointer = nearestPointerProps({
    viewBoxWidth: W,
    nearest: (px, py) => nearestLine(geometry, px, py),
    onHover: (i) => {
      const track = i === null ? null : lines[i].trackFile;
      setHoveredTrack(track);
      setHighlight(track);
    },
    onPick: (i) => focusMark(lineRefs.current[i]),
  });

  // The pilot under the mouse, else the chosen one, else whoever the rest of
  // the page has highlighted.
  const emphasizedTrack = hoveredTrack ?? focusedTrack ?? highlight;
  const emphasizedIndex = lines.findIndex((l) => l.trackFile === emphasizedTrack);
  // Named above the plot: what this chart chose, not the page's highlight.
  const named = lines.find((l) => l.trackFile === (hoveredTrack ?? focusedTrack));

  return (
    <figure className="space-y-1" data-chart="horserace">
      <ChartReadout prompt="Select a line to name the pilot behind it." lines={2}>
        {named ? lineLabel(named) : null}
      </ChartReadout>
      {/* The leaders, named. A row of real text above the plot rather than
          labels at the ends of the lines: see the note at the top. */}
      <MetLegend
        entries={colored.map((l, i) => ({
          key: l.trackFile,
          text: `${l.rank}. ${l.name}`,
          stroke: LINE_COLORS[i],
          strokeWidth: 2,
        }))}
      />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full select-none"
        role="group"
        aria-label={`${series.title}, line chart. One line per pilot; the leader runs along the top at zero. The table below carries the exact numbers.`}
        {...pointer}
      >
        {/* Grid + axes. */}
        {yTicks.map((t) => (
          <line
            key={`gy${t}`}
            x1={plotLeft}
            x2={plotRight}
            y1={y(t)}
            y2={y(t)}
            className="stroke-border"
            strokeWidth={1}
          />
        ))}
        {series.xLabels.map((_, i) => (
          <line
            key={`gx${i}`}
            x1={x(i)}
            x2={x(i)}
            y1={plotTop}
            // A name on a lower row is joined to its turnpoint by the
            // gridline running down to it.
            y2={plotBottom + rowHeight * (i % rows)}
            className="stroke-border"
            strokeWidth={1}
          />
        ))}
        <g aria-hidden fontSize={em} className="text-muted-foreground">
          {yTicks.map((t) => (
            <text
              key={`ty${t}`}
              x={plotLeft - em * 0.5}
              y={y(t) + em * 0.35}
              textAnchor="end"
              className="fill-current"
            >
              {tickText(t)}
            </text>
          ))}
          {series.xLabels.map((label, i) => (
            <text
              key={`tx${i}`}
              x={x(i)}
              y={plotBottom + em * 1.05 + rowHeight * (i % rows)}
              textAnchor="middle"
              className="fill-current"
            >
              {label}
            </text>
          ))}
        </g>

        {/* The axes, named — replacing a bare "behind" in the top-left corner
            that named neither the quantity nor its unit. Which end is better
            is carried by the ticks: 0 sits at the top. */}
        <YAxisTitle x={em * 1.05} top={plotTop} bottom={plotBottom} fontSize={em}>
          {yTitle}
        </YAxisTitle>
        <XAxisTitle left={plotLeft} right={plotRight} y={xTitleY} fontSize={em}>
          speed-section turnpoints, in order
        </XAxisTitle>

        {/* Muted field first, coloured leaders after, so leaders draw on top.
            Each line is one focusable element. The pointer is answered by the
            <svg>, which finds the nearest line, so a line needs no fat
            invisible stroke for a target. */}
        {[...lines.slice(LINE_COLORS.length), ...colored].map((l) => {
          const i = lines.indexOf(l);
          const isColored = i < LINE_COLORS.length;
          return (
            <g
              key={l.trackFile}
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              role="img"
              aria-label={lineLabel(l)}
              tabIndex={i === focusIndex ? 0 : -1}
              data-line={l.trackFile}
              className="cursor-default outline-none"
              onKeyDown={(e) => onLineKeyDown(e, i)}
              onFocus={() => {
                setFocusIndex(i);
                setFocusedTrack(l.trackFile);
                setHighlight(l.trackFile);
              }}
              onBlur={() => {
                setFocusedTrack(null);
                setHighlight(null);
              }}
            >
              <path
                d={piecesPath(geometry[i])}
                fill="none"
                style={isColored ? { stroke: LINE_COLORS[i] } : undefined}
                className={cn(!isColored && "stroke-muted-foreground/40")}
                strokeWidth={isColored ? 2 : 1}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {/* The chosen line again, last, over the field and the leaders. A
            copy rather than a reorder: moving a focused element in the DOM
            takes focus off it. */}
        {emphasizedIndex >= 0 ? (
          <path
            aria-hidden
            data-emphasized={lines[emphasizedIndex].trackFile}
            d={piecesPath(geometry[emphasizedIndex])}
            fill="none"
            style={
              emphasizedIndex < LINE_COLORS.length
                ? { stroke: LINE_COLORS[emphasizedIndex] }
                : undefined
            }
            className={cn(
              "pointer-events-none",
              emphasizedIndex >= LINE_COLORS.length && "stroke-foreground"
            )}
            strokeWidth={3.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* Each leader's rank at the end of its line, collision-spread. */}
        <g
          aria-hidden
          fontSize={em}
          className="stroke-background font-medium text-foreground [paint-order:stroke] [stroke-width:3px]"
        >
          {colored.map((l, k) => (
            <text
              key={l.trackFile}
              x={x(lastNonNullIndex(l.points)) + em * 0.5}
              y={rankLabelYs[k]}
              textAnchor="start"
              className="fill-current"
            >
              {l.rank}
            </text>
          ))}
        </g>
      </svg>

      {/* The axes now name the quantity and the order, so the caption keeps
          only what they cannot say: what a short line means, and who is
          coloured. */}
      <figcaption className="text-xs text-muted-foreground">
        A line that stops early is a pilot who landed. The top {colored.length}{" "}
        are coloured; the table below has every pilot.
      </figcaption>
    </figure>
  );
}
