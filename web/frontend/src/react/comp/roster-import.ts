/**
 * What importing a CSV would do to the roster, worked out BEFORE anything is
 * written, so the review sheet can show it and Apply can do exactly that.
 *
 * An imported file is the roster: a pilot it holds is added or updated, and a
 * pilot it does not hold is removed — tracks and all. The grid this replaced
 * did the same, said so in one sentence under the grid, and showed nobody's
 * name. The plan names every pilot it removes, with their tracks.
 *
 * Matching is the import's own (csv.ts `classifyImportRows`): by an ID, then
 * by email. A name alone never matches — names may propose, never dispose —
 * so a file of bare names re-adds everyone as new and removes the originals.
 * The plan cannot stop that without guessing, but it can SAY it: a removed
 * pilot who shares a name with a new row is flagged, which is the one case
 * where the review would otherwise read as a mistake made on purpose.
 *
 * Applied as one bulk save with an explicit `remove` list, sending only the
 * rows that change: anyone the plan does not mention — a pilot who joins
 * while the review is open — is left alone.
 */
import {
  classifyImportRows,
  importedRows,
  normalizeRow,
  parsedRowToBulk,
  parseImportedCsv,
  parsePoints,
  pilotToRow,
  validateRows,
  type BulkPilotRow,
  type CompPilot,
  type ParsedRow,
} from "./csv";

export interface ImportPlan {
  fileName: string;
  /** New pilots, as they will be sent. */
  added: BulkPilotRow[];
  /** Pilots the file changes, and what they were. */
  updated: Array<{ before: CompPilot; row: BulkPilotRow }>;
  /** Pilots the file does not hold, which Apply removes. */
  removed: Array<{ pilot: CompPilot; sameNameAsNew: boolean }>;
  /** Pilots the file holds unchanged. Nothing is sent for them. */
  unchanged: number;
  /** Why the file cannot be applied. Apply is refused while any remain. */
  errors: string[];
}

export function planImport(
  text: string,
  fileName: string,
  roster: CompPilot[],
  compClasses: string[]
): ImportPlan {
  const parsed = parseImportedCsv(text, compClasses);
  const empty: ImportPlan = { fileName, added: [], updated: [], removed: [], unchanged: 0, errors: [] };
  if (parsed.rows.length === 0) {
    return {
      ...empty,
      errors: parsed.errors.length > 0 ? parsed.errors : ["No pilot rows found in file"],
    };
  }

  const byId = new Map(roster.map((p) => [p.comp_pilot_id, p]));
  const rows: ParsedRow[] = importedRows(classifyImportRows(parsed.rows, roster)).map((row) => {
    const before = row.comp_pilot_id ? byId.get(row.comp_pilot_id) : undefined;
    // A spreadsheet has no column for where a score came from, so an exported
    // and re-imported roster would arrive with every CIVL score turned into a
    // hand-set one — and every pilot "updated". The NUMBER is what the file
    // can speak to: while it is unchanged, so is where it came from.
    if (before && before.wprs_points !== null && parsePoints(row.wprs_points) === before.wprs_points) {
      return {
        ...row,
        civl_ranking_slug: before.civl_ranking_slug,
        civl_ranking_date: before.civl_ranking_date,
      };
    }
    return row;
  });

  const { payload, errors } = validateRows(rows, compClasses);
  const plan: ImportPlan = { ...empty, errors: [...parsed.errors, ...errors] };

  const kept = new Set<string>();
  for (const row of payload) {
    const before = row.comp_pilot_id ? byId.get(row.comp_pilot_id) : undefined;
    if (!before) {
      plan.added.push(row);
      continue;
    }
    kept.add(before.comp_pilot_id);
    const was = parsedRowToBulk(normalizeRow(pilotToRow(before)));
    if (JSON.stringify(was) === JSON.stringify(row)) plan.unchanged++;
    else plan.updated.push({ before, row });
  }

  const newNames = new Set(plan.added.map((r) => r.registered_pilot_name.toLowerCase()));
  plan.removed = roster
    .filter((p) => !kept.has(p.comp_pilot_id))
    .map((pilot) => ({ pilot, sameNameAsNew: newNames.has(pilot.name.toLowerCase()) }));
  return plan;
}

/** Whether Apply has anything to do. */
export function planChanges(plan: ImportPlan): number {
  return plan.added.length + plan.updated.length + plan.removed.length;
}

/** The bulk request that applies a plan. */
export function planRequest(plan: ImportPlan): { pilots: BulkPilotRow[]; remove: string[] } {
  return {
    pilots: [...plan.updated.map((u) => u.row), ...plan.added],
    remove: plan.removed.map((r) => r.pilot.comp_pilot_id),
  };
}
