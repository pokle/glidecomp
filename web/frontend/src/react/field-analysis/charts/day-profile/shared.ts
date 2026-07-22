/**
 * Shared geometry and wind-glyph helpers for the day-profile panel.
 *
 * Every chart in the panel uses the SAME viewBox width and left/right
 * margins, and all of them render with `w-full h-auto` — so a vertical line
 * through one chart passes through the same instant in the others. That
 * alignment is the whole point of the panel; nothing here may be overridden
 * per chart.
 */

/** ViewBox width shared by every chart in the panel (and the page's other
 * charts — HorseraceLines et al. use the same 560). */
export const W = 560;

/** Left fits y-tick labels and the tiny lane labels; right fits the last
 * x-tick label without clipping. Identical across the panel's charts. */
export const MARGIN = { left: 44, right: 20 };
export const PLOT_LEFT = MARGIN.left;
export const PLOT_RIGHT = W - MARGIN.right;

const COMPASS_16 = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** 16-point compass name for a bearing, e.g. 312° → "NW". */
export function degToCompass(deg: number): string {
  return COMPASS_16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/**
 * An arrow of length `len` pointing UP (screen north), centred on the
 * origin: a shaft plus an open head. Rotate it by `directionDeg + 180` to
 * make it fly WITH the wind (the engine's directions are degrees FROM, and
 * an up-pointing arrow rotated by a compass bearing points along that
 * bearing on screen).
 */
export function windArrowPath(len: number): string {
  const half = len / 2;
  const head = Math.max(3, len * 0.32);
  const hw = head * 0.55;
  return (
    `M0 ${half.toFixed(1)} L0 ${(-half).toFixed(1)} ` +
    `M${(-hw).toFixed(1)} ${(-half + head).toFixed(1)} L0 ${(-half).toFixed(1)} ` +
    `L${hw.toFixed(1)} ${(-half + head).toFixed(1)}`
  );
}

/** The SVG transform placing a wind arrow at (x, y) flying with the wind. */
export function windArrowTransform(x: number, y: number, directionFromDeg: number): string {
  return `translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${((directionFromDeg + 180) % 360).toFixed(0)})`;
}

/** "15 km/h NW" — the compact wind reading used on bars and in readouts.
 * Speed arrives already converted to the display unit; the token is the
 * metric-unit vocabulary ('km/h', 'mph', 'kts'). */
export function windLabel(speed: number, unit: string, directionFromDeg: number): string {
  return `${speed.toFixed(0)} ${unit} ${degToCompass(directionFromDeg)}`;
}
