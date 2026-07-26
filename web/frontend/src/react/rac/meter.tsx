/**
 * React Aria Components Meter — a measurement within a known range.
 *
 * Deliberately Meter and not ProgressBar: a correlation coefficient is a
 * reading, not the completion of a task, and `role="meter"` is what tells a
 * screen reader so.
 *
 * The consumers so far are both in the field-analysis separation ranking:
 * DivergingMeter for a signed Spearman ρ in [-1, 1], which grows from the
 * centre of its track, and ProportionMeter for a part of a whole (how much of
 * the field a correlation actually measured). Sign is encoded by WHICH SIDE
 * the bar grows toward, never by colour alone, and the number is always
 * printed beside the bar (WCAG 1.4.1 Use of Color).
 */
import { Meter as AriaMeter } from "react-aria-components";

import { cn } from "@/react/lib/utils";

/** Floor width of a diverging bar: what an all-but-zero reading still draws,
 * so the centre stays marked without a rule of its own. */
const ZERO_TICK = "2px";

/**
 * A bar growing left or right from the centre — zero.
 *
 * @param value      signed, in [-maxMagnitude, maxMagnitude]
 * @param label      what is being measured — becomes the accessible name
 * @param valueLabel how the number reads aloud (e.g. "-0.62"); defaults to
 *                   the value fixed to 2dp
 */
export function DivergingMeter({
  value,
  label,
  valueLabel,
  maxMagnitude = 1,
  className,
}: {
  value: number;
  label: string;
  valueLabel?: string;
  maxMagnitude?: number;
  className?: string;
}) {
  const clamped = Math.max(-maxMagnitude, Math.min(maxMagnitude, value));
  const magnitude = Math.abs(clamped) / maxMagnitude;
  const text = valueLabel ?? clamped.toFixed(2);

  return (
    <AriaMeter
      // aria-valuenow must be the magnitude to sit inside minValue/maxValue,
      // so aria-valuetext (via valueLabel) carries the signed reading — that
      // is what a screen reader actually announces.
      value={magnitude}
      minValue={0}
      maxValue={1}
      aria-label={label}
      valueLabel={text}
      className={cn("flex w-full items-center", className)}
    >
      <div
        aria-hidden
        // A translucent track, not bg-muted: these bars sit in a table whose
        // selected row IS bg-muted, and a track that vanishes under the
        // selection takes the scale of the reading with it.
        //
        // print-color-adjust: the bar IS the reading — without it, browsers
        // strip the backgrounds and print an empty track.
        className="relative h-2 w-full rounded-full bg-foreground/10 [print-color-adjust:exact]"
      >
        {/* There is deliberately no separate zero-axis rule. The bar always
            starts at the centre, so its inner edge already marks zero — and a
            1px axis there could only ever peek out from behind the bar's
            rounded end (Safari and Chrome both drew a hairline beside the
            pill). Instead the bar itself carries a floor width, so a near-zero
            reading still shows a tick at the centre rather than nothing at
            all: "no correlation", not a rendering glitch. */}
        <div
          className="absolute inset-y-0 rounded-full bg-foreground/60"
          style={
            magnitude === 0
              ? { left: "50%", width: ZERO_TICK, transform: "translateX(-50%)" }
              : clamped < 0
                ? { right: "50%", width: `max(${ZERO_TICK}, ${magnitude * 50}%)` }
                : { left: "50%", width: `max(${ZERO_TICK}, ${magnitude * 50}%)` }
          }
        />
      </div>
    </AriaMeter>
  );
}

/**
 * A bar filling left-to-right: a part of a known whole.
 *
 * Deliberately plainer than DivergingMeter (thinner, no axis) — where the two
 * sit side by side in one table, the reading is the diverging one and this is
 * context for it.
 *
 * @param value      the part, in [0, total]
 * @param total      the whole; a zero or negative total renders an empty bar
 * @param label      what is being measured — becomes the accessible name
 * @param valueLabel how the reading reads aloud (e.g. "19 of 29 pilots");
 *                   defaults to "<value> of <total>"
 */
export function ProportionMeter({
  value,
  total,
  label,
  valueLabel,
  className,
}: {
  value: number;
  total: number;
  label: string;
  valueLabel?: string;
  className?: string;
}) {
  const fraction = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0;

  return (
    <AriaMeter
      value={fraction}
      minValue={0}
      maxValue={1}
      aria-label={label}
      valueLabel={valueLabel ?? `${value} of ${total}`}
      className={cn("flex items-center", className)}
    >
      <div
        aria-hidden
        // Translucent track + print-color-adjust, for the same two reasons
        // as above.
        className="h-1.5 w-full rounded-full bg-foreground/10 [print-color-adjust:exact]"
      >
        <div
          className="h-full rounded-full bg-foreground/40"
          style={{ width: `${fraction * 100}%` }}
        />
      </div>
    </AriaMeter>
  );
}
