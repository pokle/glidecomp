/**
 * Chart label sizing that survives being scaled into a phone-width box.
 *
 * Every chart in this app is an inline `<svg viewBox="0 0 W H" class="h-auto
 * w-full">`, so its text is measured in VIEWBOX UNITS and the browser scales
 * it by `cssWidth / W`. A `text-[10px]` tick label is therefore 10px only when
 * the chart happens to be drawn W px wide. It never is on a phone: a 560-unit
 * chart inside a card inside a 393px viewport draws about 319px wide, a factor
 * of 0.57, and the label lands at **5.7px**. Measured on the report card
 * (issue #704): the "0.0 km" tick painted at 6.1px and a pilot's name at
 * 5.8px. That is the single worst legibility bug in the app, and it is
 * invisible to code review because the source says `10px`.
 *
 * So the size cannot be a constant. It has to be derived from how wide the
 * chart is ACTUALLY drawn, which only the browser knows:
 *
 *     fontSize = targetPx x (rootPx / 16) x viewBoxWidth / cssWidth
 *
 * — a viewBox size that renders at `targetPx` whatever the chart's width, and
 * that still grows when the reader has asked their browser for larger text.
 *
 * `RankScatter` worked this out first and kept it to itself (its copy already
 * carried the "~6px — unreadable" note); this is that hook promoted, with a
 * target instead of a hardcoded 1rem, so the other fourteen charts can stop
 * being unreadable too.
 *
 * **SSR-safe by construction.** The initial value is computed with no
 * measurement at all, so the server's markup and the browser's first render
 * agree and React reports no mismatch; the observer corrects it after mount.
 * That matters because these charts are in the SSR bundle deliberately — the
 * report card's charts must be in the first paint, not swapped in later.
 *
 * **Margins have to grow with it.** A chart whose bottom margin was cut for
 * 10-unit type will clip 26-unit type straight off the frame. Every caller
 * derives its plot margins from the returned `fontSize` rather than from a
 * constant; see the call sites for the shape.
 */
import { useEffect, useState } from "react";

/**
 * Target sizes, in CSS px, named for the iOS type styles they correspond to
 * (docs/accessibility-standard.md, and the HIG review in issue #704).
 *
 * `body` is for a chart that is the point of the section it sits in — the
 * reader is looking AT it, and its labels should read like the prose around
 * them. `footnote` is for a dense chart with many labels, or a small one
 * inline under prose that already states the numbers: 13px is the smallest
 * size the HIG has a name for, and it is still more than twice what these
 * charts were painting.
 *
 * There is deliberately nothing smaller. A chart label below Footnote is not
 * a design choice, it is the bug this module exists to fix.
 */
export const CHART_LABEL_PX = {
  body: 16,
  footnote: 13,
} as const;

/**
 * The widest a label may get, as a fraction of the chart's viewBox width.
 *
 * Without it, a chart briefly drawn 1px wide — a collapsed flex parent, a
 * `display: none` ancestor being measured on the way in, a sheet mid-open —
 * asks for a font size in the thousands and paints one enormous glyph before
 * the next frame corrects it. 6% of the width is far above anything a real
 * layout produces (a 560-unit chart at 393px asks for 4%) and well below
 * absurd.
 */
const MAX_FONT_FRACTION = 0.06;

export interface ChartLabelSize {
  /** Attach to the `<svg>` whose `viewBox` width was passed in. */
  svgRef: (el: SVGSVGElement | null) => void;
  /** Label size in VIEWBOX UNITS — `fontSize={...}`, never a `text-[Npx]`. */
  fontSize: number;
}

export function useChartLabelSize(
  viewBoxWidth: number,
  targetPx: number = CHART_LABEL_PX.footnote
): ChartLabelSize {
  const [svgEl, setSvgEl] = useState<SVGSVGElement | null>(null);
  // Before measurement, assume the chart is drawn at its natural width, which
  // is what a desktop layout gives it and what the SSR render has to assume.
  // Erring here errs SMALL on a phone for one frame, never large.
  const [fontSize, setFontSize] = useState(targetPx);

  useEffect(() => {
    if (!svgEl || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const width = svgEl.getBoundingClientRect().width;
      if (width <= 0) return;
      const rootPx =
        parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const wanted = (targetPx * (rootPx / 16) * viewBoxWidth) / width;
      setFontSize(Math.min(wanted, viewBoxWidth * MAX_FONT_FRACTION));
    };
    const observer = new ResizeObserver(update);
    observer.observe(svgEl);
    update();
    return () => observer.disconnect();
  }, [svgEl, viewBoxWidth, targetPx]);

  return { svgRef: setSvgEl, fontSize };
}
