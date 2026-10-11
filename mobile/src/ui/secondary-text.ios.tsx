/**
 * Quieter text inside a list row, in SwiftUI's own secondary style and the
 * subheadline text style, so it follows Dynamic Type and dark mode.
 */
import { Text } from '@expo/ui/swift-ui';
import { font, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import type { ReactNode } from 'react';

export function secondary(text: string): ReactNode {
  return (
    <Text
      modifiers={[
        font({ textStyle: 'subheadline' }),
        foregroundStyle({ type: 'hierarchical', style: 'secondary' }),
      ]}>
      {text}
    </Text>
  );
}
