/**
 * The ⓘ affordance next to a metric label: opens that metric's method
 * description in a popover.
 *
 * A popover rather than a tooltip because the explanation is a sentence or
 * two of method prose the reader needs time with — and because tooltips are
 * hover-only, so touch users would never see it. Twenty-six explanations
 * rendered inline would bury the numbers.
 */
import { InfoIcon } from "lucide-react";
import { Popover, PopoverTrigger } from "@/react/rac/popover";
import { Button } from "@/react/rac/button";
import { DistributionStrip } from "./charts/DistributionStrip";
import type { MetricDirection, PilotMetricValue } from "./types";

/** How a metric's expected relationship to rank reads in prose. */
export function directionWords(direction: MetricDirection): string {
  switch (direction) {
    case "higher":
      return "higher is better";
    case "lower":
      return "lower is better";
    default:
      return "no expected direction";
  }
}

export function MetricExplanation({
  label,
  unit,
  direction,
  explanation,
  perPilot,
}: {
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
        className="size-6 text-muted-foreground"
        // A real accessible name, not a title attribute — the icon alone is
        // not a label, and title tooltips are unavailable to keyboard users.
        aria-label={`How ${label} is measured`}
      >
        <InfoIcon aria-hidden className="size-3.5" />
      </Button>
      <Popover>
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
      </Popover>
    </PopoverTrigger>
  );
}
