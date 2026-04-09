/**
 * Pilots section on the comp detail page.
 *
 * Renders a read-only table of registered pilots and — for admins — wires up
 * three actions: Edit as text (TSV modal), Import CSV (preview modal), and
 * Export CSV. Full editable table view is deferred to Iteration 8e.
 *
 * All mutations funnel through POST /api/comp/:comp_id/pilot/bulk so the
 * backend's diff-and-write logic (from Iteration 8b) is the single source of
 * truth for inserts / updates / deletes.
 */

import { api } from "./api";

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * The full shape a `comp_pilot` row takes when rendered in the UI. Matches
 * the server serialiser in routes/pilot.ts exactly — any field the server
 * returns is mirrored here so round-trips through the edit-as-text dialog
 * lose nothing.
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

/** Column metadata for TSV/CSV serialisation. Kept as a single source of truth. */
interface ColumnDef {
  key: keyof CompPilot;
  /** External name used in TSV/CSV headers and in user-facing hints. */
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
 * read-only table. If the caller is a comp admin, the Edit/Import/Export
 * buttons are revealed and their handlers attached.
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
    wireAdminActions();
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

// ── Admin actions ────────────────────────────────────────────────────────────

function wireAdminActions(): void {
  document.getElementById("pilots-export-btn")!.addEventListener("click", exportCsv);
  document.getElementById("pilots-edit-text-btn")!.addEventListener("click", openTextDialog);
  document.getElementById("pilots-import-btn")!.addEventListener("click", openImportDialog);
}

// ── CSV export ───────────────────────────────────────────────────────────────

/**
 * Download pilots as a CSV file. Emits the full column set (including IDs not
 * visible in the read-only table) so re-importing is a no-op.
 */
function exportCsv(): void {
  const header = COLUMNS.map((c) => c.header).join(",");
  const rows = currentPilots.map((p) =>
    COLUMNS.map((c) => csvEscape(p[c.key] as string | null | undefined)).join(",")
  );
  const content = [header, ...rows].join("\n") + "\n";

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

// ── Edit-as-text dialog ──────────────────────────────────────────────────────

/**
 * Per-line tracking of the original comp_pilot_id so that re-saving the TSV
 * recognises existing rows as updates. The array is indexed by line number
 * (0-based) in the current textarea contents and rebuilt whenever the buffer
 * is fully re-populated (open, sort, parse-on-save).
 */
let textLineIds: (string | undefined)[] = [];

function openTextDialog(): void {
  const dialog = document.getElementById("pilots-text-dialog") as HTMLDialogElement;
  const textarea = document.getElementById("pilots-text-area") as HTMLTextAreaElement;
  const errorsDiv = document.getElementById("pilots-text-errors")!;
  const sortSelect = document.getElementById("pilots-text-sort")! as unknown as HTMLSelectElement;

  sortSelect.value = "name";
  errorsDiv.classList.add("hidden");
  errorsDiv.textContent = "";

  const sorted = sortPilots(currentPilots, "name");
  textarea.value = serializePilotsToTsv(sorted);
  textLineIds = sorted.map((p) => p.comp_pilot_id);

  sortSelect.onchange = () => {
    const sortKey = sortSelect.value as "name" | "class" | "team";
    // Re-parse current buffer so in-flight edits aren't lost; if parse fails,
    // fall back to sorting the original data.
    const parsed = parseTsv(textarea.value, textLineIds);
    if (parsed.errors.length > 0) {
      // Just re-sort from current server state rather than mangled buffer
      const sorted2 = sortPilots(currentPilots, sortKey);
      textarea.value = serializePilotsToTsv(sorted2);
      textLineIds = sorted2.map((p) => p.comp_pilot_id);
    } else {
      const sorted2 = sortParsedRows(parsed.rows, sortKey);
      textarea.value = serializeParsedRowsToTsv(sorted2);
      textLineIds = sorted2.map((r) => r.comp_pilot_id);
    }
  };

  textarea.oninput = () => {
    // Debounced validation pass — just check basic shape so user gets fast feedback.
    const errors = validateTsv(textarea.value);
    if (errors.length > 0) {
      errorsDiv.textContent = errors.slice(0, 10).join("\n");
      if (errors.length > 10) {
        errorsDiv.textContent += `\n… and ${errors.length - 10} more`;
      }
      errorsDiv.classList.remove("hidden");
    } else {
      errorsDiv.classList.add("hidden");
    }
  };

  document.getElementById("pilots-text-cancel")!.onclick = () => dialog.close();
  document.getElementById("pilots-text-save")!.onclick = async () => {
    const parsed = parseTsv(textarea.value, textLineIds);
    if (parsed.errors.length > 0) {
      errorsDiv.textContent = parsed.errors.join("\n");
      errorsDiv.classList.remove("hidden");
      return;
    }
    const payload: BulkPilotRow[] = parsed.rows.map(parsedRowToBulk);
    const ok = await submitBulk(payload);
    if (ok) {
      dialog.close();
      await loadPilots();
    } else {
      errorsDiv.textContent = "Save failed. See console for details.";
      errorsDiv.classList.remove("hidden");
    }
  };

  dialog.showModal();
}

// ── CSV import dialog ────────────────────────────────────────────────────────

interface ImportPreviewRow {
  /** Source row index in the imported data (0-based, excluding header). */
  index: number;
  parsed: ParsedRow | null;
  action: "new" | "match" | "name" | "error";
  /** The existing comp_pilot_id (if matched). */
  matchedId?: string;
  /** How the match was found, for the preview label. */
  matchReason?: string;
  error?: string;
}

let importPreview: ImportPreviewRow[] = [];

function openImportDialog(): void {
  const dialog = document.getElementById("pilots-import-dialog") as HTMLDialogElement;
  const fileInput = document.getElementById("pilots-import-file") as HTMLInputElement;
  const textarea = document.getElementById("pilots-import-text") as HTMLTextAreaElement;
  const previewBtn = document.getElementById("pilots-import-preview-btn") as HTMLButtonElement;
  const applyBtn = document.getElementById("pilots-import-apply") as HTMLButtonElement;
  const previewDiv = document.getElementById("pilots-import-preview")!;
  const errorsDiv = document.getElementById("pilots-import-errors")!;
  const removeMissingCheckbox = document.getElementById("pilots-import-remove-missing") as HTMLInputElement;

  // Reset state
  fileInput.value = "";
  textarea.value = "";
  previewDiv.classList.add("hidden");
  errorsDiv.classList.add("hidden");
  applyBtn.disabled = true;
  removeMissingCheckbox.checked = false;
  importPreview = [];

  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    textarea.value = await file.text();
  };

  previewBtn.onclick = () => {
    errorsDiv.classList.add("hidden");
    const result = parseImportedCsv(textarea.value);
    if (result.errors.length > 0) {
      errorsDiv.textContent = result.errors.join("\n");
      errorsDiv.classList.remove("hidden");
      previewDiv.classList.add("hidden");
      applyBtn.disabled = true;
      return;
    }
    importPreview = classifyImportRows(result.rows);
    renderImportPreview();
    previewDiv.classList.remove("hidden");
    const hasApplyable = importPreview.some(
      (r) => r.action === "new" || r.action === "match"
    );
    applyBtn.disabled = !hasApplyable;
  };

  document.getElementById("pilots-import-cancel")!.onclick = () => dialog.close();

  applyBtn.onclick = async () => {
    const payload = buildBulkFromImport(importPreview, removeMissingCheckbox.checked);
    const ok = await submitBulk(payload);
    if (ok) {
      dialog.close();
      await loadPilots();
    } else {
      errorsDiv.textContent = "Import failed. See console for details.";
      errorsDiv.classList.remove("hidden");
    }
  };

  dialog.showModal();
}

function renderImportPreview(): void {
  const list = document.getElementById("pilots-import-preview-list")!;
  list.innerHTML = "";
  for (const row of importPreview) {
    const li = document.createElement("li");
    li.className = "flex items-start gap-2 px-2 py-1";

    const badge = document.createElement("span");
    badge.className = "text-[10px] font-medium uppercase tracking-wider w-14 shrink-0";
    switch (row.action) {
      case "new":
        badge.textContent = "new";
        badge.classList.add("text-emerald-600");
        break;
      case "match":
        badge.textContent = "update";
        badge.classList.add("text-blue-600");
        break;
      case "name":
        badge.textContent = "name?";
        badge.classList.add("text-amber-600");
        break;
      case "error":
        badge.textContent = "error";
        badge.classList.add("text-destructive");
        break;
    }

    const label = document.createElement("span");
    label.className = "flex-1 min-w-0";
    if (row.parsed) {
      label.textContent = `${row.parsed.name || "(no name)"}`;
      if (row.parsed.pilot_class) {
        const cls = document.createElement("span");
        cls.className = "text-muted-foreground ml-2";
        cls.textContent = `class: ${row.parsed.pilot_class}`;
        label.appendChild(cls);
      }
      if (row.matchReason) {
        const reason = document.createElement("span");
        reason.className = "text-muted-foreground ml-2 text-[11px]";
        reason.textContent = `(${row.matchReason})`;
        label.appendChild(reason);
      }
    } else if (row.error) {
      label.textContent = `row ${row.index + 1}: ${row.error}`;
      label.classList.add("text-destructive");
    }

    li.appendChild(badge);
    li.appendChild(label);
    list.appendChild(li);
  }
}

// ── Parsing and serialisation helpers ────────────────────────────────────────

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

function sortPilots(pilots: CompPilot[], key: "name" | "class" | "team"): CompPilot[] {
  const copy = [...pilots];
  copy.sort((a, b) => {
    const av = sortKeyValue(a, key);
    const bv = sortKeyValue(b, key);
    return av.localeCompare(bv, undefined, { sensitivity: "base" });
  });
  return copy;
}

function sortKeyValue(p: CompPilot, key: "name" | "class" | "team"): string {
  if (key === "name") return p.name || "";
  if (key === "class") return p.pilot_class || "";
  return p.team_name || "";
}

function sortParsedRows(rows: ParsedRow[], key: "name" | "class" | "team"): ParsedRow[] {
  const copy = [...rows];
  copy.sort((a, b) => {
    const av =
      key === "name" ? a.name : key === "class" ? a.pilot_class : a.team_name ?? "";
    const bv =
      key === "name" ? b.name : key === "class" ? b.pilot_class : b.team_name ?? "";
    return av.localeCompare(bv, undefined, { sensitivity: "base" });
  });
  return copy;
}

/**
 * Serialise pilots as TSV using the canonical column order. Skips the
 * `comp_pilot_id` since it's tracked in a side-array (textLineIds) — keeping
 * opaque IDs out of the user's editing surface avoids accidents.
 */
function serializePilotsToTsv(pilots: CompPilot[]): string {
  return pilots
    .map((p) => COLUMNS.map((c) => cleanCell(p[c.key])).join("\t"))
    .join("\n");
}

function serializeParsedRowsToTsv(rows: ParsedRow[]): string {
  return rows
    .map((r) =>
      COLUMNS.map((c) => cleanCell((r as unknown as Record<string, unknown>)[c.key]))
        .join("\t")
    )
    .join("\n");
}

function cleanCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  // Strip tab and newline from cell contents — they're the row/column delimiters.
  return String(value).replace(/[\t\n\r]/g, " ");
}

