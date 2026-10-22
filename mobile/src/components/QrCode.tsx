import { useMemo } from 'react';
import Svg, { Path, Rect } from 'react-native-svg';

import { qrPath } from '@/lib/qr';

/** Modules of white around the code, as the website draws it (marginSize 2). */
const QUIET = 2;

/**
 * A QR code drawn in black on white whatever the theme: a scanner reads dark
 * modules on a light ground, and a dark-mode inversion would not scan.
 */
export function QrCode({ value, size, label }: { value: string; size: number; label: string }) {
  const { size: modules, d } = useMemo(() => qrPath(value), [value]);
  const box = modules + QUIET * 2;
  return (
    <Svg
      width={size}
      height={size}
      viewBox={`${-QUIET} ${-QUIET} ${box} ${box}`}
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      testID="qr-code">
      <Rect x={-QUIET} y={-QUIET} width={box} height={box} fill="#ffffff" />
      <Path d={d} fill="#000000" />
    </Svg>
  );
}
