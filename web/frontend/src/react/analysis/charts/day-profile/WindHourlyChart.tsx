/**
 * Wind by hour, drawn: the speed line with a direction-arrow lane above it.
 *
 * Direction is NEVER a second line — the 350°→010° wraparound would make a
 * line chart lie — it is an arrow per hour, flying WITH the wind (the
 * tables' figures are degrees FROM; the legend in the panel caption settles
 * the convention). Arrow opacity tracks the hour's sample count, so a thin
 * edge-of-day bucket doesn't read as confidently as a busy one. The
 * whole-task vector mean is a dashed reference line.
 *
 * An hour is selected by touch, mouse or keyboard (HourColumns.tsx) and its
 * figures print in the legend row; the Wind by hour table below remains the
 * exact, screen-reader-navigable reading.
 *
 * Geometry comes from the stack's `ChartFrame`, and every height here is a
 * multiple of its type size — see frame.ts.
 */
import type { WindHourlySeries } from "../../types";
import { useUnits } from "@/react/lib/units";
import { formatMetricValue } from "../../types";
import { unitDisplay } from "../../units";
import { linearScale, niceTicks } from "../chart-utils";
import type { TimeAxis } from "./time-axis";
import type { ChartFrame } from "./frame";
import { TimeGridColumns, TimeTickLabels } from "./TimeAxisParts";
import { ChartHeader } from "./MetSourceTag";
import { MetLegend, type LegendEntry } from "./MetLegend";
import { HourColumns, columnAt, hourRange, useHourPointer, type HourColumn } from "./HourColumns";
import { degToCompass, windArrowPath, windArrowTransform } from "./shared";

const HOUR_MS = 3_600_000;

/** One stroke definition per series, shared by the mark and its legend
 * swatch. */
const SPEED_STROKE = { stroke: "var(--chart-2)", strokeWidth: 2 };
const MEAN_STROKE = { stroke: "var(--chart-2)", strokeWidth: 1, dash: "4 3", opacity: 0.7 };
const ARROW_STROKE = { stroke: "var(--chart-2)", strokeWidth: 1.6 };

