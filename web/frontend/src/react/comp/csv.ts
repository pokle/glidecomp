/**
 * Pure CSV / row helpers for the pilots page: the row shape the pilot page
 * edits (comp/PilotForm.tsx), and the CSV import and export
 * (comp/roster-import.ts). They take the comp's classes and current pilots as
 * explicit arguments so they stay pure and unit-testable.
 *
 * One pilot is saved through its own PATCH/POST; anything that changes many
 * pilots at once goes through POST /api/comp/:comp_id/pilot/bulk with only the
 * rows that change and an explicit `remove` list.
 */

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The full shape a `comp_pilot` row takes when rendered in the UI. Matches
 * the server serialiser in routes/pilot.ts exactly — any field the server
 * returns is mirrored here so round-trips through the edit dialog lose
 * nothing.
 */
export interface CompPilot {
  comp_pilot_id: string;
  linked: boolean;
  linked_email: string | null;
  linked_username: string | null;
  name: string;
  email: string | null;
  civl_id: string | null;
  safa_id: string | null;
  ushpa_id: string | null;
  bhpa_id: string | null;
  dhv_id: string | null;
  ffvl_id: string | null;
  fai_id: string | null;
  glider: string | null;
  pilot_class: string;
  team_name: string | null;
  driver_contact: string | null;
  /**
   * The pilot's WPRS score as the organiser is running this comp off it —
   * copied from `pilot_ranking`, or typed in. Launch order is set from it, so
   * it is a competition's own record and never re-read from the live list
   * (migrations 0029/0030). Points and not a rank because a rank is only a
   * position within one list's pool; points are the same quantity in all of
   * them.
   */
  wprs_points: number | null;
  /** The CIVL list the points came from, or null when they were set by hand. */
  civl_ranking_slug: string | null;
  /** That list's snapshot month (ISO 'YYYY-MM-01'), or null when hand-set. */
  civl_ranking_date: string | null;
  first_start_order: number | null;
  /**
   * How many tracks the pilot has uploaded to this comp. Removing the pilot
   * deletes them too, so this is what Remove costs.
   */
  track_count: number;
}

/**
 * One editable row: the CSV columns plus the original comp_pilot_id (absent
 * for newly added / unmatched imported rows) so the bulk endpoint treats
 * existing rows as updates rather than delete+create.
 */
export interface ParsedRow {
  comp_pilot_id?: string;
  name: string;
  email: string | null;
  civl_id: string | null;
  safa_id: string | null;
  ushpa_id: string | null;
  bhpa_id: string | null;
  dhv_id: string | null;
  ffvl_id: string | null;
  fai_id: string | null;
  pilot_class: string;
  team_name: string | null;
  driver_contact: string | null;
  glider: string | null;
  /** Editable as text like every other cell; parsed to a number on save. */
  wprs_points: string | null;
  /**
   * Where the points came from. NOT columns — they are carried invisibly
   * through the grid so a save keeps the provenance a fill established, and
   * the grid clears them the moment someone types over the number (see
   * PilotsSection's cellEdited). A CSV round trip drops them, which is the
   * honest answer: a score that came back through a spreadsheet is hand-set.
   */
  civl_ranking_slug?: string | null;
  civl_ranking_date?: string | null;
}

/** Request body row sent to POST /api/comp/:comp_id/pilot/bulk. */
export interface BulkPilotRow {
  comp_pilot_id?: string;
  registered_pilot_name: string;
  registered_pilot_email?: string | null;
  registered_pilot_civl_id?: string | null;
  registered_pilot_safa_id?: string | null;
  registered_pilot_ushpa_id?: string | null;
  registered_pilot_bhpa_id?: string | null;
  registered_pilot_dhv_id?: string | null;
  registered_pilot_ffvl_id?: string | null;
  registered_pilot_fai_id?: string | null;
  registered_pilot_glider?: string | null;
  pilot_class: string;
  team_name?: string | null;
  driver_contact?: string | null;
  wprs_points?: number | null;
  civl_ranking_slug?: string | null;
  civl_ranking_date?: string | null;
}

