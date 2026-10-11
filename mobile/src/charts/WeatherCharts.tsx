/**
 * The day's modelled weather as three charts on ONE time axis — wind, cloud,
 * and thermal height — the website's TaskWeatherPanel (MetWindChart,
 * MetSkyChart, MetThermalChart), drawn natively. The hourly list under them
 * stays the exact reading.
 *
 * Shared with the website rather than redrawn from scratch: the time axis
 * ticks on the competition's wall-clock hours (`@glidecomp/client/time-axis`),
 * and the wind glyph, label separation, cloud opacity, usable ceiling and
 * unit conversion are the website's own (`@glidecomp/client/met`, `/units`).
 *
 * Every chart prints its source (docs/weather.md: a prediction is never read
 * as a record). Touch replaces hover: tapping an hour names its figures on
 * the readout line.
 */
import { niceTicks, linearScale } from '@glidecomp/client/chart-scale';
import {
  approxTextWidth,
  coverOpacity,
  degToCompass,
  separateLabels,
  usableCeilingM,
  weatherInstants,
  windArrowPath,
  windArrowTransform,
} from '@glidecomp/client/met';
import { formatTimeRange, zoneAbbrev } from '@glidecomp/client/time';
import { buildTimeAxis, type TimeAxis } from '@glidecomp/client/time-axis';
import { unitDisplay } from '@glidecomp/client/units';
import { flyingHeightLevel, sourceKindLabel, type TaskWeather, type WeatherHour, type WeatherSource } from '@glidecomp/client/weather';
import { bestDaylightWindow, type UnitPreferences } from '@glidecomp/engine';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { useChartPalette, type ChartPalette } from './palette';
import { chartStyles } from './styles';
import { useWidth } from './use-width';

const HOUR_MS = 3_600_000;
const FONT = 11;
const SMALL = 10;
const LEFT = 48;
const RIGHT_PAD = 22;

interface Stroke {
  stroke: string;
  strokeWidth: number;
  dash?: string;
  opacity?: number;
}
interface EndLabel extends Stroke {
  key: string;
  text: string;
  y: number;
}

/** The daylight hours of the flying day, as the website's panel clamps them. */
function daylightHours(weather: TaskWeather): WeatherHour[] {
  const { lat, lon, fromMs, toMs } = weather.resolved;
  const win = bestDaylightWindow(lat, lon, fromMs, toMs);
  if (!win) return weather.hours;
  return weather.hours.filter((h) => {
    const t = new Date(h.t).getTime();
    return Number.isFinite(t) && t + HOUR_MS > win.sunriseMs && t < win.sunsetMs;
  });
}

export function WeatherCharts({
  weather,
  timeZone,
  prefs,
}: {
  weather: TaskWeather;
  timeZone: string | null;
  prefs: UnitPreferences;
}) {
  const palette = useChartPalette();
  const [W, onLayout] = useWidth();
  const [readout, setReadout] = useState<string | null>(null);
  const tz = timeZone ?? undefined;
  const hours = useMemo(() => daylightHours(weather), [weather]);
  const axis = useMemo(
    () => (W > 0 ? buildTimeAxis(weatherInstants(hours), tz, [LEFT, W - RIGHT_PAD]) : null),
    [hours, tz, W],
  );
  return (
    <View onLayout={onLayout} testID="weather-charts">
      {axis && hours.length > 0 ? (
        <>
          <WindChart W={W} hours={hours} weather={weather} axis={axis} tz={tz} prefs={prefs} palette={palette} onReadout={setReadout} />
          <SkyChart W={W} hours={hours} source={weather.source} axis={axis} tz={tz} palette={palette} onReadout={setReadout} />
          <ThermalChart W={W} hours={hours} source={weather.source} axis={axis} tz={tz} prefs={prefs} palette={palette} onReadout={setReadout} />
          <Text style={[chartStyles.caption, { color: palette.muted, textAlign: 'center' }]}>
            {`time of day (${zoneAbbrev(new Date(axis.domainStart), tz)})`}
          </Text>
          <Text style={[chartStyles.readout, { color: palette.muted }]} accessibilityElementsHidden importantForAccessibility="no">
            {readout ?? 'Tap a chart for exact figures.'}
          </Text>
          <Text style={[chartStyles.caption, { color: palette.muted }]}>
            All charts share that one time axis. Arrows fly WITH the wind — the readout’s direction figures are degrees the wind blows from.
          </Text>
        </>
      ) : null}
    </View>
  );
}

