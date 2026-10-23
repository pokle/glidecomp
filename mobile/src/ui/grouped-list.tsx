/**
 * The app's grouped list: the platform's own (a SwiftUI Form on iOS, a Material
 * list on Android) through @expo/ui's universal components. Screens use these
 * names and nothing from @expo/ui directly, so if the beta API changes
 * shape, this file is the only one that does.
 */
import { Icon, ListItem, RNHostView } from '@expo/ui';
import type { PropsWithChildren, ReactElement, ReactNode } from 'react';
import { Platform, PlatformColor, StyleSheet, View } from 'react-native';

import { actionStyle } from './action-style';
import { checkMark } from './check-mark';
import { FieldRow } from './field-row';
import { ListRoot, ROW_COLORS, Section } from './list-shell';
import { mapPin } from './map-pin';
import { secondary } from './secondary-text';
import { testIdModifiers } from './test-id';
import { trailing } from './trailing';

/** The scrolling list itself; fills the screen. */
export function GroupedList({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  return <ListRoot testID={testID}>{children}</ListRoot>;
}

/**
 * One titled group of rows: FieldGroup.Section on iOS, the app's own Material
 * section on Android (list-shell.android.tsx, which says why). Still a direct
 * child of GroupedList, never a wrapper or a fragment: on iOS the Form
 * recognises a section by its exact component type.
 */
export const Group = Section;

export interface RowProps {
  title: string;
  /** A second line, quieter than the title. */
  detail?: string;
  /** A short value at the trailing edge ("3 tasks", "400 m"). */
  value?: string;
  /** Rows that navigate say so with the platform's own cue. */
  onPress?: () => void;
  /** An option row: selected options carry a check mark and no chevron. */
  selected?: boolean;
  /**
   * A row whose tap shows its subject on the map (the waypoints list): the
   * pin at its leading edge names the action, which the whole row performs.
   */
  pin?: boolean;
  testID?: string;
}

export function Row({ title, detail, value, onPress, selected, pin, testID }: RowProps) {
  const chevron = onPress && selected === undefined && !pin && Platform.OS === 'ios';
  const items: ReactNode[] = [];
  if (value) items.push(secondary(value));
  if (chevron) items.push(<Icon name="chevron.right" size={13} color={PlatformColor('tertiaryLabel')} />);
  if (selected) items.push(checkMark());
  return (
    <ListItem
      onPress={onPress}
      leading={pin ? mapPin() : undefined}
      supportingText={detail ? secondary(detail) : undefined}
      trailing={items.length > 0 ? trailing(items) : undefined}
      colors={ROW_COLORS}
      testID={testID}
      modifiers={testIdModifiers(testID)}>
      {title}
    </ListItem>
  );
}

/**
 * A row that does something rather than going somewhere — Sign out, Delete
 * account — in the platform's action colour, or its destructive red. No
 * chevron: nothing is pushed.
 */
export function ActionRow({
  title,
  onPress,
  destructive = false,
  testID,
}: {
  title: string;
  onPress: () => void;
  destructive?: boolean;
  testID?: string;
}) {
  const style = actionStyle(destructive);
  return (
    <ListItem
      onPress={onPress}
      testID={testID}
      colors={ROW_COLORS ? { ...ROW_COLORS, ...style.colors } : style.colors}
      modifiers={[...(style.modifiers ?? []), ...(testIdModifiers(testID) ?? [])]}>
      {title}
    </ListItem>
  );
}

/** A sentence in a group, not a row: an empty state, an explanation. */
export function Note({ children }: { children: string }) {
  return <ListItem colors={ROW_COLORS}>{children}</ListItem>;
}

/**
 * React Native content in a group — a chart — hosted inside the native list.
 * Takes the row's width and grows to its content's height.
 */
export function Embedded({ children, testID }: { children: ReactElement; testID?: string }) {
  return (
    <RNHostView matchContents={{ vertical: true }} testID={testID}>
      <View style={styles.embedded}>{children}</View>
    </RNHostView>
  );
}

const styles = StyleSheet.create({
  embedded: { paddingVertical: 8 },
});

export { FieldRow };

// Not a ListItem, so the Android section insets it (list-shell.android.tsx).
Embedded.needsInset = true;
