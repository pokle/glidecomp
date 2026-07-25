/**
 * Modelled wind by hour — the meteorological counterpart to WindHourlyChart
 * directly above it in the stack.
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
 */
import type { WeatherHour, WeatherSource } from "@/react/weather/types";
import { flyingHeightLevel } from "@/react/weather/types";
import { formatTimeRange } from "@/react/lib/time";
import { useUnits } from "@/react/lib/units";
import { unitDisplay } from "../../units";
import { formatTickValue, linearScale, niceTicks } from "../chart-utils";
import type { TimeAxis } from "./time-axis";
import { TimeGridColumns, TimeTickLabels } from "./TimeAxisParts";
import { MetSourceTag, sourceSentence } from "./MetSourceTag";
import {
  PLOT_LEFT,
  PLOT_RIGHT,
  W,
  degToCompass,
  windArrowPath,
  windArrowTransform,
} from "./shared";

const HOUR_MS = 3_600_000;
const H = 170;
const LANE_Y = 26; // direction-arrow lane centreline
const PLOT = { top: 42, bottom: H - 26 };
const TICK_LABEL_Y = H - 10;

interface Point {
  tMs: number;
  cx: number;
  /** Wind at flying height, in display units; null when the dataset has none. */
  levelSpeed: number | null;
  levelDir: number | null;
  levelHeightM: number | null;
  surfaceSpeed: number | null;
  surfaceDir: number | null;
  gust: number | null;
}