export function WindHourlyChart({
  series,
  axis,
  frame,
  timeZone,
  selectedMs,
  onSelect,
}: {
  series: WindHourlySeries;
  axis: TimeAxis;
  frame: ChartFrame;
  timeZone: string | undefined;
  selectedMs: number | null;
  onSelect: (tMs: number | null) => void;
}) {
  // Wind is a horizontal drift, so it follows the speed preference; the
  // engine's series values are km/h and convert here at the display boundary.
  const wind = unitDisplay("km/h", useUnits());

  const points = series.hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    return { ...h, speed: h.speedKmh * wind.factor, tMs, cx: axis.x(tMs + HOUR_MS / 2) };
  });
  const circles = (n: number) => `${n} circle estimate${n === 1 ? "" : "s"}`;
  const columns: HourColumn[] = points.map((p) => ({
    tMs: p.tMs,
    label:
      `${hourRange(p.tMs, timeZone)} — ${formatMetricValue(wind.unit, p.speed)} ${wind.unit} ` +
      `from ${Math.round(p.directionDeg)}° (${degToCompass(p.directionDeg)}), ${circles(p.n)}`,
  }));
  const pointer = useHourPointer(frame, axis, columns, onSelect);

  if (points.length === 0) return null;

  const maxN = Math.max(...points.map((p) => p.n));
  const wholeTaskSpeed =
    series.wholeTask === null ? null : series.wholeTask.speedKmh * wind.factor;

  // Heights in ems of the label size: a lane for the arrows, the plot, and a
  // row for the time labels — the same rows as the modelled wind chart.
  const em = frame.fontSize;
  const laneY = em * 0.95;
  const plot = { top: em * 2.5, bottom: em * 10 };
  const H = plot.bottom + em * 2;
  const columnWidth = Math.abs(axis.x(points[0].tMs + HOUR_MS) - axis.x(points[0].tMs));
  const arrowLen = Math.max(7, Math.min(em * 1.3, columnWidth * 0.75));

  const yMax =
    Math.max(5 * wind.factor, ...points.map((p) => p.speed), wholeTaskSpeed ?? 0) * 1.08;
  const y = linearScale([0, yMax], [plot.bottom, plot.top]);
  const yTicks = niceTicks([0, yMax], 3);
  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(1)},${y(p.speed).toFixed(1)}`)
    .join("");

  const sel = columnAt(points, selectedMs);
  const legend: LegendEntry[] = [
    {
      key: "speed",
      text: "wind speed",
      value: sel
        ? `${formatMetricValue(wind.unit, sel.speed)} ${wind.unit} ${degToCompass(sel.directionDeg)}`
        : null,
      ...SPEED_STROKE,
    },
  ];
  if (wholeTaskSpeed !== null) {
    legend.push({
      key: "mean",
      text: `task mean ${wholeTaskSpeed.toFixed(0)} ${wind.unit}`,
      ...MEAN_STROKE,
    });
  }
  legend.push({
    key: "direction",
    kind: "arrow",
    text: "direction",
    value: sel ? `${Math.round(sel.directionDeg)}°` : null,
    ...ARROW_STROKE,
  });
  if (sel) legend.push({ key: "n", kind: "note", text: circles(sel.n) });

  const speeds = points.map((p) => p.speed);
  return (
    <div className="space-y-0.5" data-day-chart="wind">
      <ChartHeader title="From tracks: wind" when={sel ? hourRange(sel.tMs, timeZone) : null} />
      <MetLegend entries={legend} lines={3} />
      <svg
        viewBox={`0 0 ${frame.width} ${H}`}
        className="h-auto w-full select-none"
        role="group"
        aria-label={
          `Wind by hour: speed line with direction arrows across ${points.length} ` +
          `hour${points.length === 1 ? "" : "s"}, ranging ${formatMetricValue(wind.unit, Math.min(...speeds))} to ` +
          `${formatMetricValue(wind.unit, Math.max(...speeds))} ${wind.unit}. The Wind by hour table below carries the exact numbers.`
        }
        {...pointer}
      >
        <TimeGridColumns axis={axis} top={plot.top} bottom={plot.bottom} />
        {yTicks.map((t) => (
          <line
            key={`gy${t}`}
            x1={frame.plotLeft}
            x2={frame.plotRight}
            y1={y(t)}
            y2={y(t)}
            className="stroke-border"
            strokeWidth={1}
          />
        ))}
        <g aria-hidden fontSize={em} className="text-muted-foreground">
          {yTicks.map((t) => (
            <text
              key={`ty${t}`}
              x={frame.plotLeft - em * 0.6}
              y={y(t) + em * 0.35}
              textAnchor="end"
              className="fill-current"
            >
              {formatMetricValue(wind.unit, t).replace(/\.0+$/, "")}
            </text>
          ))}
          <text x={0} y={plot.top - em * 0.3} className="fill-current">
            {wind.unit}
          </text>
        </g>

        {/* Whole-task vector mean — the baseline the hours vary around. */}
        {wholeTaskSpeed !== null ? (
          <line
            aria-hidden
            x1={frame.plotLeft}
            x2={frame.plotRight}
            y1={y(wholeTaskSpeed)}
            y2={y(wholeTaskSpeed)}
            style={{ stroke: MEAN_STROKE.stroke }}
            strokeWidth={MEAN_STROKE.strokeWidth}
            strokeDasharray={MEAN_STROKE.dash}
            opacity={MEAN_STROKE.opacity}
          />
        ) : null}

        {/* Speed line + points. */}
        <path
          d={linePath}
          fill="none"
          style={{ stroke: SPEED_STROKE.stroke }}
          strokeWidth={SPEED_STROKE.strokeWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p) => (
          <circle key={p.t} cx={p.cx} cy={y(p.speed)} r={2.5} style={{ fill: SPEED_STROKE.stroke }} />
        ))}

        {/* Direction lane: one arrow per hour, flying with the wind; opacity
            tracks sample count so thin buckets read as tentative. */}
        {points.map((p) => (
          <path
            key={`a${p.t}`}
            d={windArrowPath(arrowLen)}
            transform={windArrowTransform(p.cx, laneY, p.directionDeg)}
            fill="none"
            style={{ stroke: ARROW_STROKE.stroke }}
            strokeWidth={ARROW_STROKE.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.4 + 0.6 * (p.n / maxN)}
          />
        ))}

        <TimeTickLabels axis={axis} y={plot.bottom + em * 1.4} frame={frame} />
        <HourColumns
          columns={columns}
          axis={axis}
          top={0}
          bottom={plot.bottom}
          selectedMs={selectedMs}
          onSelect={onSelect}
        />
      </svg>
    </div>
  );
}
