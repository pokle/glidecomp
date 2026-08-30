/**
 * A small decorative bar beside a printed value: where that value sits in its
 * column's own range, so a column of numbers can be scanned as lengths
 * instead of read digit by digit.
 *
 * Deliberately NOT a meter (unlike rac/meter's pair): a table renders dozens
 * of these per family, and a `role="meter"` on every cell would bury a screen
 * reader in announcements that all duplicate the number printed right beside
 * the bar. The number is the reading; the bar is `aria-hidden` scaffolding
 * for the eye, which is also why callers must never render the bar without
 * the number.
 *
 * Length encodes magnitude within the range the caller chose (a column's
 * min–max, or zero–max for a quantity like climb) — never "goodness": which
 * direction of a metric is better stays with the metric's own explanation.
 *
 * The track is translucent (not bg-muted) and print-colour-adjusted for the
 * same two reasons as rac/meter: these sit in tables whose selected row IS
 * bg-muted, and browsers strip plain backgrounds from print.
 */
import { cn } from "@/react/lib/utils";

export function ValueBar({
  fraction,
  className,
}: {
  /** Position in the caller's range, 0–1. Clamped. */
  fraction: number;
  className?: string;
}) {
  const width = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-1.5 w-12 shrink-0 rounded-full bg-foreground/10 [print-color-adjust:exact]",
        className
      )}
    >
      <span
        className="block h-full rounded-full bg-foreground/40"
        style={{ width: `${width}%` }}
      />
    </span>
  );
}
