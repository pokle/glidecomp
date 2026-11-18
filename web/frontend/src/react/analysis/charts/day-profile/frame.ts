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
import { useEffect, useMemo, useState } from "react";
import { CHART_LABEL_PX } from "@/react/charts/use-chart-label-size";

export interface ChartFrame {
  /** ViewBox width. */
  width: number;
  /** Plot bounds, identical for every chart in the stack. */
  plotLeft: number;
  plotRight: number;
  /** Label size in viewBox units; also the unit ("em") heights are set in. */
  fontSize: number;
}

/** The width assumed before the stack is measured — on the server, and in
 * the browser's first render, which must agree with it. */
const UNMEASURED_WIDTH = 560;

/** Narrower than this a stack is not being laid out, it is being measured on
 * its way in (a collapsed parent); draw for a small phone and wait. */
const MIN_WIDTH = 240;

/**
 * The frame for a stack drawn `cssWidth` pixels wide.
 *
 * - `left` holds the widest y tick, a bare number of up to five digits
 *   ("10000" in feet), and its gap from the plot.
 * - `right` holds the half of the last time label that overhangs the plot
 *   edge it is centred on.
 */
export function frameForWidth(cssWidth: number, rootPx = 16): ChartFrame {
  const width = Math.max(MIN_WIDTH, Math.round(cssWidth));
  const fontSize = CHART_LABEL_PX.footnote * (rootPx / 16);
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
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: UNMEASURED_WIDTH, rootPx: 16 });

  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const width = Math.round(el.getBoundingClientRect().width);
      if (width <= 0) return;
      const rootPx =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      setSize((s) => (s.width === width && s.rootPx === rootPx ? s : { width, rootPx }));
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    update();
    return () => observer.disconnect();
  }, [el]);

  const frame = useMemo(() => frameForWidth(size.width, size.rootPx), [size]);
  return { ref: setEl, frame };
}
