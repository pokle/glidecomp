/**
 * The selected metric's scatter, filling the screen.
 *
 * On a phone the pinned chart is ~330px wide, and the plot is drawn on a
 * 560-unit viewBox — so every label renders at about 6px and thirty-odd dots
 * pile into 190px of rank axis. It reads as a smudge. This is the way out:
 * one tap and the same chart gets the whole viewport.
 *
 * Full-screen, following TaskDiagramOverlay (#476) and FullScreenQR (#312):
 * RAC's modal primitives directly rather than the kit's `Modal`, whose
 * `className` styles the PANEL and leaves the overlay's padding and centering
 * hardcoded — no use to a full-bleed sheet. Focus trapping, focus restore,
 * Escape and body scroll-locking all come from react-aria rather than
 * hand-rolled listeners. The sheet uses the app's own surface, not the QR
 * overlay's black backdrop: the scatter is drawn in themed colours and would
 * be near-invisible on black in light mode.
 *
 * It departs from both in one way that matters. Those overlays make the whole
 * sheet one big close target, because a QR and a route glyph are pictures —
 * nothing inside them is clickable. This chart is the opposite: every dot is
 * focusable and names its pilot on tap, and there is a "Label every pilot"
 * checkbox. A tap-anywhere-to-close wrapper would fire on all of it. So
 * dismissal here is Escape (from `isDismissable`) and a real Close button,
 * and nothing else.
 *
 * Why it measures itself: the plot is always W units wide and scales to its
 * CSS width, so its ASPECT decides how much of a tall box it can fill. Left
 * alone at full screen a phone would get the same ~190px-tall strip it
 * already had, just with more white space under it — the expand would look
 * broken. Measuring the sheet and asking for a viewBox of the same shape
 * (RankScatter's `minHeight`) is what actually spends the screen on the rank
 * axis. Portrait gains height; landscape gains scale, so the text finally
 * comes up to a readable size.
 *
 * SSR-safe: the overlay is not rendered until opened, so the server emits
 * only the trigger, and the measuring effect never runs there.
 */
import { useCallback, useState } from "react";
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  ModalOverlay,
} from "react-aria-components";
import { Button } from "@/react/rac/button";
import type { FieldAnalysisReport, MetricReport } from "../types";
import { RankScatter, SCATTER_WIDTH } from "./RankScatter";

/**
 * Room kept below the plot for the rest of the figure — the "Label every
 * pilot" checkbox, the hover readout line and the caption. Measured at
 * 67–115px across phone-to-desktop widths (the caption wraps more when
 * narrow), so 8rem covers it with a little slack. Erring generous only makes
 * the plot slightly smaller than it could be; erring mean makes the sheet
 * scroll, which is the thing a full-screen view exists to avoid. The
 * container scrolls anyway if the estimate is ever wrong.
 */
const CAPTION_ALLOWANCE = 128;

/**
 * Readability ceiling, in the spirit of TaskDiagramOverlay's
 * `min(92vw, 110vh, 1100px)`. The plot is 560 units wide, so a 1600px monitor
 * scales every 10px label to 28px — the chart stops looking like the page it
 * came from and starts looking like a slide. Nothing below a large desktop
 * reaches this, so phones (the reason this overlay exists) are untouched.
 */
const MAX_PLOT_WIDTH = 1100;

export function MetricChartOverlay({
  metric,
  pilots,
  showAllLabels,
  onShowAllLabelsChange,
}: {
  metric: MetricReport;
  pilots: FieldAnalysisReport["pilots"];
  /** Shared with the pinned panel, so ticking it in either place sticks. */
  showAllLabels?: boolean;
  onShowAllLabelsChange?: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 print:hidden"
        // Names the metric: on a page of chart panels "Expand" alone would
        // give a screen reader a column of identical buttons.
        aria-label={`Show ${metric.label} full screen`}
        onPress={() => setOpen(true)}
      >
        <ExpandIcon />
        Expand
      </Button>

      {open ? (
        <ModalOverlay
          isOpen
          isDismissable
          onOpenChange={(next) => {
            if (!next) setOpen(false);
          }}
          className="fixed inset-0 z-[100] bg-background/95 backdrop-blur-sm"
        >
          <AriaModal className="h-full w-full outline-none">
            <AriaDialog
              aria-label={`${metric.label}, plotted against rank`}
              className="h-full w-full outline-none"
            >
              <FullScreenChart
                metric={metric}
                pilots={pilots}
                showAllLabels={showAllLabels}
                onShowAllLabelsChange={onShowAllLabelsChange}
                onClose={() => setOpen(false)}
              />
            </AriaDialog>
          </AriaModal>
        </ModalOverlay>
      ) : null}
    </>
  );
}

