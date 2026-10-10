import type { ReactNode } from 'react';

/**
 * A row's trailing items. Android rows carry at most one (a value or a check
 * mark; Material lists draw no chevron), and the Compose list only styles a
 * bare item, so it goes in unwrapped. The iOS version lays several out side
 * by side.
 */
export function trailing(items: ReactNode[]): ReactNode {
  return items[0];
}
