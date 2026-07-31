/**
 * The task's reconstructed thermals — the "Thermals" section of the task
 * field-analysis page.
 *
 * Everything renders from the stored ThermalShapeSummary list (no point
 * clouds): a census table of the day's shared thermals, then one selected
 * thermal in detail — a top-down lift rose around the measured core, the
 * headline readouts (lean vs wind, strongest side, feeders), the climb
 * profile by altitude band, and the exact numbers in a band table. The
 * summaries are MEASUREMENTS pooled from the field's own tracks, never a
 * fitted model, and the captions say so.
 *
 * The model wind is the one outside number: the task's weather column
 * (independent request, same as DayProfilePanel) interpolated to each band's
 * altitude via the engine's windAtHeight. It is drawn dashed and labelled as
 * a model run beside the track-measured wind — a reader must never mistake
 * the prediction for the measurement (docs/weather.md).
 */
import { useMemo, useState } from "react";
import { windAtHeight } from "@glidecomp/engine";
import type {
  TaskWeather,
  ThermalShapeSummary,
  FieldThermalsSummary,
  WeatherHour,
} from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { formatTimeOfDay } from "../../lib/time";
import { formatAltitude, useUnits } from "../../lib/units";
import { formatMetricValue } from "../types";
import { unitDisplay } from "../units";
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

/**
 * Top-down view of the thermal about its own core. Wedge length is RELATIVE
 * climb by sector (the shape of the lift), the dashed ring is the measured
 * working radius and the faint ring the flown extent (both in metres, to the
 * same scale as the feeder diamonds). Solid arrow: track-measured wind.
 * Dashed arrow: the model's wind — a model run, not an observation.
 */