const sourceSentence = (s: WeatherSource) => `Source: ${s.attribution} (${s.model}, ${sourceKindLabel(s.kind)}).`;
const when = (tMs: number, tz: string | undefined) =>
  formatTimeRange(new Date(tMs).toISOString(), new Date(tMs + HOUR_MS).toISOString(), tz);

function linePath(points: { cx: number }[], pick: (i: number) => number | null, y: (v: number) => number): string {
  let d = '';
  let penDown = false;
  points.forEach((p, i) => {
    const v = pick(i);
    if (v === null) {
      penDown = false;
      return;
    }
    d += `${penDown ? 'L' : 'M'}${p.cx.toFixed(1)},${y(v).toFixed(1)}`;
    penDown = true;
  });
  return d;
}

/** Room the heading takes above every chart: its name, and its source under
 *  it. The website puts the two on one row; a phone is too narrow for both. */
const HEAD = 30;

/** The chart's name, with its source beneath — every chart prints its source. */
function Heading({ title, source, palette }: { title: string; source: WeatherSource; palette: ChartPalette }) {
  return (
    <G>
      <SvgText x={LEFT - 40} y={12} fontSize={FONT} fontWeight="600" fill={palette.muted}>
        {title}
      </SvgText>
      <SvgText x={LEFT - 40} y={25} fontSize={SMALL} fill={palette.muted}>
        {`${source.model} · ${sourceKindLabel(source.kind)}`}
      </SvgText>
    </G>
  );
}

function TimeGrid({ axis, top, bottom, palette }: { axis: TimeAxis; top: number; bottom: number; palette: ChartPalette }) {
  return (
    <G>
      {axis.ticks.map((t) => (
        <Line key={t.ms} x1={axis.x(t.ms)} x2={axis.x(t.ms)} y1={top} y2={bottom} stroke={palette.grid} strokeWidth={1} />
      ))}
    </G>
  );
}

function TimeTicks({ axis, y, palette }: { axis: TimeAxis; y: number; palette: ChartPalette }) {
  return (
    <G>
      {axis.ticks.map((t) => (
        <SvgText key={t.ms} x={axis.x(t.ms)} y={y} textAnchor="middle" fontSize={SMALL} fill={palette.muted}>
          {t.label}
        </SvgText>
      ))}
    </G>
  );
}

/** Inline series labels, each behind a sample of its own stroke. */
function EndLabels({ x, labels, palette }: { x: number; labels: EndLabel[]; palette: ChartPalette }) {
  return (
    <G>
      {labels.map(({ key, text, y, stroke, strokeWidth, dash, opacity }) => {
        const swatchRight = x - approxTextWidth(text, SMALL) - 4;
        return (
          <G key={key}>
            <Line x1={swatchRight - 14} x2={swatchRight} y1={y - 3} y2={y - 3} stroke={stroke} strokeWidth={strokeWidth} strokeDasharray={dash} strokeLinecap="round" opacity={opacity} />
            <SvgText x={x} y={y} textAnchor="end" fontSize={SMALL} fill={palette.muted}>
              {text}
            </SvgText>
          </G>
        );
      })}
    </G>
  );
}

/** Invisible hour columns: tapping one names its figures. */
function HourTargets({ axis, tMs, top, height, onPress }: { axis: TimeAxis; tMs: number[]; top: number; height: number; onPress: (i: number) => void }) {
  return (
    <G>
      {tMs.map((t, i) => (
        <Rect key={t} x={axis.x(t)} width={Math.max(0, axis.x(t + HOUR_MS) - axis.x(t))} y={top} height={height} fill="transparent" onPress={() => onPress(i)} />
      ))}
    </G>
  );
}

interface ChartProps {
  W: number;
  hours: WeatherHour[];
  axis: TimeAxis;
  tz: string | undefined;
  palette: ChartPalette;
  onReadout: (text: string) => void;
}

