/**
 * Notable not-applicable pilots — turning a silent absence into information.
 *
 * A metric's null is "not applicable", never a score of zero, so those
 * pilots are excluded from plots and correlations. Usually that's routine;
 * when the excluded include the TOP-RANKED pilots it is material to how the
 * chart may be read (the winner having no gaggle departures is itself a
 * finding — see the RankScatter caption), so captions name them.
 */
import type { FieldAnalysisReport, PilotMetricValue } from "./types";

/** How deep "notable" reaches into the leaderboard. */
const NOTABLE_RANKS = 3;

/**
 * Ranks ≤ 3 among pilots with no usable value for the metric, ascending.
 * Joined by trackFile (project rule: never pair by array index).
 */
export function notableExcludedRanks(
  pilots: FieldAnalysisReport["pilots"],
  perPilot: PilotMetricValue[],
): number[] {
  const valueByTrack = new Map(perPilot.map((p) => [p.trackFile, p.value]));
  const ranks: number[] = [];
  for (const p of pilots) {
    if (p.rank > NOTABLE_RANKS) continue;
    const v = valueByTrack.get(p.trackFile);
    if (v === null || v === undefined || !Number.isFinite(v)) ranks.push(p.rank);
  }
  return ranks.sort((a, b) => a - b);
}

/** "the #1 ranked pilot" / "the #1 and #2 ranked pilots" / "#1, #2 and #3…". */
export function notableRanksPhrase(ranks: number[]): string {
  const tags = ranks.map((r) => `#${r}`);
  const list =
    tags.length === 1
      ? tags[0]
      : `${tags.slice(0, -1).join(", ")} and ${tags[tags.length - 1]}`;
  return `the ${list} ranked pilot${ranks.length === 1 ? "" : "s"}`;
}
