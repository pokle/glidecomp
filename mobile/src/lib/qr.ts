/**
 * A QR code as one SVG path: `qrcode` builds the module matrix (pure
 * JavaScript, no canvas), and every dark module becomes a unit square in a
 * `size`×`size` box, so `react-native-svg` draws the whole code in one
 * element at any scale.
 */
import { create } from 'qrcode';

export interface QrPath {
  /** Modules per side, before the quiet zone. */
  size: number;
  /** The dark modules, in module units. */
  d: string;
}

export function qrPath(value: string): QrPath {
  // Level L holds the most data, and the code is read from a screen at close
  // range — the website's choice too (WaypointQR.tsx).
  const { modules } = create(value, { errorCorrectionLevel: 'L' });
  const { size, data } = modules;
  let d = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!data[y * size + x]) {
        x++;
        continue;
      }
      // A run of dark modules along the row is one rectangle.
      let run = 1;
      while (x + run < size && data[y * size + x + run]) run++;
      d += `M${x} ${y}h${run}v1h${-run}z`;
      x += run;
    }
  }
  return { size, d };
}
