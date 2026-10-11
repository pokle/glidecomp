import type { PropsWithChildren } from 'react';
import { ScrollView, StyleSheet } from 'react-native';

/**
 * A tab's scrolling body. `automatic` content insets let iOS collapse the
 * large title on scroll and keep content clear of the tab bar.
 */
export function Screen({ children }: PropsWithChildren) {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      {children}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 16 },
});
