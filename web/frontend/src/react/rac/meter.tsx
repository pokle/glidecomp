/**
 * React Aria Components Meter — a measurement within a known range.
 *
 * Deliberately Meter and not ProgressBar: a correlation coefficient is a
 * reading, not the completion of a task, and `role="meter"` is what tells a
 * screen reader so.
 *
 * The only consumer so far is the field-analysis separation ranking, whose
 * value is a signed Spearman ρ in [-1, 1] — hence DivergingMeter below,
 * which renders from a centred zero axis. Sign is encoded by WHICH SIDE the
 * bar grows toward, never by colour alone, and the signed number is always
 * printed beside it (WCAG 1.4.1 Use of Color).
 */
import {
  Meter as AriaMeter,
  type MeterProps as AriaMeterProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

export function Meter({
  className,
  ...props
}: Omit<AriaMeterProps, "className"> & { className?: string }) {
  return <AriaMeter className={cn("flex items-center", className)} {...props} />;
}

/**
 * A bar growing left or right from a centred zero axis.
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
    <Meter
      // aria-valuenow must be the magnitude to sit inside minValue/maxValue,
      // so aria-valuetext (via valueLabel) carries the signed reading — that
      // is what a screen reader actually announces.
      value={magnitude}
      minValue={0}
      maxValue={1}
      aria-label={label}
      valueLabel={text}
      className={cn("w-full", className)}
    >
      <div
        aria-hidden
        className="relative h-2 w-full rounded-full bg-muted"
      >
        {/* The zero axis. Always visible, so a near-zero bar still reads as
            "no correlation" rather than as a rendering glitch. */}
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" />
        <div
          className="absolute inset-y-0 rounded-full bg-foreground/60"
          style={
            clamped < 0
              ? { right: "50%", width: `${magnitude * 50}%` }
              : { left: "50%", width: `${magnitude * 50}%` }
          }
        />
      </div>
    </Meter>
  );
}
