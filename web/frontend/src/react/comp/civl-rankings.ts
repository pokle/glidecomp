/**
 * The roster editor's side of the CIVL world rankings.
 *
 * Two fill buttons sit on the pilots grid: one puts CIVL IDs against names,
 * the other puts each pilot's WPRS ranking beside them. Both read
 * `POST /api/comp/:comp_id/pilot/civl-rankings`, which answers about the rows
 * currently in the GRID rather than the saved roster — the organiser is
 * mid-edit when they press it.
 *
 * The rules live on the server (`civl-ranking-match.ts`, with the reasoning);
 * this module holds the call, the display labels, and the two pure functions
 * that turn a lookup into row edits, so the fills can be tested without a grid.
 */
import { api } from "../../comp/api";
import type { ParsedRow } from "./csv";

/** What one ranking list offers one roster row. */
export interface RowMatch {
  /** Only a `civl_id` match may fill a RANK — a name never decides one. */
  matched_by: "civl_id" | "name";
  civl_id: string;
  /** The name as CIVL spells it. */
  pilot_name: string;
  rank: number;
  points: number;
}

/** One ranking list, and what it has to say about the roster we sent. */
export interface RankingList {
  slug: string;
  /** The sheet's own label, e.g. 'HG Class 1'. */
  name: string;
  /** ISO 'YYYY-MM-01' — the month this snapshot was published. */
  ranking_date: string;
  /** Roster index → match. Indices with no entry are unmatched. */
  matches: Record<number, RowMatch>;
  matched_count: number;
  rankable_count: number;
}

export interface RankingLookup {
  lists: RankingList[];
  /** The list the picker should open on, or null when we hold none. */
  default_slug: string | null;
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
 * any of that). An unknown slug — CIVL adding an eleventh list — falls back to
 * a readable form of the slug itself rather than disappearing.
 */
const LIST_LABELS: Record<string, string> = {
  "hang-gliding-class-1-xc": "HG Class 1",
  "hang-gliding-class-1-sport-xc": "HG Class 1 Sport",
  "hang-gliding-class-2-xc": "HG Class 2",
  "hang-gliding-class-5-xc": "HG Class 5",
  "paragliding-xc": "PG XC",
  "paragliding-xc-sport": "PG XC Sport",
  "paragliding-accuracy": "PG Accuracy",
  "paragliding-aerobatics": "PG Aerobatics",
  "paragliding-acro-syncro": "PG Acro Syncro",
  "paragliding-hike-fly": "PG Hike and Fly",
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
 * Where a stored ranking came from, for the pilots table. A rank with no
 * source was typed in by an organiser — that is a fact about the number, not
 * a missing value, so it is said out loud rather than left blank.
 */
export function rankingSource(pilot: {
  civl_ranking: number | null;
  civl_ranking_slug: string | null;
  civl_ranking_date: string | null;
}): string {
  if (pilot.civl_ranking === null) return "";
  if (!pilot.civl_ranking_slug) return "set by organiser";
  return `${listLabel(pilot.civl_ranking_slug)} · ${formatRankingMonth(pilot.civl_ranking_date)}`;
}

/** What a fill did, for the status line under the grid. */
export interface FillOutcome {
  rows: ParsedRow[];
  filled: number;
  /** Rows the list had nothing to say about — left exactly as they were. */
  skipped: number;
}

/**
 * Fill empty CIVL ID cells from the list's name matches.
 *
 * Only `name` matches are used, and only into an EMPTY cell: an id already in
 * the grid is someone's deliberate answer and is never second-guessed. The
 * server has already refused every ambiguous name, so anything offered here
 * is a single ranked pilot no other row is claiming.
 */
export function fillCivlIds(rows: ParsedRow[], list: RankingList): FillOutcome {
  let filled = 0;
  const out = rows.map((row, index) => {
    const match = list.matches[index];
    if (row.civl_id || !match || match.matched_by !== "name") return row;
    filled++;
    return { ...row, civl_id: match.civl_id };
  });
  return { rows: out, filled, skipped: rows.length - filled };
}

/**
 * Fill the ranking column from the list's CIVL ID matches.
 *
 * Matched BY ID ONLY, which is why the organiser fills the ids first: a rank
 * attached to the wrong human silently sets the wrong launch order, and a
 * shared name is not evidence of a shared identity. The list and month travel
 * with the number so the roster can show where it came from.
 *
 * Overwrites a rank that is already there — this is the button that says "use
 * what CIVL published", and an organiser who wants their own number types it
 * back afterwards (which drops the source, as it should).
 */
export function fillRankings(rows: ParsedRow[], list: RankingList): FillOutcome {
  let filled = 0;
  const out = rows.map((row, index) => {
    const match = list.matches[index];
    if (!match || match.matched_by !== "civl_id") return row;
    filled++;
    return {
      ...row,
      civl_ranking: String(match.rank),
      civl_ranking_slug: list.slug,
      civl_ranking_date: list.ranking_date,
    };
  });
  return { rows: out, filled, skipped: rows.length - filled };
}