function WindChart({ W, hours, weather, axis, tz, prefs, palette, onReadout }: ChartProps & { weather: TaskWeather; prefs: UnitPreferences }) {
  const H = HEAD + 162;
  const LANE_Y = HEAD + 14;
  const PLOT = { top: HEAD + 32, bottom: H - 26 };
  const wind = unitDisplay('km/h', prefs);
  const alt = unitDisplay('m', prefs);
  const terrainM = weather.resolved.elevationM ?? weather.source.pointElevationM;
  const points = hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    const level = flyingHeightLevel(h.levels, terrainM);
    return {
      tMs,
      cx: axis.x(tMs + HOUR_MS / 2),
      levelSpeed: level?.windSpeedKmh != null ? level.windSpeedKmh * wind.factor : null,
      levelDir: level?.windDirectionDeg ?? null,
      levelHeightM: level?.heightM ?? null,
      surfaceSpeed: h.surface.windSpeedKmh != null ? h.surface.windSpeedKmh * wind.factor : null,
      surfaceDir: h.surface.windDirectionDeg,
      gust: h.surface.windGustKmh != null ? h.surface.windGustKmh * wind.factor : null,
    };
  });
  const hasLevels = points.some((p) => p.levelSpeed !== null);
  const speeds = points.flatMap((p) => [p.levelSpeed, p.surfaceSpeed, p.gust].filter((v): v is number => v !== null));
  if (speeds.length === 0) return null;
  const yMax = Math.max(5 * wind.factor, ...speeds) * 1.08;
  const y = linearScale([0, yMax], [PLOT.bottom, PLOT.top]);
  const yTicks = niceTicks([0, yMax], 3);
  const heights = points.map((p) => p.levelHeightM).filter((v): v is number => v !== null);
  const levelLabel = heights.length > 0 ? `~${Math.round((heights.reduce((a, b) => a + b, 0) / heights.length) * alt.factor)} ${alt.unit}` : null;
  const level: Stroke = { stroke: palette.wind, strokeWidth: 2 };
  const surface: Stroke = { stroke: palette.wind, strokeWidth: 1.5, dash: '3 2', opacity: 0.75 };
  const band: [number, number] = [PLOT.top + 8, PLOT.bottom - 3];
  const clamp = (v: number) => Math.min(band[1], Math.max(band[0], v));
  const last = points[points.length - 1];
  const labels: EndLabel[] = [];
  if (hasLevels && last.levelSpeed !== null && last.surfaceSpeed !== null) {
    const [a, b] = separateLabels(y(last.levelSpeed) - 5, y(last.surfaceSpeed) + 11, band);
    labels.push({ key: 'level', text: `flying height ${levelLabel}`, y: a, ...level }, { key: 'surface', text: 'surface (10 m)', y: b, ...surface });
  } else if (hasLevels && last.levelSpeed !== null) {
    labels.push({ key: 'level', text: `flying height ${levelLabel}`, y: clamp(y(last.levelSpeed) - 5), ...level });
  } else if (last.surfaceSpeed !== null) {
    labels.push({ key: 'surface', text: 'surface (10 m)', y: clamp(y(last.surfaceSpeed) + 11), ...surface });
  }
  const readout = (i: number) => {
    const p = points[i];
    const parts: string[] = [];
    if (p.levelSpeed !== null && p.levelDir !== null)
      parts.push(`${p.levelSpeed.toFixed(0)} ${wind.unit} from ${Math.round(p.levelDir)}° (${degToCompass(p.levelDir)}) at ${levelLabel ?? 'flying height'}`);
    if (p.surfaceSpeed !== null && p.surfaceDir !== null)
      parts.push(`surface ${p.surfaceSpeed.toFixed(0)} ${wind.unit} from ${Math.round(p.surfaceDir)}° (${degToCompass(p.surfaceDir)})`);
    if (p.gust !== null) parts.push(`gusting ${p.gust.toFixed(0)} ${wind.unit}`);
    return `${when(p.tMs, tz)} — ${parts.join(', ')}`;
  };
  return (
    <Svg
      width={W}
      height={H}
      accessible
      accessibilityLabel={
        `Modelled wind by hour across ${points.length} hour${points.length === 1 ? '' : 's'}: ` +
        (hasLevels
          ? `wind at flying height (${levelLabel}) with the 10 metre surface wind beneath it. `
          : '10 metre surface wind only — this dataset carries no upper-level wind. ') +
        sourceSentence(weather.source)
      }>
      <Heading title="Weather: wind" source={weather.source} palette={palette} />
      <TimeGrid axis={axis} top={PLOT.top} bottom={PLOT.bottom} palette={palette} />
      {yTicks.map((t) => (
        <G key={t}>
          <Line x1={LEFT} x2={W - RIGHT_PAD} y1={y(t)} y2={y(t)} stroke={palette.grid} strokeWidth={1} />
          <SvgText x={LEFT - 6} y={y(t) + 3} textAnchor="end" fontSize={SMALL} fill={palette.muted}>
            {`${Math.round(t)} ${wind.unit}`}
          </SvgText>
        </G>
      ))}
      <SvgText x={LEFT - 6} y={LANE_Y + 3} textAnchor="end" fontSize={SMALL - 1} fill={palette.muted}>
        {hasLevels ? 'direction' : 'sfc dir'}
      </SvgText>
      <Path d={linePath(points, (i) => points[i].surfaceSpeed, y)} fill="none" stroke={surface.stroke} strokeWidth={surface.strokeWidth} strokeDasharray={surface.dash} strokeLinejoin="round" strokeLinecap="round" opacity={surface.opacity} />
      {hasLevels ? (
        <Path d={linePath(points, (i) => points[i].levelSpeed, y)} fill="none" stroke={level.stroke} strokeWidth={level.strokeWidth} strokeLinejoin="round" strokeLinecap="round" />
      ) : null}
      <EndLabels x={W - RIGHT_PAD - 2} labels={labels} palette={palette} />
      {points.map((p) => {
        const dir = hasLevels ? p.levelDir : p.surfaceDir;
        return dir === null ? null : (
          <Path key={p.tMs} d={windArrowPath(13)} transform={windArrowTransform(p.cx, LANE_Y, dir)} fill="none" stroke={palette.wind} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" opacity={0.85} />
        );
      })}
      <HourTargets axis={axis} tMs={points.map((p) => p.tMs)} top={0} height={PLOT.bottom} onPress={(i) => onReadout(readout(i))} />
      <TimeTicks axis={axis} y={H - 10} palette={palette} />
    </Svg>
  );
}

