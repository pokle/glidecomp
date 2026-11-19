/**
 * React Aria Components Meter — a measurement within a known range.
 *
 * Deliberately Meter and not ProgressBar: a correlation coefficient is a
 * reading, not the completion of a task, and `role="meter"` is what tells a
 * screen reader so.
 *
 * The consumers so far are the task and comp analysis rankings:
 * DivergingMeter for a signed Spearman ρ in [-1, 1], which grows from the
 * centre of its track; DotMeter for the same reading as one mark on a track a
 * whole list shares; and ProportionMeter for a part of a whole (how much of
 * the field a correlation actually measured). Sign is encoded by WHICH SIDE
 * the bar grows toward, never by colour alone, and the number is always
 * printed beside the bar (WCAG 1.4.1 Use of Color).
 */
import { Meter as AriaMeter } from "react-aria-components";

import { cn } from "@/react/lib/utils";

/** Floor width of a diverging bar: what an all-but-zero reading still draws,
 * so the centre stays marked without a rule of its own. A hollow bar needs a
 * wider floor than a solid one — its 1px border on each side would otherwise
 * meet in the middle and draw the outline as a solid tick, which is the one
 * thing `hollow` exists to say it is not. */
const ZERO_TICK = "2px";
const ZERO_TICK_HOLLOW = "5px";

/**
 * A bar growing left or right from the centre — zero.
 *
 * @param value      signed, in [-maxMagnitude, maxMagnitude]
 * @param label      what is being measured — becomes the accessible name
 * @param valueLabel how the number reads aloud (e.g. "-0.62"); defaults to
 *                   the value fixed to 2dp
 * @param hollow     draw the bar as an outline rather than a solid fill: the
 *                   reading is positioned honestly but is not evidence (the
 *                   comp page's per-task cells use it for a ρ that did not
 *                   clear its noise floor). Outline vs fill is a shape
 *                   difference, so it survives greyscale and print; the
 *                   caller still has to say so in `valueLabel`.
 */
