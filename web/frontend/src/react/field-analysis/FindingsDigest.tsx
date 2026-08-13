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
 * click below, and a digest that repeats them stops being a digest. Same
 * ordering as the ranking (rankMetrics), so the two can never disagree about
 * what mattered.
 *
 * Only verdicts of weak or better make the cut — a headline must not shout
 * a "could be chance" reading, however large its ρ. When nothing clears
 * that bar the card says so instead of vanishing: "no clear pattern" is
 * itself the day's finding (a lottery day), and a digest that only appears
 * on tidy days would quietly overclaim on the rest.
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

/** Verdicts loud enough for the headline: weak and above. Below that the
 * chip would be doing all the work of un-saying the claim beside it. */
const DIGEST_VERDICTS = new Set(["strong", "moderate", "weak"]);

export function FindingsDigest({
  metrics,
  onPickMetric,
}: {
  metrics: MetricReport[];
  /** Select this metric in the separation ranking (the entry's anchor does
   * the scrolling; this makes the chart follow). */
  onPickMetric?: (id: Key) => void;
}) {
  const top = rankMetrics(metrics)
    .filter((r) => DIGEST_VERDICTS.has(r.correlation.verdict))
    .slice(0, DIGEST_COUNT);

  if (top.length === 0) {
    return (
      <Card aria-labelledby="findings-digest-heading" className="gap-2">
        <h2 id="findings-digest-heading" className="text-lg font-semibold">
          What separated the field
        </h2>
        <p className="text-base text-muted-foreground">
          Can't say — no clear pattern
        </p>
      </Card>
    );
  }

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
            className="relative flex items-center gap-2.5 rounded-lg border py-2.5 pl-3 pr-4"
          >
            <VerdictBadge correlation={correlation} />
            {/* Headline-sized on purpose: these three lines are the page's
                finding, and the card exists to shout them. */}
            <a
              href="#separation-heading"
              onClick={() => onPickMetric?.(metric.id)}
              className="text-lg font-semibold outline-none after:absolute after:inset-0 after:rounded-lg after:transition-colors hover:underline hover:after:bg-foreground/5 focus-visible:after:ring-3 focus-visible:after:ring-ring/50"
            >
              {metric.label}
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
