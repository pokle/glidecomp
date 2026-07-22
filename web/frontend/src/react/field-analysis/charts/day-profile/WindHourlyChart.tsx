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
 * Hover names the hour in the panel's shared readout; the Wind by hour
 * table below remains the exact, screen-reader-navigable reading.
 */
import type { WindHourlySeries } from "../../types";
import { formatTimeRange } from "@/react/lib/time";
import { useUnits } from "@/react/lib/units";
import { formatMetricValue } from "../../types";
import { unitDisplay } from "../../units";
import { formatTickValue, linearScale, niceTicks } from "../chart-utils";
import type { TimeAxis } from "./time-axis";
import { TimeGridColumns, TimeTickLabels } from "./TimeAxisParts";
import {
  PLOT_LEFT,
  PLOT_RIGHT,
  W,
  degToCompass,
  windArrowPath,
  windArrowTransform,
} from "./shared";

const HOUR_MS = 3_600_000;
const H = 168;
const LANE_Y = 14; // direction-arrow lane centreline
const PLOT = { top: 30, bottom: H - 26 };
const TICK_LABEL_Y = H - 10;

export function WindHourlyChart({
  series,
  axis,
  timeZone,
  setReadout,
}: {
  series: WindHourlySeries;
  axis: TimeAxis;
  timeZone: string | undefined;
  setReadout: (text: string | null) => void;
}) {
  // Wind is a horizontal drift, so it follows the speed preference; the
  // engine's series values are km/h and convert here at the display boundary.
  const wind = unitDisplay("km/h", useUnits());

  if (series.hours.length === 0) return null;

  const maxN = Math.max(...series.hours.map((h) => h.n));
  const wholeTaskSpeed =
    series.wholeTask === null ? null : series.wholeTask.speedKmh * wind.factor;
  const yMax =
    Math.max(
      5 * wind.factor,
      ...series.hours.map((h) => h.speedKmh * wind.factor),
      wholeTaskSpeed ?? 0
    ) * 1.08;
  const y = linearScale([0, yMax], [PLOT.bottom, PLOT.top]);
  const yTicks = niceTicks([0, yMax], 3);

  const points = series.hours.map((h) => {
    const t = new Date(h.t).getTime();
    const speed = h.speedKmh * wind.factor;
    return { ...h, speed, tMs: t, cx: axis.x(t + HOUR_MS / 2), cy: y(speed) };
  });
  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(1)},${p.cy.toFixed(1)}`)
    .join("");

  const hourReadout = (p: (typeof points)[number]): string =>
    `${formatTimeRange(p.t, new Date(p.tMs + HOUR_MS).toISOString(), timeZone)} — ` +
    `${formatMetricValue(wind.unit, p.speed)} ${wind.unit} from ${Math.round(p.directionDeg)}° (${degToCompass(p.directionDeg)}), ` +
    `${p.n} circle estimate${p.n === 1 ? "" : "s"}`;

  const speeds = points.map((p) => p.speed);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={
        `Wind by hour: speed line with direction arrows across ${points.length} ` +
        `hour${points.length === 1 ? "" : "s"}, ranging ${formatMetricValue(wind.unit, Math.min(...speeds))} to ` +
        `${formatMetricValue(wind.unit, Math.max(...speeds))} ${wind.unit}. The Wind by hour table below carries the exact numbers.`
      }
      onMouseLeave={() => setReadout(null)}
    >
      <TimeGridColumns axis={axis} top={PLOT.top} bottom={PLOT.bottom} />
      {yTicks.map((t) => (
        <line
          key={`gy${t}`}
          x1={PLOT_LEFT}
          x2={PLOT_RIGHT}
          y1={y(t)}
          y2={y(t)}
          className="stroke-border"
          strokeWidth={1}
        />
      ))}
      <g aria-hidden className="text-[10px] text-muted-foreground">
        {yTicks.map((t) => (
          <text key={`ty${t}`} x={PLOT_LEFT - 6} y={y(t) + 3} textAnchor="end" className="fill-current">
            {formatTickValue(wind.unit, t)}
          </text>
        ))}
        <text x={PLOT_LEFT - 6} y={LANE_Y + 3} textAnchor="end" className="fill-current text-[9px]">
          direction
        </text>
      </g>

      {/* Whole-task vector mean — the baseline the hours vary around. */}
      {wholeTaskSpeed !== null ? (
        <g aria-hidden>
          <line
            x1={PLOT_LEFT}
            x2={PLOT_RIGHT}
            y1={y(wholeTaskSpeed)}
            y2={y(wholeTaskSpeed)}
            style={{ stroke: "var(--chart-2)" }}
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.7}
          />
          <text
            x={PLOT_RIGHT - 2}
            y={y(wholeTaskSpeed) - 4}
            textAnchor="end"
            className="fill-current text-[9px] text-muted-foreground"
          >
            task mean {wholeTaskSpeed.toFixed(0)} {wind.unit}
          </text>
        </g>
      ) : null}

      {/* Speed line + points. */}
      <path
        d={linePath}
        fill="none"
        style={{ stroke: "var(--chart-2)" }}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map((p) => (
        <circle key={p.t} cx={p.cx} cy={p.cy} r={2.5} style={{ fill: "var(--chart-2)" }} />
      ))}

      {/* Direction lane: one arrow per hour, flying with the wind; opacity
          tracks sample count so thin buckets read as tentative. */}
      {points.map((p) => (
        <path
          key={`a${p.t}`}
          d={windArrowPath(13)}
          transform={windArrowTransform(p.cx, LANE_Y, p.directionDeg)}
          fill="none"
          style={{ stroke: "var(--chart-2)" }}
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
          opacity={0.4 + 0.6 * (p.n / maxN)}
        />
      ))}

      {/* Hover targets: one column per hour bucket. */}
      {points.map((p) => (
        <rect
          key={`h${p.t}`}
          x={axis.x(p.tMs)}
          width={Math.max(0, axis.x(p.tMs + HOUR_MS) - axis.x(p.tMs))}
          y={0}
          height={PLOT.bottom}
          fill="transparent"
          onMouseEnter={() => setReadout(hourReadout(p))}
        />
      ))}

      <TimeTickLabels axis={axis} y={TICK_LABEL_Y} />
    </svg>
  );
}