export function DivergingMeter({
  value,
  label,
  valueLabel,
  maxMagnitude = 1,
  hollow = false,
  className,
}: {
  value: number;
  label: string;
  valueLabel?: string;
  maxMagnitude?: number;
  hollow?: boolean;
  className?: string;
}) {
  const clamped = Math.max(-maxMagnitude, Math.min(maxMagnitude, value));
  const magnitude = Math.abs(clamped) / maxMagnitude;
  const text = valueLabel ?? clamped.toFixed(2);
  const floor = hollow ? ZERO_TICK_HOLLOW : ZERO_TICK;

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
          className={cn(
            "absolute inset-y-0 rounded-full",
            hollow
              ? "border border-foreground/50 bg-background/60"
              : "bg-foreground/60"
          )}
          style={
            magnitude === 0
              ? { left: "50%", width: floor, transform: "translateX(-50%)" }
              : clamped < 0
                ? { right: "50%", width: `max(${floor}, ${magnitude * 50}%)` }
                : { left: "50%", width: `max(${floor}, ${magnitude * 50}%)` }
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

/** Where a signed reading sits across a track, in percent: the centre is
 * zero. */
function trackPercent(value: number, maxMagnitude: number): number {
  return (value / maxMagnitude + 1) * 50;
}

/** The gridlines every dot track and its axis share. */
const DOT_TICKS = [-1, -0.5, 0, 0.5, 1];

/** A signed reading in words a figure can carry: "+0.79", "−0.55", "0.00". */
export function formatSigned(value: number, digits = 2): string {
  const text = Math.abs(value).toFixed(digits);
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text;
}

/**
 * A signed reading as ONE mark on a track that many rows share: a dot at the
 * value, a line back to zero, and the number beside it.
 *
 * For a list of readings that are compared with one another (the behaviour
 * ranking). A row used to carry a bar for its strength and a second bar for
 * the pilots measured, one above the other on a phone, and the two read as
 * the same unit. Here there is one mark a row and one axis for the list,
 * drawn once above it by {@link DotMeterAxis}; the gridlines in each row line
 * up with that axis because both are laid out in percent of the same width.
 *
 * `hollow` draws the dot as an outline: the reading is placed honestly but is
 * not evidence. Outline against fill is a difference of shape, so it survives
 * greyscale and print; the caller still says so in words beside it.
 *
 * Laid out in CSS percentages, with no measuring, so it is the same on the
 * server and in the browser.
 */
export function DotMeter({
  value,
  label,
  valueLabel,
  maxMagnitude = 1,
  hollow = false,
  threshold,
  showFigure = true,
  showTrack = false,
  ticks = DOT_TICKS,
  className,
}: {
  value: number;
  label: string;
  /** How the reading is announced; defaults to the signed number. */
  valueLabel?: string;
  maxMagnitude?: number;
  hollow?: boolean;
  /** A level this row's reading has to clear, drawn as a dashed tick on the
   * same track (the similarity list's "needs to beat"). It differs from row
   * to row, so it belongs to the row and not to the axis. */
  threshold?: number;
  /** False where the row prints the figure itself, beside its name. */
  showFigure?: boolean;
  /** Draw the track as a faint bar from end to end. For a track with no
   * gridlines but its centre, which otherwise has nothing on its empty side. */
  showTrack?: boolean;
  /** The gridlines, as fractions of `maxMagnitude`. `[0]` for a track whose
   * two sides are not on one scale, where only the centre means anything. */
  ticks?: readonly number[];
  className?: string;
}) {
  const clamped = Math.max(-maxMagnitude, Math.min(maxMagnitude, value));
  const at = trackPercent(clamped, maxMagnitude);
  const figure = formatSigned(clamped);
  // The number sits beyond the dot, away from zero. A dot near either end has
  // no room there, so its number goes on the far side of zero instead.
  const nearEnd = Math.abs(clamped) / maxMagnitude > 0.7;
  const figureStyle =
    clamped < 0
      ? nearEnd
        ? { left: "calc(50% + 0.5rem)" }
        : { right: `calc(${100 - at}% + 0.75rem)` }
      : nearEnd
        ? { right: "calc(50% + 0.5rem)" }
        : { left: `calc(${at}% + 0.75rem)` };

  return (
    <AriaMeter
      // aria-valuenow must sit inside minValue/maxValue, so it is the
      // magnitude; aria-valuetext carries the signed reading, which is what a
      // screen reader announces.
      value={Math.abs(clamped) / maxMagnitude}
      minValue={0}
      maxValue={1}
      aria-label={label}
      valueLabel={valueLabel ?? figure}
      className={cn("block w-full", className)}
    >
      <div aria-hidden className="relative mx-2 h-7 [print-color-adjust:exact]">
        {showTrack ? (
          <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-muted" />
        ) : null}
        {ticks.map((t) => (
          <span
            key={t}
            className={cn(
              "absolute inset-y-0 w-px",
              t === 0 ? "bg-muted-foreground/60" : "bg-border"
            )}
            style={{ left: `${trackPercent(t * maxMagnitude, maxMagnitude)}%` }}
          />
        ))}
        <span
          className="absolute top-1/2 h-0.5 -translate-y-1/2 bg-foreground"
          style={{ left: `${Math.min(at, 50)}%`, width: `${Math.abs(at - 50)}%` }}
        />
        {threshold === undefined ? null : (
          <span
            data-threshold
            className="absolute inset-y-1 -translate-x-1/2 border-l-2 border-dashed border-foreground"
            style={{
              left: `${trackPercent(
                Math.max(-maxMagnitude, Math.min(maxMagnitude, threshold)),
                maxMagnitude
              )}%`,
            }}
          />
        )}
        <span
          className={cn(
            "absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-foreground",
            hollow ? "bg-card" : "bg-foreground"
          )}
          style={{ left: `${at}%` }}
        />
        {showFigure ? (
          <span
            className="absolute top-1/2 -translate-y-1/2 text-xs tabular-nums text-foreground"
            style={figureStyle}
          >
            {figure}
          </span>
        ) : null}
      </div>
    </AriaMeter>
  );
}

/**
 * The axis a list of {@link DotMeter}s is read against, drawn once above the
 * list: what each end means, and the scale.
 *
 * `aria-hidden`: each meter announces its own reading, and the note beside
 * the column's heading says in a sentence what the two ends mean.
 */
export function DotMeterAxis({
  lower,
  higher,
  maxMagnitude = 1,
  ticks = DOT_TICKS,
  formatTick,
  className,
}: {
  /** What a reading to the left of zero means. */
  lower: string;
  /** What a reading to the right of zero means. */
  higher: string;
  maxMagnitude?: number;
  /** The figures under the ends, as fractions of `maxMagnitude`; the same
   * list the rows' meters are given. Empty for an axis with no scale. */
  ticks?: readonly number[];
  /** How a tick's value is printed; the signed number by default. */
  formatTick?: (value: number) => string;
  className?: string;
}) {
  return (
    <div aria-hidden className={cn("text-xs font-normal text-muted-foreground", className)}>
      <div className="flex justify-between gap-3">
        <span>← {lower}</span>
        <span className="text-right">{higher} →</span>
      </div>
      {ticks.length === 0 ? null : (
        <div className="relative mx-2 h-5 tabular-nums">
          {ticks.map((t) => (
            <span
              key={t}
              className={cn(
                "absolute top-0.5",
                t === -1 ? "" : t === 1 ? "-translate-x-full" : "-translate-x-1/2"
              )}
              style={{ left: `${trackPercent(t * maxMagnitude, maxMagnitude)}%` }}
            >
              {formatTick
                ? formatTick(t * maxMagnitude)
                : t === 0
                  ? "0"
                  : formatSigned(t * maxMagnitude, t % 1 === 0 ? 0 : 1)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** One of several readings on a shared track; see {@link MultiDotMeter}. */
export interface TrackReading {
  key: string;
  /** What the badge says: a task's number, a pilot's initial. Two or three
   * characters at most. */
  badge: string;
  value: number;
  /** The reading did not clear its noise floor: drawn as an outline. */
  hollow?: boolean;
}

/**
 * Several signed readings of ONE thing on one track: a behaviour's
 * coefficient on each task of a competition. Each reading is a badge that
 * says which it is ("1", "2", "3"), on the same shared axis as
 * {@link DotMeter}, and all of them are on one line.
 *
 * Badges that agree overlap, and they are see-through, so a pile goes darker
 * and still reads as a pile. That is deliberate. Which task is which matters
 * when the tasks DISAGREE, and then the badges are apart and legible; when
 * they agree, "they agreed" is the reading, and the numbers inside the pile
 * matter least. They are drawn in order, so the last is the one on top.
 *
 * There is no mark for the average. The spread of the badges already says
 * whether the behaviour held from day to day, and an average of a strong pull
 * one way and a strong pull the other is a mark at zero that says "no
 * effect", which is the opposite of the finding.
 *
 * One meter to a screen reader, whose value text the caller writes: every
 * reading in words.
 */
export function MultiDotMeter({
  readings,
  label,
  valueLabel,
  maxMagnitude = 1,
  ticks = DOT_TICKS,
  className,
}: {
  /** The gridlines, as fractions of `maxMagnitude`. */
  ticks?: readonly number[];
  readings: readonly TrackReading[];
  label: string;
  /** Every reading, in words: what a screen reader announces. */
  valueLabel: string;
  maxMagnitude?: number;
  className?: string;
}) {
  const clamp = (v: number) => Math.max(-maxMagnitude, Math.min(maxMagnitude, v));
  // aria-valuenow has to be one number: the largest reading's size. The
  // value text carries the readings themselves.
  const largest = readings.reduce((m, r) => Math.max(m, Math.abs(clamp(r.value))), 0);
  return (
    <AriaMeter
      value={largest / maxMagnitude}
      minValue={0}
      maxValue={1}
      aria-label={label}
      valueLabel={valueLabel}
      className={cn("block w-full", className)}
    >
      <div aria-hidden className="relative mx-2 h-8 [print-color-adjust:exact]">
        {ticks.map((t) => (
          <span
            key={t}
            className={cn(
              "absolute inset-y-0 w-px",
              t === 0 ? "bg-muted-foreground/60" : "bg-border"
            )}
            style={{ left: `${trackPercent(t * maxMagnitude, maxMagnitude)}%` }}
          />
        ))}
        {readings.map((r) => (
          <span
            key={r.key}
            data-reading={r.key}
            className={cn(
              "absolute top-1/2 flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-[1.5px] border-foreground text-[0.6875rem] leading-none font-bold tabular-nums",
              r.hollow ? "bg-card/60 text-foreground" : "bg-foreground/55 text-background"
            )}
            style={{ left: `${trackPercent(clamp(r.value), maxMagnitude)}%` }}
          >
            {r.badge}
          </span>
        ))}
      </div>
    </AriaMeter>
  );
}
