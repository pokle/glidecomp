/**
 * One validity factor's curve, with the day's single point on it — the
 * website's charts/ValiditySparkline.tsx. Sparkline-sized beside the row it
 * explains: a validity factor is a fact about the TASK, so it is an
 * annotation on a number, not a chart to find yourself in. The row already
 * carries the exact percentage; the caption is the accessible label.
 */
import { linearScale } from '@glidecomp/client/chart-scale';
import type { ScoreValidityChart } from '@glidecomp/engine';
import Svg, { Circle, Line, Path } from 'react-native-svg';

import { useChartPalette } from './palette';

const W = 96;
const H = 30;
const PAD = 4;

export function ValiditySparkline({ chart }: { chart: ScoreValidityChart }) {
  const palette = useChartPalette();
  const { curve, point, caption } = chart;
  if (curve.length < 2) return null;
  // Fixed [0, 1] on both axes, so the shape compares between factors and days.
  const x = linearScale([0, 1], [PAD, W - PAD]);
  const y = linearScale([0, 1], [H - PAD, PAD]);
  const path = `M${curve.map((c) => `${x(c.x).toFixed(1)},${y(c.y).toFixed(1)}`).join('L')}`;
  return (
    <Svg width={W} height={H} accessible accessibilityLabel={caption} testID="validity-sparkline">
      <Line x1={x(point.x)} y1={y(point.y)} x2={x(point.x)} y2={H - PAD} stroke={palette.muted} strokeOpacity={0.4} strokeWidth={1} strokeDasharray="2 2" />
      <Line x1={PAD} y1={y(point.y)} x2={x(point.x)} y2={y(point.y)} stroke={palette.muted} strokeOpacity={0.4} strokeWidth={1} strokeDasharray="2 2" />
      <Path d={path} fill="none" stroke={palette.ink} strokeOpacity={0.7} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <Circle cx={x(point.x)} cy={y(point.y)} r={3} fill={palette.accent} stroke={palette.surface} strokeWidth={1} />
    </Svg>
  );
}