/** Column metadata for CSV serialisation. Kept as a single source of truth. */
export interface ColumnDef {
  key: keyof Omit<
    ParsedRow,
    "comp_pilot_id" | "civl_ranking_slug" | "civl_ranking_date"
  >;
  /** External name used in CSV headers and in user-facing hints. */
  header: string;
  /** Accepted aliases when parsing an imported header row (case-insensitive). */
  aliases?: string[];
}

export const COLUMNS: ColumnDef[] = [
  { key: "name", header: "name", aliases: ["pilot_name", "full_name"] },
  { key: "email", header: "email" },
  { key: "glider", header: "glider" },
  { key: "pilot_class", header: "class", aliases: ["pilot_class"] },
  { key: "team_name", header: "team", aliases: ["team_name"] },
  { key: "driver_contact", header: "driver", aliases: ["driver_contact"] },
  // Sits beside civl_id — not because it is an ID, but because the two are
  // filled in together (ids first, then the scores that follow from them), and
  // a column you fill from the one next to it should not be nine columns of
  // horizontal scrolling away. It stays out of the ID block itself.
  //
  // `civl_ranking` and `ranking` stay as aliases: rosters exported while the
  // column held a RANK are still on organisers' disks, and a header we refuse
  // to read would import as an unranked field with no complaint.
  {
    key: "wprs_points",
    header: "wprs_points",
    aliases: ["wprs", "points", "civl_ranking", "ranking", "world_ranking"],
  },
  { key: "civl_id", header: "civl_id", aliases: ["civl", "civlid"] },
  { key: "safa_id", header: "safa_id", aliases: ["safa"] },
  { key: "ushpa_id", header: "ushpa_id", aliases: ["ushpa"] },
  { key: "bhpa_id", header: "bhpa_id", aliases: ["bhpa"] },
  { key: "dhv_id", header: "dhv_id", aliases: ["dhv"] },
  { key: "ffvl_id", header: "ffvl_id", aliases: ["ffvl"] },
  { key: "fai_id", header: "fai_id", aliases: ["fai"] },
];

/** Maximum pilots per comp — mirrors MAX_PILOTS_PER_COMP on the server. */
export const MAX_PILOTS = 250;

// ── Row constructors / normalisation ─────────────────────────────────────────

export function emptyRow(compClasses: string[]): ParsedRow {
  return {
    name: "",
    email: null,
    civl_id: null,
    safa_id: null,
    ushpa_id: null,
    bhpa_id: null,
    dhv_id: null,
    ffvl_id: null,
    fai_id: null,
    pilot_class: compClasses.length === 1 ? compClasses[0] : "",
    team_name: null,
    driver_contact: null,
    glider: null,
    wprs_points: null,
    civl_ranking_slug: null,
    civl_ranking_date: null,
  };
}

export function pilotToRow(p: CompPilot): ParsedRow {
  return {
    comp_pilot_id: p.comp_pilot_id,
    name: p.name,
    email: p.email,
    civl_id: p.civl_id,
    safa_id: p.safa_id,
    ushpa_id: p.ushpa_id,
    bhpa_id: p.bhpa_id,
    dhv_id: p.dhv_id,
    ffvl_id: p.ffvl_id,
    fai_id: p.fai_id,
    pilot_class: p.pilot_class,
    team_name: p.team_name,
    driver_contact: p.driver_contact,
    glider: p.glider,
    wprs_points: p.wprs_points === null ? null : String(p.wprs_points),
    civl_ranking_slug: p.civl_ranking_slug,
    civl_ranking_date: p.civl_ranking_date,
  };
}

/**
 * Normalise a row: trim everything; empty optionals become null.
 *
 * The ranking's source travels with it rather than through COLUMNS: it is not
 * a cell, and clearing the rank clears the source, because a list and a month
 * attached to no number describe nothing.
 */
