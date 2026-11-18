/**
 * How high the day went — the modelled thermal ceiling by hour.
 *
 * Two heights, both above ground level, because the useful ceiling is
 * whichever comes first:
 *   * the top of the mixed layer (boundary-layer depth) — how far the
 *     thermals themselves get, and
 *   * cloud base (the lifting condensation level from the surface
 *     temperature/dewpoint spread) — where they stop being invisible.
 *
 * Cloud base ABOVE the mixed-layer top is the blue day: nothing marks the
 * thermals. Cloud base BELOW it is the cumulus day, and the lower line is
 * the working ceiling. The filled band is the lesser of the two, which is
 * the height a pilot could actually use, so the shape of the day's window
 * reads at a glance.
 *
 * This is the panel's most direct answer to a question the tracklogs raise
 * but cannot settle: the climb chart above says when the climbs were
 * strongest; this says whether the sky was letting anyone get high.
 *
 * Either line can be absent, and the chart SAYS SO rather than quietly
 * drawing the other one — a lone line under a heading of "height" reads as
 * the whole answer. The case that matters in practice is the archived
 * forecast having no boundary-layer height before ~Sept 2024, which is every
 * competition scored from it up to then.
 */
import type { WeatherHour, WeatherSource } from "@/react/weather/types";
import { formatTimeRange } from "@/react/lib/time";
import { useUnits } from "@/react/lib/units";
import { formatMetricValue } from "../../types";
import { unitDisplay } from "../../units";
import { linearScale, niceTicks } from "../chart-utils";
import type { TimeAxis } from "./time-axis";
import type { ChartFrame } from "./frame";
import { TimeGridColumns, TimeTickLabels } from "./TimeAxisParts";
import { MetChartHeader, sourceSentence } from "./MetSourceTag";
import { MetLegend, type LegendEntry } from "./MetLegend";
import { HourColumns, useHourPointer, type HourColumn } from "./HourColumns";
import { heightReading } from "./met-readout";
import { usableCeilingM } from "./met-shared";

const HOUR_MS = 3_600_000;

/** One stroke definition per series, used by BOTH the line and its legend
 * swatch — the swatch is only trustworthy if it cannot drift from the line. */
const BL_STROKE = { stroke: "var(--chart-3)", strokeWidth: 2 };
const BASE_STROKE = { stroke: "var(--chart-5)", strokeWidth: 1.75, dash: "5 3" };

interface Point {
  tMs: number;
  cx: number;
  /** Mixed-layer top, display units AGL. */
  blTop: number | null;
  /** Condensation level, display units AGL. */
  base: number | null;
}

