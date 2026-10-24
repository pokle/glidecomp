/**
 * The roster editor's side of the CIVL world rankings: the call. The labels
 * and the fill rules moved to @glidecomp/client/civl-rankings (mobile plan
 * stage 7), so the app fills a roster the same way; re-exported here.
 */
import { api } from "../../comp/api";
import type { ParsedRow } from "./csv";
import type { RankingLookup } from "@glidecomp/client/civl-rankings";

export * from "@glidecomp/client/civl-rankings";

/**
 * Ask what every list we hold makes of these rows. Order is significant: the
 * response is keyed by index into `rows`, so the caller must apply the answer
 * to the same array it sent.
 */
export async function lookupRankings(
  compId: string,
  rows: ParsedRow[]
): Promise<RankingLookup> {
  const res = await api.api.comp[":comp_id"].pilot["civl-rankings"].$post({
    param: { comp_id: compId },
    json: {
      pilots: rows.map((r) => ({ name: r.name, civl_id: r.civl_id })),
    },
  });
  if (!res.ok) throw new Error(`Ranking lookup failed (${res.status})`);
  return (await res.json()) as RankingLookup;
}