export function normalizeRow(raw: ParsedRow): ParsedRow {
  const row = emptyRow([]);
  if (raw.comp_pilot_id) row.comp_pilot_id = raw.comp_pilot_id;
  for (const c of COLUMNS) {
    const v = raw[c.key];
    const value = v === null || v === undefined ? "" : String(v).trim();
    if (c.key === "name" || c.key === "pilot_class") {
      (row as unknown as Record<string, unknown>)[c.key] = value;
    } else {
      (row as unknown as Record<string, unknown>)[c.key] = value || null;
    }
  }
  if (row.wprs_points) {
    row.civl_ranking_slug = raw.civl_ranking_slug ?? null;
    row.civl_ranking_date = raw.civl_ranking_date ?? null;
  }
  return row;
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate rows before save. Rows that are completely empty (e.g. an unused
 * "Add row") are silently dropped; anything with content needs a name and a
 * valid class. Rows are normalised first.
 */
export function validateRows(
  rows: ParsedRow[],
  compClasses: string[],
  /** False where the rows were parsed by parseImportedCsv, which has already
   *  said which classes are wrong — once per row, not twice. */
  { checkClasses = true }: { checkClasses?: boolean } = {}
): { payload: BulkPilotRow[]; errors: string[] } {
  const errors: string[] = [];
  const kept: ParsedRow[] = [];

  rows.map(normalizeRow).forEach((row, i) => {
    const hasContent = COLUMNS.some((c) => {
      const v = row[c.key];
      return v !== null && v !== undefined && String(v) !== "";
    });
    if (!hasContent) return;

    if (!row.name) {
      errors.push(`Row ${i + 1}: name is required`);
      return;
    }
    if (!checkClasses) {
      // Reported by the parser already.
    } else if (!row.pilot_class) {
      errors.push(`Row ${i + 1} (${row.name}): class is required`);
    } else if (!compClasses.includes(row.pilot_class)) {
      errors.push(
        `Row ${i + 1} (${row.name}): class "${row.pilot_class}" is not valid for this competition (valid: ${compClasses.join(", ")})`
      );
    }
    // Caught here rather than by the server's 400 so the message names the
    // row and the value.
    if (row.wprs_points !== null && parsePoints(row.wprs_points) === null) {
      errors.push(
        `Row ${i + 1} (${row.name}): WPRS points "${row.wprs_points}" is not a number above 0`
      );
    }
    kept.push(row);
  });

  if (kept.length > MAX_PILOTS) {
    errors.push(`Too many pilots: ${kept.length} (max ${MAX_PILOTS})`);
  }

  return { payload: kept.map(parsedRowToBulk), errors };
}

/**
 * A WPRS points cell as a number, or null when it is blank or not one.
 *
 * One decimal place is allowed and meaningful — CIVL publishes 261.5, and near
 * the top of a list that decimal is the whole difference between two pilots.
 * Anything else is refused rather than coerced ("261.5 pts", "~261"), because
 * the number decides launch order.
 */
export function parsePoints(value: string | null): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parsedRowToBulk(row: ParsedRow): BulkPilotRow {
  const points = parsePoints(row.wprs_points);
  return {
    ...(row.comp_pilot_id ? { comp_pilot_id: row.comp_pilot_id } : {}),
    registered_pilot_name: row.name,
    registered_pilot_email: row.email,
    registered_pilot_civl_id: row.civl_id,
    registered_pilot_safa_id: row.safa_id,
    registered_pilot_ushpa_id: row.ushpa_id,
    registered_pilot_bhpa_id: row.bhpa_id,
    registered_pilot_dhv_id: row.dhv_id,
    registered_pilot_ffvl_id: row.ffvl_id,
    registered_pilot_fai_id: row.fai_id,
    registered_pilot_glider: row.glider,
    pilot_class: row.pilot_class,
    team_name: row.team_name,
    driver_contact: row.driver_contact,
    wprs_points: points,
    // No number, no source. And a score that survived a CSV round trip has
    // lost its source columns, so it goes back as hand-set — which it is.
    civl_ranking_slug: points === null ? null : (row.civl_ranking_slug ?? null),
    civl_ranking_date: points === null ? null : (row.civl_ranking_date ?? null),
  };
}

/**
 * The pilots a save should remove: the ones the editor was opened with that
 * are no longer in the payload — deleted from the grid, or left out of an
 * imported CSV.
 *
 * Sent as the bulk route's `remove` list rather than leaving the server to
 * delete "everyone the payload does not mention", because that includes
 * pilots the editor never showed: one who joined through open registration
 * while the editor was open was deleted, tracks and all, by the next Save.
 */
export function removedPilotIds(shown: CompPilot[], payload: BulkPilotRow[]): string[] {
  const kept = new Set(payload.flatMap((r) => (r.comp_pilot_id ? [r.comp_pilot_id] : [])));
  return shown.map((p) => p.comp_pilot_id).filter((id) => !kept.has(id));
}

// ── CSV export ───────────────────────────────────────────────────────────────

/**
 * Serialise rows as CSV. Emits the full column set (including IDs not
 * visible in the read-only table) so re-importing is a no-op. The header
 * row is always written, so an empty table still yields a fillable template.
 */
/**
 * The column that carries each pilot's GlideComp id through a spreadsheet.
 *
 * Last, and not in {@link COLUMNS}, because it is not something an organiser
 * fills in — it is how an exported roster comes back as the SAME pilots. A
 * pilot who joined by uploading a track has no email or ID on their roster
 * row, so without it an export, edit and re-import matched them to nobody:
 * the import added them again and removed the originals, tracks and all.
 * Leave it blank (a new row, or a fresh template) and matching falls back to
 * IDs and email as before.
 */
export const ID_HEADER = "glidecomp_id";

export function exportCsvContent(rows: ParsedRow[]): string {
  const header = [...COLUMNS.map((c) => c.header), ID_HEADER].join(",");
  const lines = rows.map((r) =>
    [...COLUMNS.map((c) => csvEscape(r[c.key])), csvEscape(r.comp_pilot_id ?? "")].join(",")
  );
  return [header, ...lines].join("\n") + "\n";
}

/**
 * A leading `=`/`+`/`-`/`@`/tab/CR is a formula trigger in Excel/Sheets; a
 * pilot or team name starting with one is prefixed with `'` so opening the
 * exported file can never execute it (CSV/DDE formula injection).
 */
export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * The `'` `csvEscape` prefixes onto a formula-looking value is only meaningful
 * to a spreadsheet app — reimporting our own export must not carry it through
 * as a literal leading quote forever. Strips exactly the guard we would have
 * added (a `'` immediately before `=`/`+`/`-`/`@`), so a genuinely apostrophe-
 * led name is untouched.
 */
function stripFormulaGuard(value: string): string {
  return /^'[=+\-@]/.test(value) ? value.slice(1) : value;
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * One reason a row cannot be imported as it stands, with the message the
 * row-by-row list shows. `errors` carries the same messages as plain strings;
 * these are what the review page groups ("25 pilots are in the class …")
 * without reading its own sentences back.
 */
export type ImportIssue =
  | { kind: "no-name"; row: number; message: string }
  | { kind: "no-class"; row: number; name: string; message: string }
  | { kind: "unknown-class"; row: number; name: string; cls: string; message: string };

/** A row whose class the comp does not have, put in `to` at the organiser's word. */
export interface ImportRemap {
  row: number;
  name: string;
  from: string;
  to: string;
}

export interface ImportParseOptions {
  /**
   * Put every row whose class the comp does not have in this class instead
   * (the review page's "Put them in …"). Ignored unless the comp has it. A row
   * with NO class is not moved: nothing was said about it to be overruled.
   */
  unknownClassAs?: string;
}

export interface ParsedImport {
  rows: ParsedRow[];
  errors: string[];
  issues: ImportIssue[];
  remapped: ImportRemap[];
}

/**
 * Parse CSV or TSV with header row. Handles quoted fields, doubled-quote
 * escaping, a UTF-8 BOM (Excel prepends one), and comma / tab / semicolon
 * separators (auto-detected from the header; semicolon is what Excel writes
 * in many European locales). Header matching is case-insensitive, column
 * order is free, and unknown columns are ignored (no error); missing
 * columns → null. Only "name" is a required column — if "class" is absent
 * or blank it defaults to the comp's class when there is exactly one.
 *
 * Rows with a missing or invalid class are still returned (the class select
 * is the easiest place to fix them) with an error noting the problem; rows
 * without a name are dropped.
 */
export function parseImportedCsv(
  text: string,
  compClasses: string[],
  opts: ImportParseOptions = {}
): ParsedImport {
  const none = { issues: [], remapped: [] };
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (!trimmed) {
    return { rows: [], errors: ["No data provided"], ...none };
  }
  const lines = splitCsvLines(trimmed);
  if (lines.length === 0) {
    return { rows: [], errors: ["No data provided"], ...none };
  }
  // Only a class the comp has can stand in for one it does not.
  const fallback =
    opts.unknownClassAs && compClasses.includes(opts.unknownClassAs) ? opts.unknownClassAs : null;

  // Auto-detect separator: whichever of tab / semicolon / comma appears most
  // in the header row (comma on a tie or when none appear).
  const headerLine = lines[0];
  const sep = detectSeparator(headerLine);
  const headerCells = parseCsvLine(headerLine, sep).map((h) => h.trim().toLowerCase());

  // Build header → ParsedRow-key map using COLUMNS aliases
  const keyOf = new Map<string, ColumnDef["key"]>();
  for (const col of COLUMNS) {
    keyOf.set(col.header.toLowerCase(), col.key);
    for (const alias of col.aliases ?? []) {
      keyOf.set(alias.toLowerCase(), col.key);
    }
  }

  const columnKeys: (ColumnDef["key"] | null)[] = headerCells.map((h) => keyOf.get(h) ?? null);
  const idColumn = headerCells.findIndex((h) => h === ID_HEADER || h === "comp_pilot_id");

  if (!columnKeys.includes("name")) {
    return {
      rows: [],
      errors: ['CSV must contain a "name" column (all other columns are optional)'],
      ...none,
    };
  }

  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  const issues: ImportIssue[] = [];
  const remapped: ImportRemap[] = [];
  const problem = (issue: ImportIssue) => {
    issues.push(issue);
    errors.push(issue.message);
  };
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], sep);
    // emptyRow(compClasses) pre-fills the class when the comp has exactly
    // one, so a CSV without a class column still imports cleanly there.
    const row = emptyRow(compClasses);
    for (let c = 0; c < cells.length && c < columnKeys.length; c++) {
      const key = columnKeys[c];
      if (!key) continue;
      const value = cells[c].trim();
      if (key === "name") {
        row.name = stripFormulaGuard(value);
      } else if (key === "pilot_class") {
        // A blank class cell keeps the single-class default.
        if (value) row.pilot_class = value;
      } else {
        (row as unknown as Record<string, unknown>)[key] = stripFormulaGuard(value) || null;
      }
    }
    // Only ever a candidate: classifyImportRows keeps it if this roster
    // holds that pilot and drops it otherwise.
    const id = idColumn >= 0 ? (cells[idColumn] ?? "").trim() : "";
    if (id) row.comp_pilot_id = id;
    if (!row.name) {
      problem({ kind: "no-name", row: i, message: `Row ${i}: name is required — row skipped` });
      continue;
    }
    if (!row.pilot_class) {
      problem({
        kind: "no-class",
        row: i,
        name: row.name,
        message: `Row ${i} (${row.name}): class is missing — set it before saving`,
      });
    } else if (!compClasses.includes(row.pilot_class)) {
      if (fallback) {
        // The organiser chose this on the review page: a class the comp does
        // not have becomes its default one, and the review says so.
        remapped.push({ row: i, name: row.name, from: row.pilot_class, to: fallback });
        row.pilot_class = fallback;
      } else {
        problem({
          kind: "unknown-class",
          row: i,
          name: row.name,
          cls: row.pilot_class,
          message: `Row ${i} (${row.name}): class "${row.pilot_class}" is not valid (valid: ${compClasses.join(", ")}) — fix it before saving`,
        });
      }
    }
    rows.push(row);
  }

  return { rows, errors, issues, remapped };
}

