/**
 * The ⓘ affordance next to a metric label: opens that metric's method
 * description in a popover.
 *
 * The trigger itself is the kit's {@link Explain} — this adds what a METRIC
 * needs on top of it: its unit and direction, the field's distribution, the
 * pilots it does not apply to, and a link into the glossary. Twenty-six
 * explanations rendered inline would bury the numbers.
 *
 * The same prose also lives in the page's metric glossary (MetricGlossary);
 * the popover links there so a reader can jump from any table to the full
 * reference. In print the ⓘ is hidden — a popover cannot exist on paper, and
 * the glossary is the printed form of every explanation.
 */
import { Explain } from "@/react/rac/explain";
import { cn } from "@/react/lib/utils";
import { DistributionStrip } from "./charts/DistributionStrip";
import { glossaryEntryId } from "./MetricGlossary";
import { directionWords, unitWords } from "./units";
import { notableExcludedRanks, notableRanksPhrase } from "./exclusions";
import type { TaskAnalysisReport, MetricDirection, PilotMetricValue } from "./types";

export { directionWords };

/**
 * The ⓘ text, inline: unit + direction, then the method prose. Chart blocks
 * render this in a disclosure below the scatter ("How this is measured") so
 * the plot is the pane's highlight, on screen and on paper alike — print
 * expands the disclosure; there is no popover to lose. The ⓘ popover stays
 * for the metrics named inside dense tables, where twenty-six inline
 * explanations would bury the numbers.
 */
export function MetricMethod({
  unit,
  direction,
  explanation,
  className,
}: {
  unit: string;
  direction: MetricDirection;
  explanation: string;
  className?: string;
}) {
  return (
    <div className={cn("text-muted-foreground", className)}>
      <p className="text-xs">
        Measured in {unitWords(unit)} · {directionWords(direction)}
      </p>
      <p className="mt-0.5 text-sm">{explanation}</p>
    </div>
  );
}

export function MetricExplanation({
  metricId,
  label,
  unit,
  direction,
  family,
  explanation,
  perPilot,
  pilots,
}: {
  /** When provided, the popover links to this metric's glossary entry —
   * only pass it on pages that render a MetricGlossary. */
  metricId?: string;
  label: string;
  unit: string;
  direction: MetricDirection;
  /** The family label, for tables that don't group by family — it names the
   * section further down the page where this metric is detailed. Omitted
   * inside a family's own section, where it would only restate the heading. */
  family?: string;
  explanation: string;
  /** When provided, the popover also shows the field's distribution — the
   * method AND where the field actually landed, in one stop. */
  perPilot?: PilotMetricValue[];
  /** When provided (with perPilot), the popover states how many pilots the
   * metric is not applicable to — naming any top-3 ranked ones, since a
   * correlation computed without the winner must say so. */
  pilots?: TaskAnalysisReport["pilots"];
}) {
  const excludedCount =
    pilots && perPilot
      ? pilots.length -
        perPilot.filter((p) => p.value !== null && Number.isFinite(p.value)).length
      : 0;
  const notable =
    pilots && perPilot && excludedCount > 0 ? notableExcludedRanks(pilots, perPilot) : [];
  return (
    <Explain
      label={label}
      ariaLabel={`How ${label} is measured`}
      sublabel={
        <>
          {/* unitWords, matching MetricMethod above: "Measured in pct" was
              the raw token leaking into prose. */}
          Measured in {unitWords(unit)} · {directionWords(direction)}
          {family ? ` · detailed under ${family}` : ""}
        </>
      }
      {...(metricId
        ? {
            footnoteHref: `#${glossaryEntryId(metricId)}`,
            footnoteLabel: "Read in the metric glossary",
          }
        : {})}
    >
      <p>{explanation}</p>
      {perPilot && perPilot.some((p) => p.value !== null) ? (
        <DistributionStrip metric={{ label, unit, perPilot }} compact />
      ) : null}
      {excludedCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          Not applicable for {excludedCount} pilot
          {excludedCount === 1 ? "" : "s"}
          {notable.length > 0 ? `, including ${notableRanksPhrase(notable)}` : ""}
          {" — they are excluded from the chart and the correlation."}
        </p>
      ) : null}
    </Explain>
  );
}