function FullScreenChart({
  metric,
  pilots,
  showAllLabels,
  onShowAllLabelsChange,
  onClose,
}: {
  metric: MetricReport;
  pilots: FieldAnalysisReport["pilots"];
  showAllLabels?: boolean;
  onShowAllLabelsChange?: (value: boolean) => void;
  onClose: () => void;
}) {
  // The plot's box, measured. `null` for the first paint only — the chart
  // renders at its natural aspect until the observer reports, which is one
  // frame, and never looks empty.
  const [box, setBox] = useState<{ width: number; height: number } | null>(null);

  // A ref callback rather than useRef + useEffect: the node arrives and
  // departs with the overlay, and this way the observer's lifetime is tied to
  // the node itself rather than to a mount that outlives it.
  const measureRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setBox({ width, height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // Ask for the viewBox shape that matches the space the PLOT will get, so
  // the chart fills the sheet rather than sitting letterboxed in the middle
  // of an empty screen.
  const plotHeight = box ? Math.max(140, box.height - CAPTION_ALLOWANCE) : null;
  // The width the chart will actually be drawn at — the ceiling included, or
  // the aspect would be computed for a width the chart never gets and a wide
  // monitor would come out letterboxed.
  const plotWidth = box ? Math.min(box.width, MAX_PLOT_WIDTH) : null;
  const minHeight =
    plotWidth !== null && plotHeight !== null
      ? (SCATTER_WIDTH * plotHeight) / plotWidth
      : undefined;
  // Deliberately no width cap in the other regime. A box WIDER than the
  // plot's own 560×300 shape — a landscape phone, any desktop — asks for a
  // height under the floor, so the request is ignored and the chart keeps its
  // natural aspect, which at full width is taller than the box. Shrinking it
  // to fit was tried and is worse: on a 780×390 phone it produced a chart
  // SMALLER than the one already on the page. Full width and a short scroll
  // beats a chart that got smaller when you asked to expand it.

  return (
    <div className="flex h-full w-full flex-col gap-2 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-3">
        <h2 className="min-w-0 truncate text-base font-semibold">{metric.label}</h2>
        {/* autoFocus so a keyboard user lands on the way out rather than on
            the dialog container, which is what RAC would focus otherwise.
            Escape works too, but it is not a discoverable affordance (§4.1)
            and this sheet has no tap-anywhere target to fall back on. */}
        <Button autoFocus variant="outline" size="sm" onPress={onClose}>
          Close
        </Button>
      </div>

      {/* min-h-0 is what lets this actually shrink to the leftover space —
          a flex item's default min-height is its content, so without it the
          chart would push the Close button off the bottom instead of being
          measured against what is left. overflow-auto is the safety net for
          the case the sheet is shorter than the chart's own minimum. */}
      <div ref={measureRef} className="min-h-0 w-full flex-1 overflow-auto">
        <div className="mx-auto w-full" style={{ maxWidth: MAX_PLOT_WIDTH }}>
          <RankScatter
            metric={metric}
            pilots={pilots}
            showAllLabels={showAllLabels}
            onShowAllLabelsChange={onShowAllLabelsChange}
            minHeight={minHeight}
          />
        </div>
      </div>
    </div>
  );
}

/** Four corners pushing out — the usual "fill the screen" glyph. */
function ExpandIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path
        d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
