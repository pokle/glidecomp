import { Icon } from '@expo/ui';
import type { ReactNode } from 'react';
import { PlatformColor } from 'react-native';

/** The selected option's mark, as iOS Settings draws it. */
export function checkMark(): ReactNode {
  return <Icon name="checkmark" size={16} color={PlatformColor('link')} accessibilityLabel="Selected" />;
}
