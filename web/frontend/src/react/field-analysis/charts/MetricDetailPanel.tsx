/**
 * The detail view for one selected metric: its rank scatter, the field's
 * distribution strip, and whatever field-level summary lines the engine
 * emitted.
 *
 * Rendered under the separation ranking for whichever row is selected —
 * the ranking says WHICH metrics separated the field; this shows HOW.
 */
import { MetricExplanation } from "../MetricExplanation";
import type { FieldAnalysisReport, MetricReport } from "../types";
import { RankScatter } from "./RankScatter";
import { DistributionStrip } from "./DistributionStrip";

export function MetricDetailPanel({
  metric,
  report,
  showAllLabels,
  onShowAllLabelsChange,
}: {
  metric: MetricReport;
  report: FieldAnalysisReport;
  /** Scatter's "label every pilot" toggle — owned by the caller so the
   * choice survives switching metrics. */
  showAllLabels?: boolean;
  onShowAllLabelsChange?: (value: boolean) => void;
}) {
  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="font-medium">
        <span className="inline-flex items-center gap-1">
          {metric.label}
          <MetricExplanation
            metricId={metric.id}
            label={metric.label}
            unit={metric.unit}
            direction={metric.direction}
            explanation={metric.explanation}
          />
        </span>
      </p>
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
