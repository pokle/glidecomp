/**
 * A chart drawn in CSS pixels: its viewBox is as wide as the chart is drawn.
 *
 * The other way to keep a chart's labels readable is `use-chart-label-size.ts`:
 * keep a fixed viewBox and grow the type in viewBox units until it paints at
 * the size wanted. That holds the type, and nothing else. A 2-unit line, a
 * 5-unit dot and a 12-unit hit area all still shrink with the chart, and the
 * chart's height is tied to its width, so a phone gets a short strip with
 * large type in it.
 *
 * Here one unit is one pixel at every width. `fontSize` is a real type size,
 * a 2-unit stroke is a 2px line, and a chart chooses its own height. Margins
 * hold type, so a chart states them as multiples of `fontSize`.
 *
 * The weather charts did this first, for a stack that shares one frame
 * (`analysis/charts/day-profile/frame.ts`, issue #860). This is the measuring
 * half of that, for a chart on its own.
 *
 * **SSR-safe.** The first render assumes {@link UNMEASURED_WIDTH}, on the
 * server and in the browser alike, and the observer corrects it after mount.
 */
import { useEffect, useMemo, useState } from "react";
import { CHART_LABEL_PX } from "./use-chart-label-size";

/** The width assumed before the chart is measured — on the server, and in
 * the browser's first render, which must agree with it. */
export const UNMEASURED_WIDTH = 560;

/** Narrower than this a chart is not being laid out, it is being measured on
 * its way in (a collapsed parent); draw for a small phone and wait. */
const MIN_WIDTH = 240;

export interface ChartBox {
  /** ViewBox width, which is the width the chart is drawn at. */
  width: number;
  /** Label size in viewBox units, which are CSS pixels; also the unit ("em")
   * a chart sets its margins and heights in. */
  fontSize: number;
}

/** The box for a chart drawn `cssWidth` pixels wide. The label size follows
 * the reader's own text size (`rootPx`). */
export function chartBoxForWidth(
  cssWidth: number,
  rootPx = 16,
  targetPx: number = CHART_LABEL_PX.footnote
): ChartBox {
  return {
    width: Math.max(MIN_WIDTH, Math.round(cssWidth)),
    fontSize: targetPx * (rootPx / 16),
  };
}

/** Measure an element's width and the root font size, and keep both current. */
export function useMeasuredWidth(): {
  ref: (el: Element | null) => void;
  width: number;
  rootPx: number;
} {
  const [el, setEl] = useState<Element | null>(null);
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

  return { ref: setEl, width: size.width, rootPx: size.rootPx };
}

/**
 * Measure the element a chart is drawn in and keep its box current. Attach
 * `ref` to the `<svg>` (it is `w-full`, so its width is the chart's) or to
 * the element around it.
 */
export function useChartBox(targetPx: number = CHART_LABEL_PX.footnote): {
  ref: (el: Element | null) => void;
  box: ChartBox;
} {
  const { ref, width, rootPx } = useMeasuredWidth();
  const box = useMemo(
    () => chartBoxForWidth(width, rootPx, targetPx),
    [width, rootPx, targetPx]
  );
  return { ref, box };
}
