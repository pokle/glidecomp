/**
 * Wind by leg, drawn as a Gantt over the day: one row per speed-section leg
 * in course order.
 *
 * TWO nested bars per row, because one bar told a lie. The pale outer bar is
 * the leg's FLOWN window — first pilot on it to last pilot off it. The solid
 * inner band is the narrower window the wind was actually measured in: the
 * circles behind that leg's estimate. Glides produce no estimate at all, so
 * on a leg the field mostly glided the inner band can be a two-minute sliver
 * of a two-hour bar — and drawn alone (as it was until FIELD_ANALYSIS_VERSION
 * 17) it read as the course being flown out of order, a final leg "finishing"
 * before the leg preceding it began. The outer bar restores the nesting a
 * Gantt promises; the inner band's offset inside it is itself the finding.
 *
 * Bars overlap between rows — fast pilots are on leg 3 while slow pilots
 * still circle leg 1 — and on the panel's shared axis that overlap sits
 * directly under the wind and climb charts.
 *
 * Speed is NOT bar colour (a thin bar shows too little colour area to read a
 * ramp): it is the arrow's length plus a text label, with the arrow angle
 * carrying direction — same convention as the hourly chart above. Arrow and
 * band opacity track the leg's sample count, so a leg measured from one
 * pilot's four circles cannot read as confidently as one measured from 800;
 * below the thin thresholds the label says the counts outright.
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
import { ChartTitle } from "../AxisTitle";
import {
  PLOT_LEFT,
  PLOT_RIGHT,
  W,
  degToCompass,
  windArrowPath,
  windArrowTransform,
  windLabel,
} from "./shared";

/** Rows start below the chart title; H is derived from it, so the whole
 * chart simply grows by the title's height. */
const TOP = 20;
const ROW_H = 28;
const BAR_H = 9;
/** Speed→arrow-length range; bounded so a rotated arrow stays in its row. */
const ARROW_MIN = 8;
const ARROW_MAX = 16;
/** Rough px per character at the 9px label size, for the flip decision. */
const LABEL_CHAR_W = 4.6;

/** Below either of these, a leg's wind is one or two pilots' few minutes and
 * the label prints the counts rather than leaving the reader to hover. */
const THIN_ESTIMATES = 20;
const THIN_PILOTS = 3;

type Leg = WindLegsSeries["legs"][number];

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/**
 * The leg's two windows as epoch ms. Reports stored before version 17 carry
 * no flown window, so it falls back to the circling window — the old drawing,
 * rather than a missing bar, until the row revalidates.
 */