/** Quick structural validation used while the user is typing in the TSV. */
function validateTsv(text: string): string[] {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const expected = COLUMNS.length;
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    if (cols.length !== expected) {
      errors.push(
        `Line ${i + 1}: expected ${expected} columns (tab-separated), got ${cols.length}`
      );
      continue;
    }
    const name = cols[0].trim();
    if (!name) {
      errors.push(`Line ${i + 1}: name is required`);
    }
    const pilotClass = cols[9].trim();
    if (!pilotClass) {
      errors.push(`Line ${i + 1}: class is required`);
    } else if (!currentCompClasses.includes(pilotClass)) {
      errors.push(
        `Line ${i + 1}: class "${pilotClass}" is not valid for this competition (valid: ${currentCompClasses.join(", ")})`
      );
    }
  }
  return errors;
}

function parseTsv(
  text: string,
  lineIds: (string | undefined)[]
): { rows: ParsedRow[]; errors: string[] } {
  const errors = validateTsv(text);
  if (errors.length > 0) return { rows: [], errors };

  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  const rows: ParsedRow[] = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split("\t").map((c) => c.trim());
    rows.push({
      comp_pilot_id: lineIds[i],
      name: cols[0],
      email: cols[1] || null,
      civl_id: cols[2] || null,
      safa_id: cols[3] || null,
      ushpa_id: cols[4] || null,
      bhpa_id: cols[5] || null,
      dhv_id: cols[6] || null,
      ffvl_id: cols[7] || null,
      fai_id: cols[8] || null,
      pilot_class: cols[9],
      team_name: cols[10] || null,
      driver_contact: cols[11] || null,
      glider: cols[12] || null,
    });
  }
  return { rows, errors: [] };
}

