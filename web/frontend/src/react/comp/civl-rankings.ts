/**
 * The roster editor's side of the CIVL world rankings.
 *
 * One fill button sits on the pilots grid: it puts CIVL IDs against names,
 * then each pilot's WPRS score beside them. It reads
 * `POST /api/comp/:comp_id/pilot/civl-rankings`, which answers about the rows
 * currently in the GRID rather than the saved roster — the organiser is
 * mid-edit when they press it.
 *
 * The rules live on the server (`civl-ranking-match.ts`, with the reasoning);
 * this module holds the call, the display labels, and the two pure functions
 * that turn a lookup into row edits, so the fill can be tested without a grid.
 */
import { api } from "../../comp/api";
import type { ParsedRow } from "./csv";

/** What the rankings offer one roster row: a rank, and the list it is from. */
export interface RowMatch {
  /** Only a `civl_id` match may fill a RANK — a name never decides one. */
  matched_by: "civl_id" | "name";
  civl_id: string;
  /** The name as CIVL spells it. */
  pilot_name: string;
  /** Their rank in the list where their WPRS score is highest. */
  rank: number;
  points: number;
  ranking_slug: string;
  ranking_name: string;
  ranking_date: string;
}

/** What the rankings have to say about the roster we sent. */
export interface RankingLookup {
  /** Roster index → match. Indices with no entry are unmatched. */
  matches: Record<number, RowMatch>;
  /** Roster rows the rankings can place at all. */
  matched_count: number;
  /** Of those, the ones that can fill a score right now (id already present). */
  rankable_count: number;
}

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

/**
 * Display names for the ten lists CIVL publishes, so a stored ranking can say
 * where it came from without a round trip (the snapshot's own `ranking_name`
 * is only in hand once a lookup has run, and the pilots table renders before
 * any of that).
 *
 * These are CIVL's OWN labels, copied from the `ranking_name` column of a real
 * import (`web/samples/civl-rankings/civl-rankings-2026-08.csv`) rather than
 * guessed from the slug — a reader comparing the roster against civlcomps.org
 * must not find "PG Accuracy" here and "PGA" there. Refresh them from that
 * column whenever the snapshot is refreshed.
 *
 * An unknown slug — CIVL adding an eleventh list — falls back to a readable
 * form of the slug itself rather than disappearing.
 */
const LIST_LABELS: Record<string, string> = {
  "hang-gliding-class-1-xc": "HG Class 1",
  "hang-gliding-class-1-sport-xc": "HG Class 1 Sport",
  "hang-gliding-class-2-xc": "HG Class 2",
  "hang-gliding-class-5-xc": "HG Class 5",
  "paragliding-xc": "PG XC",
  "paragliding-xc-sport": "PG XC Sport",
  "paragliding-accuracy": "PGA",
  "paragliding-aerobatics": "PG Acro Solo",
  "paragliding-acro-syncro": "PG Acro Synchro",
  "paragliding-hike-fly": "PG Hike & Fly",
};

export function listLabel(slug: string): string {
  return (
    LIST_LABELS[slug] ??
    // Title-cased so an unlisted slug reads as a name beside the ten that are
    // listed, rather than as the URL fragment it is.
    slug
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")
  );
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * 'Jul 2026' from an ISO 'YYYY-MM-01'. Formatted from a fixed table rather
 * than through Intl: the roster page renders the same string on the server
 * and in the browser, and a locale-dependent month is exactly the kind of
 * difference that shows up as a hydration mismatch (docs/ssr.md).
 */
export function formatRankingMonth(date: string | null): string {
  if (!date) return "";
  const [year, month] = date.split("-");
  const label = MONTHS[Number(month) - 1];
  return label ? `${label} ${year}` : date;
}

/**
 * Where a stored score came from, for the pilots table. A number with no
 * source was typed in by an organiser — that is a fact about it, not a
 * missing value, so it is said out loud rather than left blank.
 */
export function rankingSource(pilot: {
  wprs_points: number | null;
  civl_ranking_slug: string | null;
  civl_ranking_date: string | null;
}): string {
  if (pilot.wprs_points === null) return "";
  if (!pilot.civl_ranking_slug) return "set by organiser";
  return `${listLabel(pilot.civl_ranking_slug)} · ${formatRankingMonth(pilot.civl_ranking_date)}`;
}

/** What a fill did, for the status line under the grid. */
export interface FillOutcome {
  rows: ParsedRow[];
  filled: number;
  /** Rows the rankings had nothing to say about — left exactly as they were. */
  skipped: number;
  /**
   * Rows the rankings DID match but which already held a value, so nothing
   * was written. Distinct from `skipped`, because "we know this pilot and you
   * already have their number" and "no list has heard of them" are
   * different answers, and only one of them means "clear it to get the newer
   * number". Always 0 for the id pass, which cannot match a filled cell.
   */
  already_set: number;
}

/**
 * Fill empty CIVL ID cells from the rankings' name matches.
 *
 * Only `name` matches are used, and only into an EMPTY cell: an id already in
 * the grid is someone's deliberate answer and is never second-guessed. The
 * server has already refused every ambiguous name, so anything offered here
 * is a single ranked pilot no other row is claiming.
 */
export function fillCivlIds(rows: ParsedRow[], lookup: RankingLookup): FillOutcome {
  let filled = 0;
  const out = rows.map((row, index) => {
    const match = lookup.matches[index];
    if (row.civl_id || !match || match.matched_by !== "name") return row;
    filled++;
    return { ...row, civl_id: match.civl_id };
  });
  // A row that already carries an id is never name-matched in the first place
  // (the server declines to offer one), so nothing can be "already set" here.
  return { rows: out, filled, skipped: rows.length - filled, already_set: 0 };
}

/**
 * Fill the WPRS points column from the rankings' CIVL ID matches.
 *
 * Matched BY ID ONLY, which is why the organiser fills the ids first: a rank
 * attached to the wrong human silently sets the wrong launch order, and a
 * shared name is not evidence of a shared identity. The list and month travel
 * with the number so the roster can show where it came from.
 *
 * **Only into an empty cell**, the same rule the id pass follows. A rank in
 * the grid is somebody's answer — typed by an organiser for a pilot the list
 * has wrong or has missed, or filled from a list they chose earlier — and a
 * button labelled "add when missing" may not quietly replace it.
 *
 * The cost is the refresh path: when CIVL publishes a new month, filling
 * again adds nothing to a roster that is already ranked. Clearing the column
 * (or the rows in question) is what asks for the newer numbers, and
 * `already_set` is reported so the UI can say that is what happened rather
 * than leaving "0 filled" to be read as a failure.
 */
export function fillRankings(rows: ParsedRow[], lookup: RankingLookup): FillOutcome {
  let filled = 0;
  let alreadySet = 0;
  const out = rows.map((row, index) => {
    const match = lookup.matches[index];
    if (!match || match.matched_by !== "civl_id") return row;
    if (row.wprs_points) {
      alreadySet++;
      return row;
    }
    filled++;
    return {
      ...row,
      wprs_points: String(match.points),
      // The pilot's own best list, not one list for the whole roster: two
      // pilots on one roster can now be ranked from two different lists, and
      // each number has to say which one it is.
      civl_ranking_slug: match.ranking_slug,
      civl_ranking_date: match.ranking_date,
    };
  });
  return { rows: out, filled, skipped: rows.length - filled, already_set: alreadySet };
}
