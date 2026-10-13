/**
 * An action row's look on iOS: the system's tint for an action, its red for
 * a destructive one — a Form's button rows, as Settings draws them.
 */
import { foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { PlatformColor } from 'react-native';

import type { ActionStyle } from './action-style.types';

export function actionStyle(destructive: boolean): ActionStyle {
  return {
    modifiers: [foregroundStyle(PlatformColor(destructive ? 'systemRed' : 'link'))],
  };
}
