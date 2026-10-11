/**
 * What the altitude cleaning pass did to THIS pilot's track, drawn — the
 * website's charts/TrackCleaningChart.tsx: raw GPS, raw barometer and the
 * cleaned line the analysis used, over time, with every repair shaded.
 *
 * Report-card rule (d): a channel the file doesn't carry is named in the
 * legend, never drawn as a flat line at 0, and the y domain always covers the
 * RAW excursion — how far off the fix was is the whole finding, so it is never
 * clipped off the frame. The frame, the decimation that keeps the glitches,
 * and the band geometry are the website's own (`@glidecomp/client/track-cleaning`).
 *
 * The list on the screen around it is the exact record and the chart's
 * controls; tapping a shaded band here is a shortcut to the same thing.
 */
import { extent, linearScale, niceTicks } from '@glidecomp/client/chart-scale';
import { formatTimeInZone } from '@glidecomp/client/time';
import {
  bandRect,
  channelHealth,
  decimateSeries,
  lowerBound,
  zoomWindow,
  type CleaningRange,
  type Point,
} from '@glidecomp/client/track-cleaning';
import { fixAltitude, formatAltitude, type IGCFix, type UnitPreferences } from '@glidecomp/engine';
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import Svg, { G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { CHART_FONT, useChartPalette } from './palette';
import { chartStyles } from './styles';
import { useWidth } from './use-width';

const PLOT_H = 172;
const BAND_PAD_MS = 1500;
const MIN_BAND = 2.5;
/** A finger, not a mouse: the invisible target behind a hairline band. */
const MIN_HIT = 24;

function margins(fontSize: number) {
  return {
    top: Math.round(fontSize * 1.15 + 3),
    right: 10,
    bottom: Math.round(fontSize * 2.0 + 4),
    left: Math.round(fontSize * 0.54 * 5 + fontSize * 0.6 + 6),
  };
}

function svgPath(points: Point[], x: (v: number) => number, y: (v: number) => number): string {
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join('');
}

export function TrackCleaningChart({
  fixes,
  ranges,
  selected,
  timeZone,
  prefs,
  onSelectRange,
}: {
  fixes: IGCFix[];
  ranges: CleaningRange[];
  selected: number | null;
  timeZone: string | null;
  prefs: UnitPreferences;
  onSelectRange: (index: number | null) => void;
}) {
  const palette = useChartPalette();
  const [W, onLayout] = useWidth();
  const { gnssAlive, baroAlive } = useMemo(() => channelHealth(fixes), [fixes]);
  const fontSize = CHART_FONT;
  const margin = margins(fontSize);
  const plotUnits = Math.max(1, W - margin.left - margin.right);

  const view = useMemo(() => {
    if (fixes.length < 2 || W === 0) return null;
    const flight: [number, number] = [fixes[0].time.getTime(), fixes[fixes.length - 1].time.getTime()];
    const range = selected != null ? ranges[selected] : undefined;
    const [t0, t1] = range ? zoomWindow(range, flight) : flight;
    if (t1 <= t0) return null;
    const from = Math.max(0, lowerBound(fixes, t0) - 1);
    const to = Math.min(fixes.length, lowerBound(fixes, t1) + 1);
    const slice = fixes.slice(from, to);
    if (slice.length < 2 || (!gnssAlive && !baroAlive)) return null;
    const at = (f: IGCFix, v: number): Point => [f.time.getTime(), v];
    const raw = gnssAlive ? slice.map((f) => at(f, f.gnssAltitude)) : [];
    const baro = baroAlive ? slice.map((f) => at(f, f.pressureAltitude)) : [];
    const cleaned = slice.map((f) => at(f, fixAltitude(f)));
    // The RAW excursions set the frame, not just the cleaned line (rule (d)).
    const yDomain = extent([...raw, ...baro, ...cleaned].map((p) => p[1]));
    if (!yDomain) return null;
    const pad = Math.max(20, (yDomain[1] - yDomain[0]) * 0.06);
    const buckets = Math.round(plotUnits);
    return {
      t0,
      t1,
      raw: decimateSeries(raw, buckets),
      baro: decimateSeries(baro, buckets),
      cleaned: decimateSeries(cleaned, buckets),
      yDomain: [yDomain[0] - pad, yDomain[1] + pad] as [number, number],
      bands: ranges.map((r, index) => ({ r, index })).filter(({ r }) => r.endTimeMs >= t0 && r.startTimeMs <= t1),
    };
  }, [fixes, ranges, selected, gnssAlive, baroAlive, W, plotUnits]);

  const time = (ms: number) => formatTimeInZone(new Date(ms), timeZone ?? undefined);
  const H = PLOT_H + margin.top + margin.bottom;
  const plot = { left: margin.left, right: W - margin.right, top: margin.top, bottom: H - margin.bottom };

  let body = null;
  let caption = '';
  if (view) {
    const x = linearScale([view.t0, view.t1], [plot.left, plot.right]);
    const y = linearScale(view.yDomain, [plot.bottom, plot.top]);
    const yTicks = niceTicks(view.yDomain, 4);
    const xTicks = [view.t0, (view.t0 + view.t1) / 2, view.t1];
    const range = selected != null ? ranges[selected] : null;
    caption = range
      ? `The repair at ${time(range.startTimeMs)}: ${range.fixCount} fix${range.fixCount === 1 ? '' : 'es'}, up to ${formatAltitude(range.maxCorrectionMeters, { prefs }).withUnit} off, with ${Math.round((view.t1 - view.t0) / 1000)} seconds of the flight around it.`
      : `The whole flight: ${ranges.length} repaired stretch${ranges.length === 1 ? '' : 'es'} shaded, between ${time(view.t0)} and ${time(view.t1)}.`;
    const channels = baroAlive
      ? 'Raw GPS altitude, raw barometric altitude and the cleaned line the analysis used.'
      : 'Raw GPS altitude and the cleaned line the analysis used — this file carries no barometric channel.';
    body = (
      <Svg width={W} height={H} accessible accessibilityLabel={`Altitude against time. ${channels} ${caption}`}>
        {yTicks.map((t) => (
          <Line key={`gy${t}`} x1={plot.left} x2={plot.right} y1={y(t)} y2={y(t)} stroke={palette.grid} strokeWidth={1} />
        ))}
        {view.bands.map(({ r, index }) => {
          const isSelected = index === selected;
          const band = bandRect(x(r.startTimeMs - BAND_PAD_MS), x(r.endTimeMs + BAND_PAD_MS), MIN_BAND, plot);
          const hit = bandRect(band.x, band.x + band.width, MIN_HIT, plot);
          return (
            <G key={r.startIndex} onPress={() => onSelectRange(isSelected ? null : index)}>
              <Rect x={hit.x} y={plot.top} width={hit.width} height={plot.bottom - plot.top} fill="transparent" />
              <Rect
                x={band.x}
                y={plot.top}
                width={band.width}
                height={plot.bottom - plot.top}
                fill={palette.cleaned}
                fillOpacity={isSelected ? 0.25 : 0.1}
                stroke={isSelected ? palette.cleaned : undefined}
                strokeOpacity={0.6}
              />
            </G>
          );
        })}
        {yTicks.map((t) => (
          <SvgText key={`ty${t}`} x={plot.left - fontSize * 0.6} y={y(t) + fontSize * 0.35} textAnchor="end" fontSize={fontSize} fill={palette.muted}>
            {formatAltitude(t, { prefs }).formatted}
          </SvgText>
        ))}
        <SvgText x={plot.left - fontSize * 0.6} y={plot.top - 4} textAnchor="end" fontSize={fontSize} fill={palette.muted}>
          {formatAltitude(0, { prefs }).unit}
        </SvgText>
        {xTicks.map((t, i) => (
          <SvgText
            key={`tx${t}`}
            x={x(t)}
            y={plot.bottom + fontSize * 1.5}
            textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}
            fontSize={fontSize}
            fill={palette.muted}>
            {time(t)}
          </SvgText>
        ))}
        {view.baro.length > 0 ? (
          <Path d={svgPath(view.baro, x, y)} fill="none" stroke={palette.baro} strokeWidth={1.5} strokeDasharray="1 3" strokeLinecap="round" />
        ) : null}
        {view.raw.length > 0 ? <Path d={svgPath(view.raw, x, y)} fill="none" stroke={palette.accent} strokeWidth={1.5} /> : null}
        <Path d={svgPath(view.cleaned, x, y)} fill="none" stroke={palette.cleaned} strokeWidth={2.5} strokeDasharray="6 3" />
      </Svg>
    );
  }

  // The legend's swatches repeat the lines' styles, so the series are told
  // apart without relying on hue.
  const swatch = (colour: string, dash?: string) => (
    <Svg width={16} height={4}>
      <Line x1={0} x2={16} y1={2} y2={2} stroke={colour} strokeWidth={2} strokeDasharray={dash} strokeLinecap={dash === '1 3' ? 'round' : 'butt'} />
    </Svg>
  );
  return (
    <View style={chartStyles.figure} onLayout={onLayout} testID="track-cleaning-chart">
      {body}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 16, rowGap: 4, marginTop: 4 }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        {gnssAlive ? <Legend swatch={swatch(palette.accent)} label="raw GPS" colour={palette.muted} /> : null}
        {baroAlive ? (
          <Legend swatch={swatch(palette.baro, '1 3')} label="raw barometer" colour={palette.muted} />
        ) : (
          <Text style={[chartStyles.caption, { color: palette.muted, marginTop: 0 }]}>no barometric channel in this file</Text>
        )}
        <Legend swatch={swatch(palette.cleaned, '6 3')} label="cleaned" colour={palette.muted} />
        <Legend
          swatch={<View style={{ width: 12, height: 12, backgroundColor: palette.cleaned, opacity: 0.25, borderWidth: 1, borderColor: palette.grid }} />}
          label="repaired"
          colour={palette.muted}
        />
      </View>
      {caption ? <Text style={[chartStyles.caption, { color: palette.muted }]}>{caption}</Text> : null}
    </View>
  );
}

function Legend({ swatch, label, colour }: { swatch: React.ReactNode; label: string; colour: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      {swatch}
      <Text style={{ fontSize: 12, color: colour }}>{label}</Text>
    </View>
  );
}
