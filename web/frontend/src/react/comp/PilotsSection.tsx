/**
 * Pilots section on the comp detail page — React port of
 * src/comp/pilots-section.ts.
 *
 * Renders a read-only table of registered pilots and — for admins — an Edit
 * dialog: a plain table where every cell is an input (class is a select
 * limited to the comp's classes) with CSV import/export. All mutations
 * funnel through POST /api/comp/:comp_id/pilot/bulk.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { Input } from "@/react/ui/input";
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
import { SimpleSelect } from "./fields";

interface EditRow extends ParsedRow {
  /** Stable React key — comp_pilot_id is absent for new rows. */
  rowId: number;
}

export function PilotsSection({
  compId,
  compName,
  compClasses,
  isAdmin,
}: {
  compId: string;
  compName: string;
  compClasses: string[];
  isAdmin: boolean;
}) {
  const [pilots, setPilots] = useState<CompPilot[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editOpen, setEditOpen] = useState(false);

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
      <h2 className="mt-8 text-lg font-bold">
        Pilots {pilots && pilots.length > 0 ? `(${pilots.length})` : ""}
        {isAdmin ? (
          <>
            {" "}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
            >
              Edit
            </Button>
          </>
        ) : null}
      </h2>

      {loadError ? (
        <p className="mt-2 text-muted-foreground">Could not load pilots</p>
      ) : pilots === null ? (
        <p className="mt-2 text-muted-foreground">Loading pilots…</p>
      ) : pilots.length === 0 ? (
        <div className="mt-2 text-muted-foreground">
          <p>No pilots registered yet</p>
          <p>Pilots auto-register when they upload an IGC, or use Import CSV</p>
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
          onClose={() => setEditOpen(false)}
          onSaved={async () => {
            setEditOpen(false);
            await loadPilots();
          }}
        />
      ) : null}
    </section>
  );
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
  const nextId = useRef(0);
  const newRowId = () => nextId.current++;
  const [rows, setRows] = useState<EditRow[]>(() =>
    pilots.map((p) => ({ ...pilotToRow(p), rowId: newRowId() }))
  );
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const importInputRef = useRef<HTMLInputElement>(null);

  function updateRow(rowId: number, key: keyof ParsedRow, value: string) {
    setRows((prev) =>
      prev.map((r) => (r.rowId === rowId ? { ...r, [key]: value } : r))
    );
  }

  function addRow() {
    setRows((prev) => [...prev, { ...emptyRow(compClasses), rowId: newRowId() }]);
  }

  function removeRow(rowId: number) {
    setRows((prev) => prev.filter((r) => r.rowId !== rowId));
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
    const imported: EditRow[] = classified.map((cr) => ({
      ...(cr.action === "match" && cr.matchedId
        ? { ...cr.parsed, comp_pilot_id: cr.matchedId }
        : cr.parsed),
      rowId: newRowId(),
    }));
    setRows(imported);

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
      exportCsvContent(rows.map(normalizeRow)),
      "text/csv;charset=utf-8"
    );
  }

  async function save() {
    const { payload, errors: validationErrors } = validateRows(rows, compClasses);
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
      <DialogContent className="sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Edit pilots</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Edit any cell directly. Rows without a name are ignored on save.
        </p>

        <div className="max-h-[60vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span>Remove</span>
                </TableHead>
                {COLUMNS.map((c) => (
                  <TableHead key={c.key}>{c.header}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.rowId}>
                  <TableCell>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      title="Remove pilot"
                      onClick={() => removeRow(row.rowId)}
                    >
                      ✕
                    </Button>
                  </TableCell>
                  {COLUMNS.map((c) =>
                    c.key === "pilot_class" ? (
                      <TableCell key={c.key}>
                        <SimpleSelect
                          value={row.pilot_class}
                          onChange={(v) => updateRow(row.rowId, "pilot_class", v)}
                          options={compClasses.map((cls) => ({ value: cls, label: cls }))}
                          ariaLabel="Pilot class"
                        />
                      </TableCell>
                    ) : (
                      <TableCell key={c.key}>
                        <Input
                          className="h-7 min-w-24"
                          value={row[c.key] ?? ""}
                          aria-label={c.header}
                          onChange={(e) => updateRow(row.rowId, c.key, e.target.value)}
                        />
                      </TableCell>
                    )
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

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
            Contact us
          </a>
          .
        </p>

        <DialogFooter>
          <div className="flex gap-2 sm:mr-auto">
            <Button type="button" variant="outline" size="sm" onClick={addRow}>
              Add row
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
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
            <Button type="button" variant="outline" size="sm" onClick={exportCsv}>
              Export CSV
            </Button>
          </div>
          <DialogClose render={<Button type="button" variant="outline" />}>
            Cancel
          </DialogClose>
          <Button type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
