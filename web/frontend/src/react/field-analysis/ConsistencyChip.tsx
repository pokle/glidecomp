/**
 * Sign-consistency chip for a comp-aggregate metric row — a FINDING, not a
 * warning. "consistent 4−/0+" reads as: on the 4 informative tasks (|ρ|
 * cleared its noise floor), larger values always went with better ranks.
 * A split is the most interesting outcome — the payoff depended on the day.
 */
import { Badge } from "@/react/rac/badge";
import type { CompMetricAggregate } from "./types";

function ariaText(m: CompMetricAggregate): string {
  const s = m.signSummary;
  const informative = s.negative + s.positive;
  if (informative === 0) {
    return "quiet: no task's correlation cleared its noise floor";
  }
  const neg = `larger values went with better ranks on ${s.negative}`;
  const pos = `worse ranks on ${s.positive}`;
  switch (m.consistency) {
    case "split":
      return `split: ${neg} of ${informative} informative tasks and ${pos} — the payoff depended on the day`;
    default:
      return `${m.consistency}: ${neg} and ${pos} of ${informative} informative tasks`;
  }
}

export function ConsistencyChip({ metric }: { metric: CompMetricAggregate }) {
  const s = metric.signSummary;
  const informative = s.negative + s.positive;
  if (informative === 0) {
    return <Badge variant="outline" aria-label={ariaText(metric)}>quiet</Badge>;
  }
  return (
    <Badge
      variant={metric.consistency === "consistent" ? "secondary" : "outline"}
      aria-label={ariaText(metric)}
    >
      {metric.consistency} {s.negative}−/{s.positive}+
    </Badge>
  );
}
