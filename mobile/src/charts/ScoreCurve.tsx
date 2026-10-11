/**
 * A scoring component's formula, with the field on it and one pilot picked
 * out — the website's charts/ScoreCurve.tsx, drawn natively.
 *
 * An EMPHASIS chart (report-card rule (c)): exactly one dot is the reason the
 * reader is here, in the accent with a ring; everyone else is context in muted
 * ink. The curve is the scorer's own function, sampled in the engine, and every
 * dot has been checked to sit on it — so it is always drawn and never called a
 * fit. Which pilots are named, and where, is the website's own placement
 * (`@glidecomp/client/score-curve-layout`).
 *
 * Touch replaces hover: tapping a dot names it on the readout line. The
 * caption states the reading in words and is the chart's accessible label;
 * the section's rows above remain the exact numbers.
 */
import { extent, linearScale, niceTicks } from '@glidecomp/client/chart-scale';
import { curvePilotLabel, formatChartX, placeCurveLabels } from '@glidecomp/client/score-curve-layout';
import type { ScoreChartPilot, ScoreCurveChart } from '@glidecomp/engine';
import { useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';

import { CHART_FONT, useChartPalette } from './palette';
import { HaloText } from './halo-text';
import { useWidth } from './use-width';
import { chartStyles } from './styles';

const PLOT_H = 168;

/** Margins sized for the type, as the website's chartMargins are. */
function margins(fontSize: number) {
  return {
    top: Math.round(fontSize * 1.15 + 3),
    right: Math.round(fontSize * 1.6),
    bottom: Math.round(fontSize * 2.95 + 2),
    left: Math.round(fontSize * 0.54 * 4 + fontSize * 0.6 + 8),
  };
}

export function ScoreCurve({ chart }: { chart: ScoreCurveChart }) {
  const { curve, pilots, xUnit, xLabel, caption } = chart;
  const palette = useChartPalette();
  const [width, onLayout] = useWidth();
  const [readout, setReadout] = useState<ScoreChartPilot | null>(null);
  // Curve order, left to right, as the eye reads it.
  const points = useMemo(() => [...pilots].sort((a, b) => a.x - b.x), [pilots]);
  const you = points.find((p) => p.you);
  if (points.length === 0 || curve.length === 0) return null;

  const fontSize = CHART_FONT;
  const margin = margins(fontSize);
  const H = PLOT_H + margin.top + margin.bottom;
  const W = width;
  const plot = { left: margin.left, right: W - margin.right, top: margin.top, bottom: H - margin.bottom };

  // The curve sets the domain, not the dots: it is the subject. Inset so a
  // pilot at either end — the one most likely to be reading — is not sliced
  // in half by the plot's edge.
  const xDomain = extent([...curve.map((c) => c.x), ...points.map((p) => p.x)])!;
  const yMax = Math.max(...curve.map((c) => c.y), ...points.map((p) => p.y));
  const x = linearScale(xDomain, [plot.left + 10, plot.right - 10]);
  const y = linearScale([0, yMax || 1], [plot.bottom, plot.top + 10]);
  const path = `M${curve.map((c) => `${x(c.x).toFixed(1)},${y(c.y).toFixed(1)}`).join('L')}`;
  const xTicks = niceTicks(xDomain, 3);
  const yTicks = niceTicks([0, yMax || 1], 3);
  const labels = W > 0 ? placeCurveLabels({ points, x, y, fontSize, width: W, plot }) : [];

  return (
    <View style={chartStyles.figure} onLayout={onLayout} testID="score-curve">
      {W > 0 ? (
        <Svg width={W} height={H} accessible accessibilityLabel={`${xLabel} against points. ${caption}`}>
          {yTicks.map((t) => (
            <Line key={`gy${t}`} x1={plot.left} x2={plot.right} y1={y(t)} y2={y(t)} stroke={palette.grid} strokeWidth={1} />
          ))}
          <G>
            {xTicks.map((t) => (
              <SvgText
                key={`tx${t}`}
                x={x(t)}
                y={plot.bottom + fontSize * 1.5}
                textAnchor="middle"
                fontSize={fontSize}
                fill={palette.muted}>
                {formatChartX(xUnit, t)}
              </SvgText>
            ))}
            {yTicks.map((t) => (
              <SvgText
                key={`ty${t}`}
                x={plot.left - fontSize * 0.6}
                y={y(t) + fontSize * 0.35}
                textAnchor="end"
                fontSize={fontSize}
                fill={palette.muted}>
                {String(Math.round(t))}
              </SvgText>
            ))}
            <SvgText x={plot.left - fontSize * 0.6} y={plot.top - 4} textAnchor="end" fontSize={fontSize} fill={palette.muted}>
              pts
            </SvgText>
            <SvgText x={(plot.left + plot.right) / 2} y={H - fontSize * 0.35} textAnchor="middle" fontSize={fontSize} fill={palette.muted}>
              {xLabel}
            </SvgText>
          </G>

          <Path d={path} fill="none" stroke={palette.ink} strokeOpacity={0.7} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

          {points.map((p) =>
            p.you ? null : (
              <G key={p.key} onPress={() => setReadout(p)}>
                {/* A 24 pt target over a 7 pt dot. */}
                <Circle cx={x(p.x)} cy={y(p.y)} r={12} fill="transparent" />
                <Circle
                  cx={x(p.x)}
                  cy={y(p.y)}
                  r={3.5}
                  fill={palette.muted}
                  fillOpacity={0.5}
                  stroke={readout?.key === p.key ? palette.accent : undefined}
                  strokeWidth={2}
                />
              </G>
            ),
          )}
          {you ? (
            <G onPress={() => setReadout(you)}>
              <Circle cx={x(you.x)} cy={y(you.y)} r={12} fill="transparent" />
              <Circle cx={x(you.x)} cy={y(you.y)} r={6} fill={palette.accent} stroke={palette.surface} strokeWidth={2} />
            </G>
          ) : null}

          {labels
            .filter((l) => l.leader)
            .map((l) => (
              <Line
                key={`lead-${l.key}`}
                x1={l.x}
                y1={l.y + (l.y < l.dotY ? fontSize * 0.3 : fontSize * -0.8)}
                x2={l.dotX}
                y2={l.dotY + (l.y < l.dotY ? -7 : 7)}
                stroke={palette.muted}
                strokeOpacity={0.4}
                strokeWidth={1}
              />
            ))}
          {labels.map((l) => (
            <HaloText
              key={l.key}
              x={l.x}
              y={l.y}
              fontSize={fontSize}
              fill={l.you ? palette.ink : palette.muted}
              fontWeight={l.you ? '600' : 'normal'}
              halo={palette.surface}>
              {l.name}
            </HaloText>
          ))}
        </Svg>
      ) : null}
      <Text style={[chartStyles.readout, { color: palette.muted }]} importantForAccessibility="no" accessibilityElementsHidden>
        {readout ? curvePilotLabel(xUnit, readout) : 'Tap a dot to name the pilot behind it.'}
      </Text>
      <Text style={[chartStyles.caption, { color: palette.muted }]}>{caption}</Text>
    </View>
  );
}
