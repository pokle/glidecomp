import { useTheme } from 'expo-router';
import type { PropsWithChildren } from 'react';
import { StyleSheet, Text } from 'react-native';

/** Placeholder copy for a screen a later stage of the plan builds. */
export function StageNote({ stage, children }: PropsWithChildren<{ stage: number }>) {
  const { colors } = useTheme();
  return (
    <Text testID={`stage-note-${stage}`} style={[styles.note, { color: colors.text }]}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  note: { fontSize: 17, opacity: 0.6 },
});