const CLOUD_LAYERS = [
  { key: 'lowPct', label: 'low' },
  { key: 'midPct', label: 'mid' },
  { key: 'highPct', label: 'high' },
] as const;

function SkyChart({ W, hours, source, axis, tz, palette, onReadout }: ChartProps & { source: WeatherSource }) {
  const H = HEAD + 96;
  const LANE_TOP = HEAD + 10;
  const LANE_H = 18;
  const GAP = 2;
  const cells = hours.map((h) => ({ tMs: new Date(h.t).getTime(), cloud: h.cloud, rainMm: h.precipitationMm }));
  if (!cells.some((c) => CLOUD_LAYERS.some(({ key }) => c.cloud[key] !== null))) return null;
  // High at the top, as the sky is stacked.
  const lanes = [...CLOUD_LAYERS].reverse();
  const laneY = (i: number) => LANE_TOP + i * (LANE_H + GAP);
  const peakLow = Math.max(0, ...cells.map((c) => c.cloud.lowPct ?? 0));
  const readout = (i: number) => {
    const c = cells[i];
    const parts = CLOUD_LAYERS.filter(({ key }) => c.cloud[key] !== null).map(({ key, label }) => `${label} ${Math.round(c.cloud[key]!)}%`);
    const rain = c.rainMm && c.rainMm > 0 ? `, rain ${c.rainMm.toFixed(1)} mm` : '';
    return `${when(c.tMs, tz)} — cloud cover ${parts.join(', ')}${rain}`;
  };
  return (
    <Svg
      width={W}
      height={H}
      accessible
      accessibilityLabel={
        `Cloud cover by hour in three layers — high, mid and low, top to bottom — across ${cells.length} hour${cells.length === 1 ? '' : 's'}; darker means more cover. ` +
        `Low cloud peaks at ${Math.round(peakLow)} percent. ${sourceSentence(source)}`
      }>
      <Heading title="Weather: cloud" source={source} palette={palette} />
      {lanes.map(({ key, label }, i) => (
        <G key={key}>
          <SvgText x={LEFT - 6} y={laneY(i) + LANE_H / 2 + 3} textAnchor="end" fontSize={SMALL - 1} fill={palette.muted}>
            {label}
          </SvgText>
          <Rect x={LEFT} y={laneY(i)} width={W - RIGHT_PAD - LEFT} height={LANE_H} fill={palette.bed} />
          {cells.map((c) => {
            const pct = c.cloud[key];
            if (pct === null) return null;
            const x0 = axis.x(c.tMs);
            return <Rect key={c.tMs} x={x0} y={laneY(i)} width={Math.max(0, axis.x(c.tMs + HOUR_MS) - x0)} height={LANE_H} fill={palette.accent} opacity={coverOpacity(pct)} />;
          })}
        </G>
      ))}
      {cells.map((c) =>
        c.rainMm && c.rainMm > 0 ? (
          <SvgText key={`r${c.tMs}`} x={axis.x(c.tMs + HOUR_MS / 2)} y={laneY(3) + 8} textAnchor="middle" fontSize={SMALL - 1} fill={palette.muted}>
            ▾
          </SvgText>
        ) : null,
      )}
      <HourTargets axis={axis} tMs={cells.map((c) => c.tMs)} top={LANE_TOP} height={LANE_H * 3 + GAP * 2 + 10} onPress={(i) => onReadout(readout(i))} />
      <TimeTicks axis={axis} y={H - 8} palette={palette} />
    </Svg>
  );
}

