/**
 * Pilots section on the comp detail page — React port of
 * src/comp/pilots-section.ts.
 *
 * Renders a read-only table of registered pilots and — for admins — an Edit
 * dialog: a Tabulator editable grid (frozen name column, fixed header,
 * spreadsheet-style cells, class as a list editor limited to the comp's
 * classes) with CSV import/export. All mutations funnel through
 * POST /api/comp/:comp_id/pilot/bulk.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { CellComponent, ColumnDefinition, Tabulator } from "tabulator-tables";
import { Button } from "@/react/ui/button";
import { SectionHeader } from "../components/SectionHeader";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/react/ui/table";
import { api } from "../../comp/api";
import { downloadFile } from "../lib/format";
import {
  classifyImportRows,
  emptyRow,
  exportCsvContent,
  normalizeRow,
  parseImportedCsv,
  pilotToRow,
  serverErrorMessage,
  slugify,
  validateRows,
  COLUMNS,
  type CompPilot,
  type ParsedRow,
} from "./csv";

export function PilotsSection({
  compId,
  compName,
  compClasses,
  isAdmin,
  onPilotsChanged,
}: {
  compId: string;
  compName: string;
  compClasses: string[];
  isAdmin: boolean;
  /** Called after a successful pilots save so the parent can refetch data
   * that depends on the roster (e.g. the setup guide's pilot_count). */
  onPilotsChanged?: () => void;
}) {
  const [pilots, setPilots] = useState<CompPilot[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // Deep link from the setup guide's "Add pilots" step: open the edit dialog
  // once the admin check has resolved (same hash pattern as the task page's
  // #edit-route). Also gives admins a shareable link to the pilots editor.
  useEffect(() => {
    if (location.hash === "#edit-pilots" && isAdmin) setEditOpen(true);
  }, [location.hash, isAdmin]);

  // Closing the editor drops the hash so a reload doesn't reopen it.
  const closeEditor = () => {
    setEditOpen(false);
    if (location.hash === "#edit-pilots") {
      navigate(location.pathname + location.search, { replace: true });
    }
  };

  const loadPilots = useCallback(async () => {
    try {
      const res = await api.api.comp[":comp_id"].pilot.$get({
        param: { comp_id: compId },
      });
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as { pilots: CompPilot[] };
      setPilots(data.pilots);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [compId]);

  useEffect(() => {
    void loadPilots();
  }, [loadPilots]);

  return (
    <section>
      <SectionHeader
        title={<>Pilots {pilots && pilots.length > 0 ? `(${pilots.length})` : ""}</>}
        action={
          isAdmin ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
            >
              Edit
            </Button>
          ) : null
        }
      />

      {loadError ? (
        <p className="mt-2 text-muted-foreground">Could not load pilots</p>
      ) : pilots === null ? (
        <p className="mt-2 text-muted-foreground">Loading pilots…</p>
      ) : pilots.length === 0 ? (
        <div className="mt-2 text-muted-foreground">
          <p>No pilots registered yet — pilots appear here when the organizers add them or when they submit a track.</p>
          {isAdmin ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => setEditOpen(true)}
            >
              Add pilots
            </Button>
          ) : null}
        </div>
      ) : (
        <Table className="mt-2">
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>GlideComp account</TableHead>
              <TableHead>CIVL</TableHead>
              <TableHead>SAFA</TableHead>
              <TableHead>Class</TableHead>
              <TableHead>Team</TableHead>
              <TableHead>Driver</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pilots.map((p) => (
              <TableRow key={p.comp_pilot_id}>
                <TableCell>{p.name}</TableCell>
                <TableCell>
                  {p.linked && p.linked_username ? (
                    <Link
                      className="underline underline-offset-4"
                      to={`/u/${encodeURIComponent(p.linked_username)}`}
                    >
                      @{p.linked_username}
                    </Link>
                  ) : null}
                </TableCell>
                <TableCell>{p.civl_id ?? ""}</TableCell>
                <TableCell>{p.safa_id ?? ""}</TableCell>
                <TableCell>{p.pilot_class}</TableCell>
                <TableCell>{p.team_name ?? ""}</TableCell>
                <TableCell>{p.driver_contact ?? ""}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {isAdmin && editOpen && pilots !== null ? (
        <EditPilotsDialog
          compId={compId}
          compName={compName}
          compClasses={compClasses}
          pilots={pilots}
          onClose={closeEditor}
          onSaved={async () => {
            closeEditor();
            await loadPilots();
            onPilotsChanged?.();
          }}
        />
      ) : null}
    </section>
  );
}

/**
 * Empty-grid placeholder (Tabulator renders `placeholder` strings as HTML).
 * First-time admins land here with no pilots, so it carries the onboarding:
 * which columns are required, what a CSV import expects, why the email
 * matters, and how to get a fillable template. Static markup only — never
 * interpolate user or comp data into it.
 */
const EMPTY_GRID_PLACEHOLDER = `
  <div class="pilots-empty-hint">
    <p><strong>No pilots yet.</strong> Use <strong>Add row</strong> to type pilots in, <strong>Import CSV</strong> to load a spreadsheet, or <strong>Add test pilots</strong> to try things out with dummy data.</p>
    <ul>
      <li>Only <strong>name</strong> and <strong>class</strong> are required — every other column, including all the sporting-body IDs, is optional.</li>
      <li>CSV imports need a header row naming the columns (${COLUMNS.map((c) => c.header).join(", ")}). Column order and capitalisation don't matter, and unrecognised columns are ignored.</li>
      <li>Pilots are matched to the IGC tracks they upload by <strong>email</strong> — enter the address each pilot signs in to GlideComp with (e.g. their Gmail address).</li>
      <li>Tip: <strong>Export CSV</strong> now to download a blank template you can fill in with your favourite spreadsheet (Excel, Numbers, Google Sheets…).</li>
    </ul>
  </div>
`;

/**
 * Tabulator column definitions: a frozen remove button, then one editable
 * column per CSV column. The class column is a list editor limited to the
 * comp's classes; the name column is frozen so horizontal scrolling never
 * loses track of whose row is being edited.
 */
function gridColumns(compClasses: string[]): ColumnDefinition[] {
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
      def.editorParams = { values: compClasses };
    }
    return def;
  });

  return [remove, ...dataCols];
}

function EditPilotsDialog({
  compId,
  compName,
  compClasses,
  pilots,
  onClose,
  onSaved,
}: {
  compId: string;
  compName: string;
  compClasses: string[];
  pilots: CompPilot[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const gridRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<Tabulator | null>(null);
  const [gridReady, setGridReady] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    let table: Tabulator | null = null;
    void (async () => {
      // Tabulator is admin-only, so it's lazy-loaded to keep it (and its
      // CSS) out of the comp-detail chunk every visitor downloads.
      const [{ TabulatorFull }] = await Promise.all([
        import("tabulator-tables"),
        import("tabulator-tables/dist/css/tabulator_simple.min.css"),
        import("./pilots-grid.css"),
      ]);
      if (cancelled || !gridRef.current) return;
      table = new TabulatorFull(gridRef.current, {
        data: pilots.map(pilotToRow),
        columns: gridColumns(compClasses),
        layout: "fitDataStretch",
        height: "100%",
        placeholder: EMPTY_GRID_PLACEHOLDER,
        // Editor popups (class list) must render inside the modal dialog,
        // otherwise the dialog paints over them.
        popupContainer: "#pilots-edit-dialog",
      });
      table.on("tableBuilt", () => {
        if (!cancelled) setGridReady(true);
      });
      tableRef.current = table;
    })();
    return () => {
      cancelled = true;
      table?.destroy();
      tableRef.current = null;
    };
  }, [pilots, compClasses]);

  /** Current grid contents, normalised (trimmed, empty optionals → null). */
  function gridRows(): ParsedRow[] {
    const table = tableRef.current;
    if (!table) return [];
    return (table.getData() as ParsedRow[]).map(normalizeRow);
  }

  function addRow() {
    void tableRef.current?.addRow(emptyRow(compClasses));
  }

  /**
   * Append 3 dummy pilots so a new admin can try scoring without typing a
   * real roster. Numbering continues from the highest existing test dummy
   * (each click adds 3 more); classes cycle so multi-class comps get
   * coverage. Never touches existing rows.
   */
  function addTestPilots() {
    const table = tableRef.current;
    if (!table) return;
    let maxN = 0;
    for (const row of table.getData() as ParsedRow[]) {
      const m =
        /^testdummy(\d+)@example\.com$/i.exec(row.email ?? "") ??
        /^test dummy (\d+)$/i.exec(row.name ?? "");
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    const rows: ParsedRow[] = [];
    for (let i = 1; i <= 3; i++) {
      const n = maxN + i;
      rows.push({
        ...emptyRow(compClasses),
        name: `Test Dummy ${n}`,
        email: `testdummy${n}@example.com`,
        pilot_class: compClasses[(n - 1) % compClasses.length] ?? "",
      });
    }
    void table.addRow(rows);
  }

  async function importCsv(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    input.value = ""; // allow re-selecting the same file

    setStatus(null);
    const result = parseImportedCsv(text, compClasses);
    if (result.rows.length === 0) {
      setErrors(result.errors.length > 0 ? result.errors : ["No pilot rows found in file"]);
      return;
    }

    const classified = classifyImportRows(result.rows, pilots);
    const imported: ParsedRow[] = classified.map((cr) =>
      cr.action === "match" && cr.matchedId
        ? { ...cr.parsed, comp_pilot_id: cr.matchedId }
        : cr.parsed
    );
    await tableRef.current?.setData(imported);

    const matched = classified.filter((cr) => cr.action === "match").length;
    setStatus(
      `Loaded ${imported.length} row${imported.length === 1 ? "" : "s"} from ${file.name}: ` +
        `${matched} matched existing pilots, ${imported.length - matched} new. ` +
        `Existing pilots not in the import will be removed when you save.`
    );
    setErrors(result.errors);
  }

  function exportCsv() {
    downloadFile(
      `pilots-${slugify(compName)}.csv`,
      exportCsvContent(gridRows()),
      "text/csv;charset=utf-8"
    );
  }

  async function save() {
    const { payload, errors: validationErrors } = validateRows(gridRows(), compClasses);
    if (validationErrors.length > 0) {
      setErrors(validationErrors);
      return;
    }
    setErrors([]);
    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].pilot.bulk.$post({
        param: { comp_id: compId },
        json: { pilots: payload },
      });
      if (!res.ok) {
        const body = await res.text();
        console.error("bulk pilot save failed", res.status, body);
        setErrors([`Save failed (${res.status}): ${serverErrorMessage(body)}`]);
        return;
      }
      onSaved();
    } catch (err) {
      console.error("bulk pilot save error", err);
      setErrors(["Save failed: network error"]);
    } finally {
      setSaving(false);
    }
  }

  // Cap error display like the vanilla dialog did.
  const shownErrors = errors.slice(0, 20);
  const extraErrors = errors.length - shownErrors.length;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        id="pilots-edit-dialog"
        className="flex h-[min(700px,85vh)] flex-col sm:max-w-6xl"
      >
        <DialogHeader>
          <DialogTitle>Edit pilots</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Tap a cell to edit. Rows without a name are ignored on save.
        </p>

        <div
          ref={gridRef}
          id="pilots-grid"
          className="min-h-0 flex-1 rounded border border-border"
        />

        {status ? <p className="text-sm text-muted-foreground">{status}</p> : null}
        {shownErrors.length > 0 ? (
          <ul className="list-disc pl-5 text-sm text-destructive">
            {shownErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {extraErrors > 0 ? <li>… and {extraErrors} more</li> : null}
          </ul>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Need a sporting body ID column not listed?{" "}
          <a className="underline underline-offset-4" href="mailto:tushar.pokle@gmail.com">
            Contact me
          </a>
          .
        </p>

        <DialogFooter>
          <div className="flex flex-wrap gap-2 sm:mr-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!gridReady}
              onClick={addRow}
            >
              Add row
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!gridReady}
              onClick={addTestPilots}
              title="Add 3 dummy pilots (Test Dummy 1, testdummy1@example.com, …) to try the system"
            >
              Add test pilots
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!gridReady}
              onClick={() => importInputRef.current?.click()}
            >
              Import CSV
            </Button>
            <input
              ref={importInputRef}
              type="file"
              accept=".csv,.tsv,.txt"
              hidden
              onChange={(e) => void importCsv(e.currentTarget)}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!gridReady}
              onClick={exportCsv}
            >
              Export CSV
            </Button>
          </div>
          <DialogClose render={<Button type="button" variant="outline" />}>
            Cancel
          </DialogClose>
          <Button
            type="button"
            disabled={saving || !gridReady}
            onClick={() => void save()}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
