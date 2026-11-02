/**
 * What the pilot page sends when Done is pressed, worked out without the
 * sheet: the draft is the same ParsedRow the CSV import uses, so the
 * trimming, the blank-means-null rule and the WPRS parsing are the import's
 * own (csv.ts), not a second copy.
 *
 * An existing pilot is saved with a PATCH of the fields that CHANGED, and
 * nothing else. The server audits each field it is sent and re-decides the
 * pilot's account link only when an identity field moves, so sending the
 * whole row would be heard as an edit to every field (see nextPilotLink in
 * competition-api's routes/pilot.ts).
 */
import {
  normalizeRow,
  parsedRowToBulk,
  parsePoints,
  pilotToRow,
  type BulkPilotRow,
  type CompPilot,
  type ParsedRow,
} from "./csv";

/** The editable fields, in the order the bulk row names them. */
type EditableKey = Exclude<keyof BulkPilotRow, "comp_pilot_id">;

/** The PATCH body for an edited pilot: only the fields that changed. */
export function patchBody(original: CompPilot, draft: ParsedRow): Partial<BulkPilotRow> {
  const before = parsedRowToBulk(normalizeRow(pilotToRow(original)));
  const after = parsedRowToBulk(normalizeRow(draft));
  const out: Partial<Record<EditableKey, unknown>> = {};
  for (const key of Object.keys(after) as EditableKey[]) {
    if (key === ("comp_pilot_id" as string)) continue;
    if ((before[key] ?? null) !== (after[key] ?? null)) out[key] = after[key] ?? null;
  }
  return out as Partial<BulkPilotRow>;
}

/** The POST body for a new pilot. */
export function createBody(draft: ParsedRow): BulkPilotRow {
  const { comp_pilot_id: _drop, ...row } = parsedRowToBulk(normalizeRow(draft));
  return row;
}

/** Whether the draft holds anything at all — a new pilot left blank is no pilot. */
export function isBlankDraft(draft: ParsedRow): boolean {
  const row = normalizeRow(draft);
  return Object.entries(row).every(
    ([key, value]) => key === "pilot_class" || value === null || value === ""
  );
}

/** Whether a draft differs from what it started as. */
export function isDirtyDraft(start: ParsedRow, draft: ParsedRow): boolean {
  return (
    JSON.stringify(parsedRowToBulk(normalizeRow(start))) !==
    JSON.stringify(parsedRowToBulk(normalizeRow(draft)))
  );
}

/** A deliberately loose shape check; the server holds the real rule. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Field-by-field reasons the draft cannot be saved. Empty when it can. */
export function draftProblems(
  draft: ParsedRow,
  compClasses: string[]
): Partial<Record<"name" | "pilot_class" | "email" | "wprs_points", string>> {
  const row = normalizeRow(draft);
  const problems: Partial<Record<"name" | "pilot_class" | "email" | "wprs_points", string>> = {};
  if (!row.name) problems.name = "Enter the pilot's name.";
  if (!row.pilot_class || !compClasses.includes(row.pilot_class)) {
    problems.pilot_class = "Choose a class.";
  }
  if (row.email && !EMAIL_SHAPE.test(row.email)) {
    problems.email = "Enter an email address like name@example.com.";
  }
  if (row.wprs_points !== null && parsePoints(row.wprs_points) === null) {
    problems.wprs_points =
      "Enter World Pilot Ranking Scheme points as a number above 0, like 261.5.";
  }
  return problems;
}
