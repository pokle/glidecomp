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

// The wind-glyph helpers are shared with the app (@glidecomp/client/met).
export { degToCompass, windArrowPath, windArrowTransform, windLabel } from "@glidecomp/client/met";
