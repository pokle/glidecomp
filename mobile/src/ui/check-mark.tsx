import type { ReactNode } from 'react';

/** The selected option's mark. Android has no SF Symbols; a tick will do. */
export function checkMark(): ReactNode {
  return '✓';
}