// ── CSV parsing ──────────────────────────────────────────────────────────────

/**
 * Parse CSV or TSV with header row. Handles quoted fields, doubled-quote
 * escaping, and both comma and tab separators (auto-detected from the header).
 * Unknown columns are ignored (no error); missing columns → null.
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
    const parsedKey = col.key === "pilot_class"
      ? "pilot_class"
      : col.key === "team_name"
        ? "team_name"
        : col.key === "driver_contact"
          ? "driver_contact"
          : (col.key as keyof ParsedRow);
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
      errors.push(`Row ${i}: name is required`);
      continue;
    }
    if (!row.pilot_class) {
      errors.push(`Row ${i}: class is required`);
      continue;
    }
    if (!currentCompClasses.includes(row.pilot_class)) {
      errors.push(
        `Row ${i}: class "${row.pilot_class}" is not valid (valid: ${currentCompClasses.join(", ")})`
      );
      continue;
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

/**
 * Classify each parsed import row against the currently loaded pilots.
 *
 * Priority chain mirrors the server-side resolver: CIVL → other IDs → email.
 * Name-only matches are flagged but DO NOT auto-link; the user has to fix the
 * CSV manually. This prevents accidental merges when two pilots share a name.
 */
function classifyImportRows(rows: ParsedRow[]): ImportPreviewRow[] {
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

  const out: ImportPreviewRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    let matched: CompPilot | undefined;
    let reason = "";
    if (r.civl_id && byCivl.has(r.civl_id)) {
      matched = byCivl.get(r.civl_id);
      reason = "CIVL ID";
    } else {
      for (const [k, map] of Object.entries(byOtherId)) {
        const val = (r as unknown as Record<string, string | null>)[k];
        if (val && map.has(val)) {
          matched = map.get(val);
          reason = k.replace("_id", "").toUpperCase() + " ID";
          break;
        }
      }
    }
    if (!matched && r.email) {
      const hit = byEmail.get(r.email.toLowerCase());
      if (hit) {
        matched = hit;
        reason = "email";
      }
    }

    if (matched) {
      out.push({
        index: i,
        parsed: r,
        action: "match",
        matchedId: matched.comp_pilot_id,
        matchReason: `matched by ${reason}`,
      });
      continue;
    }

    // Name-only? Flagged but not auto-matched.
    const nameHits = byName.get(r.name.toLowerCase()) ?? [];
    if (nameHits.length > 0) {
      out.push({
        index: i,
        parsed: r,
        action: "name",
        matchReason: `${nameHits.length} existing pilot${nameHits.length === 1 ? "" : "s"} with same name — not auto-linked`,
      });
      continue;
    }

    out.push({ index: i, parsed: r, action: "new" });
  }

  return out;
}

