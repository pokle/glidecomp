// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Officially published AirScore results (issue #603).
 *
 * GlideComp rescores every imported task under the current S7F edition, so
 * its numbers can disagree with the officially published record. These
 * helpers pull each pilot's published rank and total out of the result files
 * the downloader already keeps on disk, so the seed can store them beside
 * the task as a display-only annotation — never a scoring input.
 *
 * Two on-disk shapes exist per task folder (see download-airscore-comp.ts):
 *  - `airscore-result-raw.json` — the verbatim `get_task_result.php` body.
 *    Each `data` row is positional: rank in column 0 (wrapped in `<b>`),
 *    pilot name in column 2 (an anchor), distance in column 10 ('abs'/'dnf'
 *    for non-flyers), the published total in the LAST column.
 *  - `airscore-result.json` — a `.curated` parity fixture's trimmed copy,
 *    with a `pilots` array of { name, total }. It carries no rank, so ranks
 *    are re-derived from the totals under the same tie rule the published
 *    tables use (equal totals share a rank; the next rank skips).
 *
 * URL builders live here too: xc.highcloud.net's scores pages are keyed by
 * the same comPk/tasPk the comp manifest already records per task, so the
 * annotation can link straight to the official record.
 */

export interface OfficialResultRow {
  /** Pilot name exactly as published (tags stripped, whitespace collapsed). */
  name: string;
  /** Published rank. Ties repeat a rank and skip the next, as published. */
  rank: number;
  /** Published total points. */
  total: number;
}

/** '<a …>Todd Wisewould</a>' → 'Todd Wisewould'. */
function stripTags(html: unknown): string {
  return String(html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The published per-pilot results out of a verbatim AirScore task result.
 *
 * Rows that were not part of the scored field are dropped: 'abs' rows
 * (absent) and any row without a positive published rank — AirScore prints
 * rank 0 for a DNF, which is a launch-validity fact, not a standing.
 */
export function parseRawOfficialRows(raw: {
  data?: unknown[][] | null;
}): OfficialResultRow[] {
  const out: OfficialResultRow[] = [];
  for (const row of raw.data ?? []) {
    if (!Array.isArray(row) || row.length < 3) continue;
    const name = stripTags(row[2]);
    if (!name) continue;
    if (row[10] === "abs") continue;
    const rank = Number(stripTags(row[0]));
    if (!Number.isInteger(rank) || rank <= 0) continue;
    const total = Number(row[row.length - 1]);
    if (!Number.isFinite(total)) continue;
    out.push({ name, rank, total });
  }
  return out;
}

/**
 * The published results out of a curated fixture's trimmed copy. It stores
 * no rank, so ranks are derived from the totals: sorted best-first, equal
 * totals share a rank, and the next distinct total takes the position after
 * the tied block — the same rule the published tables (and S7A §5.2.5.4)
 * follow.
 */
export function parseCuratedOfficialRows(trimmed: {
  pilots?: Array<{ name?: unknown; total?: unknown }> | null;
}): OfficialResultRow[] {
  const pilots = (trimmed.pilots ?? [])
    .map((p) => ({ name: stripTags(p.name), total: Number(p.total) }))
    .filter((p) => p.name && Number.isFinite(p.total))
    .sort((a, b) => b.total - a.total);
  return pilots.map((p, i) => ({
    name: p.name,
    // First index holding this total + 1: tied pilots all take the tie's
    // opening position.
    rank: pilots.findIndex((q) => q.total === p.total) + 1,
    total: p.total,
  }));
}

/** The official comp scores page for one AirScore comp (one per class). */
export function airscoreCompUrl(host: string, comPk: number): string {
  return `${host}/comp_overall.html?comPk=${comPk}`;
}

/** The official task scores page — the published record the import parsed. */
export function airscoreTaskUrl(
  host: string,
  comPk: number,
  tasPk: number,
): string {
  return `${host}/task_result.html?comPk=${comPk}&tasPk=${tasPk}`;
}
