/**
 * The app's grouped list: the platform's own (a SwiftUI Form on iOS, a Material
 * list on Android) through @expo/ui's universal components. Screens use these
 * names and nothing from @expo/ui directly, so if the beta API changes
 * shape, this file is the only one that does.
 */
import { FieldGroup, Host, Icon, ListItem, RNHostView } from '@expo/ui';
import type { PropsWithChildren, ReactElement, ReactNode } from 'react';
import { Platform, PlatformColor, StyleSheet, View } from 'react-native';

import { checkMark } from './check-mark';
import { secondary } from './secondary-text';
import { testIdModifiers } from './test-id';
import { trailing } from './trailing';

/** The scrolling list itself; fills the screen. */
export function GroupedList({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  return (
    <Host style={styles.fill}>
      <FieldGroup testID={testID}>{children}</FieldGroup>
    </Host>
  );
}

/**
 * One titled group of rows. The section component itself, not a wrapper:
 * Android's FieldGroup recognises a section by its exact component type and
 * wraps anything else in an implicit section of its own (nested cards).
 */
export const Group = FieldGroup.Section;

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
  testID?: string;
}

export function Row({ title, detail, value, onPress, selected, testID }: RowProps) {
  const chevron = onPress && selected === undefined && Platform.OS === 'ios';
  const items: ReactNode[] = [];
  if (value) items.push(secondary(value));
  if (chevron) items.push(<Icon name="chevron.right" size={13} color={PlatformColor('tertiaryLabel')} />);
  if (selected) items.push(checkMark());
  return (
    <ListItem
      onPress={onPress}
      supportingText={detail ? secondary(detail) : undefined}
      trailing={items.length > 0 ? trailing(items) : undefined}
      testID={testID}
      modifiers={testIdModifiers(testID)}>
      {title}
    </ListItem>
  );
}

/** A sentence in a group, not a row: an empty state, an explanation. */
export function Note({ children }: { children: string }) {
  return <ListItem>{children}</ListItem>;
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
  fill: { flex: 1 },
  embedded: { paddingVertical: 8 },
});