export function MetWindChart({
  hours,
  source,
  axis,
  timeZone,
  setReadout,
}: {
  hours: WeatherHour[];
  source: WeatherSource;
  axis: TimeAxis;
  timeZone: string | undefined;
  setReadout: (text: string | null) => void;
}) {
  // Same conversion boundary as the pilot-derived wind chart: the engine and
  // every provider work in km/h, and the viewer's preference applies here.
  const wind = unitDisplay("km/h", useUnits());
  const alt = unitDisplay("m", useUnits());

  if (hours.length === 0) return null;

  // The grid's own elevation is the right datum for "flying height": it is
  // the terrain the model thinks is under this point, so terrain + 1000 m
  // lands in the air the pilots were actually working.
  const terrainM = source.pointElevationM;

  const points: Point[] = hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    const level = flyingHeightLevel(h.levels, terrainM);
    return {
      tMs,
      cx: axis.x(tMs + HOUR_MS / 2),
      levelSpeed: level?.windSpeedKmh != null ? level.windSpeedKmh * wind.factor : null,
      levelDir: level?.windDirectionDeg ?? null,
      levelHeightM: level?.heightM ?? null,
      surfaceSpeed:
        h.surface.windSpeedKmh != null ? h.surface.windSpeedKmh * wind.factor : null,
      surfaceDir: h.surface.windDirectionDeg,
      gust: h.surface.windGustKmh != null ? h.surface.windGustKmh * wind.factor : null,
    };
  });

  const hasLevels = points.some((p) => p.levelSpeed !== null);
  const speeds = points.flatMap((p) =>
    [p.levelSpeed, p.surfaceSpeed, p.gust].filter((v): v is number => v !== null)
  );
  if (speeds.length === 0) return null;

  const yMax = Math.max(5 * wind.factor, ...speeds) * 1.08;
  const y = linearScale([0, yMax], [PLOT.bottom, PLOT.top]);
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
  const laneLabel = hasLevels ? "direction" : "sfc dir";

  const heights = points
    .map((p) => p.levelHeightM)
    .filter((v): v is number => v !== null);
  const levelLabel =
    heights.length > 0
      ? `~${Math.round((heights.reduce((a, b) => a + b, 0) / heights.length) * alt.factor)} ${alt.unit}`
      : null;

  const readout = (p: Point): string => {
    const when = formatTimeRange(
      new Date(p.tMs).toISOString(),
      new Date(p.tMs + HOUR_MS).toISOString(),
      timeZone
    );
    const parts: string[] = [];
    if (p.levelSpeed !== null && p.levelDir !== null) {
      parts.push(
        `${p.levelSpeed.toFixed(0)} ${wind.unit} from ${Math.round(p.levelDir)}° ` +
          `(${degToCompass(p.levelDir)}) at ${levelLabel ?? "flying height"}`
      );
    }
    if (p.surfaceSpeed !== null && p.surfaceDir !== null) {
      parts.push(
        `surface ${p.surfaceSpeed.toFixed(0)} ${wind.unit} from ${Math.round(p.surfaceDir)}° ` +
          `(${degToCompass(p.surfaceDir)})`
      );
    }
    if (p.gust !== null) parts.push(`gusting ${p.gust.toFixed(0)} ${wind.unit}`);
    return `${when} — ${parts.join(", ")}`;
  };

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
      aria-label={
        `Modelled wind by hour across ${points.length} hour${points.length === 1 ? "" : "s"}: ` +
        (hasLevels
          ? `wind at flying height (${levelLabel}) with the 10 metre surface wind beneath it. `
          : `10 metre surface wind only — this dataset carries no upper-level wind. `) +
        sourceSentence(source)
      }
      onMouseLeave={() => setReadout(null)}
    >
      <text
        aria-hidden
        x={PLOT_LEFT - 38}
        y={12}
        className="fill-current text-[10px] font-medium text-muted-foreground"
      >
        Weather: wind
      </text>
      <MetSourceTag source={source} y={12} />

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
          <text
            key={`ty${t}`}
            x={PLOT_LEFT - 6}
            y={y(t) + 3}
            textAnchor="end"
            className="fill-current"
          >
            {formatTickValue(wind.unit, t)}
          </text>
        ))}
        <text
          x={PLOT_LEFT - 6}
          y={LANE_Y + 3}
          textAnchor="end"
          className="fill-current text-[9px]"
        >
          {laneLabel}
        </text>
      </g>

      {/* Surface wind: faint, and always the LOWER of the two on a normal
          day. Drawn first so the flying-height line sits over it. */}
      <path
        d={path((p) => p.surfaceSpeed)}
        fill="none"
        style={{ stroke: "var(--chart-4)" }}
        strokeWidth={1.5}
        strokeDasharray="3 2"
        strokeLinejoin="round"
        strokeLinecap="round"
        opacity={0.75}
      />
      {hasLevels ? (
        <path
          d={path((p) => p.levelSpeed)}
          fill="none"
          style={{ stroke: "var(--chart-4)" }}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}

      {/* Inline series labels rather than a legend box: at this size a
          legend costs more room than the two words it explains. */}
      <g aria-hidden className="text-[9px] text-muted-foreground">
        {hasLevels && points.at(-1)?.levelSpeed != null ? (
          <text
            x={PLOT_RIGHT - 2}
            y={y(points.at(-1)!.levelSpeed!) - 5}
            textAnchor="end"
            className="fill-current"
          >
            flying height {levelLabel}
          </text>
        ) : null}
        {points.at(-1)?.surfaceSpeed != null ? (
          <text
            x={PLOT_RIGHT - 2}
            y={y(points.at(-1)!.surfaceSpeed!) + 11}
            textAnchor="end"
            className="fill-current"
          >
            surface (10 m)
          </text>
        ) : null}
      </g>

      {/* Direction lane, same convention as the pilot-derived chart above:
          arrows fly WITH the wind. */}
      {points.map((p) => {
        const dir = arrowDir(p);
        return dir === null ? null : (
          <path
            key={`a${p.tMs}`}
            d={windArrowPath(13)}
            transform={windArrowTransform(p.cx, LANE_Y, dir)}
            fill="none"
            style={{ stroke: "var(--chart-4)" }}
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.85}
          />
        );
      })}

      {points.map((p) => (
        <rect
          key={`h${p.tMs}`}
          x={axis.x(p.tMs)}
          width={Math.max(0, axis.x(p.tMs + HOUR_MS) - axis.x(p.tMs))}
          y={0}
          height={PLOT.bottom}
          fill="transparent"
          onMouseEnter={() => setReadout(readout(p))}
        />
      ))}

      <TimeTickLabels axis={axis} y={TICK_LABEL_Y} />
    </svg>
  );
}
