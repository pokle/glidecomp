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
import type { MetricDirection } from "./types";

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
}: {
  label: string;
  unit: string;
  direction: MetricDirection;
  explanation: string;
}) {
  return (
    <PopoverTrigger>
      <Button
        variant="ghost"
        size="icon"
        className="size-5 text-muted-foreground"
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
      </Popover>
    </PopoverTrigger>
  );
}
