import { useCallback, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';

/**
 * The width a chart has been given, from layout. Charts draw in the screen's
 * own points rather than scaling a fixed viewBox, so their type is the
 * platform's real footnote size at every width — the website measures and
 * corrects for that (`use-chart-label-size.ts`); here it is simply true.
 */
export function useWidth(): [number, (e: LayoutChangeEvent) => void] {
  const [width, setWidth] = useState(0);
  const onLayout = useCallback((e: LayoutChangeEvent) => {
    const w = Math.round(e.nativeEvent.layout.width);
    setWidth((prev) => (prev === w ? prev : w));
  }, []);
  return [width, onLayout];
}