function ThermalRose({
  shape,
  model,
  climbFactor,
  climbUnit,
}: {
  shape: ThermalShapeSummary;
  model: ModelWindProfile | null;
  climbFactor: number;
  climbUnit: string;
}) {
  const c = ROSE_SIZE / 2;
  const sectors = aggregateSectors(shape);
  const maxAbs = Math.max(...sectors.map((s) => Math.abs(s.mean ?? 0)), 0.5);

  let radiusW = 0;
  let radiusN = 0;
  let extent = 0;
  for (const b of shape.bands) {
    radiusW += b.coreRadius * b.sampleCount;
    radiusN += b.sampleCount;
    extent = Math.max(extent, b.extentRadius);
  }
  const coreRadius = radiusN > 0 ? radiusW / radiusN : 0;
  const metresPerPx = Math.max(extent, coreRadius * 1.4, 100) / ROSE_R;

  const sectorWidth = 360 / Math.max(sectors.length, 1);
  const wedgePath = (bearing: number, r: number): string => {
    const a0 = ((bearing - sectorWidth / 2 - 90) * Math.PI) / 180;
    const a1 = ((bearing + sectorWidth / 2 - 90) * Math.PI) / 180;
    return (
      `M${c},${c} L${(c + r * Math.cos(a0)).toFixed(1)},${(c + r * Math.sin(a0)).toFixed(1)} ` +
      `A${r},${r} 0 0 1 ${(c + r * Math.cos(a1)).toFixed(1)},${(c + r * Math.sin(a1)).toFixed(1)} Z`
    );
  };

  /** Arrow entering from the compass edge the wind blows FROM. */
  const windArrow = (directionFromDeg: number, dashed: boolean, key: string) => {
    const a = ((directionFromDeg - 90) * Math.PI) / 180;
    const r0 = c - 10;
    const r1 = c - 34;
    const x0 = c + r0 * Math.cos(a);
    const y0 = c + r0 * Math.sin(a);
    const x1 = c + r1 * Math.cos(a);
    const y1 = c + r1 * Math.sin(a);
    const ah = Math.atan2(y1 - y0, x1 - x0);
    return (
      <g key={key} className={dashed ? "stroke-muted-foreground" : "stroke-foreground/80"} fill="none">
        <path d={`M${x0},${y0} L${x1},${y1}`} strokeWidth={1.6} strokeDasharray={dashed ? "4 3" : undefined} />
        <path
          d={`M${x1},${y1} L${x1 - 7 * Math.cos(ah - 0.5)},${y1 - 7 * Math.sin(ah - 0.5)} M${x1},${y1} L${x1 - 7 * Math.cos(ah + 0.5)},${y1 - 7 * Math.sin(ah + 0.5)}`}
          strokeWidth={1.6}
        />
      </g>
    );
  };

  const strongest = shape.strongestSide;
  const label = strongest
    ? `Top-down lift rose: strongest on the ${degToCompass(strongest.bearing)} side of the core at ` +
      `${formatMetricValue(climbUnit, strongest.meanVario * climbFactor)} ${climbUnit}. Exact numbers per band are in the table below.`
    : "Top-down lift rose. Exact numbers per band are in the table below.";

  return (
    <svg viewBox={`0 0 ${ROSE_SIZE} ${ROSE_SIZE}`} className="h-auto w-full max-w-80" role="img" aria-label={label}>
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
      {/* Working radius + flown extent, in metres. */}
      <g aria-hidden fill="none">
        <circle cx={c} cy={c} r={extent / metresPerPx} className="stroke-border" strokeDasharray="2 4" />
        <circle cx={c} cy={c} r={coreRadius / metresPerPx} className="stroke-muted-foreground/70" strokeDasharray="5 3" />
        <circle cx={c} cy={c} r={2.5} className="fill-muted-foreground" />
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
        <text x={c} y={12} textAnchor="middle" className="fill-current text-[10px] text-muted-foreground">
          N
        </text>
        {shape.wind ? windArrow(shape.wind.direction, false, "measured") : null}
        {model ? windArrow(model.mean.directionDeg, true, "model") : null}
      </g>
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
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = shapes.find((s) => s.id === (selectedId ?? defaultId)) ?? shapes[0];

  const model = useMemo(() => modelWindFor(selected, weather), [selected, weather]);

  const altLabel = (m: number) => formatAltitude(m, { prefs: units }).formatted;
  const altWithUnit = (m: number) => formatAltitude(m, { prefs: units }).withUnit;
  const climbText = (ms: number) => `${formatMetricValue(climb.unit, ms * climb.factor)} ${climb.unit}`;
  // Wind readouts follow the horizontal-speed preference; measurements are m/s.
  const windText = (ms: number) =>
    `${formatMetricValue(speed.unit, ms * 3.6 * speed.factor)} ${speed.unit}`;

  const multiCoreBands = selected.bands.filter((b) => b.subCores.length >= 2);
  const replayHref = replayHrefFor(selected.id);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {shapes.length < thermals.totalShapeCount
          ? `The ${shapes.length} most-shared of ${thermals.totalShapeCount} multi-pilot thermals, reconstructed by pooling every pilot's track through the same climb.`
          : `${shapes.length} multi-pilot thermal${shapes.length === 1 ? "" : "s"}, reconstructed by pooling every pilot's track through the same climb.`}{" "}
        Everything shown is measured from the tracks — no fitted lift model.
      </p>

      <div className="overflow-x-auto">
        <Table aria-label="Reconstructed thermals" className="min-w-[40rem]">
          <TableHeader>
            <Column isRowHeader>Start</Column>
            <Column>Pilots</Column>
            <Column>Height band</Column>
            <Column>Mean climb</Column>
            <Column>Strongest side</Column>
            <Column>
              <span className="sr-only">Detail</span>
            </Column>
          </TableHeader>
          <TableBody>
            {shapes.map((s) => {
              const isSelected = s.id === selected.id;
              return (
                <Row key={s.id} className={isSelected ? "bg-muted/50" : undefined}>
                  <Cell>
                    <time dateTime={new Date(s.startMs).toISOString()}>
                      {formatTimeOfDay(new Date(s.startMs).toISOString(), tz)}
                    </time>
                  </Cell>
                  <Cell>{s.pilotCount}</Cell>
                  <Cell>
                    {altLabel(s.bands[0].altMin)}–{altWithUnit(s.bands[s.bands.length - 1].altMax)}
                  </Cell>
                  <Cell>+{climbText(meanClimb(s))}</Cell>
                  <Cell>{s.strongestSide ? degToCompass(s.strongestSide.bearing) : "—"}</Cell>
                  <Cell>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-pressed={isSelected}
                      onPress={() => setSelectedId(s.id)}
                    >
                      {isSelected ? "Shown" : "Show"}
                    </Button>
                  </Cell>
                </Row>
              );
            })}
          </TableBody>
        </Table>
      </div>

      <div className="rounded-lg border p-4">
        <h3 className="text-sm font-semibold">
          Thermal at{" "}
          {formatTimeOfDay(new Date(selected.startMs).toISOString(), tz)} —{" "}
          {selected.pilotCount} pilots, {selected.useCount} climbs
        </h3>
        <div className="mt-3 grid gap-6 md:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <ThermalRose shape={selected} model={model} climbFactor={climb.factor} climbUnit={climb.unit} />
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
                className="inline-block text-sm underline underline-offset-4 hover:text-foreground"
              >
                Watch this thermal in the 3D replay
              </a>
            ) : null}
          </div>
        </div>

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
      </div>

      <p className="text-xs text-muted-foreground">
        How to read this: each thermal pools every pilot's fixes through the same climb into{" "}
        100 m altitude bands; a band's core is the lift-weighted centre of its fixes, so the
        rose and the sector readings are already normalised for the thermal's lean and drift.
        Wedge length is relative climb by side of the core; the dashed ring is the measured
        working radius and the faint ring the widest the field ranged. The solid arrow is the
        wind measured from the pilots' circles; the dashed arrow is the weather model's wind
        for the same place, time and altitudes — a model run, not an observation.
        {weather?.source ? ` Model: ${weather.source.attribution} (${weather.source.model}).` : ""}
      </p>
    </div>
  );
}
