/**
 * What a report card screen shows until its narrative is ready — QueryGate's
 * states, plus the one only a report card has: the pilot's track is in but
 * the served scores predate it. That is a WAIT, not a "not found" (the
 * website's wording): telling a pilot who has just submitted that their score
 * can't be found reads as "your track did not go in". The scores query polls
 * while stale, so the wait ends by itself.
 */
import { taskPath } from '@glidecomp/client/slug';
import type { ReportCard } from '@glidecomp/client/report-card';
import { router, useTheme } from 'expo-router';
import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ReportCardState } from '@/lib/use-report-card';

export function ReportCardGate({
  state,
  compId,
  taskId,
  children,
}: {
  state: ReportCardState;
  compId: string;
  taskId: string;
  children: (card: ReportCard) => ReactNode;
}) {
  const { colors } = useTheme();
  if (state.kind === 'ready') return <>{children(state.card)}</>;
  const message = (text: string, testID: string, action?: { label: string; onPress: () => void }) => (
    <View style={styles.centre} testID={testID}>
      <Text style={[styles.message, { color: colors.text }]}>{text}</Text>
      {action ? (
        <Pressable accessibilityRole="button" onPress={action.onPress} hitSlop={12}>
          <Text style={[styles.action, { color: colors.primary }]}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
  switch (state.kind) {
    case 'pending':
      return (
        <View style={styles.centre} testID="score-pending" accessibilityRole="progressbar">
          <ActivityIndicator />
          <Text style={[styles.message, { color: colors.text }]}>
            Your track is in. Working out the scores — they depend on everyone else’s tracks too…
          </Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            onPress={() => router.push(taskPath(compId, null, taskId, null) as never)}>
            <Text style={[styles.action, { color: colors.primary }]}>Go to the task</Text>
          </Pressable>
        </View>
      );
    case 'not-found':
      return message('No score for this pilot on this task.', 'not-found');
    case 'unavailable':
      return message(`${state.message}.`, 'unavailable');
    case 'error':
      return message('Couldn’t load this. Check your signal and try again.', 'load-error', {
        label: 'Try again',
        onPress: state.retry,
      });
    default:
      return (
        <View style={styles.centre} accessibilityRole="progressbar" accessibilityLabel="Loading the report card…">
          <ActivityIndicator />
          <Text style={[styles.message, { color: colors.text, opacity: 0.6 }]}>Loading the report card…</Text>
        </View>
      );
  }
}

const styles = StyleSheet.create({
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  message: { fontSize: 17, textAlign: 'center' },
  action: { fontSize: 17, fontWeight: '600' },
});
