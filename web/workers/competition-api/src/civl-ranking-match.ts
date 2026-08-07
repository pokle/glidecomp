/**
 * Matching a competition roster against the CIVL world ranking lists.
 *
 * The roster editor has two fill buttons, and this module decides what each
 * one is allowed to offer. Both rules come straight from what an organiser is
 * doing: they know who is flying, they want the WPRS ranking beside each name
 * so they can set a fair launch order, and they need the result to be
 * checkable afterwards.
 *
 *   * **A rank is only ever matched by CIVL ID.** An id identifies a human;
 *     a name does not. This mirrors `pilot-resolver.ts` and `pilot-linker.ts`,
 *     which refuse to link an account on a name, and it is why the fill leaves
 *     a rank alone rather than guessing when the id is missing.
 *   * **An ID may be matched by name, but only when the name is unambiguous.**
 *     This is the one place a name decides anything, and it is safe for two
 *     reasons: the organiser asked for it explicitly by pressing the button,
 *     and every ambiguity is refused rather than resolved (see below). It only
 *     ever fills an EMPTY cell, so it cannot overwrite an id someone entered.
 *
 * Everything an ambiguity could hide is dropped instead:
 *
 *   * two ranked pilots whose names match the same roster row → no suggestion
 *     (the list itself cannot say which human this is);
 *   * two roster rows matching the same ranked pilot → neither is offered
 *     (one of the two would be given someone else's id);
 *   * a ranked pilot whose id is already on another roster row → not offered
 *     (that would produce two rows with one id, which the bulk save rejects
 *     as "two rows resolved to the same pilot" anyway).
 *
 * Name comparison is exact up to case and surrounding/among whitespace.
 * Accents are NOT folded: 'Jose' does not match 'José'. Folding would have to
 * happen in SQL — SQLite's NOCASE is ASCII-only — and the honest failure (the
 * row is left alone for the organiser to fix) is better than a fold that
 * quietly equates two spellings the source distinguishes.
 *
 * Pure: no D1, no Hono. `routes/pilot.ts` fetches the candidate rows and hands
 * them here, which is what makes all of the above testable.
 */

/**
 * One row of the roster as it currently stands in the editor's grid. A blank
 * cell arrives as null from the grid and as `undefined` from a payload that
 * omitted it; both mean the same thing here.
 */
export interface RosterEntry {
  name: string;
  civl_id?: string | null;
}

/** One `pilot_ranking` row, already narrowed to a list's latest snapshot. */
export interface RankingRow {
  rank: number;
  points: number;
  civl_id: string;
  pilot_name: string;
}

/**
 * A list we hold a snapshot of. Carried separately from its rows because a
 * list that matches nobody still has to appear in the picker — showing "0 of
 * 24" is how an organiser learns they picked the wrong discipline, rather
 * than the list silently not being there.
 */
export interface ListInfo {
  slug: string;
  /** The sheet's own label, e.g. 'HG Class 1'. */
  name: string;
  /** ISO 'YYYY-MM-01' — the month this snapshot was published. */
  ranking_date: string;
}

/** What one ranking list offers one roster row. */
export interface RowMatch {
  /** How this row was found. Only `civl_id` matches may fill a RANK. */
  matched_by: "civl_id" | "name";
  /** The ranked pilot's CIVL ID — what a `name` match offers to fill in. */
  civl_id: string;
  /** The name as CIVL spells it, so the UI can show what it matched. */
  pilot_name: string;
  rank: number;
  points: number;
}

/** One ranking list, and what it has to say about this roster. */
export interface ListMatches extends ListInfo {
  /** Roster index → match. Indices with no entry are unmatched. */
  matches: Record<number, RowMatch>;
  /** Roster rows this list can place at all — the picker's "n of N". */
  matched_count: number;
  /** Of those, the ones that can fill a rank right now (id already present). */
  rankable_count: number;
}