/** Pick the separator (tab / semicolon / comma) that appears most in the header. */
function detectSeparator(headerLine: string): string {
  let best = ",";
  let bestCount = 0;
  for (const sep of ["\t", ";", ","]) {
    const count = headerLine.split(sep).length - 1;
    if (count > bestCount) {
      best = sep;
      bestCount = count;
    }
  }
  return best;
}

/** Split text into CSV lines, respecting quoted newlines. */
function splitCsvLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      current += ch;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/** Parse a single CSV line into cells, handling quoted fields. */
function parseCsvLine(line: string, sep: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === sep) {
        cells.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  cells.push(current);
  return cells;
}

// ── Import classification ────────────────────────────────────────────────────

export interface ImportClassifiedRow {
  parsed: ParsedRow;
  action: "new" | "match" | "name";
  /** The existing comp_pilot_id (if matched). */
  matchedId?: string;
}

/**
 * Classify each parsed import row against the currently loaded pilots.
 *
 * Priority chain mirrors the server-side resolver: CIVL → other IDs → email.
 * Name-only matches are flagged but DO NOT auto-link; the user has to fix the
 * CSV manually. This prevents accidental merges when two pilots share a name.
 */
export function classifyImportRows(
  rows: ParsedRow[],
  currentPilots: CompPilot[]
): ImportClassifiedRow[] {
  const byCivl = new Map<string, CompPilot>();
  const byEmail = new Map<string, CompPilot>();
  const byName = new Map<string, CompPilot[]>();
  const byOtherId: Record<string, Map<string, CompPilot>> = {
    safa_id: new Map(),
    ushpa_id: new Map(),
    bhpa_id: new Map(),
    dhv_id: new Map(),
    ffvl_id: new Map(),
    fai_id: new Map(),
  };
  for (const p of currentPilots) {
    if (p.civl_id) byCivl.set(p.civl_id, p);
    if (p.email) byEmail.set(p.email.toLowerCase(), p);
    const nameKey = p.name.toLowerCase();
    const existing = byName.get(nameKey) ?? [];
    existing.push(p);
    byName.set(nameKey, existing);
    for (const k of Object.keys(byOtherId)) {
      const v = (p as unknown as Record<string, string | null>)[k];
      if (v) byOtherId[k].set(v, p);
    }
  }

  const byId = new Map(currentPilots.map((p) => [p.comp_pilot_id, p]));

  const out: ImportClassifiedRow[] = [];
  for (const fileRow of rows) {
    // The file's own id (an exported roster's glidecomp_id column) settles it
    // when this roster holds that pilot. One it does not hold — a file from
    // another comp — is dropped rather than sent: it names nobody here.
    const { comp_pilot_id: fileId, ...r } = fileRow;
    if (fileId && byId.has(fileId)) {
      out.push({ parsed: r, action: "match", matchedId: fileId });
      continue;
    }

    let matched: CompPilot | undefined;
    if (r.civl_id && byCivl.has(r.civl_id)) {
      matched = byCivl.get(r.civl_id);
    } else {
      for (const [k, map] of Object.entries(byOtherId)) {
        const val = (r as unknown as Record<string, string | null>)[k];
        if (val && map.has(val)) {
          matched = map.get(val);
          break;
        }
      }
    }
    if (!matched && r.email) {
      matched = byEmail.get(r.email.toLowerCase());
    }

    if (matched) {
      out.push({ parsed: r, action: "match", matchedId: matched.comp_pilot_id });
      continue;
    }

    // Name-only? Flagged but not auto-matched.
    const nameHits = byName.get(r.name.toLowerCase()) ?? [];
    out.push({ parsed: r, action: nameHits.length > 0 ? "name" : "new" });
  }

  return out;
}

/**
 * The rows an import puts in place of the roster: each matched row carries
 * the existing pilot's id, so the bulk save updates that pilot rather than
 * replacing them; every other row is new. Pilots the file leaves out are
 * removed by the save — callers say so before it.
 */
export function importedRows(classified: ImportClassifiedRow[]): ParsedRow[] {
  return classified.map((cr) =>
    cr.action === "match" && cr.matchedId ? { ...cr.parsed, comp_pilot_id: cr.matchedId } : cr.parsed
  );
}

// ── Misc ─────────────────────────────────────────────────────────────────────

/** Pull a readable message out of a JSON error body, or fall back to raw text. */
export function serverErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through to raw text
  }
  return body.slice(0, 300) || "unknown error";
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "pilots"
  );
}
