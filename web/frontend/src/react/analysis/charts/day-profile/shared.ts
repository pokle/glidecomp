/**
 * Wind-glyph helpers for the day-profile panel, re-exported for its charts
 * and for the thermals panel.
 *
 * The panel's shared GEOMETRY is not here: every chart in a stack is drawn in
 * the one `ChartFrame` its panel measures (frame.ts), which is what keeps a
 * vertical line through one chart on the same instant in the others.
 */
export { degToCompass, windArrowPath, windArrowTransform, windLabel } from "./met-shared";