/** Case- and whitespace-insensitive name key. See the module header on accents. */
export function nameKey(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** A CIVL id compares as text with surrounding space ignored ('25161'). */
function idKey(civlId: string): string {
  return civlId.trim();
}

/**
 * Match one list's rows against the roster.
 *
 * `rows` must already be narrowed to this list and its latest snapshot; the
 * caller owns that because "latest" is a property of the table, not of the
 * matching. An empty `rows` is normal — that is a list that places nobody.
 */
export function matchList(
  list: ListInfo,
  roster: RosterEntry[],
  rows: RankingRow[]
): ListMatches {
  const byId = new Map<string, RankingRow>();
  // A name that two ranked pilots share is recorded as ambiguous and then
  // never offered — the map holds `null` for it rather than losing the fact.
  const byName = new Map<string, RankingRow | null>();

  for (const row of rows) {
    byId.set(idKey(row.civl_id), row);
    const key = nameKey(row.pilot_name);
    if (byName.has(key)) byName.set(key, null);
    else byName.set(key, row);
  }

  // Ids already on the roster are spoken for: a name match must never hand a
  // second row the same id.
  const idsInUse = new Set(
    roster.flatMap((entry) => (entry.civl_id ? [idKey(entry.civl_id)] : []))
  );

  // First pass: id matches (authoritative), and the name candidates.
  const matches: Record<number, RowMatch> = {};
  const nameCandidates = new Map<number, RankingRow>();
  const claimedByName = new Map<string, number[]>();

  for (const [index, entry] of roster.entries()) {
    if (entry.civl_id) {
      const hit = byId.get(idKey(entry.civl_id));
      if (hit) {
        matches[index] = {
          matched_by: "civl_id",
          civl_id: hit.civl_id,
          pilot_name: hit.pilot_name,
          rank: hit.rank,
          points: hit.points,
        };
      }
      // A row that already carries an id is never name-matched: the id is the
      // answer, and disagreeing with it is not this button's business.
      continue;
    }
    const hit = byName.get(nameKey(entry.name));
    if (!hit) continue; // absent, or ambiguous within the list
    if (idsInUse.has(idKey(hit.civl_id))) continue; // another row holds this id
    nameCandidates.set(index, hit);
    const claimants = claimedByName.get(idKey(hit.civl_id)) ?? [];
    claimants.push(index);
    claimedByName.set(idKey(hit.civl_id), claimants);
  }

  // Second pass: drop any ranked pilot two roster rows both claim (two rows
  // named the same person). Neither gets the id — one of them is not them.
  for (const [index, hit] of nameCandidates) {
    if ((claimedByName.get(idKey(hit.civl_id)) ?? []).length > 1) continue;
    matches[index] = {
      matched_by: "name",
      civl_id: hit.civl_id,
      pilot_name: hit.pilot_name,
      rank: hit.rank,
      points: hit.points,
    };
  }

  const all = Object.values(matches);
  return {
    ...list,
    matches,
    matched_count: all.length,
    rankable_count: all.filter((m) => m.matched_by === "civl_id").length,
  };
}

/**
 * Which list the picker should open on.
 *
 * The comp's own discipline goes first — a hang gliding comp has no business
 * defaulting to a paragliding list even if more of its pilots happen to be
 * ranked there — and within the discipline, the list that places the most
 * pilots. Falls back to the best list of any discipline (an organiser running
 * an HG comp with a PG-ranked field still gets something useful), then to the
 * first list we hold, and to null when we hold none.
 */
export function defaultListSlug(
  lists: ListMatches[],
  category: "hg" | "pg"
): string | null {
  if (lists.length === 0) return null;
  const ofDiscipline = lists.filter((l) => disciplineOf(l.slug) === category);
  const best = (candidates: ListMatches[]): ListMatches | null =>
    candidates.reduce<ListMatches | null>(
      (acc, l) => (acc === null || l.matched_count > acc.matched_count ? l : acc),
      null
    );
  const bestOfDiscipline = best(ofDiscipline);
  if (bestOfDiscipline && bestOfDiscipline.matched_count > 0) {
    return bestOfDiscipline.slug;
  }
  const bestOverall = best(lists);
  if (bestOverall && bestOverall.matched_count > 0) return bestOverall.slug;
  return bestOfDiscipline?.slug ?? lists[0].slug;
}

/**
 * The list a discipline means when nobody has said which — its main XC
 * ranking, which is what "the world ranking" refers to in either sport.
 *
 * Picking the first slug of the right discipline alphabetically does NOT work:
 * that is 'hang-gliding-class-1-sport-xc', the Sport list, so an HG comp
 * looking up its field would quietly read a ranking almost none of them are
 * in. Named, in preference order, rather than sorted.
 */
const MAIN_LIST: Record<"hg" | "pg", string[]> = {
  hg: ["hang-gliding-class-1-xc", "hang-gliding-class-5-xc", "hang-gliding-class-2-xc"],
  pg: ["paragliding-xc", "paragliding-accuracy"],
};

/**
 * Which of the lists we hold to read when the caller named none.
 *
 * Unlike `defaultListSlug` this has no roster to count matches against — it is
 * for the name typeahead, which runs before there is anything to match.
 */
export function preferredListSlug(
  held: string[],
  category: "hg" | "pg"
): string | null {
  if (held.length === 0) return null;
  for (const slug of MAIN_LIST[category]) {
    if (held.includes(slug)) return slug;
  }
  return held.find((s) => disciplineOf(s) === category) ?? held[0];
}

/**
 * The discipline a list slug belongs to. The slugs are civlcomps.org's own
 * ('hang-gliding-class-1-xc', 'paragliding-xc'), so the prefix is the
 * discipline; anything unrecognised is treated as paragliding-side only for
 * the purpose of NOT matching an 'hg' comp.
 */
export function disciplineOf(slug: string): "hg" | "pg" {
  return slug.startsWith("hang-gliding") ? "hg" : "pg";
}
