/**
 * Track data cleaning: what the altitude plausibility pass repaired in this
 * tracklog before analysis — the website's TrackDataCleaningNote, with its
 * chart (report-card rule (d)). The list is the exact record and always
 * shows; once the tracklog arrives, the same repairs are drawn, and each
 * entry zooms the chart to its stretch.
 */
import { idFromSegment } from '@glidecomp/client/slug';
import { formatTimeInZone } from '@glidecomp/client/time';
import type { AltitudeCleaningData } from '@glidecomp/client/types';
import { formatAltitude } from '@glidecomp/engine';
import { Stack, useLocalSearchParams, useTheme } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { TrackCleaningChart } from '@/charts/TrackCleaningChart';
import { useChartPalette } from '@/charts/palette';
import { openDoc } from '@/lib/open-doc';
import { useFixes, useReportCard } from '@/lib/use-report-card';
import { useUnits } from '@/settings/units';
import { ReportCardGate } from '@/ui/ReportCardGate';

export default function CleaningScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string; pilot: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const pilotId = idFromSegment(params.pilot);
  const { state } = useReportCard(compId, taskId, pilotId);
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: 'Track data cleaning', headerLargeTitle: false }} />
      <ReportCardGate state={state} compId={compId} taskId={taskId}>
        {(card) =>
          card.altitudeCleaning ? (
            <CleaningBody
              cleaning={card.altitudeCleaning}
              timeZone={card.comp.timezone ?? null}
              compId={compId}
              taskId={taskId}
              pilotId={pilotId}
            />
          ) : null
        }
      </ReportCardGate>
    </View>
  );
}

function CleaningBody({
  cleaning,
  timeZone,
  compId,
  taskId,
  pilotId,
}: {
  cleaning: AltitudeCleaningData;
  timeZone: string | null;
  compId: string;
  taskId: string;
  pilotId: string;
}) {
  const { colors } = useTheme();
  const palette = useChartPalette();
  const prefs = useUnits();
  const { fixes } = useFixes(compId, taskId, pilotId);
  const [selected, setSelected] = useState<number | null>(null);
  const time = (ms: number) => formatTimeInZone(new Date(ms), timeZone ?? undefined);
  const pct = (100 * cleaning.repairedFixCount) / cleaning.totalFixCount;
  const charted = fixes != null && fixes.length > 1;
  const entryText = (r: AltitudeCleaningData['ranges'][number]) =>
    `${r.startTimeMs === r.endTimeMs ? time(r.startTimeMs) : `${time(r.startTimeMs)}–${time(r.endTimeMs)}`} · ${r.fixCount} fix${
      r.fixCount === 1 ? '' : 'es'
    } · up to ${formatAltitude(r.maxCorrectionMeters, { prefs }).withUnit} off`;
  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      testID="track-cleaning">
      <View style={[styles.card, { backgroundColor: colors.card }]}>
        <Text style={[styles.body, { color: colors.text }]}>
          {`${cleaning.repairedFixCount} of ${cleaning.totalFixCount} GPS fixes (${pct < 0.1 ? '<0.1' : pct.toFixed(1)}%) carried an implausible altitude and were repaired before analysis — ${
            cleaning.crossChecked
              ? 'flagged by cross-checking GPS altitude against the barometric channel'
              : 'flagged by vertical-speed limits (no barometric channel to cross-check)'
          }. Positions and times are never altered.`}
        </Text>
        <Pressable accessibilityRole="link" onPress={() => openDoc('/scoring/data-cleaning')} hitSlop={8} style={styles.link}>
          <Text style={[styles.body, { color: colors.primary }]}>How data cleaning works</Text>
        </Pressable>
      </View>

      {charted ? (
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <TrackCleaningChart
            fixes={fixes}
            ranges={cleaning.ranges}
            selected={selected}
            timeZone={timeZone}
            prefs={prefs}
            onSelectRange={setSelected}
          />
          {selected === null ? (
            <Text style={[styles.hint, { color: palette.muted }]}>Pick a stretch below to zoom the chart to it.</Text>
          ) : (
            <Pressable accessibilityRole="button" onPress={() => setSelected(null)} hitSlop={8} style={styles.link}>
              <Text style={[styles.hint, { color: colors.primary }]}>Show the whole flight</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      <View style={[styles.card, styles.list, { backgroundColor: colors.card }]}>
        {cleaning.ranges.map((r, i) => {
          const isSelected = i === selected;
          const text = (
            <Text style={[styles.entry, { color: isSelected ? colors.text : palette.muted, fontWeight: isSelected ? '600' : 'normal' }]}>
              {entryText(r)}
            </Text>
          );
          const rowStyle = [styles.row, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }];
          return charted ? (
            <Pressable
              key={r.startIndex}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              onPress={() => setSelected(isSelected ? null : i)}
              style={rowStyle}
              testID={`repair-${i}`}>
              {text}
            </Pressable>
          ) : (
            <View key={r.startIndex} style={rowStyle}>
              {text}
            </View>
          );
        })}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
  card: { borderRadius: 12, padding: 16, gap: 8 },
  list: { paddingVertical: 4 },
  body: { fontSize: 15, lineHeight: 20 },
  hint: { fontSize: 13 },
  link: { alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' },
  row: { minHeight: 44, justifyContent: 'center' },
  entry: { fontSize: 15, fontVariant: ['tabular-nums'] },
});