function windows(l: Leg): { flown: [number, number] | null; circling: [number, number] | null } {
  const cFrom = ms(l.from);
  const cTo = ms(l.to);
  const circling = cFrom !== null && cTo !== null ? ([cFrom, cTo] as [number, number]) : null;
  const fFrom = ms(l.flownFrom);
  const fTo = ms(l.flownTo);
  const flown = fFrom !== null && fTo !== null ? ([fFrom, fTo] as [number, number]) : circling;
  return { flown, circling };
}

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
  // Confidence is relative to the best-sampled leg, the same ramp the hourly
  // chart uses for its buckets.
  const maxN = Math.max(1, ...series.legs.map((l) => l.n));

  // Just the race's bookends here — the first gate and the deadline. The
  // full gate sequence is labelled on the climb chart above; repeating all
  // of it would bury the bars. Dropped when they fall outside the axis
  // window (which is framed by the field's own flying, ±2 h).
  const rules = (
    timing
      ? [
          ...timing.startGates.slice(0, 1).map((g) => new Date(g).getTime()),
          ...(timing.deadline ? [new Date(timing.deadline).getTime()] : []),
        ]
      : []
  ).filter((t) => t >= axis.domainStart && t <= axis.domainEnd);

  /** "4 circles, 1 pilot" — the sample behind a leg's figure, in words. */
  const sampleText = (l: Leg): string => {
    const circles = `${l.n} circle${l.n === 1 ? "" : "s"}`;
    return l.pilotsWithEstimates === undefined
      ? circles
      : `${circles}, ${l.pilotsWithEstimates} pilot${l.pilotsWithEstimates === 1 ? "" : "s"}`;
  };

  const isThin = (l: Leg): boolean =>
    l.n < THIN_ESTIMATES || (l.pilotsWithEstimates !== undefined && l.pilotsWithEstimates < THIN_PILOTS);

  const legReadout = (l: Leg): string => {
    const { flown, circling } = windows(l);
    const flownPart =
      flown === null
        ? "no pilot flew the whole leg"
        : `flown ${formatTimeRange(new Date(flown[0]).toISOString(), new Date(flown[1]).toISOString(), timeZone)}` +
          (l.pilotsOnLeg ? ` by ${l.pilotsOnLeg} pilot${l.pilotsOnLeg === 1 ? "" : "s"}` : "");
    if (circling === null || l.speedKmh === null || l.directionDeg === null)
      return `${l.label} — ${flownPart}; no circling on it, so no wind estimate`;
    return (
      `${l.label} — ${flownPart}. Wind ${formatMetricValue(wind.unit, l.speedKmh * wind.factor)} ${wind.unit} ` +
      `from ${Math.round(l.directionDeg)}° (${degToCompass(l.directionDeg)}), measured from ${sampleText(l)} ` +
      `while circling ${formatTimeRange(new Date(circling[0]).toISOString(), new Date(circling[1]).toISOString(), timeZone)}`
    );
  };

  const measured = series.legs.filter((l) => l.n > 0).length;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={
        `Wind by leg: ${series.legs.length} speed-section legs as time bars. Each pale bar spans when the ` +
        `field flew that leg; the solid band inside it spans only the circles the leg's wind was measured ` +
        `from, with an arrow and speed per leg (${measured} of ${series.legs.length} legs have estimates). ` +
        `The Wind by leg table below carries the exact numbers and sample counts.`
      }
      onMouseLeave={() => setReadout(null)}
    >
      {/* Named in-plot, matching the modelled charts in the same stack. */}
      <ChartTitle x={PLOT_LEFT - 38} y={12}>
        From tracks: wind by leg
      </ChartTitle>

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
        {rules.map((t, i) => (
          <line
            key={`r${t}-${i}`}
            x1={axis.x(t)}
            x2={axis.x(t)}
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
        const { flown: flownWin, circling } = windows(l);
        const hasWind = circling !== null && l.speedKmh !== null && l.directionDeg !== null;
        const span = (w: [number, number]): [number, number] => {
          const a = axis.x(w[0]);
          return [a, Math.max(axis.x(w[1]), a + 3)];
        };
        const [fx0, fx1] = flownWin ? span(flownWin) : [0, 0];
        const [cx0, cx1] = circling ? span(circling) : [0, 0];
        const arrowLen = hasWind ? ARROW_MIN + (ARROW_MAX - ARROW_MIN) * (l.speedKmh! / maxSpeed) : 0;
        // Opacity says "how much evidence"; the same 0.4→1.0 ramp as the
        // hourly chart's direction arrows.
        const confidence = 0.4 + 0.6 * (l.n / maxN);
        const text = hasWind
          ? windLabel(l.speedKmh! * wind.factor, wind.unit, l.directionDeg!) +
            (isThin(l) ? ` · ${sampleText(l)}` : "")
          : "no circling on this leg";
        // Labels sit past the FLOWN bar's end, flipping to its left when the
        // text would run off the plot — but only if the left has room, else a
        // long label on a bar that ends late would clip at the other edge.
        const textW = text.length * LABEL_CHAR_W;
        const labelRight = fx1 + 6 + textW <= PLOT_RIGHT || fx0 - 6 - textW < PLOT_LEFT;
        const labelX = flownWin ? (labelRight ? fx1 + 6 : fx0 - 6) : PLOT_LEFT + 2;
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
            {/* Outer bar: when the field was on the leg. */}
            {flownWin ? (
              <rect
                x={fx0}
                width={fx1 - fx0}
                y={barY}
                height={BAR_H}
                rx={2}
                style={{ fill: "var(--chart-2)" }}
                opacity={0.16}
              />
            ) : null}
            {/* Inner band: when its wind was measured. */}
            {hasWind ? (
              <>
                <rect
                  x={cx0}
                  width={cx1 - cx0}
                  y={barY}
                  height={BAR_H}
                  rx={2}
                  style={{ fill: "var(--chart-2)" }}
                  // Floored well clear of the outer bar's 0.16: a thin leg
                  // should read as tentative, not vanish — the reader still
                  // has to find WHERE in the leg the wind was measured.
                  opacity={0.38 + 0.32 * (l.n / maxN)}
                />
                <path
                  d={windArrowPath(arrowLen)}
                  transform={windArrowTransform((cx0 + cx1) / 2, barCy, l.directionDeg!)}
                  fill="none"
                  style={{ stroke: "var(--chart-2)" }}
                  strokeWidth={1.6}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  opacity={confidence}
                />
              </>
            ) : null}
            <text
              x={labelX}
              y={barCy + 3}
              textAnchor={flownWin && !labelRight ? "end" : "start"}
              className={
                hasWind
                  ? "fill-current stroke-background text-[9px] text-muted-foreground [paint-order:stroke] [stroke-width:3px]"
                  : "fill-current stroke-background text-[9px] italic text-muted-foreground [paint-order:stroke] [stroke-width:3px]"
              }
            >
              {text}
            </text>
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
