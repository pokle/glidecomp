/**
 * How far the field got, one dot per pilot on a single lane, against the
 * minimum and nominal distances and the reader's own — the website's
 * charts/DistributionStrip.tsx. Dots rather than bins: where the field
 * bunched they overlap and darken, so "how many are near me" is answered by
 * looking. The caption states the reading and is the accessible label.
 */
import { linearScale, niceTicks } from '@glidecomp/client/chart-scale';
import type { ScoreDistributionChart } from '@glidecomp/engine';
import { Text, View } from 'react-native';
import Svg, { Circle, G, Line, Text as SvgText } from 'react-native-svg';

import { HaloText } from './halo-text';
import { CHART_FONT, useChartPalette } from './palette';
import { chartStyles } from './styles';
import { useWidth } from './use-width';

/** The website's layout, tuned at 10-unit type and scaled with the font. */
const TUNED_AT = 10;
const LANE_Y = 58;
const DOT_R = 3;
const LABEL_ROWS = [26, 12];
const TICK_LABEL_Y = 76;
const AXIS_TITLE_Y = 94;
const TUNED_H = 108;
const MARGIN = 14;
const labelWidth = (t: string, fontSize: number) => t.length * 0.54 * fontSize;

export function DistributionStrip({ chart }: { chart: ScoreDistributionChart }) {
  const palette = useChartPalette();
  const [W, onLayout] = useWidth();
  const { points, markers, xLabel, caption } = chart;
  if (points.length === 0) return null;

  const fontSize = CHART_FONT;
  const k = fontSize / TUNED_AT;
  const laneY = LANE_Y * k;
  const dotR = DOT_R * k;
  const labelRows = LABEL_ROWS.map((v) => v * k);
  const H = TUNED_H * k;
  const plot = { left: MARGIN, right: W - MARGIN };
  const xMax = Math.max(...points.map((p) => p.x), ...markers.map((m) => m.x));
  const x = linearScale([0, xMax || 1], [plot.left + dotR, plot.right - dotR]);
  const ticks = niceTicks([0, xMax || 1], 4);

  // Marker labels on two rows, the reader's own placed first so it is never
  // the one bumped: on a devalued day the best distance sits right on the
  // nominal one, which is exactly why the day was devalued.
  const rowEnds = labelRows.map(() => -Infinity);
  const placed = [...markers]
    .sort((a, b) => (b.you ? 1 : 0) - (a.you ? 1 : 0))
    .map((m) => {
      const half = labelWidth(m.label, fontSize) / 2;
      const labelX = Math.min(W - half - 2, Math.max(half + 2, x(m.x)));
      let row = labelRows.findIndex((_, i) => labelX - half > rowEnds[i] + 4);
      if (row < 0) row = labelRows.length - 1;
      rowEnds[row] = Math.max(rowEnds[row], labelX + half);
      return { ...m, labelX, labelY: labelRows[row] };
    });

  return (
    <View style={chartStyles.figure} onLayout={onLayout} testID="distribution-strip">
      {W > 0 ? (
        <Svg width={W} height={H} accessible accessibilityLabel={caption}>
          <Line x1={plot.left} x2={plot.right} y1={laneY} y2={laneY} stroke={palette.grid} strokeWidth={1} />
          {placed.map((m) => (
            <G key={m.label}>
              <Line
                x1={x(m.x)}
                x2={x(m.x)}
                y1={m.labelY + fontSize * 0.4}
                y2={laneY + fontSize * 1.2}
                stroke={m.you ? palette.accent : palette.muted}
                strokeOpacity={m.you ? 1 : 0.6}
                strokeWidth={m.you ? 2 : 1}
                strokeDasharray={m.you ? undefined : '3 3'}
              />
              <HaloText
                x={m.labelX}
                y={m.labelY}
                fontSize={fontSize}
                fill={m.you ? palette.ink : palette.muted}
                fontWeight={m.you ? '600' : 'normal'}
                halo={palette.surface}>
                {m.label}
              </HaloText>
            </G>
          ))}
          {points.map((p) =>
            p.you ? null : <Circle key={p.key} cx={x(p.x)} cy={laneY} r={dotR} fill={palette.ink} fillOpacity={0.3} />,
          )}
          {points
            .filter((p) => p.you)
            .map((p) => (
              <Circle key={p.key} cx={x(p.x)} cy={laneY} r={dotR + 2 * k} fill={palette.accent} stroke={palette.surface} strokeWidth={2} />
            ))}
          {ticks.map((t) => (
            <G key={t}>
              <Line x1={x(t)} x2={x(t)} y1={laneY + fontSize * 0.8} y2={laneY + fontSize * 1.2} stroke={palette.grid} strokeWidth={1} />
              <SvgText x={x(t)} y={TICK_LABEL_Y * k} textAnchor="middle" fontSize={fontSize} fill={palette.muted}>
                {String(Math.round(t / 1000))}
              </SvgText>
            </G>
          ))}
          <SvgText x={(plot.left + plot.right) / 2} y={AXIS_TITLE_Y * k} textAnchor="middle" fontSize={fontSize} fill={palette.muted}>
            {`${xLabel} (km)`}
          </SvgText>
        </Svg>
      ) : null}
      <Text style={[chartStyles.caption, { color: palette.muted }]}>{caption}</Text>
    </View>
  );
}
