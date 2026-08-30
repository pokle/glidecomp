/**
 * The detail view for one selected metric: its rank scatter, the field's
 * distribution strip, and whatever field-level summary lines the engine
 * emitted.
 *
 * Rendered under the separation ranking for whichever row is selected —
 * the ranking says WHICH metrics separated the field; this shows HOW. Also
 * rendered print-only for every strong-verdict metric.
 *
 * The chart is the pane's highlight. The metric's method prose lives in a
 * disclosure BELOW it ("How this is measured") so neither a phone nor the
 * sticky desktop column is a paragraph with a smudge under it. Print expands
 * the disclosure — paper has no tap.
 *
 * The metric name is a real heading with a stable id (`headingId`) so the
 * pane around it can be a `role="region"` labelled by it. On the task page
 * this panel is DOM-ordered BEFORE the ranking table it details (MasterDetail
 * puts the pane first so it can pin, or so stacked navigation can swap
 * which half is on screen), so it has to announce what it is rather than
 * rely on following the table that explains it.
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { cn } from "@/react/lib/utils";
import { Disclosure } from "@/react/rac/disclosure";
import { MetricMethod } from "../MetricExplanation";
import type { TaskAnalysisReport, MetricReport } from "../types";
import { RankScatter, SCATTER_WIDTH } from "./RankScatter";
import { DistributionStrip } from "./DistributionStrip";

/**
 * Room kept below the plot for the rest of the figure (checkbox, readout,
 * caption) when filling leftover height in the side-by-side column. Same
 * budget as MetricChartOverlay.
 */
const CAPTION_ALLOWANCE = 128;

/** Stacked, the plot spends this fraction of the viewport on the rank axis. */
const STACKED_PLOT_VH = 0.7;

export function MetricDetailPanel({
  metric,
  report,
  showAllLabels,
  onShowAllLabelsChange,
  headingId,
  headingLevel = 3,
  headerAction,
  fillViewport = false,
  className,
}: {
  metric: MetricReport;
  report: TaskAnalysisReport;
  /** Scatter's "label every pilot" toggle — owned by the caller so the
   * choice survives switching metrics. */
  showAllLabels?: boolean;
  onShowAllLabelsChange?: (value: boolean) => void;
  /** id put on the metric-name heading, for an `aria-labelledby` outside. */
  headingId?: string;
  /** Depth of the metric-name heading — 4 when the panel sits under a
   * heading of its own (the print block), 3 when it is the section's own
   * first level. */
  headingLevel?: 3 | 4;
  /** Control rendered opposite the metric name — the full-screen trigger.
   * Absent in print, which has no screen to fill. */
  headerAction?: ReactNode;
  /**
   * Grow the scatter to fill the screen (stacked) or the leftover column
   * (side by side). Print copies leave this off so a pair still fits A4.
   */
  fillViewport?: boolean;
  className?: string;
}) {
  const Heading = headingLevel === 4 ? "h4" : "h3";
  const { plotRef, minHeight } = usePlotMinHeight(fillViewport);
  return (
    <div
      className={cn(
        "space-y-3 rounded-lg border p-4",
        // Side by side the pane is a fixed-height column; this fills it so
        // the scatter can measure the leftover and spend it on the rank axis.
        fillViewport && "@5xl:flex @5xl:h-full @5xl:min-h-0 @5xl:flex-col",
        className
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <Heading id={headingId} className="min-w-0 font-medium">
          {metric.label}
        </Heading>
        {headerAction}
      </div>
      <div
        ref={plotRef}
        className={cn(
          "w-full",
          // Stacked: reserve most of the viewport on first paint. Side by
          // side: flex-1 is the leftover in the sticky column (the thing
          // we measure). Paper sizes from content.
          fillViewport &&
            "min-h-[70dvh] @5xl:min-h-0 @5xl:flex-1 @5xl:overflow-auto print:min-h-0"
        )}
      >
        <RankScatter
          metric={metric}
          pilots={report.pilots}
          showAllLabels={showAllLabels}
          onShowAllLabelsChange={onShowAllLabelsChange}
          minHeight={minHeight}
        />
      </div>
      <DistributionStrip metric={metric} />
      {metric.fieldSummary && metric.fieldSummary.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {metric.fieldSummary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <Disclosure title="How this is measured" headingLevel={4}>
        <MetricMethod
          unit={metric.unit}
          direction={metric.direction}
          explanation={metric.explanation}
          className="mt-1"
        />
      </Disclosure>
    </div>
  );
}

/**
 * Ask RankScatter for the viewBox height that matches the space we want the
 * plot to occupy. Stacked that is most of the viewport; side by side it is
 * the flex-1 leftover in the sticky column (the same conversion the
 * full-screen overlay uses).
 *
 * SSR-safe: the observer is an effect, so the server and the first client
 * paint agree (BASE_H), then the chart grows.
 */
function usePlotMinHeight(enabled: boolean): {
  plotRef: RefObject<HTMLDivElement | null>;
  minHeight: number | undefined;
} {
  const plotRef = useRef<HTMLDivElement>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>();

  useEffect(() => {
    if (!enabled) return;
    const el = plotRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const update = () => {
      if (typeof window === "undefined" || window.matchMedia("print").matches) {
        setMinHeight(undefined);
        return;
      }
      const width = el.clientWidth;
      if (width <= 0) return;
      // Nearly full-bleed means stacked: the pane is the view, and there is
      // no parent height to flex into, so we claim most of the viewport.
      // Side by side the wrapper is flex-1 in a fixed-height column — measure
      // that box, not the window leftover, or an unscrolled page (heading,
      // lede, picker still above the pair) would size a short strip that
      // never grew once the column stuck.
      const stacked = width >= window.innerWidth * 0.75;
      const boxH = el.clientHeight;
      const plotPx = stacked
        ? window.innerHeight * STACKED_PLOT_VH
        : Math.max(140, boxH - CAPTION_ALLOWANCE);
      setMinHeight((SCATTER_WIDTH * plotPx) / width);
    };

    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    const printMq = window.matchMedia("print");
    printMq.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      printMq.removeEventListener("change", update);
    };
  }, [enabled]);

  return { plotRef, minHeight };
}
