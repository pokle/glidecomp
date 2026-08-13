/**
 * The findings digest — the separation ranking's strongest behaviours, said
 * first.
 *
 * The ranking is the page's finding, but it sits below two long grounding
 * sections (weather, thermals), so a reader who gives the page five seconds
 * used to leave knowing what the day looked like and nothing about what
 * separated the field. These tiles hand over the headline up front and each
 * one jumps to — and selects — its row in the full ranking, where the
 * scatter, the ⓘs and the one-task caveat live.
 *
 * A summary OF the ranking, not a rival to it: same ordering (rankMetrics),
 * same meter, same verdict chips — including "could be chance", which is
 * exactly the honesty a headline must not shed. Presentation order of the
 * analysis itself is unchanged; this is the report's abstract, the same job
 * the CLI report's leading lines do.
 *
 * Tiles use a stretched link (the anchor's ::after covers the tile) so the
 * whole card is clickable while the link's accessible name stays the metric
 * label alone. The DivergingMeter inside announces itself as a meter, same
 * as it does in the ranking table.
 */
import type { Key } from "react-aria-components";
import { Card } from "@/react/rac/card";
import { DivergingMeter } from "@/react/rac/meter";
import { rankMetrics, VerdictBadge } from "./SeparationRanking";
import type { MetricReport } from "./types";

/** How many tiles the digest shows — the same top-3 the family auto-open
 * already treats as "the ones worth opening". */
const DIGEST_COUNT = 3;

export function FindingsDigest({
  metrics,
  fieldSize,
  onPickMetric,
}: {
  metrics: MetricReport[];
  /** Pilots analysed — the denominator of each tile's coverage line. */
  fieldSize: number;
  /** Select this metric in the separation ranking (the tile's anchor does
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
      <ul className="grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-3">
        {top.map(({ metric, correlation }) => (
          <li
            key={metric.id}
            className="relative flex flex-col gap-2 rounded-lg border p-3"
          >
            <VerdictBadge correlation={correlation} />
            <a
              href="#separation-heading"
              onClick={() => onPickMetric?.(metric.id)}
              className="text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-lg after:transition-colors hover:underline hover:after:bg-foreground/5 focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
            >
              {metric.label}
            </a>
            <div className="mt-auto flex items-center gap-2">
              <DivergingMeter
                className="min-w-16 flex-1"
                value={correlation.rho}
                label={`${metric.label}: Spearman correlation against rank`}
                valueLabel={correlation.rho.toFixed(2)}
              />
              {/* aria-hidden: the meter already announces this exact number
                  as its value text. */}
              <span
                aria-hidden
                className="shrink-0 text-xs tabular-nums text-muted-foreground"
              >
                {correlation.rho.toFixed(2)}
              </span>
            </div>
            <p className="text-xs tabular-nums text-muted-foreground">
              {correlation.n} of {fieldSize} pilots measured
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}
