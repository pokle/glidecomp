/**
 * The ⓘ affordance next to a metric label: opens that metric's method
 * description in a popover.
 *
 * A popover rather than a tooltip because the explanation is a sentence or
 * two of method prose the reader needs time with — and because tooltips are
 * hover-only, so touch users would never see it. Twenty-six explanations
 * rendered inline would bury the numbers.
 *
 * The same prose also lives in the page's metric glossary (MetricGlossary);
 * the popover links there so a reader can jump from any table to the full
 * reference. In print the ⓘ is hidden — a popover cannot exist on paper, and
 * the glossary is the printed form of every explanation.
 */
import { InfoIcon } from "lucide-react";
import { Popover, PopoverTrigger } from "@/react/rac/popover";
import { Button } from "@/react/rac/button";
import { DistributionStrip } from "./charts/DistributionStrip";
import { glossaryEntryId } from "./MetricGlossary";
import { directionWords } from "./units";
import type { MetricDirection, PilotMetricValue } from "./types";

export { directionWords };

export function MetricExplanation({
  metricId,
  label,
  unit,
  direction,
  explanation,
  perPilot,
}: {
  /** When provided, the popover links to this metric's glossary entry —
   * only pass it on pages that render a MetricGlossary. */
  metricId?: string;
  label: string;
  unit: string;
  direction: MetricDirection;
  explanation: string;
  /** When provided, the popover also shows the field's distribution — the
   * method AND where the field actually landed, in one stop. */
  perPilot?: PilotMetricValue[];
}) {
  return (
    <PopoverTrigger>
      <Button
        variant="ghost"
        size="icon"
        // size-6 (24px), the accessibility standard's §4.5 pointer-target
        // floor (WCAG 2.5.8) — this button sits crowded inside sortable
        // column headers, so it gets no spacing exemption.
        className="size-6 text-muted-foreground print:hidden"
        // A real accessible name, not a title attribute — the icon alone is
        // not a label, and title tooltips are unavailable to keyboard users.
        aria-label={`How ${label} is measured`}
      >
        <InfoIcon aria-hidden className="size-3.5" />
      </Button>
      <Popover>
        {({ close }) => (
          <>
            <p className="font-medium">{label}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Measured in {unit} · {directionWords(direction)}
            </p>
            <p className="mt-2">{explanation}</p>
            {perPilot && perPilot.some((p) => p.value !== null) ? (
              <div className="mt-2">
                <DistributionStrip metric={{ label, unit, perPilot }} compact />
              </div>
            ) : null}
            {metricId ? (
              // A plain hash link: the browser scrolls (honouring the
              // entry's scroll-margin) and the hash lands in the URL, so
              // the spot is shareable. Closing first keeps the popover from
              // floating over the glossary after the jump.
              <a
                href={`#${glossaryEntryId(metricId)}`}
                onClick={() => close()}
                className="mt-2 inline-block text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                Read in the metric glossary
              </a>
            ) : null}
          </>
        )}
      </Popover>
    </PopoverTrigger>
  );
}