export function MetThermalChart({
  hours,
  source,
  axis,
  frame,
  timeZone,
  selectedMs,
  onSelect,
}: {
  hours: WeatherHour[];
  source: WeatherSource;
  axis: TimeAxis;
  frame: ChartFrame;
  timeZone: string | undefined;
  selectedMs: number | null;
  onSelect: (tMs: number | null) => void;
}) {
  // Heights follow the altitude preference; providers report metres.
  const alt = unitDisplay("m", useUnits());

  const columns: HourColumn[] = hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    const when = formatTimeRange(h.t, new Date(tMs + HOUR_MS).toISOString(), timeZone);
    const reading = heightReading(h, alt);
    return { tMs, label: reading ? `${when} — ${reading}` : `${when} — no height figures` };
  });
  const pointer = useHourPointer(frame, axis, columns, onSelect);

  const points: Point[] = hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    return {
      tMs,
      cx: axis.x(tMs + HOUR_MS / 2),
      blTop: h.boundaryLayerDepthM != null ? h.boundaryLayerDepthM * alt.factor : null,
      base: h.cloudBaseAglM != null ? h.cloudBaseAglM * alt.factor : null,
    };
  });

  const values = points.flatMap((p) =>
    [p.blTop, p.base].filter((v): v is number => v !== null)
  );
  if (values.length === 0) return null;

  // Heights in ems of the label size: room for the unit stamp, the plot, and
  // a row for the time labels.
  const em = frame.fontSize;
  const plot = { top: em * 1.5, bottom: em * 10 };
  const H = plot.bottom + em * 2;

  const yMax = Math.max(...values) * 1.1;
  const y = linearScale([0, yMax], [plot.bottom, plot.top]);
  const yTicks = niceTicks([0, yMax], 3);

  /** Line through the available points, lifting the pen across gaps. */
  const path = (pick: (p: Point) => number | null): string => {
    let d = "";
    let penDown = false;
    for (const p of points) {
      const v = pick(p);
      if (v === null) {
        penDown = false;
        continue;
      }
      d += `${penDown ? "L" : "M"}${p.cx.toFixed(1)},${y(v).toFixed(1)}`;
      penDown = true;
    }
    return d;
  };

  // The usable band: floor to the LOWER of the two ceilings, hour by hour.
  // Only drawn across a run of hours that have one, so a gap doesn't close
  // the polygon through empty space.
  const usableRuns: Point[][] = [];
  let run: Point[] = [];
  for (const p of points) {
    const ceiling = usableCeiling(p);
    if (ceiling === null) {
      if (run.length > 1) usableRuns.push(run);
      run = [];
    } else {
      run.push(p);
    }
  }
  if (run.length > 1) usableRuns.push(run);

  const hasBase = points.some((p) => p.base !== null);
  const hasBl = points.some((p) => p.blTop !== null);

  // A missing line is a fact about the DATASET, and one line on a chart
  // captioned "height" reads as the whole answer unless it says otherwise.
  // `variables` distinguishes the two ways it can go missing: the dataset
  // never carried a boundary-layer height (Open-Meteo's archived forecast
  // before ~Sept 2024, and every comp scored from it), or it carries one but
  // not for these hours.
  const missingNote = hasBl
    ? null
    : source.variables.includes("boundary_layer")
      ? "no thermal top in these hours"
      : "no thermal top — this dataset carries no boundary-layer height";

  // Solid for the thermal top, dashed for cloud base. The two lines cross on
  // exactly the interesting day (cloud base passing the thermal top is blue
  // turning to cumulus), so the swatch, not the position, names them.
  const legend: LegendEntry[] = [];
  if (hasBl) legend.push({ key: "bl", text: "thermal top", ...BL_STROKE });
  if (hasBase) legend.push({ key: "base", text: "cloud base", ...BASE_STROKE });
  if (missingNote) legend.push({ key: "missing", kind: "note", text: missingNote });

  return (
    <div className="space-y-0.5" data-met-chart="height">
      <MetChartHeader title="Weather: height" source={source} />
      <MetLegend entries={legend} />
      <svg
        viewBox={`0 0 ${frame.width} ${H}`}
        className="h-auto w-full select-none"
        role="group"
        aria-label={
          `Modelled thermal ceiling by hour above ground level: ` +
          [
            hasBl ? "the top of the mixed layer" : null,
            hasBase ? "the condensation level (cloud base)" : null,
          ]
            .filter(Boolean)
            .join(" and ") +
          `, peaking at ${Math.max(...values).toFixed(0)} ${alt.unit}. ` +
          (missingNote ? `${missingNote}. ` : "") +
          sourceSentence(source)
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
        {/* Bare numbers with the unit stamped once — and the stamp says AGL,
            which the ticks never did. */}
        <g aria-hidden fontSize={em} className="text-muted-foreground">
          {yTicks.map((t) => (
            <text
              key={`ty${t}`}
              x={frame.plotLeft - em * 0.6}
              y={y(t) + em * 0.35}
              textAnchor="end"
              className="fill-current"
            >
              {formatMetricValue(alt.unit, t).replace(/\.0+$/, "")}
            </text>
          ))}
          {/* From the chart's left edge, not right-aligned to the ticks as
              `AxisUnit` is: the stamp can be wider than the margin. */}
          <text x={0} y={plot.top - em * 0.3} className="fill-current">
            {`${alt.unit} AGL`}
          </text>
        </g>

        {/* Usable band — floor to whichever ceiling is lower that hour. */}
        {usableRuns.map((r) => (
          <path
            key={`band${r[0].tMs}`}
            aria-hidden
            d={
              r.map((p, i) => `${i === 0 ? "M" : "L"}${p.cx.toFixed(1)},${y(usableCeiling(p)!).toFixed(1)}`).join("") +
              `L${r.at(-1)!.cx.toFixed(1)},${y(0).toFixed(1)}` +
              `L${r[0].cx.toFixed(1)},${y(0).toFixed(1)}Z`
            }
            style={{ fill: "var(--chart-3)" }}
            opacity={0.13}
          />
        ))}

        {hasBl ? (
          <path
            d={path((p) => p.blTop)}
            fill="none"
            style={{ stroke: BL_STROKE.stroke }}
            strokeWidth={BL_STROKE.strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}
        {hasBase ? (
          <path
            d={path((p) => p.base)}
            fill="none"
            style={{ stroke: BASE_STROKE.stroke }}
            strokeWidth={BASE_STROKE.strokeWidth}
            strokeDasharray={BASE_STROKE.dash}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

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

/** This hour's usable ceiling in DISPLAY units — the shared rule, applied to
 * the already-converted values so the band lines up with the axis. */
function usableCeiling(p: Point): number | null {
  return usableCeilingM(p.blTop, p.base);
}
