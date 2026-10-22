/**
 * The day profile (stage 8): what the tracks say the day did, on ONE time
 * axis — climb by the hour (median, with the middle half of the field as a
 * band), wind by the hour, and a lane of the day's moments (start gates,
 * takeoffs, the best hour). The website's DayProfilePanel, drawn natively;
 * the tables under it stay the exact reading.
 *
 * Series are the engine's `ReportSeries`, a discriminated union: a kind this
 * chart does not know is ignored, never a crash (an older app in front of a
 * newer engine degrades to the tables). The axis ticks on the competition's
 * wall-clock hours (`@glidecomp/client/time-axis`), as the weather charts do.
 */
import { linearScale, niceTicks } from '@glidecomp/client/chart-scale';
import { zoneAbbrev } from '@glidecomp/client/time';
import { buildTimeAxis, type TimeAxis } from '@glidecomp/client/time-axis';
import { unitDisplay } from '@glidecomp/client/units';
import type { ClimbHourlySeries, DayTimingSeries, ReportSeries, UnitPreferences, WindHourlySeries } from '@glidecomp/engine';
import { useMemo } from 'react';
import { Text, View } from 'react-native';
import Svg, { G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { useChartPalette, type ChartPalette } from './palette';
import { chartStyles } from './styles';
import { useWidth } from './use-width';

const HOUR_MS = 3_600_000;
const LEFT = 48;
const RIGHT = 22;
const SMALL = 10;
const PLOT_H = 110;
const HEAD = 18;

const ms = (iso: string | null | undefined) => (iso ? new Date(iso).getTime() : NaN);

/** The series this chart draws, picked out of a family's metrics by kind. */
export function daySeries(series: readonly ReportSeries[]) {
  let climb: ClimbHourlySeries | null = null;
  let wind: WindHourlySeries | null = null;
  let timing: DayTimingSeries | null = null;
  for (const s of series) {
    switch (s.kind) {
      case 'climb-hourly':
        climb ??= s;
        break;
      case 'wind-hourly':
        wind ??= s;
        break;
      case 'day-timing':
        timing ??= s;
        break;
      default:
        // Horserace, waterfall, wind legs, and any kind added later: their
        // tables carry them.
        break;
    }
  }
  return { climb, wind, timing };
}

export function DayProfileChart({ series, timeZone, prefs }: { series: readonly ReportSeries[]; timeZone: string | null; prefs: UnitPreferences }) {
  const palette = useChartPalette();
  const [W, onLayout] = useWidth();
  const tz = timeZone ?? undefined;
  const { climb, wind, timing } = useMemo(() => daySeries(series), [series]);
  const instants = useMemo(() => {
    const out: number[] = [];
    for (const h of climb?.hours ?? []) out.push(ms(h.t), ms(h.t) + HOUR_MS);
    for (const h of wind?.hours ?? []) out.push(ms(h.t), ms(h.t) + HOUR_MS);
    if (timing) {
      out.push(...timing.takeoffs.map(ms), ...timing.startGates.map(ms), ms(timing.launchOpen), ms(timing.deadline));
      if (timing.bestHour) out.push(ms(timing.bestHour.from), ms(timing.bestHour.to));
    }
    return out.filter(Number.isFinite);
  }, [climb, wind, timing]);
  const axis = useMemo(() => (W > 0 ? buildTimeAxis(instants, tz, [LEFT, W - RIGHT]) : null), [instants, tz, W]);
  if (!climb && !wind && !timing) return null;
  return (
    <View onLayout={onLayout} testID="day-profile">
      {axis ? (
        <>
          {climb && climb.hours.length > 0 ? <ClimbChart W={W} s={climb} axis={axis} prefs={prefs} palette={palette} /> : null}
          {wind && wind.hours.length > 0 ? <WindChart W={W} s={wind} axis={axis} prefs={prefs} palette={palette} /> : null}
          {timing ? <TimingLane W={W} s={timing} axis={axis} palette={palette} /> : null}
          <Text style={[chartStyles.caption, { color: palette.muted, textAlign: 'center' }]}>
            {`time of day (${zoneAbbrev(new Date(axis.domainStart), tz)}) · one axis for every chart`}
          </Text>
        </>
      ) : null}
    </View>
  );
}

function Grid({ axis, top, bottom, palette, labels }: { axis: TimeAxis; top: number; bottom: number; palette: ChartPalette; labels?: boolean }) {
  return (
    <G>
      {axis.ticks.map((t) => (
        <G key={t.ms}>
          <Line x1={axis.x(t.ms)} x2={axis.x(t.ms)} y1={top} y2={bottom} stroke={palette.grid} strokeWidth={1} />
          {labels ? (
            <SvgText x={axis.x(t.ms)} y={bottom + 12} textAnchor="middle" fontSize={SMALL} fill={palette.muted}>
              {t.label}
            </SvgText>
          ) : null}
        </G>
      ))}
    </G>
  );
}

function YAxis({ ticks, y, palette, unit }: { ticks: number[]; y: (v: number) => number; palette: ChartPalette; unit: string }) {
  return (
    <G>
      {ticks.map((v) => (
        <SvgText key={v} x={LEFT - 6} y={y(v) + 3} textAnchor="end" fontSize={SMALL} fill={palette.muted}>
          {`${Number.isInteger(v) ? v : v.toFixed(1)}`}
        </SvgText>
      ))}
      <SvgText x={4} y={HEAD - 6} fontSize={SMALL} fill={palette.muted}>
        {unit}
      </SvgText>
    </G>
  );
}

function ClimbChart({ W, s, axis, prefs, palette }: { W: number; s: ClimbHourlySeries; axis: TimeAxis; prefs: UnitPreferences; palette: ChartPalette }) {
  const conv = unitDisplay('m/s', prefs);
  const pts = s.hours.map((h) => ({ x: axis.x(ms(h.t) + HOUR_MS / 2), lo: h.p25 * conv.factor, mid: h.median * conv.factor, hi: h.p75 * conv.factor }));
  const max = Math.max(0.5, ...pts.map((p) => p.hi));
  const ticks = niceTicks([0, max], 3);
  const top = ticks[ticks.length - 1] ?? max;
  const y = linearScale([0, top], [HEAD + PLOT_H, HEAD]);
  const band = pts.length > 0 ? `M${pts.map((p) => `${p.x},${y(p.hi)}`).join('L')}L${[...pts].reverse().map((p) => `${p.x},${y(p.lo)}`).join('L')}Z` : '';
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${y(p.mid).toFixed(1)}`).join('');
  return (
    <Svg width={W} height={HEAD + PLOT_H + 18} accessibilityLabel={`${s.title}: median climb by the hour, with the middle half of the field. The table below has the figures.`}>
      <SvgText x={LEFT} y={12} fontSize={11} fontWeight="600" fill={palette.muted}>
        {s.title}
      </SvgText>
      <Grid axis={axis} top={HEAD} bottom={HEAD + PLOT_H} palette={palette} labels />
      <YAxis ticks={ticks} y={y} palette={palette} unit={conv.unit} />
      <Path d={band} fill={palette.cleaned} opacity={0.18} />
      <Path d={line} stroke={palette.cleaned} strokeWidth={2} fill="none" />
    </Svg>
  );
}

function WindChart({ W, s, axis, prefs, palette }: { W: number; s: WindHourlySeries; axis: TimeAxis; prefs: UnitPreferences; palette: ChartPalette }) {
  const conv = unitDisplay('km/h', prefs);
  const pts = s.hours.map((h) => ({ x: axis.x(ms(h.t) + HOUR_MS / 2), v: h.speedKmh * conv.factor }));
  const max = Math.max(5, ...pts.map((p) => p.v));
  const ticks = niceTicks([0, max], 3);
  const top = ticks[ticks.length - 1] ?? max;
  const y = linearScale([0, top], [HEAD + PLOT_H, HEAD]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${y(p.v).toFixed(1)}`).join('');
  return (
    <Svg width={W} height={HEAD + PLOT_H + 18} accessibilityLabel={`${s.title}: wind speed by the hour, from the pilots' circles. The table below has the figures.`}>
      <SvgText x={LEFT} y={12} fontSize={11} fontWeight="600" fill={palette.muted}>
        {s.title}
      </SvgText>
      <Grid axis={axis} top={HEAD} bottom={HEAD + PLOT_H} palette={palette} labels />
      <YAxis ticks={ticks} y={y} palette={palette} unit={conv.unit} />
      <Path d={line} stroke={palette.wind} strokeWidth={2} fill="none" />
    </Svg>
  );
}

