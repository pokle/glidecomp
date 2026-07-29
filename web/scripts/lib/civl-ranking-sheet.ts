// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Turn a CIVL "Pilots ranking list" export into records.
 *
 * The workbook civlcomps.org produces is two tables stacked in one sheet:
 *
 *   row 1   ranking_date |   | name        |   | region |   | selection |   | created
 *   row 2   Jul 1, 2026  |   | HG Class 1  |   | World  |   | Overall   |   | Jul 1, 2026 03:05
 *   rows 3-4  (blank)
 *   row 5   Rank | CIVL ID | Name | Gender | Nation | Points | r1 p1 e1 … r4 p4 e4
 *   row 6+  1 | 25161 | Marco Laurenzi | M | Italy | 339.3 | …
 *   row N-1 count
 *   row N   747
 *
 * Three things about that shape drive the parsing below:
 *
 *   * The metadata header interleaves blanks (values in A, C, E, G, I), so
 *     both header rows are read BY NAME. Reading positionally works right up
 *     until CIVL drops a column.
 *   * The pilot header row is found by looking for the row starting "Rank",
 *     not by hardcoding row 5. Same reason.
 *   * The trailing two-row `count` footer is a free integrity check — the row
 *     total, computed by the exporter. `parseRankingSheet` asserts it, so a
 *     truncated download fails loudly instead of quietly importing a partial
 *     ranking. (`extract_civl_ranking.py` in the predecessor project just
 *     dropped these rows as NaN; asserting is strictly better.)
 */

const MONTHS = [
  'jan', 'feb', 'mar', 'apr', 'may', 'jun',
  'jul', 'aug', 'sep', 'oct', 'nov', 'dec',
];

/** The four metadata fields carried onto every row, plus the export timestamp. */
export interface RankingMeta {
  /** ISO 'YYYY-MM-DD'. CIVL always publishes on the 1st. */
  ranking_date: string;
  /** Display label, e.g. 'HG Class 1'. */
  name: string;
  /** e.g. 'World'. */
  region: string;
  /** e.g. 'Overall'. */
  selection: string;
  /** Raw `created` cell, e.g. 'Jul 1, 2026 03:05'. Kept for logging only. */
  created: string;
}

export interface RankingPilot {
  rank: number;
  civl_id: string;
  name: string;
  gender: string;
  nation: string;
  points: number;
}

export interface ParsedRankingSheet {
  meta: RankingMeta;
  pilots: RankingPilot[];
}

/**
 * `'Jul 1, 2026'` -> `'2026-07-01'`.
 *
 * Deliberately strict, and deliberately not `new Date(...)`: the parsed date
 * is what the importer compares against D1 to decide whether a month is
 * already stored, so a value it can't read must be an error rather than
 * something that silently never matches (or, worse, matches the wrong month
 * after a timezone shift).
 */
