/**
 * The geometry every chart in a day-profile stack is drawn in — decided ONCE
 * per stack, by the panel, and handed to each chart.
 *
 * Why it is not a set of constants any more (issue #860). The charts were a
 * fixed 560-unit viewBox scaled to whatever width the page gave them, so
 * their type was scaled with it: 5.7px on a phone, 19px on a desktop, and
 * never the 10px the source said. `charts/use-chart-label-size.ts` describes
 * the bug. A chart there measures itself; a STACK cannot, because its whole
 * point is that a vertical line through one chart passes through the same
 * instant in the others, and three charts measuring themselves separately
 * are three chances to disagree by a pixel. So the panel measures, and the
 * charts are told.
 *
 * The frame is in CSS pixels: the viewBox is as wide as the chart is
 * drawn, so one unit is one pixel, `fontSize` is a real type size and a 2-unit
 * stroke is a 2px line at every width. Margins hold type, so they are
 * multiples of the type size, and so is every height a chart derives.
 */
import { useMemo } from "react";
import { chartBoxForWidth, useMeasuredWidth } from "@/react/charts/use-chart-box";

export interface ChartFrame {
  /** ViewBox width. */
  width: number;
  /** Plot bounds, identical for every chart in the stack. */
  plotLeft: number;
  plotRight: number;
  /** Label size in viewBox units; also the unit ("em") heights are set in. */
  fontSize: number;
}

/**
 * The frame for a stack drawn `cssWidth` pixels wide.
 *
 * - `left` holds the widest y tick, a bare number of up to five digits
 *   ("10000" in feet), and its gap from the plot.
 * - `right` holds the half of the last time label that overhangs the plot
 *   edge it is centred on.
 *
 * The width and the type size are `charts/use-chart-box.ts`'s, which a chart
 * on its own uses too; the plot bounds are this stack's.
 */
export function frameForWidth(cssWidth: number, rootPx = 16): ChartFrame {
  const { width, fontSize } = chartBoxForWidth(cssWidth, rootPx);
  return {
    width,
    plotLeft: Math.round(fontSize * 3.5),
    plotRight: width - Math.round(fontSize * 1.4),
    fontSize,
  };
}

/**
 * Measure the element a stack is drawn in and keep its frame current.
 *
 * SSR-safe: the first render assumes 560px, on the server and in the browser
 * alike, and the observer corrects it after mount.
 */
export function useChartFrame(): {
  ref: (el: HTMLElement | null) => void;
  frame: ChartFrame;
} {
  const { ref, width, rootPx } = useMeasuredWidth();
  const frame = useMemo(() => frameForWidth(width, rootPx), [width, rootPx]);
  return { ref, frame };
}
