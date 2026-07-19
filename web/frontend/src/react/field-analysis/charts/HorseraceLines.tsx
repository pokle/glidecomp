/**
 * The horserace, drawn: minutes behind the fastest pilot at each speed-
 * section turnpoint, one line per pilot. The leader hugs the top (0 behind);
 * lines that dive show where a race was lost — a bad glide between two
 * turnpoints is a visible cliff in a way no table row can be.
 *
 * The top five pilots are coloured (--chart-1..5, fixed order by rank) and
 * end-labelled; the rest are muted context. A line simply stops at the last
 * turnpoint its pilot reached. Arrow keys walk the lines in rank order, and
 * hover/focus names the pilot in a readout line and highlights them
 * page-wide. The horserace table below the chart remains the exact,
 * screen-reader-navigable reading.
 */
import { useMemo, useRef, useState } from "react";
import { cn } from "@/react/lib/utils";
import type { FieldAnalysisReport, ReportSeries } from "../types";
import { usePilotHighlight } from "../PilotHighlightContext";
import { formatTickValue, linearScale, niceTicks, spreadLabels } from "./chart-utils";

const W = 560;
const H = 320;
const MARGIN = { top: 10, right: 116, bottom: 28, left: 44 };
const PLOT = {
  left: MARGIN.left,
  right: W - MARGIN.right,
  top: MARGIN.top,
  bottom: H - MARGIN.bottom,
};
/** Fixed rank-order palette for the coloured leaders. */
const LINE_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

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

/** SVG path through the non-null points, breaking where a value is missing. */
function linePath(
  points: (number | null)[],
  x: (i: number) => number,
  y: (v: number) => number
): string {
  let d = "";
  let pen = false;
  points.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

export function HorseraceLines({
  series,
  report,
}: {
  series: ReportSeries;
  report: FieldAnalysisReport;
}) {
  const { highlight, setHighlight } = usePilotHighlight();
  const [focusIndex, setFocusIndex] = useState(0);
  const [focusedTrack, setFocusedTrack] = useState<string | null>(null);
  const [readout, setReadout] = useState<RaceLine | null>(null);
  const lineRefs = useRef<(SVGGElement | null)[]>([]);

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

  const yMax = Math.max(
    1,
    ...lines.flatMap((l) => l.points.filter((v): v is number => v !== null))
  );
  const x = linearScale([0, series.xLabels.length - 1], [PLOT.left + 6, PLOT.right - 6]);
  // 0 behind (the leader) at the TOP: up is better, everywhere on the page.
  const y = linearScale([0, yMax], [PLOT.top + 4, PLOT.bottom - 6]);
  const yTicks = niceTicks([0, yMax], 4);

  const colored = lines.slice(0, LINE_COLORS.length);
  const endLabelYs = spreadLabels(
    colored.map((l) => y(l.points[lastNonNullIndex(l.points)] ?? 0) + 3),
    11,
    PLOT.top + 4,
    PLOT.bottom
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

  const emphasizedTrack = focusedTrack ?? highlight;

  return (
    <figure className="space-y-1">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full"
        role="group"
        aria-label={`${series.title}, line chart. One line per pilot; the leader runs along the top at zero. The table below carries the exact numbers.`}
        onMouseLeave={() => {
          setReadout(null);
          setHighlight(null);
        }}
      >
        {/* Grid + axes. */}
        {yTicks.map((t) => (
          <line
            key={`gy${t}`}
            x1={PLOT.left}
            x2={PLOT.right}
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
            y1={PLOT.top}
            y2={PLOT.bottom}
            className="stroke-border"
            strokeWidth={1}
          />
        ))}
        <g aria-hidden className="text-[10px] text-muted-foreground">
          {yTicks.map((t) => (
            <text
              key={`ty${t}`}
              x={PLOT.left - 6}
              y={y(t) + 3}
              textAnchor="end"
              className="fill-current"
            >
              {formatTickValue(series.yUnit, t)}
            </text>
          ))}
          <text x={PLOT.left - 6} y={PLOT.top - 1} textAnchor="end" className="fill-current">
            behind
          </text>
          {series.xLabels.map((label, i) => (
            <text
              key={`tx${i}`}
              x={x(i)}
              y={PLOT.bottom + 14}
              textAnchor="middle"
              className="fill-current"
            >
              {label}
            </text>
          ))}
        </g>

        {/* Muted field first, coloured leaders after, so leaders draw on top.
            Each line is one focusable element; a fat invisible stroke is the
            pointer/focus target. */}
        {[...lines.slice(LINE_COLORS.length), ...colored].map((l) => {
          const i = lines.indexOf(l);
          const isColored = i < LINE_COLORS.length;
          const emphasized = emphasizedTrack === l.trackFile;
          const d = linePath(l.points, x, y);
          return (
            <g
              key={l.trackFile}
              ref={(el) => {
                lineRefs.current[i] = el;
              }}
              role="img"
              aria-label={lineLabel(l)}
              tabIndex={i === focusIndex ? 0 : -1}
              className="cursor-default outline-none"
              onKeyDown={(e) => onLineKeyDown(e, i)}
              onFocus={() => {
                setFocusIndex(i);
                setFocusedTrack(l.trackFile);
                setReadout(l);
                setHighlight(l.trackFile);
              }}
              onBlur={() => {
                setFocusedTrack(null);
                setHighlight(null);
              }}
              onMouseEnter={() => {
                setReadout(l);
                setHighlight(l.trackFile);
              }}
            >
              <path
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                pointerEvents="stroke"
              />
              <path
                d={d}
                fill="none"
                style={isColored ? { stroke: LINE_COLORS[i] } : undefined}
                className={cn(
                  !isColored && "stroke-muted-foreground/40",
                  emphasized && !isColored && "stroke-foreground/70"
                )}
                strokeWidth={emphasized ? 3 : isColored ? 2 : 1}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            </g>
          );
        })}

        {/* End labels for the coloured leaders, collision-spread. */}
        <g
          aria-hidden
          className="stroke-background text-[10px] text-muted-foreground [paint-order:stroke] [stroke-width:3px]"
        >
          {colored.map((l, k) => {
            const lastIdx = lastNonNullIndex(l.points);
            return (
              <text
                key={l.trackFile}
                x={x(lastIdx) + 8}
                y={endLabelYs[k]}
                textAnchor="start"
                className="fill-current"
              >
                {l.rank}. {l.name}
              </text>
            );
          })}
        </g>
      </svg>

      <p aria-hidden className="min-h-4 text-xs text-muted-foreground">
        {readout
          ? lineLabel(readout)
          : "Hover or focus a line to name the pilot behind it."}
      </p>

      <figcaption className="text-xs text-muted-foreground">
        Minutes behind the fastest pilot at each turnpoint — the leader runs
        along the top at zero, and a line that stops early is a pilot who
        landed. The top {colored.length} are coloured; every pilot's exact
        numbers are in the table below.
      </figcaption>
    </figure>
  );
}