export function parseCivlDate(input: string): string {
  const m = input.trim().match(/^([A-Za-z]{3,})\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) throw new Error(`Unrecognised CIVL date: ${JSON.stringify(input)}`);
  const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (month === -1) throw new Error(`Unrecognised month in CIVL date: ${JSON.stringify(input)}`);
  const day = Number(m[2]);
  if (day < 1 || day > 31) throw new Error(`Out-of-range day in CIVL date: ${JSON.stringify(input)}`);
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Case- and space-insensitive header lookup: 'CIVL ID' and 'civl_id' both hit. */
function headerIndex(row: string[], ...names: string[]): number {
  const want = names.map((n) => n.toLowerCase().replace(/[\s_]+/g, ''));
  for (let i = 0; i < row.length; i++) {
    const cell = (row[i] ?? '').trim().toLowerCase().replace(/[\s_]+/g, '');
    if (cell && want.includes(cell)) return i;
  }
  return -1;
}

function requireHeader(row: string[], label: string, ...names: string[]): number {
  const i = headerIndex(row, ...names);
  if (i === -1) throw new Error(`Ranking sheet has no "${label}" column (headers: ${row.join(' | ')})`);
  return i;
}

/**
 * Parse the grid produced by `readSheetRows`.
 *
 * @param rows padded so `rows[n - 1]` is spreadsheet row n
 */
export function parseRankingSheet(rows: string[][]): ParsedRankingSheet {
  // --- metadata: the first row carrying a `ranking_date` header ------------
  let metaHeader = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (headerIndex(rows[i], 'ranking_date') !== -1) {
      metaHeader = i;
      break;
    }
  }
  if (metaHeader === -1) throw new Error('Ranking sheet has no metadata header row');
  const mh = rows[metaHeader];
  const mv = rows[metaHeader + 1] ?? [];
  const metaCell = (label: string, ...names: string[]) =>
    (mv[requireHeader(mh, label, ...names)] ?? '').trim();

  const meta: RankingMeta = {
    ranking_date: parseCivlDate(metaCell('ranking_date', 'ranking_date')),
    name: metaCell('name', 'name'),
    region: metaCell('region', 'region'),
    selection: metaCell('selection', 'selection'),
    created: metaCell('created', 'created'),
  };
  if (!meta.name) throw new Error('Ranking sheet metadata has an empty name');

  // --- pilot table --------------------------------------------------------
  let pilotHeader = -1;
  for (let i = metaHeader + 2; i < rows.length; i++) {
    if (headerIndex(rows[i], 'rank') === 0) {
      pilotHeader = i;
      break;
    }
  }
  if (pilotHeader === -1) throw new Error('Ranking sheet has no pilot header row (expected one starting "Rank")');
  const ph = rows[pilotHeader];
  const cRank = requireHeader(ph, 'Rank', 'rank');
  const cCivl = requireHeader(ph, 'CIVL ID', 'civl id', 'civlid');
  const cName = requireHeader(ph, 'Name', 'name');
  const cGender = headerIndex(ph, 'gender');
  const cNation = headerIndex(ph, 'nation');
  const cPoints = headerIndex(ph, 'points');

  const pilots: RankingPilot[] = [];
  let declaredCount: number | null = null;

  for (let i = pilotHeader + 1; i < rows.length; i++) {
    const row = rows[i];
    const first = (row[0] ?? '').trim();

    // The footer: a `count` label, then the total on the next row. Everything
    // after it is out of the table.
    if (first.toLowerCase() === 'count') {
      const raw = (rows[i + 1]?.[0] ?? '').trim();
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`Ranking sheet footer count is not a number: ${JSON.stringify(raw)}`);
      declaredCount = n;
      break;
    }

    const civlId = (row[cCivl] ?? '').trim();
    if (!civlId) continue; // blank separator row
    const rank = Number((row[cRank] ?? '').trim());
    if (!Number.isFinite(rank)) {
      throw new Error(`Ranking sheet row ${i + 1} has a non-numeric rank: ${JSON.stringify(row[cRank])}`);
    }
    const points = cPoints === -1 ? 0 : Number((row[cPoints] ?? '').trim());

    pilots.push({
      rank,
      civl_id: civlId,
      name: (row[cName] ?? '').trim(),
      gender: cGender === -1 ? '' : (row[cGender] ?? '').trim(),
      nation: cNation === -1 ? '' : (row[cNation] ?? '').trim(),
      points: Number.isFinite(points) ? points : 0,
    });
  }

  if (declaredCount === null) {
    throw new Error('Ranking sheet has no "count" footer — the download may be truncated');
  }
  if (declaredCount !== pilots.length) {
    throw new Error(
      `Ranking sheet count mismatch: footer says ${declaredCount}, parsed ${pilots.length} pilots`,
    );
  }

  // One CIVL id per list per month. A duplicate would silently collide on the
  // unique index at insert time; catching it here names the pilot.
  const seen = new Set<string>();
  for (const p of pilots) {
    if (seen.has(p.civl_id)) {
      throw new Error(`Ranking sheet has duplicate CIVL ID ${p.civl_id} (${p.name})`);
    }
    seen.add(p.civl_id);
  }

  return { meta, pilots };
}
