/**
 * The detail view for one selected metric: its rank scatter, the field's
 * distribution strip, and whatever field-level summary lines the engine
 * emitted.
 *
 * Rendered under the separation ranking for whichever row is selected —
 * the ranking says WHICH metrics separated the field; this shows HOW. Also
 * rendered print-only for every strong-verdict metric.
 *
 * The metric's method prose renders inline under the heading (MetricMethod)
 * rather than behind a ⓘ popover: the panel is a reading surface, not a
 * dense table, and print has no popovers at all.
 *
 * The metric name is a real heading with a stable id (`headingId`) so the
 * pane around it can be a `role="region"` labelled by it. On the task page
 * this panel is DOM-ordered BEFORE the ranking table it details (that is what
 * lets it pin to the top of a narrow viewport), so it has to announce what it
 * is rather than rely on following the table that explains it.
 */
import { cn } from "@/react/lib/utils";
import { MetricMethod } from "../MetricExplanation";
import type { FieldAnalysisReport, MetricReport } from "../types";
import { RankScatter } from "./RankScatter";
import { DistributionStrip } from "./DistributionStrip";

export function MetricDetailPanel({
  metric,
  report,
  showAllLabels,
  onShowAllLabelsChange,
  headingId,
  headingLevel = 3,
  methodClassName,
  className,
}: {
  metric: MetricReport;
  report: FieldAnalysisReport;
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
  /** Extra classes on the method prose. The pinned pane drops it on a narrow
   * screen (`hidden @5xl:block`): pinned, the panel gets a few hundred
   * pixels, and a paragraph of method spends all of them before the chart —
   * which is the thing being pinned. The same prose is one ⓘ away on the
   * row that selected it. */
  methodClassName?: string;
  className?: string;
}) {
  const Heading = headingLevel === 4 ? "h4" : "h3";
  return (
    <div className={cn("space-y-3 rounded-lg border p-4", className)}>
      <div>
        <Heading id={headingId} className="font-medium">
          {metric.label}
        </Heading>
        <MetricMethod
          unit={metric.unit}
          direction={metric.direction}
          explanation={metric.explanation}
          className={cn("mt-1", methodClassName)}
        />
      </div>
      <RankScatter
        metric={metric}
        pilots={report.pilots}
        showAllLabels={showAllLabels}
        onShowAllLabelsChange={onShowAllLabelsChange}
      />
      <DistributionStrip metric={metric} />
      {metric.fieldSummary && metric.fieldSummary.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {metric.fieldSummary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
