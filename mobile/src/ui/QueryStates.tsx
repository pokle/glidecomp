/**
 * What a screen shows around its data: a loading line, an error with Retry,
 * a "not found", and — the case that matters on a hill — a banner over data
 * that could not be refreshed. A failed request NEVER replaces data a reader
 * already has (issue #481: a failure to ask is not an answer).
 */
import { onlineManager, type UseQueryResult } from '@tanstack/react-query';
import { useTheme } from 'expo-router';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError, isNotFound } from '@/api/client';
import { ago } from '@/lib/ago';

function useOnline(): boolean {
  return useSyncExternalStore(
    (cb) => onlineManager.subscribe(cb),
    () => onlineManager.isOnline(),
  );
}

/** Re-render every half minute, so "N minutes ago" keeps counting. */
function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/** Over data that is still on screen but could not be refreshed. */
export function StaleBanner({ query }: { query: UseQueryResult<unknown> }) {
  const online = useOnline();
  const now = useNow();
  const { colors } = useTheme();
  if (query.data === undefined || (!query.isError && online)) return null;
  // The server answered but failed (a 5xx after retries): the signal is fine.
  const serverFailed = online && query.error instanceof ApiError;
  const when = ago(query.dataUpdatedAt, now);
  return (
    <View
      testID="stale-banner"
      accessibilityRole="alert"
      style={[styles.banner, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.bannerText, { color: colors.text }]}>
        {serverFailed
          ? `GlideComp isn’t answering — showing what you saw ${when}.`
          : `No signal — showing what you saw ${when}.`}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => query.refetch()}
        hitSlop={12}
        style={styles.retry}>
        <Text style={[styles.retryText, { color: colors.primary }]}>Retry</Text>
      </Pressable>
    </View>
  );
}

interface GateProps<T> {
  query: UseQueryResult<T>;
  /** "Loading competitions…" */
  loading: string;
  /** "This competition doesn’t exist, or isn’t public." */
  notFound: string;
  children: (data: T) => ReactNode;
}

/** Renders `children` once there is data — from the network or the phone. */
export function QueryGate<T>({ query, loading, notFound, children }: GateProps<T>) {
  const { colors } = useTheme();
  if (query.data !== undefined) return <>{children(query.data)}</>;
  if (query.isError) {
    const missing = isNotFound(query.error);
    return (
      <View style={styles.centre} testID={missing ? 'not-found' : 'load-error'}>
        <Text style={[styles.message, { color: colors.text }]}>
          {missing ? notFound : 'Couldn’t load this. Check your signal and try again.'}
        </Text>
        {missing ? null : (
          <Pressable accessibilityRole="button" onPress={() => query.refetch()} hitSlop={12}>
            <Text style={[styles.retryText, { color: colors.primary }]}>Try again</Text>
          </Pressable>
        )}
      </View>
    );
  }
  return (
    <View style={styles.centre} accessibilityRole="progressbar" accessibilityLabel={loading}>
      <ActivityIndicator />
      <Text style={[styles.message, { color: colors.text, opacity: 0.6 }]}>{loading}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bannerText: { flex: 1, fontSize: 15 },
  retry: { minHeight: 44, justifyContent: 'center' },
  retryText: { fontSize: 17, fontWeight: '600' },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24 },
  message: { fontSize: 17, textAlign: 'center' },
});
