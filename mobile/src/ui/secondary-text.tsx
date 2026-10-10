/**
 * Quieter text inside a list row. Android's Material list item already sets
 * supporting and trailing text in the theme's secondary style, and it only
 * styles a BARE string, so the string goes in as it is (the iOS version is
 * secondary-text.ios.tsx).
 */
import type { ReactNode } from 'react';

export function secondary(text: string): ReactNode {
  return text;
}
