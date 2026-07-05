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
import { Dialog } from "@base-ui/react/dialog";
import { Input } from "@base-ui/react/input";
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

/** Editable text columns (everything except pilot_class, which is a select). */
const TEXT_COLUMNS = COLUMNS.filter((c) => c.key !== "pilot_class");

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
      <h2>
        Pilots {pilots && pilots.length > 0 ? `(${pilots.length})` : ""}
        {isAdmin ? (
          <>
            {" "}
            <button type="button" onClick={() => setEditOpen(true)}>
              Edit
            </button>
          </>
        ) : null}
      </h2>

      {loadError ? (
        <p>Could not load pilots</p>
      ) : pilots === null ? (
        <p>Loading pilots…</p>
      ) : pilots.length === 0 ? (
        <div>
          <p>No pilots registered yet</p>
          <p>Pilots auto-register when they upload an IGC, or use Import CSV</p>
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>GlideComp account</th>
              <th>CIVL</th>
              <th>SAFA</th>
              <th>Class</th>
              <th>Team</th>
              <th>Driver</th>
            </tr>
          </thead>
          <tbody>
            {pilots.map((p) => (
              <tr key={p.comp_pilot_id}>
                <td>{p.name}</td>
                <td>
                  {p.linked && p.linked_username ? (
                    <Link to={`/u/${encodeURIComponent(p.linked_username)}`}>
                      @{p.linked_username}
                    </Link>
                  ) : null}
                </td>
                <td>{p.civl_id ?? ""}</td>
                <td>{p.safa_id ?? ""}</td>
                <td>{p.pilot_class}</td>
                <td>{p.team_name ?? ""}</td>
                <td>{p.driver_contact ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop />
        <Dialog.Popup>
          <Dialog.Title>Edit pilots</Dialog.Title>
          <p>Edit any cell directly. Rows without a name are ignored on save.</p>

          <table>
            <thead>
              <tr>
                <th>
                  <span>Remove</span>
                </th>
                {COLUMNS.map((c) => (
                  <th key={c.key}>{c.header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.rowId}>
                  <td>
                    <button
                      type="button"
                      title="Remove pilot"
                      onClick={() => removeRow(row.rowId)}
                    >
                      ✕
                    </button>
                  </td>
                  {COLUMNS.map((c) =>
                    c.key === "pilot_class" ? (
                      <td key={c.key}>
                        <SimpleSelect
                          value={row.pilot_class}
                          onChange={(v) => updateRow(row.rowId, "pilot_class", v)}
                          options={compClasses.map((cls) => ({ value: cls, label: cls }))}
                          ariaLabel="Pilot class"
                        />
                      </td>
                    ) : (
                      <td key={c.key}>
                        <Input
                          value={row[c.key] ?? ""}
                          aria-label={c.header}
                          onValueChange={(v) => updateRow(row.rowId, c.key, v)}
                        />
                      </td>
                    )
                  )}
                </tr>
              ))}
            </tbody>
          </table>

          {status ? <p>{status}</p> : null}
          {shownErrors.length > 0 ? (
            <ul>
              {shownErrors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
              {extraErrors > 0 ? <li>… and {extraErrors} more</li> : null}
            </ul>
          ) : null}
          <p>
            Need a sporting body ID column not listed?{" "}
            <a href="mailto:tushar.pokle@gmail.com">Contact us</a>.
          </p>

          <button type="button" onClick={addRow}>
            Add row
          </button>{" "}
          <button type="button" onClick={() => importInputRef.current?.click()}>
            Import CSV
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept=".csv,.tsv,.txt"
            hidden
            onChange={(e) => void importCsv(e.currentTarget)}
          />{" "}
          <button type="button" onClick={exportCsv}>
            Export CSV
          </button>{" "}
          <Dialog.Close>Cancel</Dialog.Close>{" "}
          <button type="button" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving..." : "Save"}
          </button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
