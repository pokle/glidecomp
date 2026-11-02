/**
 * One metric's rank scatter at full size, on a page of its own (#815).
 *
 * /comp/:compId/task/:taskId/analysis/metrics/:metric — reached by the Expand
 * link beside the chart on the Winning strategies page, and left with the
 * browser's Back. It was a full-screen overlay (MetricChartOverlay) until the
 * "No full-screen overlays" rule in CLAUDE.md: a fixed layer over a scrolled
 * page, with its own Escape, Close button and focus return, all of which a
 * page gets from the browser.
 *
 * Why it exists at all: on a phone the inline chart is a few hundred pixels
 * wide, and the plot is drawn on a 560-unit viewBox, so its labels render at
 * about 6px. Here the chart has the page's whole width, and asks for a
 * viewBox the shape of the screen, so the rank axis spends the height too.
 *
 * Nothing is handed over from the page underneath. The report comes from
 * use-task-report.ts like every sibling (seeded by SSR on a hard load), the
 * metric is named by the URL, and the class and the pinned pilot ride in the
 * query — so a reload and a shared link both open the same chart. A segment
 * no metric in the report answers to is a not-found.
 *
 * PUBLIC and SSR'd through the same loader as its siblings (functions/comp/
 * [[path]].ts), but always noindexed: it is a bigger copy of a chart the
 * Winning strategies page already shows, one per metric, and a search engine
 * should list the page that explains it rather than thirty copies of it.
 *
 * SSR-safe: the measuring effect never runs on the server, and the first
 * client render draws the chart at its natural aspect, as the server did.
 */
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Card } from "@/react/rac/card";
import { NotFound } from "../components/NotFound";
import {
  compUrlId,
  metricSegment,
  taskAnalysisMetricPath,
} from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { TaskAnalysisFrame } from "../analysis/TaskAnalysisFrame";
import { useTaskAnalysis } from "../analysis/use-task-report";
import { findTaskAnalysisSection } from "../analysis/sections";
import { RankScatter, SCATTER_WIDTH } from "../analysis/charts/RankScatter";
import type { MetricReport, TaskAnalysisReport } from "../analysis/types";

/** The section this page hangs off: the one that holds every metric. */
const METRICS_SECTION = findTaskAnalysisSection("metrics")!;

/**
 * Room kept below the plot for the rest of the figure — the "Label every
 * pilot" checkbox, the hover readout line and the caption. Measured at
 * 67–115px across phone-to-desktop widths (the caption wraps more when
 * narrow), so 8rem covers it with a little slack. Erring generous only makes
 * the plot slightly smaller than it could be.
 */
const CAPTION_ALLOWANCE = 128;

/**
 * Readability ceiling. The plot is 560 units wide, so a 1600px monitor would
 * scale every 10px label to 28px and the chart would stop looking like the
 * page it came from. Nothing below a large desktop reaches this, so phones
 * (the reason this page exists) are untouched.
 */
const MAX_PLOT_WIDTH = 1100;

export function TaskAnalysisMetricChart() {
  const { metric: segment } = useParams<{ metric: string }>();
  const bundle = useTaskAnalysis();
  const { compId, taskId, comp, task, report } = bundle;

  // Resolved against the report the page fetched — the only list of metrics
  // there is. Null while the report is still on its way (or pending), when
  // the frame shows those states under the parent section's name.
  const metric =
    report?.metrics.find((m) => metricSegment(m.id) === segment) ?? null;

  // Settle the address bar on the canonical `${slug}-${id}` once both names
  // load, carrying a hidden comp's share key (compUrlId).
  useCanonicalPath(
    comp && task && metric
      ? taskAnalysisMetricPath(
          compUrlId(comp, compId),
          comp.name,
          taskId,
          task.name,
          metric.id
        )
      : null
  );

  // A report in hand with no such metric: a dead URL, not an empty chart.
  if (report && !metric) return <NotFound title="Metric not found" />;

  return (
    <TaskAnalysisFrame
      bundle={bundle}
      section={
        metric
          ? { label: metric.label, lede: "Plotted against rank." }
          : METRICS_SECTION
      }
      parent={metric ? METRICS_SECTION : undefined}
      // The scatter tints the pinned pilot, as it does on the strategies page.
      pilotPicker
    >
      {({ report }) =>
        metric ? <FullSizeChart metric={metric} pilots={report.pilots} /> : null
      }
    </TaskAnalysisFrame>
  );
}

function FullSizeChart({
  metric,
  pilots,
}: {
  metric: MetricReport;
  pilots: TaskAnalysisReport["pilots"];
}) {
  const [showAllLabels, setShowAllLabels] = useState(false);
  const { boxRef, minHeight } = useScreenShapedPlot();
  return (
    <Card className="gap-2 p-3 sm:p-4">
      <div ref={boxRef} className="w-full">
        <div className="mx-auto w-full" style={{ maxWidth: MAX_PLOT_WIDTH }}>
          <RankScatter
            metric={metric}
            pilots={pilots}
            showAllLabels={showAllLabels}
            onShowAllLabelsChange={setShowAllLabels}
            minHeight={minHeight}
          />
        </div>
      </div>
    </Card>
  );
}

/**
 * Ask RankScatter for the viewBox shape of the SCREEN, so the chart fills it
 * once scrolled to rather than sitting in a ~190px strip.
 *
 * The plot is always SCATTER_WIDTH units wide and scales to its CSS width, so
 * its aspect decides how much height it can use. The height it can have is
 * the window, less the site header where that header is sticky (it covers
 * the top of whatever is scrolled under it) and the caption below the plot.
 *
 * Portrait gains height; landscape asks for a height under the scatter's own
 * floor, which RankScatter ignores, so the chart keeps its natural aspect at
 * full width — taller than the window, and a short scroll. Shrinking it to
 * fit was tried in the overlay this replaced, and made the chart SMALLER than
 * the one on the page it was opened from.
 */
function useScreenShapedPlot() {
  const boxRef = useRef<HTMLDivElement>(null);
  const [minHeight, setMinHeight] = useState<number | undefined>();

  useEffect(() => {
    const el = boxRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    const update = () => {
      if (window.matchMedia("print").matches) {
        setMinHeight(undefined);
        return;
      }
      const width = Math.min(el.clientWidth, MAX_PLOT_WIDTH);
      if (width <= 0) return;
      const header = document.querySelector("header");
      const headerPx =
        header instanceof HTMLElement &&
        getComputedStyle(header).position === "sticky"
          ? header.offsetHeight
          : 0;
      const plotPx = Math.max(140, window.innerHeight - headerPx - CAPTION_ALLOWANCE);
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
  }, []);

  return { boxRef, minHeight };
}
