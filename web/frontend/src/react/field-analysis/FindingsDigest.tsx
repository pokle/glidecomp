/**
 * The findings digest — the separation ranking's strongest behaviours, said
 * first.
 *
 * The ranking is the page's finding, but it sits below two long grounding
 * sections (weather, thermals), so a reader who gives the page five seconds
 * used to leave knowing what the day looked like and nothing about what
 * separated the field. The digest hands over the headline as the first thing
 * on the page, and each entry jumps to — and selects — its row in the full
 * ranking, where the meters, the scatter, the ⓘs and the one-task caveat
 * live.
 *
 * Deliberately just the behaviour and its verdict chip: the numbers are one
 * click below, and a digest that repeats them stops being a digest. The chip
 * matters — including "could be chance", which is exactly the honesty a
 * headline must not shed. Same ordering as the ranking (rankMetrics), so the
 * two can never disagree about what mattered.
 *
 * Entries use a stretched link (the anchor's ::after covers the tile) so the
 * whole chip-and-label is clickable while the link's accessible name stays
 * the metric label alone.
 */
import type { Key } from "react-aria-components";
import { Card } from "@/react/rac/card";
import { rankMetrics, VerdictBadge } from "./SeparationRanking";
import type { MetricReport } from "./types";

/** How many entries the digest shows — the same top-3 the family auto-open
 * already treats as "the ones worth opening". */
const DIGEST_COUNT = 3;

export function FindingsDigest({
  metrics,
  onPickMetric,
}: {
  metrics: MetricReport[];
  /** Select this metric in the separation ranking (the entry's anchor does
   * the scrolling; this makes the chart follow). */
  onPickMetric?: (id: Key) => void;
}) {
  const top = rankMetrics(metrics).slice(0, DIGEST_COUNT);
  if (top.length === 0) return null;

  return (
    <Card aria-labelledby="findings-digest-heading" className="gap-3">
      <div>
        <h2 id="findings-digest-heading" className="text-lg font-semibold">
          What separated the field
        </h2>
        <p className="text-sm text-muted-foreground">
          The behaviours that went most strongly with better ranks on this
          task. Each links to the full ranking below.
        </p>
      </div>
      <ul className="flex list-none flex-wrap gap-2 p-0">
        {top.map(({ metric, correlation }) => (
          <li
            key={metric.id}
            className="relative flex items-center gap-2 rounded-lg border py-2 pl-2 pr-3"
          >
            <VerdictBadge correlation={correlation} />
            <a
              href="#separation-heading"
              onClick={() => onPickMetric?.(metric.id)}
              className="text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-lg after:transition-colors hover:underline hover:after:bg-foreground/5 focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
            >
              {metric.label}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
