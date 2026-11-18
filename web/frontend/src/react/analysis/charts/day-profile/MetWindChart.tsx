/**
 * Modelled wind by hour — the meteorological counterpart to the
 * track-derived WindHourlyChart beneath it in the combined stack.
 *
 * Drawn in the SAME visual language as the pilot-derived chart (speed line,
 * direction-arrow lane, arrows flying WITH the wind) precisely so the two
 * can be read against each other: a vertical scan says "the model had 30
 * km/h from the west at 2pm; the field's circles said 24 from the
 * west-northwest". Where they disagree, that IS the finding — the tracks are
 * a measurement of the air pilots were in, the model is a grid cell.
 *
 * TWO lines, and the distinction matters more than anything else on this
 * chart: the SOLID line is the wind at flying height (the pressure level
 * nearest terrain + 1000 m), and the FAINT line is the 10 m surface wind.
 * Plotting only the surface — the naive integration — would make the model
 * look like it contradicted the pilots when it merely described a different
 * height. On a real Corryong afternoon the surface ran 8–18 km/h while 900
 * hPa ran 30–42.
 *
 * A dataset without pressure levels (ERA5, and so every pre-2022 comp) gets
 * the surface line alone, labelled as such.
 *
 * Geometry comes from the stack's {@link ChartFrame}, and every height here
 * is a multiple of its type size — see frame.ts. The title, the source stamp
 * and the legend are text ABOVE the plot, not in it.
 */
import type { WeatherHour, WeatherSource } from "@/react/weather/types";
import { flyingHeightLevel } from "@/react/weather/types";
import { formatTimeRange } from "@/react/lib/time";
import { useUnits } from "@/react/lib/units";
import { formatMetricValue } from "../../types";
import { unitDisplay } from "../../units";
import { linearScale, niceTicks } from "../chart-utils";
import type { TimeAxis } from "./time-axis";
import type { ChartFrame } from "./frame";
import { TimeGridColumns, TimeTickLabels } from "./TimeAxisParts";
import { ChartHeader, sourceSentence } from "./MetSourceTag";
import { MetLegend, type LegendEntry } from "./MetLegend";
import { HourColumns, columnAt, hourRange, useHourPointer, type HourColumn } from "./HourColumns";
import { flyingHeightLabel, windReading } from "./met-readout";
import { degToCompass, windArrowPath, windArrowTransform } from "./shared";

const HOUR_MS = 3_600_000;

/** One stroke definition per series, shared by the line and its legend swatch
 * so the swatch cannot come to describe a line that has since changed. */
const LEVEL_STROKE = { stroke: "var(--chart-4)", strokeWidth: 2 };
const SURFACE_STROKE = {
  stroke: "var(--chart-4)",
  strokeWidth: 1.5,
  dash: "3 2",
  opacity: 0.75,
};
const ARROW_STROKE = { stroke: "var(--chart-4)", strokeWidth: 1.6, opacity: 0.85 };

interface Point {
  tMs: number;
  cx: number;
  /** Wind at flying height, in display units; null when the dataset has none. */
  levelSpeed: number | null;
  levelDir: number | null;
  surfaceSpeed: number | null;
  surfaceDir: number | null;
  gust: number | null;
}

