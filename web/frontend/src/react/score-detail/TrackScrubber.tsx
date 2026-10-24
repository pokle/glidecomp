/**
 * The map time scrubber and the fix lookup that drives it.
 *
 * Split out of PilotScoreDetail, which had grown past 1,400 lines with every
 * one of its sub-components inlined below the page itself.
 */
import type { IGCFix } from "@glidecomp/engine";
import { nearestFixIndexByTime } from "../../analysis/map-geometry";
import { formatTimeInZone } from "../lib/time";

export { nearestFixIndexByTime };

/**
 * Map time scrubber: drag to draw the track only up to a moment — when a
 * pilot crosses the same cylinder repeatedly, the clipped track is what
 * makes the sequence readable. At the right end the scrub clears and the
 * whole flight shows again.
 *
 * A native range input (not a kit slider) on purpose: it lets us set
 * aria-valuetext to the wall-clock flight time, where the RAC/shadcn
 * sliders would announce a meaningless fix index.
 */
export function TrackScrubber({
  fixes,
  scrubIndex,
  timezone,
  onScrub,
}: {
  fixes: IGCFix[];
  scrubIndex: number | null;
  timezone: string | null;
  onScrub: (index: number | null) => void;
}) {
  const max = fixes.length - 1;
  const value = Math.min(scrubIndex ?? max, max);
  const time = formatTimeInZone(fixes[value].time, timezone ?? undefined);
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        aria-label="Flight time"
        aria-valuetext={time}
        onChange={(e) => {
          const v = Number(e.currentTarget.value);
          onScrub(v >= max ? null : v);
        }}
        className="h-6 min-w-0 flex-1 accent-primary"
      />
      <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {scrubIndex == null ? "Whole flight" : `Until ${time}`}
      </span>
    </div>
  );
}
