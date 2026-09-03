/**
 * The task's reconstructed thermals — the "Thermals" section of the task
 * task-analysis page.
 *
 * Everything renders from the stored ThermalShapeSummary list (no point
 * clouds): a census table of the day's shared thermals, paired with one
 * selected thermal in detail — a top-down lift rose around the measured core,
 * the headline readouts (lean vs wind, strongest side, feeders), the climb
 * profile by altitude band, and the exact numbers in a band table. Census and
 * detail are laid out by the shared {@link MasterDetail}, in its `navigation`
 * mode — side by side on a wide screen, one at a time on a phone. The
 * summaries are MEASUREMENTS pooled from the field's own tracks, never a
 * fitted model, and the captions say so.
 *
 * Which thermal is selected lives in the URL, as `?thermal=<id>`. That is what
 * makes the stacked layout a real master/detail rather than a pinned preview:
 * a phone shows the census alone, choosing a row NAVIGATES to the detail, and
 * the browser's own Back returns to the list (MasterDetail's `navigation`
 * mode). Side by side nothing navigates — both halves are on screen — so a
 * pick only replaces the URL, and Back still means "leave this page".
 *
 * The model wind is the one outside number: the task's weather column
 * (independent request, same as DayProfilePanel) interpolated to each band's
 * altitude via the engine's windAtHeight. It is drawn dashed and labelled as
 * a model run beside the track-measured wind — a reader must never mistake
 * the prediction for the measurement (docs/weather.md).
 */
