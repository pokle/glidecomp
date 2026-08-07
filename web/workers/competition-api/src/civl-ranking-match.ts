/**
 * Matching a competition roster against the CIVL world ranking lists.
 *
 * The roster editor has one fill button, and this module decides what it is
 * allowed to offer. The rules come from what an organiser is doing: they know
 * who is flying, they want the WPRS ranking beside each name so they can set a
 * fair launch order, and they need the result to be checkable afterwards.
 *
 *   * **A rank is only ever matched by CIVL ID.** An id identifies a human; a
 *     name does not. This mirrors `pilot-resolver.ts` and `pilot-linker.ts`,
 *     which refuse to link an account on a name, and it is why the fill leaves
 *     a rank alone rather than guessing when the id is missing.
 *   * **An ID may be matched by name, but only when the name is unambiguous.**
 *     This is the one place a name decides anything, and it is safe for two
 *     reasons: the organiser asked for it explicitly by pressing the button,
 *     and every ambiguity is refused rather than resolved (see below). It only
 *     ever fills an EMPTY cell, so it cannot overwrite an id someone entered.
 *
 * ── One number per pilot, across every list ────────────────────────────────
 *
 * CIVL publishes ten lists — one per discipline and class — and **no overall
 * ranking**: every row of every list is `region=World, selection=Overall`,
 * where "Overall" is CIVL's own selection filter rather than an aggregate. So
 * a pilot in more than one list (41% of ranked pilots are, up to four lists)
 * has no single published number, and one has to be chosen.
 *
 * We take their **best rank — the lowest number** — whichever list it comes
 * from, and record that list on the row so the number stays checkable.
 *
 * Know what that costs, because it is not small: a rank is a position within
 * one pool, and the pools differ enormously (HG Class 2 holds six pilots, PG
 * XC holds 6,875). Luke Nicol is #1 in PG XC Sport and #106 in PG XC on
 * IDENTICAL points, because Sport is a subset; best-rank gives him #1. Across
 * the August 2026 snapshot, 3,457 pilots' best rank and best points come from
 * different lists. Ranking by `points` instead would be comparable across
 * lists in a way ranks are not — it is a one-line change to `isBetter` below —
 * but the rule an organiser asked for is the lowest number, and it is at least
 * a number CIVL really published about that pilot.
 *
 * ── What is refused ───────────────────────────────────────────────────────
 *
 *   * two DIFFERENT ranked humans whose names match the same roster row → no
 *     suggestion (the lists cannot say which of them this is);
 *   * two roster rows matching the same ranked pilot → neither is offered;
 *   * a ranked pilot whose id is already on another roster row → not offered
 *     (that would produce two rows with one id, which the bulk save rejects
 *     as "two rows resolved to the same pilot" anyway).
 *
 * One pilot appearing in several lists is NOT an ambiguity: it is one human,
 * and collapsing them to their best rank before any of this happens is what
 * keeps it from looking like two.
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

/**
 * One `pilot_ranking` row, carrying the list it belongs to. Unlike before
 * there is no per-list call: every candidate row from every list arrives in
 * one array, because a pilot's best rank is a fact about all of them.
 */
export interface RankedEntry {
  rank: number;
  points: number;
  civl_id: string;
  pilot_name: string;
  /** civlcomps.org URL segment — the list's identity. */
  ranking_slug: string;
  /** The sheet's own label, e.g. 'HG Class 1'. */
  ranking_name: string;
  /** ISO 'YYYY-MM-01' — the month that snapshot was published. */
  ranking_date: string;
}

/** What the rankings offer one roster row. */
export interface RowMatch extends RankedEntry {
  /** How this row was found. Only `civl_id` matches may fill a RANK. */
  matched_by: "civl_id" | "name";
}

/** What the rankings have to say about a whole roster. */
export interface RosterMatches {
  /** Roster index → match. Indices with no entry are unmatched. */
  matches: Record<number, RowMatch>;
  /** Roster rows the rankings can place at all. */
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
 * Is `a` the entry to keep for this pilot? Lowest rank wins; equal ranks go to
 * the more points (the same standing in a bigger pool), and an exact tie falls
 * to the slug so a re-run answers identically.
 */
function isBetter(a: RankedEntry, b: RankedEntry): boolean {
  if (a.rank !== b.rank) return a.rank < b.rank;
  if (a.points !== b.points) return a.points > b.points;
  return a.ranking_slug < b.ranking_slug;
}

/**
 * One entry per ranked pilot: their best across every list they appear in.
 *
 * Done BEFORE any matching so that a pilot in four lists reads as one human
 * rather than as four ranked pilots sharing a name — which the ambiguity rule
 * would otherwise refuse outright, and which was the whole reason the picker
 * existed.
 */
export function bestPerPilot(entries: RankedEntry[]): Map<string, RankedEntry> {
  const best = new Map<string, RankedEntry>();
  for (const entry of entries) {
    const key = idKey(entry.civl_id);
    const held = best.get(key);
    if (!held || isBetter(entry, held)) best.set(key, entry);
  }
  return best;
}

/**
 * Match the rankings against the roster.
 *
 * `entries` are candidate rows from every list, already narrowed to each
 * list's latest snapshot — the caller owns "latest" because it is a property
 * of the table, not of the matching. An empty array is normal: that is a
 * database with no rankings imported.
 */
export function matchRoster(
  roster: RosterEntry[],
  entries: RankedEntry[]
): RosterMatches {
  const byId = bestPerPilot(entries);

  // A name two DIFFERENT humans answer to is recorded as ambiguous and then
  // never offered — the map holds `null` for it rather than losing the fact.
  const byName = new Map<string, RankedEntry | null>();
  for (const entry of byId.values()) {
    const key = nameKey(entry.pilot_name);
    const held = byName.get(key);
    if (held === undefined) byName.set(key, entry);
    else if (held !== null && idKey(held.civl_id) !== idKey(entry.civl_id)) {
      byName.set(key, null);
    }
  }

  // Ids already on the roster are spoken for: a name match must never hand a
  // second row the same id.
  const idsInUse = new Set(
    roster.flatMap((entry) => (entry.civl_id ? [idKey(entry.civl_id)] : []))
  );

  // First pass: id matches (authoritative), and the name candidates.
  const matches: Record<number, RowMatch> = {};
  const nameCandidates = new Map<number, RankedEntry>();
  const claimedByName = new Map<string, number[]>();

  for (const [index, entry] of roster.entries()) {
    if (entry.civl_id) {
      const hit = byId.get(idKey(entry.civl_id));
      if (hit) matches[index] = { ...hit, matched_by: "civl_id" };
      // A row that already carries an id is never name-matched: the id is the
      // answer, and disagreeing with it is not this button's business.
      continue;
    }
    const hit = byName.get(nameKey(entry.name));
    if (!hit) continue; // absent, or answered to by more than one human
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
    matches[index] = { ...hit, matched_by: "name" };
  }

  const all = Object.values(matches);
  return {
    matches,
    matched_count: all.length,
    rankable_count: all.filter((m) => m.matched_by === "civl_id").length,
  };
}
