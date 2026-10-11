/**
 * One section of the report card: its points, where the pilot placed on its
 * input, and every line of the arithmetic with its inputs substituted
 * (report-card rule (a)) — the website's ExplanationSection. The component's
 * chart sits UNDER the arithmetic it illustrates: the numbers are the answer,
 * the curve is the shape.
 *
 * A line that happened somewhere (a start crossing, a turnpoint) carries a
 * pin, and opens the map at that spot.
 */
import type { ReportCard } from '@glidecomp/client/report-card';
import { idFromSegment } from '@glidecomp/client/slug';
import type { ScoreExplanationItem, ScoreExplanationSection } from '@glidecomp/engine';
import { router, Stack, useLocalSearchParams, useTheme } from 'expo-router';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { ScoreChartView } from '@/charts/ScoreChartView';
import { useChartPalette } from '@/charts/palette';
import { openDoc } from '@/lib/open-doc';
import { sectionPoints } from '@/lib/section-points';
import { useReportCard } from '@/lib/use-report-card';
import { ReportCardGate } from '@/ui/ReportCardGate';

export default function SectionScreen() {
  const params = useLocalSearchParams<{ comp: string; task: string; pilot: string; section: string }>();
  const compId = idFromSegment(params.comp);
  const taskId = idFromSegment(params.task);
  const { state } = useReportCard(compId, taskId, idFromSegment(params.pilot));
  const section = state.kind === 'ready' ? state.card.explanation.sections.find((s) => s.id === params.section) : undefined;
  const mapPath = `/comp/${params.comp}/task/${params.task}/pilot/${params.pilot}/map`;
  return (
    <View style={{ flex: 1 }}>
      <Stack.Screen options={{ title: section?.title ?? 'Report card', headerLargeTitle: false }} />
      <ReportCardGate state={state} compId={compId} taskId={taskId}>
        {(card) =>
          section ? (
            <SectionBody
              card={card}
              section={section}
              onShowOnMap={(item) => router.push(`${mapPath}?item=${encodeURIComponent(item.id)}` as never)}
            />
          ) : null
        }
      </ReportCardGate>
    </View>
  );
}

function SectionBody({
  card,
  section,
  onShowOnMap,
}: {
  card: ReportCard;
  section: ScoreExplanationSection;
  onShowOnMap: (item: ScoreExplanationItem) => void;
}) {
  const { colors } = useTheme();
  const palette = useChartPalette();
  const points = sectionPoints(section);
  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      testID={`section-${section.id}`}>
      {points || section.rank || section.summary ? (
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          {points ? (
            <Text style={[styles.points, { color: colors.text }]} testID="section-points">
              {points}
            </Text>
          ) : null}
          {section.rank ? <Text style={[styles.secondary, { color: palette.muted }]}>{section.rank}</Text> : null}
          {section.summary ? <Text style={[styles.secondary, { color: palette.muted }]}>{section.summary}</Text> : null}
        </View>
      ) : null}

      <View style={[styles.card, styles.list, { backgroundColor: colors.card }]}>
        {section.items.map((item, i) => (
          <ItemRow
            key={item.id}
            item={item}
            first={i === 0}
            anchored={card.eventsByItem.has(item.id)}
            onPress={() => onShowOnMap(item)}
          />
        ))}
      </View>

      {section.chart ? (
        <View style={[styles.card, { backgroundColor: colors.card }]}>
          <ScoreChartView chart={section.chart} />
        </View>
      ) : null}

      {section.docHref ? (
        <Pressable
          accessibilityRole="link"
          accessibilityLabel={`How ${section.title.toLowerCase()} works`}
          onPress={() => openDoc(section.docHref!)}
          style={styles.docLink}
          hitSlop={8}
          testID="how-this-works">
          <Text style={[styles.docText, { color: colors.primary }]}>How this works</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

function ItemRow({
  item,
  first,
  anchored,
  onPress,
}: {
  item: ScoreExplanationItem;
  first: boolean;
  anchored: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  const palette = useChartPalette();
  const textColour = item.emphasis === 'warning' ? palette.warning : item.emphasis === 'muted' ? palette.muted : colors.text;
  // A sparkline is an annotation on its row's number and sits beside it;
  // anything larger (the distance distribution) is a figure, and goes below.
  const inline = item.chart?.kind === 'validity';
  const body = (
    <>
      <View style={styles.itemLine}>
        {anchored ? (
          <SymbolView
            name={{ ios: 'mappin', android: 'location_on' }}
            size={16}
            tintColor={palette.muted}
            style={styles.pin}
          />
        ) : null}
        <Text style={[styles.itemText, { color: textColour }]}>{item.text}</Text>
        {inline ? <ScoreChartView chart={item.chart!} /> : null}
        {item.value ? <Text style={[styles.value, { color: palette.muted }]}>{item.value}</Text> : null}
      </View>
      {item.detail ? <Text style={[styles.detail, { color: palette.muted }]}>{item.detail}</Text> : null}
      {item.chart && !inline ? <ScoreChartView chart={item.chart} /> : null}
    </>
  );
  const rowStyle = [styles.item, !first && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }];
  if (!anchored) return <View style={rowStyle}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Shows where this happened on the map"
      onPress={onPress}
      style={({ pressed }) => [rowStyle, pressed && { opacity: 0.6 }]}
      testID={`item-${item.id}`}>
      {body}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
  card: { borderRadius: 12, padding: 16, gap: 4 },
  list: { paddingVertical: 4 },
  points: { fontSize: 22, fontWeight: '600', fontVariant: ['tabular-nums'] },
  secondary: { fontSize: 15, lineHeight: 20 },
  item: { paddingVertical: 10, gap: 4 },
  itemLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pin: { width: 16, height: 16 },
  itemText: { flex: 1, fontSize: 15, lineHeight: 20 },
  value: { fontSize: 15, fontVariant: ['tabular-nums'] },
  detail: { fontSize: 13, lineHeight: 18 },
  docLink: { alignSelf: 'flex-start', paddingHorizontal: 4, minHeight: 44, justifyContent: 'center' },
  docText: { fontSize: 15 },
});