function ThermalChart({ W, hours, source, axis, tz, prefs, palette, onReadout }: ChartProps & { source: WeatherSource; prefs: UnitPreferences }) {
  const H = HEAD + 160;
  const PLOT = { top: HEAD + 18, bottom: H - 26 };
  const alt = unitDisplay('m', prefs);
  const points = hours.map((h) => {
    const tMs = new Date(h.t).getTime();
    return {
      tMs,
      cx: axis.x(tMs + HOUR_MS / 2),
      blTop: h.boundaryLayerDepthM != null ? h.boundaryLayerDepthM * alt.factor : null,
      base: h.cloudBaseAglM != null ? h.cloudBaseAglM * alt.factor : null,
      capeJkg: h.capeJkg,
    };
  });
  const values = points.flatMap((p) => [p.blTop, p.base].filter((v): v is number => v !== null));
  if (values.length === 0) return null;
  const yMax = Math.max(...values) * 1.1;
  const y = linearScale([0, yMax], [PLOT.bottom, PLOT.top]);
  const yTicks = niceTicks([0, yMax], 3);
  const band: [number, number] = [PLOT.top + 8, PLOT.bottom - 3];
  const clamp = (v: number) => Math.min(band[1], Math.max(band[0], v));
  const ceiling = (p: (typeof points)[number]) => usableCeilingM(p.blTop, p.base);
  // The usable band, floor to whichever ceiling is lower that hour, in runs.
  const runs: (typeof points)[] = [];
  let run: typeof points = [];
  for (const p of points) {
    if (ceiling(p) === null) {
      if (run.length > 1) runs.push(run);
      run = [];
    } else run.push(p);
  }
  if (run.length > 1) runs.push(run);
  const hasBase = points.some((p) => p.base !== null);
  const hasBl = points.some((p) => p.blTop !== null);
  const missingNote = hasBl
    ? null
    : source.variables.includes('boundary_layer')
      ? 'no thermal top in these hours'
      : 'no thermal top — this dataset carries no boundary-layer height';
  const bl: Stroke = { stroke: palette.baro, strokeWidth: 2 };
  const base: Stroke = { stroke: palette.cloudBase, strokeWidth: 1.75, dash: '5 3' };
  const last = points[points.length - 1];
  const labels: EndLabel[] = [];
  if (hasBl && last.blTop !== null && hasBase && last.base !== null) {
    const [a, b] = separateLabels(y(last.blTop) - 5, y(last.base) + 11, band);
    labels.push({ key: 'bl', text: 'thermal top', y: a, ...bl }, { key: 'base', text: 'cloud base', y: b, ...base });
  } else if (hasBl && last.blTop !== null) {
    labels.push({ key: 'bl', text: 'thermal top', y: clamp(y(last.blTop) - 5), ...bl });
  } else if (hasBase && last.base !== null) {
    labels.push({ key: 'base', text: 'cloud base', y: clamp(y(last.base) + 11), ...base });
  }
  const readout = (i: number) => {
    const p = points[i];
    const parts: string[] = [];
    if (p.blTop !== null) parts.push(`thermal top ${p.blTop.toFixed(0)} ${alt.unit} AGL`);
    if (p.base !== null) parts.push(`cloud base ${p.base.toFixed(0)} ${alt.unit} AGL`);
    if (p.base !== null && p.blTop !== null) parts.push(p.base > p.blTop ? 'blue' : 'cumulus');
    if (p.capeJkg !== null) parts.push(`CAPE ${Math.round(p.capeJkg)} J/kg`);
    return `${when(p.tMs, tz)} — ${parts.join(', ')}`;
  };
  return (
    <Svg
      width={W}
      height={H}
      accessible
      accessibilityLabel={
        'Modelled thermal ceiling by hour above ground level: ' +
        [hasBl ? 'the top of the mixed layer' : null, hasBase ? 'the condensation level (cloud base)' : null].filter(Boolean).join(' and ') +
        `, peaking at ${Math.max(...values).toFixed(0)} ${alt.unit}. ` +
        (missingNote ? `${missingNote}. ` : '') +
        sourceSentence(source)
      }>
      <Heading title="Weather: height" source={source} palette={palette} />
      {missingNote ? (
        <SvgText x={LEFT - 40} y={HEAD + 8} fontSize={SMALL - 1} fill={palette.muted}>
          {missingNote}
        </SvgText>
      ) : null}
      <TimeGrid axis={axis} top={PLOT.top} bottom={PLOT.bottom} palette={palette} />
      {yTicks.map((t) => (
        <G key={t}>
          <Line x1={LEFT} x2={W - RIGHT_PAD} y1={y(t)} y2={y(t)} stroke={palette.grid} strokeWidth={1} />
          <SvgText x={LEFT - 6} y={y(t) + 3} textAnchor="end" fontSize={SMALL} fill={palette.muted}>
            {`${Math.round(t)} ${alt.unit}`}
          </SvgText>
        </G>
      ))}
      {runs.map((r) => (
        <Path
          key={`band${r[0].tMs}`}
          d={
            r.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.cx.toFixed(1)},${y(ceiling(p)!).toFixed(1)}`).join('') +
            `L${r[r.length - 1].cx.toFixed(1)},${y(0).toFixed(1)}L${r[0].cx.toFixed(1)},${y(0).toFixed(1)}Z`
          }
          fill={palette.baro}
          opacity={0.13}
        />
      ))}
      {hasBl ? <Path d={linePath(points, (i) => points[i].blTop, y)} fill="none" stroke={bl.stroke} strokeWidth={bl.strokeWidth} strokeLinejoin="round" strokeLinecap="round" /> : null}
      {hasBase ? (
        <Path d={linePath(points, (i) => points[i].base, y)} fill="none" stroke={base.stroke} strokeWidth={base.strokeWidth} strokeDasharray={base.dash} strokeLinejoin="round" strokeLinecap="round" />
      ) : null}
      <EndLabels x={W - RIGHT_PAD - 2} labels={labels} palette={palette} />
      <HourTargets axis={axis} tMs={points.map((p) => p.tMs)} top={0} height={PLOT.bottom} onPress={(i) => onReadout(readout(i))} />
      <TimeTicks axis={axis} y={H - 10} palette={palette} />
    </Svg>
  );
}
