import type { ReactNode } from 'react';

/** A row's "shows this on the map" mark. Android has no SF Symbols; a pin will do. */
export function mapPin(): ReactNode {
  return '📍';
}
