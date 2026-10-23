/**
 * The grouped list's frame on iOS: @expo/ui's universal FieldGroup, which is
 * a SwiftUI Form, and its Section. Android has its own
 * (list-shell.android.tsx) — see there for why.
 */
import { FieldGroup, Host } from '@expo/ui';
import type { PropsWithChildren } from 'react';
import { StyleSheet } from 'react-native';

export function ListRoot({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  return (
    <Host style={styles.fill}>
      <FieldGroup testID={testID}>{children}</FieldGroup>
    </Host>
  );
}

export const Section = FieldGroup.Section;

/** A row's own background: none of its own on iOS, where the Form draws the group. */
export const ROW_COLORS: { containerColor?: string } | undefined = undefined;

const styles = StyleSheet.create({ fill: { flex: 1 } });