export function MetWindChart({
  hours,
  source,
  terrainElevationM,
  axis,
  frame,
  timeZone,
  selectedMs,
  onSelect,
}: {
  hours: WeatherHour[];
  source: WeatherSource;
  /** The task's own terrain elevation (AMSL) — see the datum note below. */
  terrainElevationM: number | null;
  axis: TimeAxis;
  frame: ChartFrame;
  timeZone: string | undefined;
  selectedMs: number | null;
  onSelect: (tMs: number | null) => void;
}) {
  // Same conversion boundary as the pilot-derived wind chart: the engine and
  // every provider work in km/h, and the viewer's preference applies here.
  const wind = unitDisplay("km/h", useUnits());
  const alt = unitDisplay("m", useUnits());

  // Datum for "flying height" = terrain + 1000 m. Prefer the TASK's terrain
  // over the provider's grid elevation: a cell kilometres wide averages a
  // ridge and its valley, and at Corryong reports 298 m for a course whose
  // turnpoints mean 543 m. Picking the level off the smoothed figure would
  // systematically choose air lower than the pilots were working. The grid
  // elevation remains the fallback, since it is at least self-consistent
  // with the AGL fields.
  const terrainM = terrainElevationM ?? source.pointElevationM;
  const levelLabel = flyingHeightLabel(hours, terrainM, alt);

  const columns: HourColumn[] = hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    const when = formatTimeRange(h.t, new Date(tMs + HOUR_MS).toISOString(), timeZone);
    const reading = windReading(h, terrainM, wind, levelLabel);
    return { tMs, label: reading ? `${when} — ${reading}` : `${when} — no wind figures` };
  });
  const pointer = useHourPointer(frame, axis, columns, onSelect);

  if (hours.length === 0) return null;

  const points: Point[] = hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    const level = flyingHeightLevel(h.levels, terrainM);
    return {
      tMs,
      cx: axis.x(tMs + HOUR_MS / 2),
      levelSpeed: level?.windSpeedKmh != null ? level.windSpeedKmh * wind.factor : null,
      levelDir: level?.windDirectionDeg ?? null,
      surfaceSpeed:
        h.surface.windSpeedKmh != null ? h.surface.windSpeedKmh * wind.factor : null,
      surfaceDir: h.surface.windDirectionDeg,
      gust: h.surface.windGustKmh != null ? h.surface.windGustKmh * wind.factor : null,
    };
  });

  const hasLevels = points.some((p) => p.levelSpeed !== null);
  const hasSurface = points.some((p) => p.surfaceSpeed !== null);
  const speeds = points.flatMap((p) =>
    [p.levelSpeed, p.surfaceSpeed, p.gust].filter((v): v is number => v !== null)
  );
  if (speeds.length === 0) return null;

  // Heights in ems of the label size: a lane for the arrows, the plot, and a
  // row for the time labels.
  const em = frame.fontSize;
  const laneY = em * 0.95;
  const plot = { top: em * 2.5, bottom: em * 10 };
  const H = plot.bottom + em * 2;
  const columnWidth = Math.abs(axis.x(points[0].tMs + HOUR_MS) - axis.x(points[0].tMs));
  const arrowLen = Math.max(7, Math.min(em * 1.3, columnWidth * 0.75));

  const yMax = Math.max(5 * wind.factor, ...speeds) * 1.08;
  const y = linearScale([0, yMax], [plot.bottom, plot.top]);
  const yTicks = niceTicks([0, yMax], 3);

  /**
   * A line through the points that have a value. A gap in the data LIFTS the
   * pen (the next segment starts with M, not L) rather than bridging it —
   * an interpolated straight line across a missing hour would be a claim the
   * provider never made.
   */
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

  // The arrow lane shows flying-height direction where we have it, surface
  // otherwise — one lane, never two, or the panel's alignment stops reading.
  const arrowDir = (p: Point): number | null => (hasLevels ? p.levelDir : p.surfaceDir);

  // The selected hour's figures, printed in the legend beside each line.
  const sel = columnAt(points, selectedMs);
  const speedText = (speed: number | null, dir: number | null): string | null =>
    speed === null
      ? null
      : `${speed.toFixed(0)} ${wind.unit}` + (dir === null ? "" : ` ${degToCompass(dir)}`);
  const selDir = sel ? arrowDir(sel) : null;

  const legend: LegendEntry[] = [];
  if (hasLevels) {
    legend.push({
      key: "level",
      text: sel ? "flying height" : `flying height ${levelLabel}`,
      value: sel ? (speedText(sel.levelSpeed, sel.levelDir) ?? "no figure") : null,
      ...LEVEL_STROKE,
    });
  }
  if (hasSurface) {
    const surface = sel ? speedText(sel.surfaceSpeed, sel.surfaceDir) : null;
    legend.push({
      key: "surface",
      text: sel ? "surface" : "surface (10 m)",
      value: sel
        ? surface === null
          ? "no figure"
          : surface + (sel.gust !== null ? `, gusting ${sel.gust.toFixed(0)}` : "")
        : null,
      ...SURFACE_STROKE,
    });
  }
  if (points.some((p) => arrowDir(p) !== null)) {
    legend.push({
      key: "direction",
      kind: "arrow",
      text: hasLevels ? "direction" : "surface direction",
      value: selDir === null ? null : `${Math.round(selDir)}°`,
      ...ARROW_STROKE,
    });
  }

  return (
    <div className="space-y-0.5" data-met-chart="wind">
      <ChartHeader
        title="Weather: wind"
        when={sel ? hourRange(sel.tMs, timeZone) : null}
        source={source}
      />
      {/* A legend row rather than labels on the lines: at a readable size
          the labels cover the lines they name. Each entry carries a sample of
          its own stroke, since the two lines are the same colour and only
          the dash tells them apart — and the selected hour's figure. */}
      <MetLegend entries={legend} lines={3} />
      <svg
        viewBox={`0 0 ${frame.width} ${H}`}
        className="h-auto w-full select-none"
        role="group"
        aria-label={
          `Modelled wind by hour across ${points.length} hour${points.length === 1 ? "" : "s"}: ` +
          (hasLevels
            ? `wind at flying height (${levelLabel}) with the 10 metre surface wind beneath it. `
            : `10 metre surface wind only — this dataset carries no upper-level wind. `) +
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
        {/* Bare numbers, with the unit stamped once above them: "30 km/h" on
            every tick is a margin a phone cannot spare. */}
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
          {/* From the chart's left edge, not right-aligned to the ticks as
              `AxisUnit` is: the stamp can be wider than the margin. */}
          <text x={0} y={plot.top - em * 0.3} className="fill-current">
            {wind.unit}
          </text>
        </g>

        {/* Surface wind: faint, and always the LOWER of the two on a normal
            day. Drawn first so the flying-height line sits over it. */}
        <path
          d={path((p) => p.surfaceSpeed)}
          fill="none"
          style={{ stroke: SURFACE_STROKE.stroke }}
          strokeWidth={SURFACE_STROKE.strokeWidth}
          strokeDasharray={SURFACE_STROKE.dash}
          strokeLinejoin="round"
          strokeLinecap="round"
          opacity={SURFACE_STROKE.opacity}
        />
        {hasLevels ? (
          <path
            d={path((p) => p.levelSpeed)}
            fill="none"
            style={{ stroke: LEVEL_STROKE.stroke }}
            strokeWidth={LEVEL_STROKE.strokeWidth}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ) : null}

        {/* Direction lane, same convention as the pilot-derived chart:
            arrows fly WITH the wind. */}
        {points.map((p) => {
          const dir = arrowDir(p);
          return dir === null ? null : (
            <path
              key={`a${p.tMs}`}
              d={windArrowPath(arrowLen)}
              transform={windArrowTransform(p.cx, laneY, dir)}
              fill="none"
              style={{ stroke: ARROW_STROKE.stroke }}
              strokeWidth={ARROW_STROKE.strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={ARROW_STROKE.opacity}
            />
          );
        })}

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
