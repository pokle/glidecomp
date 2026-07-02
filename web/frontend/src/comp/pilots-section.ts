/**
 * Pilots section on the comp detail page.
 *
 * Renders a read-only table of registered pilots and — for admins — a single
 * Edit action that opens a Tabulator-based editable table dialog with CSV
 * import/export built in.
 *
 * All mutations funnel through POST /api/comp/:comp_id/pilot/bulk so the
 * backend's diff-and-write logic (from Iteration 8b) is the single source of
 * truth for inserts / updates / deletes.
 */

import type { CellComponent, ColumnDefinition, Tabulator } from "tabulator-tables";

import { api } from "./api";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The full shape a `comp_pilot` row takes when rendered in the UI. Matches
 * the server serialiser in routes/pilot.ts exactly — any field the server
 * returns is mirrored here so round-trips through the edit dialog lose
 * nothing.
 */
interface CompPilot {
  comp_pilot_id: string;
  linked: boolean;
  linked_email: string | null;
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

/** Column metadata for CSV serialisation. Kept as a single source of truth. */
interface ColumnDef {
  key: keyof CompPilot;
  /** External name used in CSV headers and in user-facing hints. */
  header: string;
  /** Accepted aliases when parsing an imported header row (case-insensitive). */
  aliases?: string[];
}

const COLUMNS: ColumnDef[] = [
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
const MAX_PILOTS = 250;

/** Request body sent to POST /api/comp/:comp_id/pilot/bulk. */
interface BulkPilotRow {
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

// ── Module state ─────────────────────────────────────────────────────────────

let currentPilots: CompPilot[] = [];
let currentCompId = "";
let currentCompClasses: string[] = [];
let currentCompSlug = "pilots";

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Wire up the Pilots section. Loads pilots for the comp and renders the
 * read-only table. If the caller is a comp admin, the Edit button is
 * revealed and its handler attached.
 */
export async function setupPilotsSection(
  compId: string,
  compName: string,
  compClasses: string[],
  isAdmin: boolean
): Promise<void> {
  currentCompId = compId;
  currentCompClasses = compClasses;
  currentCompSlug = slugify(compName);

  if (isAdmin) {
    document.getElementById("pilots-admin-actions")!.classList.remove("hidden");
    document.getElementById("pilots-edit-btn")!.addEventListener("click", openEditDialog);
  }

  await loadPilots();
}

async function loadPilots(): Promise<void> {
  try {
    const res = await api.api.comp[":comp_id"].pilot.$get({
      param: { comp_id: currentCompId },
    });
    if (!res.ok) {
      renderError();
      return;
    }
    const data = (await res.json()) as { pilots: CompPilot[] };
    currentPilots = data.pilots;
    renderTable();
  } catch {
    renderError();
  }
}

// ── Read-only table ──────────────────────────────────────────────────────────

function renderTable(): void {
  const tbody = document.getElementById("pilots-tbody") as HTMLTableSectionElement;
  const empty = document.getElementById("pilots-empty")!;
  const wrap = document.getElementById("pilots-table-wrap")!;
  const count = document.getElementById("pilots-count")!;

  tbody.innerHTML = "";
  count.textContent = currentPilots.length
    ? `(${currentPilots.length})`
    : "";

  if (currentPilots.length === 0) {
    wrap.classList.add("hidden");
    empty.classList.remove("hidden");
    return;
  }

  wrap.classList.remove("hidden");
  empty.classList.add("hidden");

  for (const p of currentPilots) {
    const tr = document.createElement("tr");
    tr.className = "border-b border-border/30";

    tr.appendChild(nameCell(p));
    tr.appendChild(textCell(p.civl_id));
    tr.appendChild(textCell(p.safa_id));
    tr.appendChild(textCell(p.pilot_class));
    tr.appendChild(textCell(p.team_name));
    tr.appendChild(textCell(p.driver_contact));

    tbody.appendChild(tr);
  }
}

function nameCell(p: CompPilot): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "py-1.5 pr-3";
  const name = document.createElement("span");
  name.textContent = p.name;
  name.className = "font-medium";
  const icon = document.createElement("span");
  icon.className = "ml-1.5 text-xs";
  if (p.linked) {
    icon.textContent = "🔗";
    icon.title = p.linked_email
      ? `Linked to ${p.linked_email}`
      : "Linked to GlideComp account";
  } else {
    icon.textContent = "⚠";
    icon.title = "Not linked to any GlideComp account";
    icon.className += " text-muted-foreground/50";
  }
  td.appendChild(name);
  td.appendChild(icon);
  return td;
}

function textCell(value: string | null | undefined): HTMLTableCellElement {
  const td = document.createElement("td");
  td.className = "py-1.5 pr-3 text-muted-foreground";
  td.textContent = value ?? "";
  return td;
}

function renderError(): void {
  const empty = document.getElementById("pilots-empty")!;
  const wrap = document.getElementById("pilots-table-wrap")!;
  wrap.classList.add("hidden");
  empty.classList.remove("hidden");
  empty.querySelector("p")!.textContent = "Could not load pilots";
}

// ── Edit dialog (Tabulator grid) ─────────────────────────────────────────────

/**
 * One row in the edit grid: the editable CSV columns plus the original
 * comp_pilot_id (absent for newly added / unmatched imported rows) so the
 * bulk endpoint treats existing rows as updates rather than delete+create.
 */
interface ParsedRow {
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

let editTable: Tabulator | null = null;

async function openEditDialog(): Promise<void> {
  // Tabulator is admin-only, so it's lazy-loaded to keep it (and its CSS)
  // out of the comp-detail chunk every visitor downloads.
  const [{ TabulatorFull }] = await Promise.all([
    import("tabulator-tables"),
    import("tabulator-tables/dist/css/tabulator_simple.min.css"),
    import("./pilots-grid.css"),
  ]);

  const dialog = document.getElementById("pilots-edit-dialog") as HTMLDialogElement;
  const gridEl = document.getElementById("pilots-grid")!;
  const saveBtn = document.getElementById("pilots-edit-save") as HTMLButtonElement;
  const importInput = document.getElementById("pilots-edit-import-file") as HTMLInputElement;

  hideEditStatus();
  hideEditErrors();
  saveBtn.disabled = false;
  importInput.value = "";

  // Tabulator measures its container, so the dialog must be visible first.
  dialog.showModal();

  editTable = new TabulatorFull(gridEl, {
    data: currentPilots.map(pilotToGridRow),
    columns: gridColumns(),
    layout: "fitDataStretch",
    height: "100%",
    placeholder: "No pilots yet — use Add row, or Import CSV",
    // Editor popups (class list) must render inside the modal dialog,
    // otherwise the <dialog> paints over them.
    popupContainer: "#pilots-edit-dialog",
  });

  document.getElementById("pilots-edit-add-row")!.onclick = () => {
    editTable?.addRow(emptyGridRow());
  };

  document.getElementById("pilots-edit-import")!.onclick = () => importInput.click();
  importInput.onchange = () => importCsvIntoGrid(importInput);

  document.getElementById("pilots-edit-export")!.onclick = () => {
    exportCsv(gridRows());
  };

  document.getElementById("pilots-edit-cancel")!.onclick = () => dialog.close();

  saveBtn.onclick = async () => {
    const { payload, errors } = validateGridRows(gridRows());
    if (errors.length > 0) {
      showEditErrors(errors);
      return;
    }
    hideEditErrors();
    saveBtn.disabled = true;
    const error = await submitBulk(payload);
    saveBtn.disabled = false;
    if (error === null) {
      dialog.close();
      await loadPilots();
    } else {
      showEditErrors([error]);
    }
  };

  dialog.onclose = () => {
    editTable?.destroy();
    editTable = null;
  };
}

function gridColumns(): ColumnDefinition[] {
  const remove: ColumnDefinition = {
    title: "",
    width: 36,
    hozAlign: "center",
    headerSort: false,
    frozen: true,
    formatter: () =>
      '<span class="text-muted-foreground cursor-pointer" title="Remove pilot">✕</span>',
    cellClick: (_e: UIEvent, cell: CellComponent) => {
      cell.getRow().delete();
    },
  };

  const dataCols = COLUMNS.map((c): ColumnDefinition => {
    const def: ColumnDefinition = {
      title: c.header,
      field: c.key,
      editor: "input",
      // Select the existing value on edit so typing replaces it (matches
      // spreadsheet behaviour; without this, mobile taps append text).
      editorParams: { selectContents: true },
      minWidth: 90,
    };
    if (c.key === "name") {
      def.frozen = true;
      def.minWidth = 140;
    }
    if (c.key === "pilot_class") {
      def.editor = "list";
      def.editorParams = { values: currentCompClasses };
    }
    return def;
  });

  return [remove, ...dataCols];
}

function pilotToGridRow(p: CompPilot): ParsedRow {
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

function emptyGridRow(): ParsedRow {
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
    pilot_class: currentCompClasses.length === 1 ? currentCompClasses[0] : "",
    team_name: null,
    driver_contact: null,
    glider: null,
  };
}

/** Current grid contents, normalised (trimmed, empty optionals → null). */
function gridRows(): ParsedRow[] {
  if (!editTable) return [];
  return (editTable.getData() as Record<string, unknown>[]).map((raw) => {
    const row = { ...emptyGridRow() };
    if (typeof raw.comp_pilot_id === "string" && raw.comp_pilot_id) {
      row.comp_pilot_id = raw.comp_pilot_id;
    }
    for (const c of COLUMNS) {
      const value =
        raw[c.key] === null || raw[c.key] === undefined ? "" : String(raw[c.key]).trim();
      if (c.key === "name" || c.key === "pilot_class") {
        (row as unknown as Record<string, unknown>)[c.key] = value;
      } else {
        (row as unknown as Record<string, unknown>)[c.key] = value || null;
      }
    }
    return row;
  });
}

/**
 * Validate grid rows before save. Rows that are completely empty (e.g. an
 * unused "Add row") are silently dropped; anything with content needs a name
 * and a valid class.
 */
function validateGridRows(rows: ParsedRow[]): {
  payload: BulkPilotRow[];
  errors: string[];
} {
  const errors: string[] = [];
  const kept: ParsedRow[] = [];

  rows.forEach((row, i) => {
    const hasContent = COLUMNS.some((c) => {
      const v = (row as unknown as Record<string, unknown>)[c.key];
      return v !== null && v !== undefined && String(v) !== "";
    });
    if (!hasContent) return;

    if (!row.name) {
      errors.push(`Row ${i + 1}: name is required`);
      return;
    }
    if (!row.pilot_class) {
      errors.push(`Row ${i + 1} (${row.name}): class is required`);
    } else if (!currentCompClasses.includes(row.pilot_class)) {
      errors.push(
        `Row ${i + 1} (${row.name}): class "${row.pilot_class}" is not valid for this competition (valid: ${currentCompClasses.join(", ")})`
      );
    }
    kept.push(row);
  });

  if (kept.length > MAX_PILOTS) {
    errors.push(`Too many pilots: ${kept.length} (max ${MAX_PILOTS})`);
  }

  return { payload: kept.map(parsedRowToBulk), errors };
}

// ── Edit-dialog CSV import ───────────────────────────────────────────────────

/**
 * Load a CSV file into the grid, replacing all current rows. Imported rows
 * that match an existing pilot (by CIVL → other IDs → email, mirroring the
 * server resolver) keep their comp_pilot_id so saving treats them as updates.
 */
async function importCsvIntoGrid(input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;
  const text = await file.text();
  input.value = ""; // allow re-selecting the same file

  hideEditStatus();
  const result = parseImportedCsv(text);
  if (result.rows.length === 0) {
    showEditErrors(result.errors.length > 0 ? result.errors : ["No pilot rows found in file"]);
    return;
  }

  const classified = classifyImportRows(result.rows);
  const rows: ParsedRow[] = classified.map((cr) =>
    cr.action === "match" && cr.matchedId
      ? { ...cr.parsed, comp_pilot_id: cr.matchedId }
      : cr.parsed
  );
  await editTable?.setData(rows);

  const matched = classified.filter((cr) => cr.action === "match").length;
  showEditStatus(
    `Loaded ${rows.length} row${rows.length === 1 ? "" : "s"} from ${file.name}: ` +
      `${matched} matched existing pilots, ${rows.length - matched} new. ` +
      `Existing pilots not in the import will be removed when you save.`
  );
  if (result.errors.length > 0) {
    showEditErrors(result.errors);
  } else {
    hideEditErrors();
  }
}

function showEditStatus(message: string): void {
  const el = document.getElementById("pilots-edit-status")!;
  el.textContent = message;
  el.classList.remove("hidden");
}

function hideEditStatus(): void {
  document.getElementById("pilots-edit-status")!.classList.add("hidden");
}

function showEditErrors(errors: string[]): void {
  const el = document.getElementById("pilots-edit-errors")!;
  el.textContent = errors.slice(0, 20).join("\n");
  if (errors.length > 20) {
    el.textContent += `\n… and ${errors.length - 20} more`;
  }
  el.classList.remove("hidden");
}

function hideEditErrors(): void {
  document.getElementById("pilots-edit-errors")!.classList.add("hidden");
}

// ── CSV export ───────────────────────────────────────────────────────────────

/**
 * Download rows as a CSV file. Emits the full column set (including IDs not
 * visible in the read-only table) so re-importing is a no-op. The header row
 * is always written, so an empty table still yields a fillable template.
 */
function exportCsv(rows: ParsedRow[]): void {
  const header = COLUMNS.map((c) => c.header).join(",");
  const lines = rows.map((r) =>
    COLUMNS.map((c) =>
      csvEscape((r as unknown as Record<string, unknown>)[c.key] as string | null | undefined)
    ).join(",")
  );
  const content = [header, ...lines].join("\n") + "\n";

  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `pilots-${currentCompSlug}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(value: string | number | null | undefined): string {
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
 * Rows with a missing or invalid class are still returned (the grid's class
 * editor is the easiest place to fix them) with an error noting the problem;
 * rows without a name are dropped.
 */
function parseImportedCsv(text: string): { rows: ParsedRow[]; errors: string[] } {
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
  const headerCells = parseCsvLine(headerLine, sep).map((h) =>
    h.trim().toLowerCase()
  );

  // Build header → ParsedRow-key map using COLUMNS aliases
  const keyOf = new Map<string, keyof ParsedRow>();
  for (const col of COLUMNS) {
    const parsedKey = col.key as keyof ParsedRow;
    keyOf.set(col.header.toLowerCase(), parsedKey);
    for (const alias of col.aliases ?? []) {
      keyOf.set(alias.toLowerCase(), parsedKey);
    }
  }

  const columnKeys: (keyof ParsedRow | null)[] = headerCells.map(
    (h) => keyOf.get(h) ?? null
  );

  if (!columnKeys.includes("name")) {
    return {
      rows: [],
      errors: ['CSV must contain a "name" column'],
    };
  }
  if (!columnKeys.includes("pilot_class")) {
    return {
      rows: [],
      errors: ['CSV must contain a "class" column'],
    };
  }

  const rows: ParsedRow[] = [];
  const errors: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i], sep);
    const row: ParsedRow = {
      name: "",
      email: null,
      civl_id: null,
      safa_id: null,
      ushpa_id: null,
      bhpa_id: null,
      dhv_id: null,
      ffvl_id: null,
      fai_id: null,
      pilot_class: "",
      team_name: null,
      driver_contact: null,
      glider: null,
    };
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
    } else if (!currentCompClasses.includes(row.pilot_class)) {
      errors.push(
        `Row ${i} (${row.name}): class "${row.pilot_class}" is not valid (valid: ${currentCompClasses.join(", ")}) — fix it before saving`
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

interface ImportClassifiedRow {
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
function classifyImportRows(rows: ParsedRow[]): ImportClassifiedRow[] {
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

function parsedRowToBulk(row: ParsedRow): BulkPilotRow {
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

// ── Bulk save ────────────────────────────────────────────────────────────────

/** Returns null on success, or a human-readable error message. */
async function submitBulk(pilots: BulkPilotRow[]): Promise<string | null> {
  try {
    const res = await api.api.comp[":comp_id"].pilot.bulk.$post({
      param: { comp_id: currentCompId },
      json: { pilots },
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("bulk pilot save failed", res.status, body);
      return `Save failed (${res.status}): ${serverErrorMessage(body)}`;
    }
    return null;
  } catch (err) {
    console.error("bulk pilot save error", err);
    return "Save failed: network error";
  }
}

/** Pull a readable message out of a JSON error body, or fall back to raw text. */
function serverErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: unknown; message?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through to raw text
  }
  return body.slice(0, 300) || "unknown error";
}

// ── Misc helpers ─────────────────────────────────────────────────────────────

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "pilots"
  );
}
