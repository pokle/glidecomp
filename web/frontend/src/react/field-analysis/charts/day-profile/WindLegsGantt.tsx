/**
 * Wind by leg, drawn as a Gantt over the day: one row per speed-section leg
 * in course order, its bar spanning the window the field actually circled
 * on that leg. The bars overlap in time — fast pilots are on leg 3 while
 * slow pilots still circle leg 1 — and on the panel's shared axis that
 * overlap sits directly under the wind and climb charts.
 *
 * Speed is NOT bar colour (a thin bar shows too little colour area to read
 * a ramp): it is the arrow's length plus a text label, with the arrow angle
 * carrying direction — same convention as the hourly chart above. A leg
 * nobody circled on still gets its row, honestly empty.
 *
 * Hover names the leg in the panel's shared readout; the Wind by leg table
 * below remains the exact, screen-reader-navigable reading.
 */
import type { DayTimingSeries, WindLegsSeries } from "../../types";
import { formatTimeRange } from "@/react/lib/time";
import { useUnits } from "@/react/lib/units";
import { formatMetricValue } from "../../types";
import { unitDisplay } from "../../units";
import type { TimeAxis } from "./time-axis";
import { TimeGridColumns, TimeTickLabels } from "./TimeAxisParts";
import {
  PLOT_LEFT,
  PLOT_RIGHT,
  W,
  degToCompass,
  windArrowPath,
  windArrowTransform,
  windLabel,
} from "./shared";

const TOP = 6;
const ROW_H = 28;
const BAR_H = 9;
/** Speed→arrow-length range; bounded so a rotated arrow stays in its row. */
const ARROW_MIN = 8;
const ARROW_MAX = 16;
/** Room a "15 km/h NW" label needs before it flips to the bar's other side. */
const LABEL_W = 58;

export function WindLegsGantt({
  series,
  timing,
  axis,
  timeZone,
  setReadout,
}: {
  series: WindLegsSeries;
  timing: DayTimingSeries | null;
  axis: TimeAxis;
  timeZone: string | undefined;
  setReadout: (text: string | null) => void;
}) {
  // Wind follows the speed preference; series values are km/h and convert
  // here at the display boundary. Arrow lengths use the km/h ratio directly
  // (a linear factor cancels out of speed/maxSpeed).
  const wind = unitDisplay("km/h", useUnits());

  if (series.legs.length === 0) return null;

  const rowsBottom = TOP + series.legs.length * ROW_H;
  const H = rowsBottom + 18;
  const maxSpeed = Math.max(1, ...series.legs.map((l) => l.speedKmh ?? 0));

  // Just the race's bookends here — the first gate and the deadline. The
  // full gate sequence is labelled on the climb chart above; repeating all
  // of it would bury the bars.
  const rules = timing
    ? [
        ...timing.startGates.slice(0, 1).map((g) => new Date(g).getTime()),
        ...(timing.deadline ? [new Date(timing.deadline).getTime()] : []),
      ]
    : [];

  const legReadout = (l: WindLegsSeries["legs"][number]): string =>
    l.from !== null && l.to !== null && l.speedKmh !== null && l.directionDeg !== null
      ? `${l.label} — field circled ${formatTimeRange(l.from, l.to, timeZone)}, ` +
        `${formatMetricValue(wind.unit, l.speedKmh * wind.factor)} ${wind.unit} from ${Math.round(l.directionDeg)}° ` +
        `(${degToCompass(l.directionDeg)}), ${l.n} circle estimate${l.n === 1 ? "" : "s"}`
      : `${l.label} — no circling on this leg, so no wind estimate`;

  const flown = series.legs.filter((l) => l.n > 0).length;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={
        `Wind by leg: ${series.legs.length} speed-section legs as time bars spanning when the ` +
        `field circled on each, with a wind arrow and speed per leg (${flown} of ` +
        `${series.legs.length} legs have estimates). The Wind by leg table below carries the exact numbers.`
      }
      onMouseLeave={() => setReadout(null)}
    >
      <TimeGridColumns axis={axis} top={TOP} bottom={rowsBottom} />
      {/* Row separators. */}
      {series.legs.map((_, i) => (
        <line
          key={`s${i}`}
          x1={PLOT_LEFT}
          x2={PLOT_RIGHT}
          y1={TOP + (i + 1) * ROW_H}
          y2={TOP + (i + 1) * ROW_H}
          className="stroke-border"
          strokeWidth={1}
        />
      ))}

      {/* Task-clock rules (labelled on the climb chart above). */}
      <g aria-hidden>
        {rules.map((ms, i) => (
          <line
            key={`r${ms}-${i}`}
            x1={axis.x(ms)}
            x2={axis.x(ms)}
            y1={TOP}
            y2={rowsBottom}
            className="stroke-muted-foreground/70"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
        ))}
      </g>

      {series.legs.map((l, i) => {
        const rowTop = TOP + i * ROW_H;
        const barY = rowTop + 15;
        const barCy = barY + BAR_H / 2;
        const hasData = l.from !== null && l.to !== null && l.speedKmh !== null && l.directionDeg !== null;
        const x0 = hasData ? axis.x(new Date(l.from!).getTime()) : 0;
        const x1 = hasData ? Math.max(axis.x(new Date(l.to!).getTime()), x0 + 3) : 0;
        const arrowLen = hasData ? ARROW_MIN + (ARROW_MAX - ARROW_MIN) * (l.speedKmh! / maxSpeed) : 0;
        const labelRight = x1 + 6 + LABEL_W <= PLOT_RIGHT;
        return (
          // Key by row index: concentric tasks (e.g. Kosciuszko Loop) repeat
          // the same waypoint name in every leg label.
          <g key={i} aria-hidden>
            {/* The leg's name, printed over the grid with a background halo. */}
            <text
              x={PLOT_LEFT + 2}
              y={rowTop + 11}
              textAnchor="start"
              className="fill-current stroke-background text-[10px] [paint-order:stroke] [stroke-width:3px]"
            >
              {l.label}
            </text>
            {hasData ? (
              <>
                <rect
                  x={x0}
                  width={x1 - x0}
                  y={barY}
                  height={BAR_H}
                  rx={2}
                  style={{ fill: "var(--chart-2)" }}
                  opacity={0.35}
                />
                <path
                  d={windArrowPath(arrowLen)}
                  transform={windArrowTransform((x0 + x1) / 2, barCy, l.directionDeg!)}
                  fill="none"
                  style={{ stroke: "var(--chart-2)" }}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <text
                  x={labelRight ? x1 + 6 : x0 - 6}
                  y={barCy + 3}
                  textAnchor={labelRight ? "start" : "end"}
                  className="fill-current stroke-background text-[9px] text-muted-foreground [paint-order:stroke] [stroke-width:3px]"
                >
                  {windLabel(l.speedKmh! * wind.factor, wind.unit, l.directionDeg!)}
                </text>
              </>
            ) : (
              <text
                x={PLOT_LEFT + 2}
                y={barCy + 3}
                textAnchor="start"
                className="fill-current text-[9px] italic text-muted-foreground"
              >
                no circling on this leg
              </text>
            )}
          </g>
        );
      })}

      {/* Hover targets: whole rows. */}
      {series.legs.map((l, i) => (
        <rect
          key={`h${i}`}
          x={PLOT_LEFT}
          width={PLOT_RIGHT - PLOT_LEFT}
          y={TOP + i * ROW_H}
          height={ROW_H}
          fill="transparent"
          onMouseEnter={() => setReadout(legReadout(l))}
        />
      ))}

      <TimeTickLabels axis={axis} y={rowsBottom + 14} />
    </svg>
  );
}