function TimingLane({ W, s, axis, palette }: { W: number; s: DayTimingSeries; axis: TimeAxis; palette: ChartPalette }) {
  const H = 44;
  const best = s.bestHour ? { x0: axis.x(ms(s.bestHour.from)), x1: axis.x(ms(s.bestHour.to)) } : null;
  return (
    <Svg width={W} height={H + 16} accessibilityLabel="The day's moments: launch open, start gates, takeoffs and the best hour. The table below has the times.">
      <SvgText x={LEFT} y={10} fontSize={11} fontWeight="600" fill={palette.muted}>
        The day’s moments
      </SvgText>
      <Rect x={LEFT} y={16} width={Math.max(0, W - LEFT - RIGHT)} height={H - 16} fill={palette.bed} />
      {best ? <Rect x={best.x0} y={16} width={Math.max(2, best.x1 - best.x0)} height={H - 16} fill={palette.cleaned} opacity={0.3} /> : null}
      {s.takeoffs.map((t, i) => (
        <Line key={`t${i}`} x1={axis.x(ms(t))} x2={axis.x(ms(t))} y1={H - 10} y2={H} stroke={palette.muted} strokeWidth={1} />
      ))}
      {s.startGates.map((t, i) => (
        <Line key={`g${i}`} x1={axis.x(ms(t))} x2={axis.x(ms(t))} y1={16} y2={H} stroke={palette.accent} strokeWidth={2} />
      ))}
      {s.launchOpen ? <Line x1={axis.x(ms(s.launchOpen))} x2={axis.x(ms(s.launchOpen))} y1={16} y2={H} stroke={palette.ink} strokeWidth={1} strokeDasharray="3 3" /> : null}
      {s.deadline ? <Line x1={axis.x(ms(s.deadline))} x2={axis.x(ms(s.deadline))} y1={16} y2={H} stroke={palette.warning} strokeWidth={2} /> : null}
      <SvgText x={LEFT} y={H + 12} fontSize={SMALL} fill={palette.muted}>
        {`blue: gates · ticks: takeoffs · green: best hour${s.deadline ? ' · orange: deadline' : ''}`}
      </SvgText>
    </Svg>
  );
}
