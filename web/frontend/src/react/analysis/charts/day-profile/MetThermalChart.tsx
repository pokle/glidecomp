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
import { unitDisplay } from "../../units";
import { formatTickValue, linearScale, niceTicks } from "../chart-utils";
import type { TimeAxis } from "./time-axis";
import { TimeGridColumns, TimeTickLabels } from "./TimeAxisParts";
import { MetSourceTag, sourceSentence } from "./MetSourceTag";
import { PLOT_LEFT, PLOT_RIGHT, W } from "./shared";
import { separateLabels, usableCeilingM } from "./met-shared";
import { SeriesEndLabels, type SeriesEndLabel } from "./SeriesEndLabels";

const HOUR_MS = 3_600_000;
const H = 168;
const PLOT = { top: 30, bottom: H - 26 };
const TICK_LABEL_Y = H - 10;

/** The band inline series labels must stay inside. */
const LABEL_BAND: [number, number] = [PLOT.top + 8, PLOT.bottom - 3];

/** One stroke definition per series, used by BOTH the line and its label
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
  capeJkg: number | null;
}

export function MetThermalChart({
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
  // Heights follow the altitude preference; providers report metres.
  const alt = unitDisplay("m", useUnits());

  const points: Point[] = hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    return {
      tMs,
      cx: axis.x(tMs + HOUR_MS / 2),
      blTop: h.boundaryLayerDepthM != null ? h.boundaryLayerDepthM * alt.factor : null,
      base: h.cloudBaseAglM != null ? h.cloudBaseAglM * alt.factor : null,
      capeJkg: h.capeJkg,
    };
  });

  const values = points.flatMap((p) =>
    [p.blTop, p.base].filter((v): v is number => v !== null)
  );
  if (values.length === 0) return null;

  const yMax = Math.max(...values) * 1.1;
  const y = linearScale([0, yMax], [PLOT.bottom, PLOT.top]);
  const yTicks = niceTicks([0, yMax], 3);

  const clampLabel = (v: number) =>
    Math.min(LABEL_BAND[1], Math.max(LABEL_BAND[0], v));

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

  const readout = (p: Point): string => {
    const when = formatTimeRange(
      new Date(p.tMs).toISOString(),
      new Date(p.tMs + HOUR_MS).toISOString(),
      timeZone
    );
    const parts: string[] = [];
    if (p.blTop !== null)
      parts.push(`thermal top ${p.blTop.toFixed(0)} ${alt.unit} AGL`);
    if (p.base !== null)
      parts.push(`cloud base ${p.base.toFixed(0)} ${alt.unit} AGL`);
    if (p.base !== null && p.blTop !== null) {
      parts.push(p.base > p.blTop ? "blue" : "cumulus");
    }
    if (p.capeJkg !== null) parts.push(`CAPE ${Math.round(p.capeJkg)} J/kg`);
    return `${when} — ${parts.join(", ")}`;
  };

  // Label positions for the two line ends, separated so they stay readable.
  const lastBl = points.at(-1)?.blTop ?? null;
  const lastBase = points.at(-1)?.base ?? null;
  const endLabels: SeriesEndLabel[] = [];
  if (hasBl && lastBl !== null && hasBase && lastBase !== null) {
    const [yBl, yBase] = separateLabels(y(lastBl) - 5, y(lastBase) + 11, LABEL_BAND);
    endLabels.push({ key: "bl", text: "thermal top", y: yBl, ...BL_STROKE });
    endLabels.push({ key: "base", text: "cloud base", y: yBase, ...BASE_STROKE });
  } else if (hasBl && lastBl !== null) {
    endLabels.push({
      key: "bl",
      text: "thermal top",
      y: clampLabel(y(lastBl) - 5),
      ...BL_STROKE,
    });
  } else if (hasBase && lastBase !== null) {
    endLabels.push({
      key: "base",
      text: "cloud base",
      y: clampLabel(y(lastBase) + 11),
      ...BASE_STROKE,
    });
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="h-auto w-full"
      role="img"
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
      onMouseLeave={() => setReadout(null)}
    >
      <text
        aria-hidden
        x={PLOT_LEFT - 38}
        y={12}
        className="fill-current text-[10px] font-medium text-muted-foreground"
      >
        Weather: height
      </text>
      <MetSourceTag source={source} y={12} />
      {missingNote ? (
        <text
          aria-hidden
          x={PLOT_LEFT - 38}
          y={24}
          className="fill-current text-[9px] text-muted-foreground"
        >
          {missingNote}
        </text>
      ) : null}

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
            {formatTickValue(alt.unit, t)}
          </text>
        ))}
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

      {/* Inline labels, each behind a sample of its own stroke — solid for
          the thermal top, dashed for cloud base — and pushed apart where the
          two lines converge, which is exactly the interesting day (cloud base
          crossing the thermal top is blue turning to cumulus), so overlap
          here is the common case, not an edge one. */}
      <SeriesEndLabels x={PLOT_RIGHT - 2} labels={endLabels} />

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

/** This hour's usable ceiling in DISPLAY units — the shared rule, applied to
 * the already-converted values so the band lines up with the axis. */
function usableCeiling(p: Point): number | null {
  return usableCeilingM(p.blTop, p.base);
}
