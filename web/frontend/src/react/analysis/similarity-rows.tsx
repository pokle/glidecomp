/**
 * The pieces the two pilot-similarity pages draw their rows with: the results
 * ("Who flew like me?") and the comparison of one pair that a row opens.
 */
import { DotMeterAxis, MultiDotMeter, formatSigned } from "@/react/rac/meter";
import { READING_NAME, ReadingRow } from "@/react/rac/reading-list";
import { cn } from "@/react/lib/utils";
import { formatMetricValue } from "./types";

/** One behaviour of a pair, as the engine's similarity report gives it. */
export interface PairContribution {
  metricId: string;
  label: string;
  shortLabel?: string;
  unit: string;
  subjectZ: number;
  neighbourZ: number;
  subjectValue: number;
  neighbourValue: number;
  contribution: number;
}

/** A signed z-score, "+1.4 SD": always with its sign, so above and below the
 * field's average cannot be confused. */
export function formatZ(z: number): string {
  return `${formatSigned(z, 1)} SD`;
}

/**
 * Where a similarity sits on a track whose centre is zero and whose ends are
 * ±1.
 *
 * The two sides are not on one scale, because the measure is not: Tanimoto
 * reaches 1 for two pilots who flew alike but only −1/3 for two who did the
 * opposite. Each side is drawn against its own limit, so a full-strength
 * opposite is a full track and not a third of one. That is why the track has
 * a centre line and no other gridline.
 */
export function similarityOnTrack(similarity: number): number {
  return similarity >= 0 ? Math.min(1, similarity) : Math.max(-1, similarity * 3);
}

/** A similarity as it is printed: three places, a true minus sign. */
export function formatSimilarity(similarity: number): string {
  return `${similarity < 0 ? "−" : ""}${Math.abs(similarity).toFixed(3)}`;
}

/** What a pilot's badge says on a pair's track: the first letter of the name. */
export function pilotBadge(name: string): string {
  return (name.trim()[0] ?? "?").toUpperCase();
}

/** A pilot's given name, for the short line under a track. */
export function shortName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** How far from the field's average a pair's track runs, in SD. A pilot
 * further out is drawn at the end. */
export const Z_TRACK_SD = 3;
/** The gridlines of a pair's track: the average, and 2 SD either side. */
export const Z_TRACK_TICKS = [-2 / Z_TRACK_SD, 0, 2 / Z_TRACK_SD];

/** The axis a list of {@link PairBehaviourRow}s is read against. */
export function PairAxis({ className }: { className?: string }) {
  return (
    <DotMeterAxis
      className={className}
      lower="below the field's average"
      higher="above it"
      maxMagnitude={Z_TRACK_SD}
      ticks={Z_TRACK_TICKS}
      formatTick={(v) => (v === 0 ? "0" : formatZ(v).replace(".0", ""))}
    />
  );
}

/** Which badge is which pilot, said once above the rows. */
export function PairKey({
  subjectName,
  otherName,
  className,
}: {
  subjectName: string;
  otherName: string;
  className?: string;
}) {
  const badge =
    "inline-flex size-5 items-center justify-center rounded-full border-[1.5px] border-foreground text-[0.6875rem] leading-none font-bold";
  return (
    <p className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground", className)}>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={cn(badge, "bg-foreground/55 text-background")}>
          {pilotBadge(subjectName)}
        </span>
        {subjectName}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className={cn(badge, "bg-card/60 text-foreground")}>
          {pilotBadge(otherName)}
        </span>
        {otherName}
      </span>
    </p>
  );
}

/**
 * One behaviour of a pair: its name, one figure, and both pilots as badges
 * on a track that runs from below the field's average to above it.
 *
 * The track is why the figure is what it is. Two badges close together on the
 * same side of the average are a behaviour that made the pair alike; one on
 * each side is a behaviour that set them apart. Both pilots' real values are
 * in words under it.
 */
export function PairBehaviourRow({
  contribution: c,
  subjectName,
  otherName,
  figure,
  figureLabel,
  name,
  children,
  className,
}: {
  contribution: PairContribution;
  subjectName: string;
  otherName: string;
  /** The figure on the row's first line, and what it is for a screen reader. */
  figure: string;
  figureLabel: string;
  /** The row's name, where it is not the behaviour (the results in gap mode
   * name the other pilot). */
  name?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
}) {
  // "41%" and a bare ratio, where the table this replaced printed the
  // engine's unit names, "41 pct" and "1.32 ratio".
  const value = (v: number) => {
    const n = formatMetricValue(c.unit, v);
    return c.unit === "pct" ? `${n}%` : c.unit === "ratio" ? n : `${n} ${c.unit}`.trim();
  };
  return (
    <ReadingRow className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <span className={READING_NAME}>{name ?? c.label}</span>
        <span className="font-semibold whitespace-nowrap tabular-nums">
          <span className="sr-only">{figureLabel} </span>
          {figure}
        </span>
      </div>
      <MultiDotMeter
        className="mt-1"
        maxMagnitude={Z_TRACK_SD}
        ticks={Z_TRACK_TICKS}
        // The other pilot first, so the pilot being read is drawn on top.
        readings={[
          { key: "other", badge: pilotBadge(otherName), value: c.neighbourZ, hollow: true },
          { key: "subject", badge: pilotBadge(subjectName), value: c.subjectZ },
        ]}
        label={`${c.label}: where each pilot sat against the field`}
        valueLabel={`${subjectName} ${formatZ(c.subjectZ)}, ${otherName} ${formatZ(c.neighbourZ)}`}
      />
      <p className="mt-1 text-sm text-muted-foreground tabular-nums">
        {shortName(subjectName)} {value(c.subjectValue)} · {shortName(otherName)}{" "}
        {value(c.neighbourValue)}
      </p>
      {children}
    </ReadingRow>
  );
}
