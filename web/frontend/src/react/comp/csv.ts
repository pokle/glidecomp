/**
 * Pure CSV / row helpers for the pilots edit dialog, ported from
 * src/comp/pilots-section.ts. The Tabulator grid is gone — these functions
 * take the comp's classes and current pilots as explicit arguments so they
 * stay pure and unit-testable.
 *
 * All mutations funnel through POST /api/comp/:comp_id/pilot/bulk so the
 * backend's diff-and-write logic is the single source of truth for
 * inserts / updates / deletes.
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
  first_start_order: number | null;
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
}

/** Column metadata for CSV serialisation. Kept as a single source of truth. */
export interface ColumnDef {
  key: keyof Omit<ParsedRow, "comp_pilot_id">;
  /** External name used in CSV headers and in user-facing hints. */
  header: string;
  /** Accepted aliases when parsing an imported header row (case-insensitive). */
  aliases?: string[];
}

export const COLUMNS: ColumnDef[] = [
  { key: "name", header: "name", aliases: ["pilot_name", "full_name"] },
  { key: "email", header: "email" },
  { key: "civl_id", header: "civl_id", aliases: ["civl", "civlid"] },
  { key: "safa_id", header: "safa_id", aliases: ["safa"] },
  { key: "ushpa_id", header: "ushpa_id", aliases: ["ushpa"] },
  { key: "bhpa_id", header: "bhpa_id", aliases: ["bhpa"] },
  { key: "dhv_id", header: "dhv_id", aliases: ["dhv"] },
  { key: "ffvl_id", header: "ffvl_id", aliases: ["ffvl"] },
  { key: "fai_id", header: "fai_id", aliases: ["fai"] },
  { key: "pilot_class", header: "class", aliases: ["pilot_class"] },
  { key: "team_name", header: "team", aliases: ["team_name"] },
  { key: "driver_contact", header: "driver", aliases: ["driver_contact"] },
  { key: "glider", header: "glider" },
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
  };
}

/** Normalise a row: trim everything; empty optionals become null. */
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
  compClasses: string[]
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
    if (!row.pilot_class) {
      errors.push(`Row ${i + 1} (${row.name}): class is required`);
    } else if (!compClasses.includes(row.pilot_class)) {
      errors.push(
        `Row ${i + 1} (${row.name}): class "${row.pilot_class}" is not valid for this competition (valid: ${compClasses.join(", ")})`
      );
    }
    kept.push(row);
  });

  if (kept.length > MAX_PILOTS) {
    errors.push(`Too many pilots: ${kept.length} (max ${MAX_PILOTS})`);
  }

  return { payload: kept.map(parsedRowToBulk), errors };
}

export function parsedRowToBulk(row: ParsedRow): BulkPilotRow {
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
  };
}

// ── CSV export ───────────────────────────────────────────────────────────────

/**
 * Serialise rows as CSV. Emits the full column set (including IDs not
 * visible in the read-only table) so re-importing is a no-op. The header
 * row is always written, so an empty table still yields a fillable template.
 */
export function exportCsvContent(rows: ParsedRow[]): string {
  const header = COLUMNS.map((c) => c.header).join(",");
  const lines = rows.map((r) => COLUMNS.map((c) => csvEscape(r[c.key])).join(","));
  return [header, ...lines].join("\n") + "\n";
}

export function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Parse CSV or TSV with header row. Handles quoted fields, doubled-quote
 * escaping, and both comma and tab separators (auto-detected from the header).
 * Unknown columns are ignored (no error); missing columns → null.
 *
 * Rows with a missing or invalid class are still returned (the class select
 * is the easiest place to fix them) with an error noting the problem; rows
 * without a name are dropped.
 */
export function parseImportedCsv(
  text: string,
  compClasses: string[]
): { rows: ParsedRow[]; errors: string[] } {
  const trimmed = text.trim();
  if (!trimmed) {
    return { rows: [], errors: ["No data provided"] };
  }
  const lines = splitCsvLines(trimmed);
  if (lines.length === 0) {
    return { rows: [], errors: ["No data provided"] };
  }

  // Auto-detect separator from header row
  const headerLine = lines[0];
  const sep = headerLine.includes("\t") ? "\t" : ",";
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

  if (!columnKeys.includes("name")) {
    return { rows: [], errors: ['CSV must contain a "name" column'] };
  }
  if (!columnKeys.includes("pilot_class")) {
    return { rows: [], errors: ['CSV must contain a "class" column'] };
  }

  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], sep);
    const row = emptyRow([]);
    for (let c = 0; c < cells.length && c < columnKeys.length; c++) {
      const key = columnKeys[c];
      if (!key) continue;
      const value = cells[c].trim();
      if (key === "name" || key === "pilot_class") {
        (row as unknown as Record<string, unknown>)[key] = value;
      } else {
        (row as unknown as Record<string, unknown>)[key] = value || null;
      }
    }
    if (!row.name) {
      errors.push(`Row ${i}: name is required — row skipped`);
      continue;
    }
    if (!row.pilot_class) {
      errors.push(`Row ${i} (${row.name}): class is missing — set it before saving`);
    } else if (!compClasses.includes(row.pilot_class)) {
      errors.push(
        `Row ${i} (${row.name}): class "${row.pilot_class}" is not valid (valid: ${compClasses.join(", ")}) — fix it before saving`
      );
    }
    rows.push(row);
  }

  return { rows, errors };
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

  const out: ImportClassifiedRow[] = [];
  for (const r of rows) {
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