import {
  lazy,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import type { Selection } from "react-aria-components";
import { InfoIcon } from "lucide-react";
import { windAtHeight } from "@glidecomp/engine";
import type {
  TaskWeather,
  ThermalShapeSummary,
  FieldThermalsSummary,
  WeatherHour,
} from "@glidecomp/engine";
import { Button, ToggleButton } from "@/react/rac/button";
import { FullScreenSheet } from "@/react/rac/full-screen-sheet";
import { MasterDetail } from "@/react/components/MasterDetail";
import { useMasterDetailSelection } from "@/react/components/use-master-detail-selection";
import { ExpandIcon } from "../charts/MetricChartOverlay";
import { cn } from "@/react/lib/utils";
import { Popover, PopoverTrigger } from "@/react/rac/popover";
import { Explain } from "@/react/rac/explain";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { formatTimeOfDay } from "../../lib/time";
import { formatAltitude, useUnits } from "../../lib/units";
import { formatMetricValue } from "../types";
import { unitDisplay } from "../units";
import { ValueBar } from "../ValueBar";
import { degToCompass } from "../charts/day-profile/shared";

/** One band's model wind, interpolated from the task's weather column. */
interface BandModelWind {
  altMid: number;
  directionDeg: number;
  speedMs: number;
}

interface ModelWindProfile {
  hourIso: string;
  bands: BandModelWind[];
  /** Vector mean over the bands — the single arrow / readout figure. */
  mean: { directionDeg: number; speedMs: number };
}

/** Smallest angular difference |a−b| in degrees (0–180). */
function angDiff(a: number, b: number): number {
  const d = Math.abs((a - b) % 360);
  return d > 180 ? 360 - d : d;
}

/**
 * The model's wind at each band altitude, read from the weather hour nearest
 * the thermal's mid-time. Null when the column carries no level winds (ERA5
 * days) or no weather has arrived.
 */
function modelWindFor(
  shape: ThermalShapeSummary,
  weather: TaskWeather | null
): ModelWindProfile | null {
  if (!weather || weather.hours.length === 0) return null;
  const midMs = (shape.startMs + shape.endMs) / 2;
  let hour: WeatherHour | null = null;
  let bestGap = Infinity;
  for (const h of weather.hours) {
    const gap = Math.abs(Date.parse(h.t) + 1_800_000 - midMs);
    if (gap < bestGap) {
      hour = h;
      bestGap = gap;
    }
  }
  if (!hour) return null;
  const bands: BandModelWind[] = [];
  for (const b of shape.bands) {
    const w = windAtHeight(hour.levels, b.altMid);
    if (w) bands.push({ altMid: b.altMid, directionDeg: w.directionDeg, speedMs: w.speedKmh / 3.6 });
  }
  if (bands.length === 0) return null;
  let u = 0;
  let v = 0;
  for (const b of bands) {
    const rad = (b.directionDeg * Math.PI) / 180;
    u += b.speedMs * Math.sin(rad);
    v += b.speedMs * Math.cos(rad);
  }
  u /= bands.length;
  v /= bands.length;
  return {
    hourIso: hour.t,
    bands,
    mean: {
      directionDeg: ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360,
      speedMs: Math.hypot(u, v),
    },
  };
}

/** A climb value with its sign always shown: sink already carries "-".
 * A negative that rounds to zero shows "+0.0", never "-0.0". */
function signedClimb(ms: number, climbText: (ms: number) => string): string {
  const text = climbText(ms);
  if (text.startsWith("-")) {
    return parseFloat(text) === 0 ? `+${text.slice(1)}` : text;
  }
  return `+${text}`;
}

/** Sample-weighted mean climb over a shape's bands (m/s). */
function meanClimb(shape: ThermalShapeSummary): number {
  let v = 0;
  let n = 0;
  for (const b of shape.bands) {
    v += b.meanVario * b.sampleCount;
    n += b.sampleCount;
  }
  return n > 0 ? v / n : 0;
}

/** Sector means aggregated over every band, sample-weighted. */
function aggregateSectors(shape: ThermalShapeSummary): { bearing: number; mean: number | null }[] {
  const count = shape.bands[0]?.sectors.length ?? 0;
  const sum = new Array<number>(count).fill(0);
  const n = new Array<number>(count).fill(0);
  for (const b of shape.bands) {
    b.sectors.forEach((s, i) => {
      if (s.meanVario === null) return;
      sum[i] += s.meanVario * s.samples;
      n[i] += s.samples;
    });
  }
  return sum.map((s, i) => ({
    bearing: (i * 360) / count,
    mean: n[i] > 0 ? s / n[i] : null,
  }));
}

// --- Top-down rose ---

const ROSE_SIZE = 320;
const ROSE_R = 132;

/** Census rows shown before "Show all …": the most-shared thermals — enough
 * to read the day's pattern, few enough that the rose leads the section. */
const TOP_THERMALS = 10;

/** The URL parameter the selected thermal round-trips through. */
const THERMAL_PARAM = "thermal";

/**
 * The thermal a query value names, or null for "nothing chosen".
 *
 * Compares the raw text rather than a parsed number, deliberately. Thermal
 * ids start at ZERO, and `URLSearchParams.get` answers `null` for a parameter
 * that is not there — so `Number(...)` turned an absent parameter into a
 * choice of the thermal with id 0. On every task that had one the census
 * could never be the view, and "All thermals" (which deletes the parameter)
 * appeared to do nothing. Absent, empty and junk all mean nothing chosen.
 */
export function thermalFromParam<T extends { id: number }>(
  param: string | null,
  shapes: readonly T[]
): T | null {
  if (param === null || param === "") return null;
  return shapes.find((s) => String(s.id) === param) ?? null;
}

// The map backdrop stays a separate lazy chunk: mapbox-gl (and its CSS) load
// only when someone flips the toggle, and never in the SSR entry.
const ThermalRoseMap = lazy(() => import("./ThermalRoseMap"));
const HAS_MAP_TOKEN = Boolean(import.meta.env.VITE_MAPBOX_TOKEN);

/**
 * The rose's ground geometry: the sample-weighted working radius, the widest
 * flown extent, and the metres one SVG viewBox unit represents. One function
 * shared by the rose and the map backdrop, so the overlay can never disagree
 * with the chart about scale.
 */
function roseGeometry(shape: ThermalShapeSummary): {
  coreRadius: number;
  extent: number;
  metresPerPx: number;
} {
  let radiusW = 0;
  let radiusN = 0;
  let extent = 0;
  for (const b of shape.bands) {
    radiusW += b.coreRadius * b.sampleCount;
    radiusN += b.sampleCount;
    extent = Math.max(extent, b.extentRadius);
  }
  const coreRadius = radiusN > 0 ? radiusW / radiusN : 0;
  return {
    coreRadius,
    extent,
    metresPerPx: Math.max(extent, coreRadius * 1.4, 100) / ROSE_R,
  };
}

/** Sample-weighted mean of the band cores — where the column stood on the
 * ground, for the map backdrop. */
function shapeLocation(shape: ThermalShapeSummary): { lat: number; lon: number } {
  let lat = 0;
  let lon = 0;
  let n = 0;
  for (const b of shape.bands) {
    lat += b.core.lat * b.sampleCount;
    lon += b.core.lon * b.sampleCount;
    n += b.sampleCount;
  }
  return n > 0 ? { lat: lat / n, lon: lon / n } : shape.origin;
}

/**
 * Top-down view of the thermal about its own core. Wedge length is RELATIVE
 * climb by sector (the shape of the lift), each labelled with its mean
 * climb/sink rate; the dashed ring is the measured working circle and the
 * dotted ring the flown extent, each labelled with its diameter in the
 * viewer's units (drawn to the same scale as the feeder diamonds). Solid
 * arrow, labelled "actual": track-measured wind. Dashed arrow, labelled
 * "forecast": the model's wind — a model run, not an observation.
 */
function ThermalRose({
  shape,
  model,
  climbFactor,
  climbUnit,
  distanceText,
}: {
  shape: ThermalShapeSummary;
  model: ModelWindProfile | null;
  climbFactor: number;
  climbUnit: string;
  /** Formats a ground distance in metres for display (viewer's units). */
  distanceText: (m: number) => string;
}) {
  const c = ROSE_SIZE / 2;
  const sectors = aggregateSectors(shape);
  const maxAbs = Math.max(...sectors.map((s) => Math.abs(s.mean ?? 0)), 0.5);
  const { coreRadius, extent, metresPerPx } = roseGeometry(shape);

  const sectorWidth = 360 / Math.max(sectors.length, 1);
  const wedgePath = (bearing: number, r: number): string => {
    const a0 = ((bearing - sectorWidth / 2 - 90) * Math.PI) / 180;
    const a1 = ((bearing + sectorWidth / 2 - 90) * Math.PI) / 180;
    return (
      `M${c},${c} L${(c + r * Math.cos(a0)).toFixed(1)},${(c + r * Math.sin(a0)).toFixed(1)} ` +
      `A${r},${r} 0 0 1 ${(c + r * Math.cos(a1)).toFixed(1)},${(c + r * Math.sin(a1)).toFixed(1)} Z`
    );
  };

  // Every on-chart label carries a background-coloured halo (paint-order) so
  // it stays readable where it crosses a wedge, a ring — or the map backdrop.
  const HALO = "stroke-background [paint-order:stroke] [stroke-width:3px]";

  /** Arrow entering from the compass edge the wind blows FROM, named so the
   * two arrows never need the legend to tell apart. The two label radii
   * differ so the names stack instead of colliding when the forecast agrees
   * with the measurement. */
  const windArrow = (directionFromDeg: number, dashed: boolean, key: string, name: string) => {
    const a = ((directionFromDeg - 90) * Math.PI) / 180;
    const r0 = c - 10;
    const r1 = c - 34;
    const x0 = c + r0 * Math.cos(a);
    const y0 = c + r0 * Math.sin(a);
    const x1 = c + r1 * Math.cos(a);
    const y1 = c + r1 * Math.sin(a);
    const ah = Math.atan2(y1 - y0, x1 - x0);
    const lr = dashed ? r1 - 26 : r1 - 12;
    return (
      <g key={key} className={dashed ? "stroke-muted-foreground" : "stroke-foreground/80"} fill="none">
        <path d={`M${x0},${y0} L${x1},${y1}`} strokeWidth={1.6} strokeDasharray={dashed ? "4 3" : undefined} />
        <path
          d={`M${x1},${y1} L${x1 - 7 * Math.cos(ah - 0.5)},${y1 - 7 * Math.sin(ah - 0.5)} M${x1},${y1} L${x1 - 7 * Math.cos(ah + 0.5)},${y1 - 7 * Math.sin(ah + 0.5)}`}
          strokeWidth={1.6}
        />
        <text
          x={c + lr * Math.cos(a)}
          y={c + lr * Math.sin(a) + 3}
          textAnchor="middle"
          className={cn(
            "fill-current text-[9px]",
            HALO,
            dashed ? "text-muted-foreground" : "text-foreground/80"
          )}
        >
          {name}
        </text>
      </g>
    );
  };

  const strongest = shape.strongestSide;
  const diameters =
    `Working diameter ${distanceText(coreRadius * 2)}; the field ranged across ${distanceText(extent * 2)}.`;
  const label = strongest
    ? `Top-down lift rose: strongest on the ${degToCompass(strongest.bearing)} side of the core at ` +
      `${formatMetricValue(climbUnit, strongest.meanVario * climbFactor)} ${climbUnit}. ${diameters} Exact numbers per band are in the table below.`
    : `Top-down lift rose. ${diameters} Exact numbers per band are in the table below.`;

  return (
    // No width cap of its own: the figure wrapper decides how big the rose
    // draws (max-w-80 inline; the full-screen sheet spends the viewport).
    <svg viewBox={`0 0 ${ROSE_SIZE} ${ROSE_SIZE}`} className="h-auto w-full" role="img" aria-label={label}>
      {/* Sector wedges: relative climb by side of the core. */}
      <g aria-hidden>
        {sectors.map((s) =>
          s.mean === null ? null : (
            <path
              key={s.bearing}
              d={wedgePath(s.bearing, (Math.abs(s.mean) / maxAbs) * ROSE_R)}
              className={s.mean >= 0 ? "fill-chart-3/30" : "fill-chart-1/30"}
            />
          )
        )}
      </g>
      {/* Each wedge's mean climb (sink keeps its minus sign), near the tip. */}
      <g aria-hidden>
        {sectors.map((s) => {
          if (s.mean === null) return null;
          const r = (Math.abs(s.mean) / maxAbs) * ROSE_R;
          const lr = r >= 46 ? r - 14 : r + 14;
          const a = ((s.bearing - 90) * Math.PI) / 180;
          return (
            <text
              key={s.bearing}
              x={c + lr * Math.cos(a)}
              y={c + lr * Math.sin(a) + 3}
              textAnchor="middle"
              className={cn("fill-current text-[9px] text-foreground/80", HALO)}
            >
              {s.mean >= 0 ? "+" : ""}
              {formatMetricValue(climbUnit, s.mean * climbFactor)}
            </text>
          );
        })}
      </g>
      {/* Working circle + flown extent, each labelled with its diameter. */}
      <g aria-hidden fill="none">
        <circle cx={c} cy={c} r={extent / metresPerPx} className="stroke-muted-foreground/50" strokeDasharray="2 4" />
        <circle cx={c} cy={c} r={coreRadius / metresPerPx} className="stroke-muted-foreground/70" strokeDasharray="5 3" />
        <circle cx={c} cy={c} r={2.5} className="fill-muted-foreground" />
      </g>
      <g aria-hidden>
        <text
          x={c}
          y={c - coreRadius / metresPerPx - 5}
          textAnchor="middle"
          className={cn("fill-current text-[9px] text-muted-foreground", HALO)}
        >
          {`⌀ ${distanceText(coreRadius * 2)}`}
        </text>
        <text
          x={c}
          y={c + extent / metresPerPx - 7}
          textAnchor="middle"
          className={cn("fill-current text-[9px] text-muted-foreground", HALO)}
        >
          {`⌀ ${distanceText(extent * 2)}`}
        </text>
      </g>
      {/* Feeder sub-cores, offset from their own band's core. */}
      <g aria-hidden>
        {shape.bands.flatMap((b) =>
          b.subCores.length < 2
            ? []
            : b.subCores.map((sc, i) => {
                const dx = (sc.east - b.core.east) / metresPerPx;
                const dy = -(sc.north - b.core.north) / metresPerPx;
                return (
                  <rect
                    key={`${b.altMid}-${i}`}
                    x={c + dx - 3}
                    y={c + dy - 3}
                    width={6}
                    height={6}
                    transform={`rotate(45 ${c + dx} ${c + dy})`}
                    className="fill-chart-4"
                  />
                );
              })
        )}
      </g>
      <g aria-hidden>
        <text x={c} y={12} textAnchor="middle" className={cn("fill-current text-[10px] text-muted-foreground", HALO)}>
          N
        </text>
        <text x={4} y={ROSE_SIZE - 5} className={cn("fill-current text-[9px] text-muted-foreground", HALO)}>
          mean climb ({climbUnit}) by sector
        </text>
        {shape.wind ? windArrow(shape.wind.direction, false, "measured", "actual") : null}
        {model ? windArrow(model.mean.directionDeg, true, "model", "forecast") : null}
      </g>
    </svg>
  );
}

/**
 * The ⓘ legend on the rose: every mark named, each with its own glyph drawn
 * in the same classes the rose uses, so the swatch always matches the chart.
 * A popover rather than a tooltip for the usual reason (rac/popover.tsx):
 * seven lines of prose need time, and touch users never see hover.
 */
function RoseLegend() {
  const glyph = (children: React.ReactNode) => (
    <svg viewBox="0 0 20 14" aria-hidden className="mt-0.5 h-3.5 w-5 shrink-0">
      {children}
    </svg>
  );
  const rows: { glyph: React.ReactNode; text: string }[] = [
    {
      glyph: glyph(<path d="M3,12 L17,12 A14,14 0 0 0 12.9,2.1 Z" className="fill-chart-3/40" />),
      text: "Wedges: relative climb by side of the core — longer means stronger lift on that side (blue marks sink). Each is labelled with its mean climb or sink rate.",
    },
    {
      glyph: glyph(
        <circle cx={10} cy={7} r={5.5} fill="none" strokeDasharray="5 3" className="stroke-muted-foreground/70" />
      ),
      text: "Dashed ring: the measured working circle, labelled with its diameter.",
    },
    {
      glyph: glyph(
        <circle cx={10} cy={7} r={5.5} fill="none" strokeDasharray="2 4" className="stroke-muted-foreground/50" />
      ),
      text: "Dotted ring: the widest the field ranged in this thermal, labelled with its diameter.",
    },
    {
      glyph: glyph(<circle cx={10} cy={7} r={2.5} className="fill-muted-foreground" />),
      text: "Centre dot: the core, seen from above — bands are re-centred, so lean and drift are already taken out.",
    },
    {
      glyph: glyph(
        <g fill="none" strokeWidth={1.6} className="stroke-foreground/80">
          <path d="M2,7 L15,7" />
          <path d="M15,7 L11,4 M15,7 L11,10" />
        </g>
      ),
      text: "Solid arrow (“actual”): wind measured from the pilots' circles, entering from the side it blows from.",
    },
    {
      glyph: glyph(
        <g fill="none" strokeWidth={1.6} className="stroke-muted-foreground">
          <path d="M2,7 L15,7" strokeDasharray="4 3" />
          <path d="M15,7 L11,4 M15,7 L11,10" />
        </g>
      ),
      text: "Dashed arrow (“forecast”): the weather model's wind — a model run, not an observation.",
    },
    {
      glyph: glyph(<rect x={7} y={4} width={6} height={6} transform="rotate(45 10 7)" className="fill-chart-4" />),
      text: "Diamonds: separate feeder cores in a band before they merged.",
    },
  ];
  return (
    <PopoverTrigger>
      <Button
        variant="ghost"
        size="icon"
        // size-6 (24px), the accessibility standard's §4.5 pointer-target
        // floor (WCAG 2.5.8).
        className="size-6 text-muted-foreground print:hidden"
        aria-label="What the thermal rose shows"
      >
        <InfoIcon aria-hidden className="size-3.5" />
      </Button>
      {/* Above the FullScreenSheet's z-[100]: the legend renders inside the
          expanded figure too, and the default popover z-50 would put it
          behind the sheet's own backdrop. */}
      <Popover className="z-[110]">
        <p className="font-medium">Reading the rose</p>
        <ul className="mt-2 space-y-1.5">
          {rows.map((r, i) => (
            <li key={i} className="flex gap-2">
              {r.glyph}
              <span className="text-xs">{r.text}</span>
            </li>
          ))}
        </ul>
      </Popover>
    </PopoverTrigger>
  );
}

/**
 * The rose over its optional satellite backdrop, with the figure's own
 * controls: the Map toggle, the maximise/restore control on the map's own
 * corner (one button, one place — press to fill the screen, press again to
 * come back; the browser Fullscreen API mapbox's own control rides on does
 * not exist on iPhones, so the "full screen" is the app's FullScreenSheet),
 * the legend, and — once the camera has been panned or zoomed away —
 * Re-centre. One component for the inline detail pane AND the full-screen
 * sheet, so the two can never disagree about behaviour.
 *
 * While the map is shown the rose stops taking pointer events: drags and
 * pinches belong to the map (inline, touch panning takes two fingers so one
 * finger still scrolls the page). And once the camera leaves the locked
 * framing the rose fades out entirely — its rings and wedges are drawn at
 * ground scale for that framing only, and over a moved camera they would be
 * a lie. The map's core marker keeps saying where the thermal is, and
 * Re-centre restores the locked view (and the rose with it).
 *
 * Two layouts. Inline the figure IS the rose's square. `fill` (the sheet)
 * spends the whole box on the MAP — that is what maximising is for — with
 * the rose a centred square over it; the scale lock then keys off the
 * rose's own width (`scaleRef`), not the map's, so the rings stay at true
 * ground size while the map shows more terrain around them.
 */
function RoseFigure({
  shape,
  model,
  climbFactor,
  climbUnit,
  distanceText,
  showMap,
  onShowMapChange,
  expanded = false,
  onToggleExpand,
  cooperativeGestures = true,
  fill = false,
  className,
}: {
  shape: ThermalShapeSummary;
  model: ModelWindProfile | null;
  climbFactor: number;
  climbUnit: string;
  distanceText: (m: number) => string;
  /** Lifted to the panel so the inline figure and the sheet stay in step. */
  showMap: boolean;
  onShowMapChange: (on: boolean) => void;
  /** Whether this instance IS the full-screen one (flips the control's
   * glyph from maximise to restore). */
  expanded?: boolean;
  /** The maximise/restore control's action. */
  onToggleExpand?: () => void;
  /** Two-finger touch pan — on inline maps embedded in the scrolling page. */
  cooperativeGestures?: boolean;
  /** Fill the parent box with the map, rose centred over it (the sheet). */
  fill?: boolean;
  className?: string;
}) {
  const [away, setAway] = useState(false);
  const [recentreToken, setRecentreToken] = useState(0);
  // The rose's own square, when it is smaller than the map (fill mode).
  const roseBoxRef = useRef<HTMLDivElement>(null);
  // Hiding the map hands the figure straight back to the rose.
  useEffect(() => {
    if (!showMap) setAway(false);
  }, [showMap]);
  const loc = shapeLocation(shape);
  const rose = (
    <ThermalRose
      shape={shape}
      model={model}
      climbFactor={climbFactor}
      climbUnit={climbUnit}
      distanceText={distanceText}
    />
  );
  return (
    <div
      className={cn(
        "relative",
        fill ? "h-full w-full" : "mx-auto w-full max-w-80",
        className
      )}
    >
      {showMap ? (
        <Suspense fallback={null}>
          {/* Interactive, so no aria-hidden: the map canvas is focusable and
              carries mapbox's own "Map" label. */}
          <div className={cn("absolute inset-0 overflow-hidden", !fill && "rounded-lg")}>
            <ThermalRoseMap
              lat={loc.lat}
              lon={loc.lon}
              metresPerSvgUnit={roseGeometry(shape).metresPerPx}
              svgSize={ROSE_SIZE}
              cooperativeGestures={cooperativeGestures}
              onAwayChange={setAway}
              recentreToken={recentreToken}
              scaleRef={fill ? roseBoxRef : undefined}
            />
            {/* Scrim so the rose's ink stays legible over imagery — gone with
                the rose while exploring, so the terrain reads clean. */}
            <div
              className={cn(
                "pointer-events-none absolute inset-0 bg-background/30 transition-opacity",
                away && "opacity-0"
              )}
            />
          </div>
        </Suspense>
      ) : null}
      <div
        aria-hidden={showMap && away ? true : undefined}
        className={cn(
          "transition-opacity",
          // Inline the rose is the box; filling, it floats centred over the
          // map, a square no bigger than the shorter viewport edge.
          fill
            ? "absolute inset-0 flex items-center justify-center"
            : "relative",
          // Gestures over the figure belong to the map while it is shown.
          showMap && "pointer-events-none",
          showMap && away && "opacity-0"
        )}
      >
        {fill ? (
          <div
            ref={roseBoxRef}
            className="w-full max-w-[min(100%,calc(100dvh-9rem))]"
          >
            {rose}
          </div>
        ) : (
          rose
        )}
      </div>
      <div className="absolute top-0 left-0 flex items-center gap-1 print:hidden">
        {HAS_MAP_TOKEN ? (
          <ToggleButton size="sm" isSelected={showMap} onChange={onShowMapChange}>
            Map
          </ToggleButton>
        ) : null}
        {/* In the toolbar, not floated at the figure's foot: stacked, the
            pinned pane clips the figure's bottom edge off screen, and an
            affordance to find your way back must not need finding itself. */}
        {showMap && away ? (
          <Button
            variant="outline"
            size="sm"
            onPress={() => setRecentreToken((t) => t + 1)}
          >
            Re-centre
          </Button>
        ) : null}
      </div>
      {/* The map's own maximise/restore control, mapbox-style on the map's
          corner: ONE button in ONE place, whose glyph flips — press to take
          the whole screen, press the same button to come back. Shown while
          the map is (or full screen, so the way back never disappears if the
          map is toggled off in there). */}
      {onToggleExpand && (showMap || expanded) ? (
        <div className="absolute top-8 right-0 print:hidden">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={expanded ? "Restore map size" : "Maximise map"}
            onPress={onToggleExpand}
          >
            {expanded ? <CollapseIcon /> : <ExpandIcon />}
          </Button>
        </div>
      ) : null}
      <div className="absolute top-0 right-0">
        <RoseLegend />
      </div>
    </div>
  );
}

/** Four corners pulling in — ExpandIcon's inverse, for the restore state of
 * the map's maximise control. */
function CollapseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path
        d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// --- Climb profile ---

const PROFILE_W = 320;
const PROFILE_ROW = 16;

/** Mean climb per altitude band, drawn as horizontal bars (highest band on
 * top). The band table below is the exact reading. */
function ClimbProfile({
  shape,
  climbFactor,
  climbUnit,
  altitudeLabel,
}: {
  shape: ThermalShapeSummary;
  climbFactor: number;
  climbUnit: string;
  altitudeLabel: (m: number) => string;
}) {
  const bands = shape.bands;
  const h = bands.length * PROFILE_ROW + 18;
  const maxV = Math.max(...bands.map((b) => b.meanVario), 0.5);
  const labelW = 56;
  const valueW = 44;
  const plotW = PROFILE_W - labelW - valueW;
  return (
    <svg
      viewBox={`0 0 ${PROFILE_W} ${h}`}
      className="h-auto w-full max-w-80"
      role="img"
      aria-label={`Mean climb by altitude band, from ${altitudeLabel(bands[0].altMin)} to ${altitudeLabel(bands[bands.length - 1].altMax)}. Exact numbers are in the band table.`}
    >
      {bands.map((b, i) => {
        const y = (bands.length - 1 - i) * PROFILE_ROW + 3;
        const w = Math.max((b.meanVario / maxV) * plotW, 1);
        return (
          <g key={b.altMid} aria-hidden>
            <text x={labelW - 5} y={y + PROFILE_ROW - 7} textAnchor="end" className="fill-current text-[9px] text-muted-foreground">
              {altitudeLabel(b.altMin)}
            </text>
            <rect x={labelW} y={y} width={w} height={PROFILE_ROW - 6} rx={2} className="fill-chart-3/70" />
            <text x={labelW + w + 4} y={y + PROFILE_ROW - 7} className="fill-current text-[9px] text-muted-foreground">
              {formatMetricValue(climbUnit, b.meanVario * climbFactor)}
            </text>
          </g>
        );
      })}
      <text x={labelW} y={h - 4} className="fill-current text-[9px] text-muted-foreground" aria-hidden>
        mean climb ({climbUnit}) by band
      </text>
    </svg>
  );
}

// --- The panel ---

export function ThermalsPanel({
  thermals,
  compTimezone,
  weather,
  weatherPending,
  replayHrefFor,
}: {
  thermals: FieldThermalsSummary;
  compTimezone: string | null;
  weather: TaskWeather | null;
  weatherPending: boolean;
  /** Deep link into the 3D replay for one thermal; null hides the link. */
  replayHrefFor: (thermalId: number) => string | null;
}) {
  const units = useUnits();
  const climb = unitDisplay("m/s", units);
  const speed = unitDisplay("km/h", units);
  const tz = compTimezone ?? undefined;
  const shapes = thermals.shapes;

  // Deterministic default (also the SSR render): the most-shared thermal.
  const defaultId = useMemo(
    () =>
      shapes.reduce(
        (best, s) => (s.pilotCount > best.pilotCount ? s : best),
        shapes[0]
      ).id,
    [shapes]
  );
  // The selection is URL state, not component state: stacked, choosing a row
  // is a navigation, and Back is how a reader gets out of the detail. Read
  // from the query on both the server and the first client render, so a
  // shared link opens on the thermal it names.
  const [searchParams] = useSearchParams();
  const chosen = thermalFromParam(searchParams.get(THERMAL_PARAM), shapes);
  // Satellite backdrop under the rose — off by default (and in the SSR
  // snapshot), so mapbox-gl only ever loads on an explicit flip. Shared by
  // the inline figure and the full-screen sheet.
  const [showMap, setShowMap] = useState(false);
  // The figure filling the screen (rac/full-screen-sheet.tsx), for actually
  // exploring the terrain around the thermal.
  const [expanded, setExpanded] = useState(false);
  // What the pane shows. With nothing chosen it is still the default thermal:
  // side by side the pane is on screen from the first paint and must not be
  // empty, and stacked it is off screen anyway until a row is picked.
  const selected = chosen ?? shapes.find((s) => s.id === defaultId) ?? shapes[0];
  // Labels the detail region (it is read before the census it belongs to).
  const headingId = useId();

  // The query parameter, the push-vs-replace decision, the back control and
  // the side-by-side seed all live in the shared hook — the census only says
  // WHICH thermal the URL names and which one stands in for it.
  const { showingDetail, wide, choose, back, onWideChange } =
    useMasterDetailSelection({
      param: THERMAL_PARAM,
      chosen: chosen?.id ?? null,
      defaultId,
    });

  const model = useMemo(() => modelWindFor(selected, weather), [selected, weather]);

  const altLabel = (m: number) => formatAltitude(m, { prefs: units }).formatted;
  const altWithUnit = (m: number) => formatAltitude(m, { prefs: units }).withUnit;
  const climbText = (ms: number) => `${formatMetricValue(climb.unit, ms * climb.factor)} ${climb.unit}`;
  // Wind readouts follow the horizontal-speed preference; measurements are m/s.
  const windText = (ms: number) =>
    `${formatMetricValue(speed.unit, ms * 3.6 * speed.factor)} ${speed.unit}`;

  const multiCoreBands = selected.bands.filter((b) => b.subCores.length >= 2);
  const replayHref = replayHrefFor(selected.id);

  // The census's mean-climb bars, scaled from zero (climb is a magnitude —
  // a bar starting at the day's weakest thermal would exaggerate the spread)
  // to the day's strongest. Cached per shape id so the max and forty cells
  // don't each re-walk every band.
  const climbByShape = useMemo(
    () => new Map(shapes.map((s) => [s.id, meanClimb(s)])),
    [shapes]
  );
  const maxMeanClimb = Math.max(0, ...climbByShape.values());

  // The census opens on the most-shared thermals so the rose — the actual
  // reading — leads the section instead of competing with forty rows. Order
  // stays chronological (the stored list's order); "top" only decides which
  // rows show. The selected thermal always stays visible: collapsing the
  // list must never take the detail pane's subject out of the census.
  const [showAll, setShowAll] = useState(false);
  const topIds = useMemo(() => {
    const ranked = [...shapes].sort(
      (a, b) => b.pilotCount - a.pilotCount || a.startMs - b.startMs
    );
    return new Set(ranked.slice(0, TOP_THERMALS).map((s) => s.id));
  }, [shapes]);
  const truncatable = shapes.length > TOP_THERMALS;
  const collapsed = truncatable && !showAll;
  const visibleShapes = collapsed
    ? shapes.filter((s) => topIds.has(s.id) || s.id === selected.id)
    : shapes;

  /** The intro's first sentence, for a given shown-count. */
  const censusIntro = (count: number) =>
    count < thermals.totalShapeCount
      ? `The ${count} most-shared of ${thermals.totalShapeCount} multi-pilot thermals, reconstructed by pooling every pilot's track through the same climb.`
      : `${count} multi-pilot thermal${count === 1 ? "" : "s"}, reconstructed by pooling every pilot's track through the same climb.`;

  // One table for both renders: the interactive census on screen, and — only
  // while the census is truncated — a non-interactive print copy of every
  // row, because this report prints whole (the family Disclosures force
  // their panels open in print for the same reason) and paper has no
  // "Show all" to press.
  const censusTable = (rows: ThermalShapeSummary[], interactive: boolean) => (
    <Table
      aria-label="Reconstructed thermals"
      scrollLabel="Reconstructed thermals"
      // The same edge-to-edge bleed as the separation ranking's master: the
      // card's side padding is a tenth of a phone's width, and paying it here
      // squeezes the columns into a sideways scroll they don't need.
      viewportClassName={cn(
        "-mx-5 w-auto border-y",
        "@5xl:mx-0 @5xl:w-full @5xl:border-y-0"
      )}
      {...(interactive
        ? {
            selectionMode: "single" as const,
            // TOGGLE, not the ranking's "replace": under `replace` react-aria
            // selects whatever the arrow keys focus, and stacked that would
            // navigate away from the census on the first Down press — taking
            // the list, and the keyboard user's place in it, off the screen.
            // Toggle moves focus and waits for Enter, which is what a list
            // you navigate OUT of has to do. A click still picks, on both.
            selectionBehavior: "toggle" as const,
            disallowEmptySelection: true,
            // The CHOSEN thermal, not the one the pane happens to be showing.
            // Lighting the default row before anyone picked it would make
            // re-picking it a no-op — RAC drops a selection event that does
            // not change the set — and stacked that row is the only way in.
            selectedKeys: chosen ? [chosen.id] : [],
            onSelectionChange: (keys: Selection) => {
              if (keys !== "all") {
                const key = [...keys][0];
                if (key !== undefined) choose(Number(key), wide);
              }
            },
          }
        : {})}
    >
      <TableHeader>
        <Column isRowHeader>Start</Column>
        <Column>Pilots</Column>
        <Column>Height band</Column>
        <Column>Mean climb</Column>
        <Column>Strongest side</Column>
      </TableHeader>
      <TableBody>
        {rows.map((s) => (
          <Row key={s.id} id={s.id}>
            <Cell>
              <time dateTime={new Date(s.startMs).toISOString()}>
                {formatTimeOfDay(new Date(s.startMs).toISOString(), tz)}
              </time>
            </Cell>
            <Cell>{s.pilotCount}</Cell>
            <Cell>
              {altLabel(s.bands[0].altMin)}–{altWithUnit(s.bands[s.bands.length - 1].altMax)}
            </Cell>
            <Cell>
              <span className="flex items-center gap-2 tabular-nums">
                {/* Bar first so every row's bar shares a left edge — aligned
                    lengths are what make forty rows scannable. Hidden narrow
                    for the same reason as PerPilotMetricTable's bars: on a
                    phone the census already scrolls sideways. */}
                {maxMeanClimb > 0 ? (
                  <ValueBar
                    className="hidden w-10 sm:inline-block"
                    fraction={(climbByShape.get(s.id) ?? 0) / maxMeanClimb}
                  />
                ) : null}
                <span>+{climbText(climbByShape.get(s.id) ?? 0)}</span>
              </span>
            </Cell>
            <Cell>{s.strongestSide ? degToCompass(s.strongestSide.bearing) : "—"}</Cell>
          </Row>
        ))}
      </TableBody>
    </Table>
  );

  const census = (
    <div>
      <div className={collapsed ? "print:hidden" : undefined}>
        {censusTable(visibleShapes, true)}
      </div>
      {collapsed ? (
        <div aria-hidden className="hidden print:block">
          {censusTable(shapes, false)}
        </div>
      ) : null}
      {truncatable ? (
        <div className="mt-2 print:hidden">
          <Button variant="ghost" size="sm" onPress={() => setShowAll((v) => !v)}>
            {showAll
              ? `Show the ${TOP_THERMALS} most shared`
              : `Show all ${shapes.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {/* The count states what the census is SHOWING (top-10 collapsed,
            the stored set expanded) against the day's true total, so the
            sentence stays honest in every state — including print, where
            the hidden rows come back and the screen count would be a lie. */}
        <span className={collapsed ? "print:hidden" : undefined}>
          {censusIntro(collapsed ? TOP_THERMALS : shapes.length)}
        </span>
        {collapsed ? (
          <span className="hidden print:inline">{censusIntro(shapes.length)}</span>
        ) : null}{" "}
        Everything shown is measured from the tracks — no fitted lift model.
        {/* An instruction to interact — meaningless on paper. */}
        <span className="print:hidden"> Select a thermal to see it in detail.</span>
      </p>

      <MasterDetail
        detailLabel="detail"
        detailHeadingId={headingId}
        navigation={{
          showingDetail,
          backLabel: "All thermals",
          onBack: back,
        }}
        onWideChange={onWideChange}
        master={census}
        detail={<div className="p-4">
        <h3 id={headingId} className="text-sm font-semibold">
          Thermal at{" "}
          {formatTimeOfDay(new Date(selected.startMs).toISOString(), tz)} —{" "}
          {selected.pilotCount} pilots, {selected.useCount} climbs
        </h3>
        {/* One column always: the pane is never wider than its 35rem cap
            (stacked) or the grid's right column (side by side), so the old
            rose-beside-readouts split has no width to spend. */}
        <div className="mt-3 space-y-4">
          <RoseFigure
            shape={selected}
            model={model}
            climbFactor={climb.factor}
            climbUnit={climb.unit}
            distanceText={(m) => altWithUnit(m)}
            showMap={showMap}
            onShowMapChange={setShowMap}
            onToggleExpand={() => setExpanded(true)}
          />
          <div className="space-y-3 text-sm">
            <ul className="space-y-2">
              {selected.wind ? (
                <li>
                  Wind {windText(selected.wind.speed)} from {Math.round(selected.wind.direction)}°{" "}
                  ({degToCompass(selected.wind.direction)}), measured from {selected.wind.samples} circle
                  estimates in the pilots' own tracks.
                </li>
              ) : null}
              {model && weather ? (
                <li>
                  Model wind {windText(model.mean.speedMs)} from {Math.round(model.mean.directionDeg)}°{" "}
                  ({degToCompass(model.mean.directionDeg)}) — a model run, not an observation
                  {selected.wind
                    ? `; ${Math.round(angDiff(model.mean.directionDeg, selected.wind.direction))}° from the track-measured wind`
                    : ""}
                  .
                </li>
              ) : weatherPending ? (
                <li className="text-muted-foreground">Model wind cross-check loading…</li>
              ) : null}
              {selected.lean ? (
                <li>
                  Leans {Math.round(selected.lean.tiltDeg)}° from vertical toward{" "}
                  {Math.round(selected.lean.bearing)}° ({degToCompass(selected.lean.bearing)})
                  {selected.wind
                    ? (() => {
                        const downwind = (selected.wind.direction + 180) % 360;
                        const d = Math.round(angDiff(selected.lean.bearing, downwind));
                        return d <= 45
                          ? `, within ${d}° of downwind`
                          : `, ${d}° off downwind (${Math.round(downwind)}°)`;
                      })()
                    : ""}
                  .
                  {selected.lean.confounded ? (
                    <span className="text-muted-foreground">
                      {" "}
                      The field climbed as one wave, so lean cannot be told from drift here.
                    </span>
                  ) : null}
                </li>
              ) : null}
              {selected.strongestSide ? (
                <li>
                  Strongest on the {degToCompass(selected.strongestSide.bearing)} side of the core at
                  +{climbText(selected.strongestSide.meanVario)}
                  {selected.strongestSide.oppositeMeanVario !== null
                    ? ` against ${selected.strongestSide.oppositeMeanVario >= 0 ? "+" : ""}${climbText(selected.strongestSide.oppositeMeanVario)} on the ${degToCompass((selected.strongestSide.bearing + 180) % 360)} side`
                    : ""}
                  .
                </li>
              ) : null}
              {multiCoreBands.length > 0 ? (
                <li>
                  Multiple cores in {multiCoreBands.length} of {selected.bands.length} bands between{" "}
                  {altLabel(multiCoreBands[0].altMin)} and {altWithUnit(multiCoreBands[multiCoreBands.length - 1].altMax)}{" "}
                  — separate feeders (⬧ in the rose) before they merged.
                </li>
              ) : null}
            </ul>
            <ClimbProfile shape={selected} climbFactor={climb.factor} climbUnit={climb.unit} altitudeLabel={altLabel} />
            {replayHref ? (
              <a
                href={replayHref}
                // A new tab, deliberately: coming back from the replay does
                // not restore the scroll position in this long page.
                target="_blank"
                rel="noopener"
                className="inline-block text-sm underline underline-offset-4 hover:text-foreground"
              >
                Watch this thermal in the 3D replay
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
            ) : null}
          </div>
        </div>

        {/* Per-pilot climb ranges — only in reports stored since
            TASK_ANALYSIS_VERSION 21; older payloads simply lack the field
            and the table stays hidden rather than failing. */}
        {selected.pilotClimbs && selected.pilotClimbs.length === selected.pilots.length ? (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-muted-foreground">
              Pilots in this thermal (climb rates)
            </summary>
            <div className="mt-2 overflow-x-auto">
              <Table aria-label="Pilots in this thermal, climb rates" className="min-w-[28rem] text-xs">
                <TableHeader>
                  <Column isRowHeader>Pilot</Column>
                  <Column>Min</Column>
                  <Column>Median</Column>
                  <Column>Max</Column>
                </TableHeader>
                <TableBody>
                  {selected.pilots
                    .map((name, i) => ({ name, i, climb: selected.pilotClimbs![i] }))
                    .sort((a, b) => b.climb.medianVario - a.climb.medianVario)
                    .map(({ name, i, climb }) => (
                      <Row key={i}>
                        <Cell>{name}</Cell>
                        {climb.samples === 0 ? (
                          <>
                            <Cell>—</Cell>
                            <Cell>—</Cell>
                            <Cell>—</Cell>
                          </>
                        ) : (
                          <>
                            <Cell>{signedClimb(climb.minVario, climbText)}</Cell>
                            <Cell>{signedClimb(climb.medianVario, climbText)}</Cell>
                            <Cell>{signedClimb(climb.maxVario, climbText)}</Cell>
                          </>
                        )}
                      </Row>
                    ))}
                </TableBody>
              </Table>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Each pilot's slowest, typical and best climb over their own vario samples in this
              thermal — a negative minimum means they touched sink inside it.
            </p>
          </details>
        ) : null}

        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-muted-foreground">
            Band table (exact numbers)
          </summary>
          <div className="mt-2 overflow-x-auto">
            <Table aria-label="Thermal bands, exact numbers" className="min-w-[46rem] text-xs">
              <TableHeader>
                <Column isRowHeader>Band</Column>
                <Column>Core offset E/N (m)</Column>
                <Column>Working radius</Column>
                <Column>Extent</Column>
                <Column>Mean climb</Column>
                <Column>Best climb</Column>
                <Column>Samples</Column>
                <Column>Pilots</Column>
                <Column>Cores</Column>
                {model ? <Column>Model wind</Column> : null}
              </TableHeader>
              <TableBody>
                {[...selected.bands].reverse().map((b) => {
                  const mw = model?.bands.find((x) => x.altMid === b.altMid);
                  return (
                    <Row key={b.altMid}>
                      <Cell>
                        {altLabel(b.altMin)}–{altWithUnit(b.altMax)}
                      </Cell>
                      <Cell>
                        {Math.round(b.core.east)} / {Math.round(b.core.north)}
                      </Cell>
                      <Cell>{altWithUnit(b.coreRadius)}</Cell>
                      <Cell>{altWithUnit(b.extentRadius)}</Cell>
                      <Cell>+{climbText(b.meanVario)}</Cell>
                      <Cell>+{climbText(b.maxVario)}</Cell>
                      <Cell>{b.sampleCount}</Cell>
                      <Cell>{b.pilotCount}</Cell>
                      <Cell>{Math.max(b.subCores.length, 1)}</Cell>
                      {model ? (
                        <Cell>
                          {mw ? `${windText(mw.speedMs)} @ ${Math.round(mw.directionDeg)}°` : "—"}
                        </Cell>
                      ) : null}
                    </Row>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </details>
      </div>}
      />

      {/* The figure at full size. Mounted only while open (the sheet's
          contract), so the SSR snapshot and the un-expanded page carry none
          of it. Cooperative gestures come OFF in here: there is no page
          underneath to scroll, so one finger may pan the map. */}
      {expanded ? (
        <FullScreenSheet
          label={`Thermal at ${formatTimeOfDay(new Date(selected.startMs).toISOString(), tz)}, rose and map`}
          onClose={() => setExpanded(false)}
          className="flex flex-col gap-2 p-3 sm:p-4"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 truncate text-base font-semibold">
              Thermal at{" "}
              {formatTimeOfDay(new Date(selected.startMs).toISOString(), tz)} —{" "}
              {selected.pilotCount} pilots
            </h2>
            {/* autoFocus so a keyboard user lands on the way out rather than
                on the dialog container (same reasoning as the metric chart's
                sheet — Escape alone is not discoverable, §4.1). */}
            <Button
              autoFocus
              variant="outline"
              size="sm"
              onPress={() => setExpanded(false)}
            >
              Close
            </Button>
          </div>
          <div className="min-h-0 w-full flex-1">
            {/* `fill`: the MAP spends the whole box — that is what
                maximising is for — and the rose floats over it as a centred
                square no bigger than the shorter viewport edge. */}
            <RoseFigure
              shape={selected}
              model={model}
              climbFactor={climb.factor}
              climbUnit={climb.unit}
              distanceText={(m) => altWithUnit(m)}
              showMap={showMap}
              onShowMapChange={setShowMap}
              expanded
              onToggleExpand={() => setExpanded(false)}
              cooperativeGestures={false}
              fill
            />
          </div>
        </FullScreenSheet>
      ) : null}

      {/* The reconstruction method is behind the ⓘ. The model ATTRIBUTION is
          not: it is a licence obligation, so it stays on the page in both
          media, and the "a model run, not an observation" caveat stays with
          it — a prediction must never be readable as a record. */}
      <p className="text-xs text-muted-foreground">
        <span className="inline-flex items-baseline gap-1">
          <span>
            The dashed &ldquo;forecast&rdquo; arrow is the weather
            model&rsquo;s wind — a model run, not an observation.
            {weather?.source
              ? ` Model: ${weather.source.attribution} (${weather.source.model}).`
              : ""}
          </span>
          <Explain label="How the thermals were reconstructed" className="self-center">
            <ThermalsNote />
          </Explain>
        </span>
      </p>
      {/* The note renders <p>s, so its print copy sits beside the paragraph,
          not inside it — a <p> cannot hold another <p>. */}
      <div className="hidden text-xs text-muted-foreground print:block">
        <ThermalsNote />
      </div>
    </div>
  );
}

/** How a thermal shape is built and what each mark on the rose means. One
 * definition, rendered in the ⓘ and again for print. */
function ThermalsNote() {
  return (
    <>
      <p>
        Each thermal pools every pilot&rsquo;s fixes through the same climb into
        100 m altitude bands. A band&rsquo;s core is the lift-weighted centre of
        its fixes, so the rose and the sector readings are already normalised
        for the thermal&rsquo;s lean and drift.
      </p>
      <p>
        Wedge length is relative climb by side of the core, each wedge labelled
        with its mean climb or sink rate; the dashed ring is the measured
        working circle and the dotted ring the widest the field ranged, each
        labelled with its diameter. The solid &ldquo;actual&rdquo; arrow is the
        wind measured from the pilots&rsquo; circles; the dashed
        &ldquo;forecast&rdquo; arrow is the weather model&rsquo;s wind.
      </p>
    </>
  );
}
