/**
 * Sign-consistency chip for a comp-aggregate metric row — a FINDING, not a
 * warning: "same way each task" reads as "on every task whose coefficient
 * cleared its noise floor, larger values went with better ranks".
 *
 * The chip used to print the engine's own word plus a tally — "consistent
 * 3−/0+", and worse, "quiet 0−/1+", which looks like a contradiction. Both
 * asked the reader to learn a notation to reach a conclusion the chip could
 * simply state. The tally survives in the accessible name (and the per-task
 * bars beside it show which days voted), the same way the task page's verdict
 * chips say "could be chance" and leave |ρ| to the legend.
 *
 * "Depended on the day" is the most interesting outcome here, not a failure.
 */
import { Badge } from "@/react/rac/badge";
import type { CompMetricAggregate, SignConsistency } from "./types";

/** The chip's words, exported so the consistency map's readout line names a
 * dot the same way the table names its row. `quiet` says HOW few tasks were clear rather than just
 * that they were too few: with three tasks and a noise floor to clear, that
 * verdict is common, and "no clear task" and "one clear task only" are
 * different situations for a reader deciding whether to believe the row. */
export function consistencyWords(
  consistency: SignConsistency,
  informative: number
): string {
  switch (consistency) {
    case "consistent":
      return "same way each task";
    case "leaning":
      return "mostly one way";
    case "split":
      return "depended on the day";
    default:
      return informative === 0 ? "no clear task" : "one clear task only";
  }
}

function ariaText(m: CompMetricAggregate): string {
  const s = m.signSummary;
  const informative = s.negative + s.positive;
  if (informative === 0) {
    return "no clear task: the correlation of no task cleared its noise floor";
  }
  const neg = `larger values went with better ranks on ${s.negative}`;
  const pos = `worse ranks on ${s.positive}`;
  switch (m.consistency) {
    case "split":
      return `depended on the day: ${neg} of ${informative} tasks that cleared their noise floor and ${pos}`;
    case "quiet":
      return `one clear task only: ${neg} and ${pos}. One task cleared its noise floor, which is too few to read a direction from`;
    default:
      return `${consistencyWords(m.consistency, informative)}: ${neg} and ${pos} of ${informative} tasks that cleared their noise floor`;
  }
}

export function ConsistencyChip({ metric }: { metric: CompMetricAggregate }) {
  const informative = metric.signSummary.negative + metric.signSummary.positive;
  return (
    <Badge
      variant={metric.consistency === "consistent" ? "secondary" : "outline"}
      aria-label={ariaText(metric)}
    >
      {consistencyWords(metric.consistency, informative)}
    </Badge>
  );
}
