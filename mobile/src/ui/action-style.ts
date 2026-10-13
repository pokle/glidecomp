/**
 * An action row's look on Android: Material's error colour for a destructive
 * row; an ordinary action keeps the list's own content colour (the iOS
 * version is action-style.ios.ts).
 */
import { Appearance } from 'react-native';

import type { ActionStyle } from './action-style.types';

export function actionStyle(destructive: boolean): ActionStyle {
  if (!destructive) return {};
  const dark = Appearance.getColorScheme() === 'dark';
  return { colors: { contentColor: dark ? '#F2B8B5' : '#B3261E' } };
}
