/**
 * What importing a CSV would do to the roster, worked out BEFORE anything is
 * written, so the review page can show it and Apply can do exactly that.
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
  type ImportIssue,
  type ImportParseOptions,
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
  /** The same reasons, grouped the way the review page states them. */
  problems: ImportProblems;
  /**
   * Classes the comp does not have whose pilots were put in another one at
   * the organiser's word (`unknownClassAs`), with how many each.
   */
  remapped: Array<{ from: string; to: string; count: number }>;
}

/** Rows the review lists under a grouped sentence, with their own messages. */
export type ProblemRows = Array<{ row: number; message: string }>;

export interface ImportProblems {
  /** One entry per class the file names and the comp does not have. */
  unknownClasses: Array<{ cls: string; rows: ProblemRows }>;
  /** Rows with no name: skipped. */
  noName: ProblemRows;
  /** Rows with a name and no class. */
  noClass: ProblemRows;
  /** Anything else, as it was said: a missing name column, bad points, too many pilots. */
  other: string[];
}

/** Group the parser's issues; `other` is every error none of them explains. */
function groupProblems(issues: ImportIssue[], errors: string[]): ImportProblems {
  const problems: ImportProblems = { unknownClasses: [], noName: [], noClass: [], other: [] };
  const explained = new Set<string>();
  for (const issue of issues) {
    explained.add(issue.message);
    const entry = { row: issue.row, message: issue.message };
    if (issue.kind === "no-name") problems.noName.push(entry);
    else if (issue.kind === "no-class") problems.noClass.push(entry);
    else {
      const group = problems.unknownClasses.find((g) => g.cls === issue.cls);
      if (group) group.rows.push(entry);
      else problems.unknownClasses.push({ cls: issue.cls, rows: [entry] });
    }
  }
  problems.other = errors.filter((e) => !explained.has(e));
  return problems;
}

export type PlanOptions = ImportParseOptions;

export function planImport(
  text: string,
  fileName: string,
  roster: CompPilot[],
  compClasses: string[],
  opts: PlanOptions = {}
): ImportPlan {
  const parsed = parseImportedCsv(text, compClasses, opts);
  const remapped: ImportPlan["remapped"] = [];
  for (const r of parsed.remapped) {
    const group = remapped.find((g) => g.from === r.from);
    if (group) group.count++;
    else remapped.push({ from: r.from, to: r.to, count: 1 });
  }
  const empty: ImportPlan = {
    fileName,
    added: [],
    updated: [],
    removed: [],
    unchanged: 0,
    errors: [],
    problems: groupProblems([], []),
    remapped,
  };
  if (parsed.rows.length === 0) {
    const errors = parsed.errors.length > 0 ? parsed.errors : ["No pilot rows found in file"];
    return { ...empty, errors, problems: groupProblems(parsed.issues, errors) };
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

  // The parser has already said which classes are wrong; validating them
  // again listed every such row twice.
  const { payload, errors } = validateRows(rows, compClasses, { checkClasses: false });
  const allErrors = [...parsed.errors, ...errors];
  const plan: ImportPlan = {
    ...empty,
    errors: allErrors,
    problems: groupProblems(parsed.issues, allErrors),
  };

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

/**
 * The class "put them in …" means: the comp's default, or its first class
 * when the default is somehow not among them.
 */
export function fallbackClass(compClasses: string[], defaultClass: string | null | undefined): string {
  return defaultClass && compClasses.includes(defaultClass) ? defaultClass : compClasses[0];
}

/** "a", "a and b", "a, b and c". */
export function listInWords(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
