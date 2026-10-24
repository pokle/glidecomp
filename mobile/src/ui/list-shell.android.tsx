/**
 * The grouped list's frame on Android: the Material 3 "connected list" that
 * @expo/ui's FieldGroup draws, built here rather than taken from it.
 *
 * FieldGroup.Section wraps every child in a Material ListItem card of its
 * own, and our rows ARE ListItems, each with its own background and padding.
 * So every row was a lighter card inset inside its section's card, at every
 * screen, from stage 2 until this file. Here a row is one card: the section
 * clips each child to its position's corners and paints the card, and the
 * rows draw no background of their own (`ROW_COLORS`).
 *
 * FieldGroup itself cannot be kept around these sections: it treats any child
 * that is not its own Section as a row and wraps it in an implicit section —
 * the nesting again — so the column is ours too.
 */
import { Box, Column, Host, LazyColumn, Text, useMaterialColors } from '@expo/ui/jetpack-compose';
import {
  background,
  clip,
  fillMaxSize,
  fillMaxWidth,
  padding,
  Shapes,
} from '@expo/ui/jetpack-compose/modifiers';
import { Children, Fragment, isValidElement, type PropsWithChildren, type ReactNode } from 'react';
import { StyleSheet } from 'react-native';

import { testIdModifiers } from './test-id';

export function ListRoot({ children, testID }: PropsWithChildren<{ testID?: string }>) {
  const colors = useMaterialColors();
  return (
    <Host style={styles.fill}>
      <LazyColumn
        verticalArrangement={{ spacedBy: 24 }}
        contentPadding={{ start: 16, end: 16, top: 16, bottom: 16 }}
        modifiers={[fillMaxSize(), background(colors.surface), ...(testIdModifiers(testID) ?? [])]}>
        {Children.toArray(children)}
      </LazyColumn>
    </Host>
  );
}

export function Section({
  title,
  testID,
  children,
}: PropsWithChildren<{ title?: string; testID?: string }>) {
  const colors = useMaterialColors();
  const rows = flatten(children);
  return (
    <Column
      verticalArrangement={{ spacedBy: 4 }}
      modifiers={[fillMaxWidth(), ...(testIdModifiers(testID) ?? [])]}>
      {title ? (
        <Column modifiers={[padding(16, 0, 16, 8)]}>
          <Text color={colors.onSurfaceVariant} style={{ typography: 'titleMedium' }}>
            {title}
          </Text>
        </Column>
      ) : null}
      {rows.length > 0 ? (
        <Column verticalArrangement={{ spacedBy: 2 }} modifiers={[fillMaxWidth()]}>
          {rows.map((row, index) => (
            <Box
              key={index}
              modifiers={[
                fillMaxWidth(),
                clip(Shapes.RoundedCorner(corners(index, rows.length))),
                background(colors.surfaceContainer),
                // A ListItem brings its own insets; a chart or a text field
                // does not, and gets the same ones from here.
                ...(needsInset(row) ? [padding(16, 8, 16, 8)] : []),
              ]}>
              {row}
            </Box>
          ))}
        </Column>
      ) : null}
    </Column>
  );
}

/** A row's own background: none, so the section's card is the only one. */
export const ROW_COLORS = { containerColor: 'transparent' };

/**
 * The section's rows, one per card. A screen often passes several rows in a
 * fragment (`{route ? <>…</> : <Note …/>}`); left whole, a fragment became ONE
 * card with its rows drawn on top of each other. @expo/ui's own section opens
 * fragments the same way.
 */
function flatten(children: ReactNode): ReactNode[] {
  const rows: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (child == null || typeof child === 'boolean') return;
    if (isValidElement(child) && child.type === Fragment) {
      rows.push(...flatten((child.props as { children?: ReactNode }).children));
    } else {
      rows.push(child);
    }
  });
  return rows;
}

/**
 * Rows marked `needsInset` (grouped-list's Embedded and FieldRow) are not
 * ListItems and bring no insets of their own. Every other row is, or renders,
 * a ListItem — a screen's own component around a Row included.
 */
function needsInset(row: ReactNode): boolean {
  return isValidElement(row) && (row.type as { needsInset?: boolean }).needsInset === true;
}

/** Material 3's connected list: fully rounded at the section's ends, slightly between rows. */
function corners(index: number, count: number) {
  const full = 20;
  const small = 4;
  const first = index === 0;
  const last = index === count - 1;
  return {
    topStart: first ? full : small,
    topEnd: first ? full : small,
    bottomStart: last ? full : small,
    bottomEnd: last ? full : small,
  };
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
