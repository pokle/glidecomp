/**
 * An absolute timestamp shown in a competition-aware time zone. Tapping or
 * clicking it cycles through the zones it knows about — the competition zone
 * (when given), the viewer's own local zone, and UTC — so a reader can see
 * the instant in whichever frame they think in. Each zone is labelled with
 * its abbreviated name plus numeric offset when available (e.g.
 * "AEST (GMT+10)"), falling back to the offset alone or "UTC".
 *
 * Use this everywhere an absolute instant is shown (e.g. "Scores computed …")
 * so the format and the click-to-switch affordance stay consistent.
 *
 * Built on the react-aria-components kit (RAC `Button` + `Tooltip`): the
 * press handling is unified across mouse/touch/keyboard by RAC, and the hint
 * is a real `Tooltip` rather than a `title` attribute (which never surfaced
 * for keyboard or touch users). Kept inline — no button chrome — so it reads
 * as tappable text, not a control.
 */
import { useEffect, useState } from "react";
import { Button } from "react-aria-components";
import { cn } from "@/react/lib/utils";
import { Tooltip, TooltipTrigger } from "../rac/tooltip";
import { buildZoneCycle } from "../lib/time";

export function Timestamp({
  value,
  compTimezone = null,
  className,
}: {
  /** The instant to display, as an ISO 8601 string. */
  value: string;
  /** The competition's IANA zone, when this instant belongs to a comp. */
  compTimezone?: string | null;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  // The viewer's local zone is only knowable in the browser; add it after
  // mount so the server and first client render agree (no hydration mismatch).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const date = new Date(value);
  const choices = buildZoneCycle(date, compTimezone, mounted);
  if (choices.length === 0) return null;

  const current = choices[index % choices.length];
  const iso = date.toISOString();

  // A single distinct zone: nothing to cycle to, so render plain static text.
  if (choices.length === 1) {
    return (
      <time dateTime={iso} className={className} title={`Shown in ${current.kindLabel}`}>
        {current.text}
      </time>
    );
  }

  const zoneList = choices.map((c) => c.kindLabel).join(", ");
  return (
    <TooltipTrigger>
      <Button
        onPress={() => setIndex((i) => (i + 1) % choices.length)}
        aria-label={`${current.text}, ${current.kindLabel}. Activate to change time zone.`}
        className={cn(
          "cursor-pointer rounded-sm underline decoration-dotted decoration-muted-foreground/50 underline-offset-2 outline-none transition-colors data-hovered:decoration-foreground data-focus-visible:ring-2 data-focus-visible:ring-ring",
          className
        )}
      >
        <time dateTime={iso}>{current.text}</time>
      </Button>
      <Tooltip>
        Shown in {current.kindLabel} — click to change ({zoneList})
      </Tooltip>
    </TooltipTrigger>
  );
}