function buildBulkFromImport(
  preview: ImportPreviewRow[],
  removeMissing: boolean
): BulkPilotRow[] {
  const payload: BulkPilotRow[] = [];
  const touchedIds = new Set<string>();

  for (const row of preview) {
    if (!row.parsed || row.action === "error") continue;
    // Name-only matches are treated as inserts — the user can fix the CSV if
    // they meant to update. Better than a silent merge.
    const bulk: BulkPilotRow = {
      ...parsedRowToBulk(row.parsed),
    };
    if (row.action === "match" && row.matchedId) {
      bulk.comp_pilot_id = row.matchedId;
      touchedIds.add(row.matchedId);
    }
    payload.push(bulk);
  }

  if (removeMissing) {
    // Nothing extra needed — the bulk endpoint already deletes rows absent
    // from the payload. But in additive mode we must include untouched
    // existing pilots so they survive the diff.
  } else {
    for (const p of currentPilots) {
      if (touchedIds.has(p.comp_pilot_id)) continue;
      // Pass-through row to keep existing pilots alive in an additive import.
      payload.push({
        comp_pilot_id: p.comp_pilot_id,
        registered_pilot_name: p.name,
        registered_pilot_email: p.email,
        registered_pilot_civl_id: p.civl_id,
        registered_pilot_safa_id: p.safa_id,
        registered_pilot_ushpa_id: p.ushpa_id,
        registered_pilot_bhpa_id: p.bhpa_id,
        registered_pilot_dhv_id: p.dhv_id,
        registered_pilot_ffvl_id: p.ffvl_id,
        registered_pilot_fai_id: p.fai_id,
        registered_pilot_glider: p.glider,
        pilot_class: p.pilot_class,
        team_name: p.team_name,
        driver_contact: p.driver_contact,
      });
    }
  }

  return payload;
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

async function submitBulk(pilots: BulkPilotRow[]): Promise<boolean> {
  try {
    const res = await api.api.comp[":comp_id"].pilot.bulk.$post({
      param: { comp_id: currentCompId },
      json: { pilots },
    });
    if (!res.ok) {
      const body = await res.text();
      console.error("bulk pilot save failed", res.status, body);
      return false;
    }
    return true;
  } catch (err) {
    console.error("bulk pilot save error", err);
    return false;
  }
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
