/**
 * Pilots section on the comp detail page — React port of
 * src/comp/pilots-section.ts.
 *
 * Renders a read-only table of registered pilots (RAC kit) and — for admins —
 * an Edit dialog: a **Tabulator** editable grid (frozen name column, fixed
 * header, spreadsheet-style cells, class as a list editor limited to the
 * comp's classes) with CSV import/export. The grid stays Tabulator by policy
 * (docs/2026-07-18-rac-adoption-guide.md — it's excellent at spreadsheet
 * editing and is not part of the RAC conversion) and is declared through the
 * shared `TabulatorGrid` wrapper, which owns the lazy load and lifecycle; only
 * the dialog shell and buttons around it are RAC. All mutations funnel through
 * POST /api/comp/:comp_id/pilot/bulk.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  FileTrigger,
  Link as AriaLink,
  type SortDescriptor,
} from "react-aria-components";
import type { CellComponent, ColumnDefinition, Tabulator } from "tabulator-tables";
import { Badge } from "@/react/rac/badge";
import { Button } from "@/react/rac/button";
import { Loading } from "@/react/rac/progress";
import { SectionHeader } from "../components/SectionHeader";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { Table, TableHeader, TableBody, Column, Row, Cell } from "@/react/rac/table";
import { Tooltip, TooltipTrigger } from "@/react/rac/tooltip";
import { TabulatorGrid } from "./TabulatorGrid";
import {
  fillCivlIds,
  fillRankings,
  formatRankingMonth,
  listLabel,
  lookupRankings,
  rankingSource,
  type RankingLookup,
} from "./civl-rankings";
import { api } from "../../comp/api";
import { downloadFile } from "../lib/format";
import { Card } from "@/react/rac/card";
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

/**
 * Sort a copy of the roster by the RAC sort descriptor.
 *
 * WPRS points sort numerically with unscored pilots pinned last in BOTH
 * directions: "no score" is not a very good or a very bad one, and an
 * organiser sorting to find their top seeds should not have to scroll past
 * everyone who has never been ranked. Every other column is locale text.
 */
function sortPilots(pilots: CompPilot[], sort: SortDescriptor | undefined): CompPilot[] {
  if (!sort) return pilots;
  const dir = sort.direction === "descending" ? -1 : 1;
  const col = String(sort.column);
  return [...pilots].sort((a, b) => {
    if (col === "wprs_points") {
      if (a.wprs_points === null && b.wprs_points === null) return 0;
      if (a.wprs_points === null) return 1;
      if (b.wprs_points === null) return -1;
      // Natural order, so `aria-sort="ascending"` describes what is on screen
      // — and ascending happens to BE the task-1 launch order, which runs in
      // reverse world-ranking order: fewest points launches first.
      return (a.wprs_points - b.wprs_points) * dir;
    }
    const text = (p: CompPilot): string => {
      if (col === "account") return p.linked_username ?? "";
      return String((p as unknown as Record<string, unknown>)[col] ?? "");
    };
    return text(a).localeCompare(text(b)) * dir;
  });
}

export function PilotsSection({
  compId,
  compName,
  compClasses,
  isAdmin,
  openRegistration,
  onPilotsChanged,
  headingAs = "h2",
}: {
  compId: string;
  compName: string;
  compClasses: string[];
  isAdmin: boolean;
  /** Whether a pilot can join this comp by submitting a track. Shown here
   *  because the roster is the only place the consequence is visible. */
  openRegistration?: boolean;
  /** Called after a successful pilots save so the parent can refetch data
   * that depends on the roster (e.g. the setup guide's pilot_count). */
  onPilotsChanged?: () => void;
  /** "h1" when the section is the whole page (/comp/:id/pilots). */
  headingAs?: "h1" | "h2";
}) {
  const [pilots, setPilots] = useState<CompPilot[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  // Undefined until a header is clicked: the server already returns the roster
  // by name, and re-sorting it here on mount would only move rows for no
  // reason. See sortPilots for what each column compares.
  const [sort, setSort] = useState<SortDescriptor | undefined>(undefined);
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
    <Card>
      <SectionHeader
        as={headingAs}
        className={headingAs === "h1" ? "mt-2" : undefined}
        title={<>Pilots {pilots && pilots.length > 0 ? `(${pilots.length})` : ""}</>}
        action={
          isAdmin ? (
            <Button variant="outline" size="sm" onPress={() => setEditOpen(true)}>
              Edit
            </Button>
          ) : null
        }
      />

      {/* Whether this list can grow on its own. It used to be true of every
          competition with nothing anywhere to say so — an organiser reading
          their own roster could not tell that anyone signed in could join it.
          This is the list the answer belongs to, because this is the list that
          changes. */}
      {openRegistration !== undefined ? (
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <Badge variant={openRegistration ? "default" : "secondary"}>
            {openRegistration ? "Open registration" : "Registration closed"}
          </Badge>
          {openRegistration
            ? "Any signed-in pilot joins this list the first time they submit a track."
            : "Only an admin can add pilots. Anyone else is told to ask an organiser."}
          {isAdmin ? <span>Change it in Competition settings.</span> : null}
        </p>
      ) : null}

      {loadError ? (
        <p className="mt-2 text-muted-foreground">Could not load pilots</p>
      ) : pilots === null ? (
        <Loading className="mt-2">Loading pilots…</Loading>
      ) : pilots.length === 0 ? (
        <div className="mt-2 text-muted-foreground">
          <p>No pilots registered yet — pilots appear here when the organizers add them or when they submit a track.</p>
          {isAdmin ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onPress={() => setEditOpen(true)}
            >
              Add pilots
            </Button>
          ) : null}
        </div>
      ) : (
        <Table
          aria-label="Pilots"
          scrollLabel="Pilots"
          className="mt-2"
          sortDescriptor={sort}
          onSortChange={setSort}
        >
          <TableHeader>
            <Column id="name" isRowHeader allowsSorting>
              Name
            </Column>
            <Column id="account" allowsSorting>
              GlideComp account
            </Column>
            {/* The reason the roster is sortable at all: launch order is set
                in ranking order, so this is the column an organiser reads the
                table down. Right-aligned as a plain quantity. */}
            <Column id="wprs_points" allowsSorting className="text-right">
              WPRS points
            </Column>
            <Column id="civl_id" allowsSorting>
              CIVL
            </Column>
            <Column id="safa_id" allowsSorting>
              SAFA
            </Column>
            <Column id="pilot_class" allowsSorting>
              Class
            </Column>
            <Column id="team_name" allowsSorting>
              Team
            </Column>
            <Column id="driver_contact" allowsSorting>
              Driver
            </Column>
          </TableHeader>
          <TableBody>
            {sortPilots(pilots, sort).map((p) => (
              <Row key={p.comp_pilot_id} id={p.comp_pilot_id}>
                <Cell>{p.name}</Cell>
                <Cell>
                  {p.linked && p.linked_username ? (
                    <AriaLink
                      className="underline underline-offset-4 outline-none data-focus-visible:ring-2 data-focus-visible:ring-ring/50"
                      href={`/u/${encodeURIComponent(p.linked_username)}`}
                    >
                      @{p.linked_username}
                    </AriaLink>
                  ) : null}
                </Cell>
                <Cell className="text-right tabular-nums">
                  {p.wprs_points === null ? (
                    ""
                  ) : (
                    <>
                      {p.wprs_points}{" "}
                      {/* A score nobody can trace is a score nobody can check
                          — the list and month it came from, or the fact that
                          it was set by hand. */}
                      <span className="ml-1 text-xs font-normal text-muted-foreground">
                        {rankingSource(p)}
                      </span>
                    </>
                  )}
                </Cell>
                <Cell>{p.civl_id ?? ""}</Cell>
                <Cell>{p.safa_id ?? ""}</Cell>
                <Cell>{p.pilot_class}</Cell>
                <Cell>{p.team_name ?? ""}</Cell>
                <Cell>{p.driver_contact ?? ""}</Cell>
              </Row>
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
    </Card>
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
    if (c.key === "wprs_points") {
      // A score reads right-aligned, and the tooltip is where the provenance
      // the row is carrying invisibly becomes visible.
      def.hozAlign = "right";
      def.tooltip = (_e: MouseEvent, cell: CellComponent) => {
        const row = cell.getRow().getData() as ParsedRow;
        if (!row.wprs_points) return "";
        return row.civl_ranking_slug
          ? `From ${listLabel(row.civl_ranking_slug)}, ${formatRankingMonth(row.civl_ranking_date ?? null)}`
          : "Set by an organiser";
      };
    }
    return def;
  });

  return [remove, ...dataCols];
}

/**
 * The editor's panel size. A spreadsheet wants the screen.
 *
 * It fills the overlay's content box: the overlay's own `p-4` is the whole
 * inset and is deliberately not overridable (rac/dialog.tsx), so the only
 * thing between the grid and the screen edge is 16px of backdrop.
 *
 *   * `max-w-full` overrides the panel's usual `max-w-[calc(100%-2rem)]`,
 *     which was costing a phone another 32px of the little width it has.
 *   * `dvh`, not `vh`: on mobile Safari `vh` counts the collapsing toolbar, so
 *     a `vh` height puts the footer's Save button underneath it.
 *   * Wide screens keep a cap. Past about 1400px the fourteen columns have all
 *     the room they can use, and a panel the width of a monitor stops reading
 *     as a dialog.
 */
const EDITOR_PANEL_CLASS =
  "h-[calc(100dvh-2rem)] max-w-full sm:h-[calc(100dvh-3rem)] sm:max-w-[min(88rem,100%)]";

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
  const tableRef = useRef<Tabulator | null>(null);
  const [gridReady, setGridReady] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  // What the CIVL rankings make of the rows currently in the grid. Null until
  // the first lookup answers; a lookup with no matches and no lists is a
  // database with nothing imported, which the dialog says out loud.
  const [lookup, setLookup] = useState<RankingLookup | null>(null);
  const [looking, setLooking] = useState(false);
  // How many rows that answer was about, so "18 of 24" counts the same rows
  // the matches came from rather than whatever the grid holds a moment later.
  const [lookupSize, setLookupSize] = useState(0);
  // The fill lives in its own dialog: on a phone its picker and label took a
  // fifth of the editor's height whether or not anyone was filling anything,
  // and the grid is what the screen is for.
  const [civlOpen, setCivlOpen] = useState(false);
  const [filling, setFilling] = useState(false);

  /** Current grid contents, normalised (trimmed, empty optionals → null). */
  function gridRows(): ParsedRow[] {
    const table = tableRef.current;
    if (!table) return [];
    return (table.getData() as ParsedRow[]).map(normalizeRow);
  }

  /**
   * Re-ask the rankings about the grid as it stands now.
   *
   * Run when the grid is ready and again after ids are filled — the matches
   * are keyed by row index, so an answer about a previous state of the grid
   * would fill the wrong rows. Returns the answer so a caller can act on it
   * rather than on state React has not committed yet.
   *
   * A failure is reported and nothing else: the rest of the editor works
   * perfectly well without rankings.
   */
  const refreshLookup = useCallback(
    async (rows: ParsedRow[]): Promise<RankingLookup | null> => {
      setLooking(true);
      try {
        const result = await lookupRankings(compId, rows);
        setLookup(result);
        setLookupSize(rows.length);
        return result;
      } catch {
        setLookup({ matches: {}, matched_count: 0, rankable_count: 0 });
        setErrors((e) => [
          ...e,
          "Could not read the CIVL rankings. The rest of the editor still works.",
        ]);
        return null;
      } finally {
        setLooking(false);
      }
    },
    [compId]
  );

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

  /**
   * Fill in everything the chosen list can say about the grid, in one press.
   *
   * Ids first, then the rest — because the rest is matched by ID ONLY, and a
   * rank attached to the wrong human silently sets the wrong launch order. So
   * the lookup is re-run in between: rows that just gained an id are matched
   * by it on the second pass, which is what makes their rankings fillable at
   * all. Two buttons made the organiser perform that ordering by hand, and
   * pressing them in the other order simply did less.
   *
   * Both steps are on the SPREADSHEET, not the competition: nothing is written
   * until the organiser saves, so a fill they disagree with is undone by
   * cancelling.
   */
  async function fillFromCivl() {
    const table = tableRef.current;
    if (!table || !lookup) return;

    const ids = fillCivlIds(gridRows(), lookup);
    await table.setData(ids.rows);

    // Re-ask about the grid as it now stands. On failure the ids are still in
    // (they are already in the grid) and the ranks are simply not attempted —
    // refreshLookup has reported the problem itself.
    const refreshed = await refreshLookup(ids.rows);
    if (!refreshed) {
      setStatus(
        `${ids.filled} CIVL ID${ids.filled === 1 ? "" : "s"} filled in. ` +
          `Could not read the rankings again, so no scores were filled.`
      );
      return;
    }

    const ranks = fillRankings(ids.rows, refreshed);
    await table.setData(ranks.rows);

    const noId = ranks.rows.filter((r) => !r.civl_id).length;
    setStatus(
      `${ids.filled} CIVL ID${ids.filled === 1 ? "" : "s"} and ` +
        `${ranks.filled} WPRS score${ranks.filled === 1 ? "" : "s"} filled in.` +
        // Only missing cells are written, so a roster that is already scored
        // gets "0 filled in" — which reads as a failure unless the reason is
        // said out loud, along with what to do about a newer month.
        (ranks.already_set > 0
          ? ` ${ranks.already_set} already had a score and ` +
            `${ranks.already_set === 1 ? "was" : "were"} left alone — clear one ` +
            `to refill.`
          : "") +
        (noId > 0
          ? ` ${noId} row${noId === 1 ? " has" : "s have"} no ID — no exact ` +
            `name match.`
          : "")
    );
  }

  /**
   * Open the fill dialog, asking the rankings about the grid AS IT IS NOW.
   *
   * This used to be asked once, when the grid finished loading, and the answer
   * reused forever after. A name corrected in the meantime — which is the
   * commonest reason a pilot has no ID, and so the commonest reason to press
   * this button — was still being matched against the name it had on load, so
   * the fill did nothing at all. Saving and reopening the editor fixed it,
   * because that rebuilt the grid and asked again.
   *
   * Dropping the old answer first is what makes the dialog say "Reading the
   * CIVL world rankings…" rather than showing a count from before the edit.
   * The grid cannot be edited while the dialog is over it, so an answer taken
   * here is still true when Fill is pressed.
   */
  function openCivlFill() {
    setLookup(null);
    setCivlOpen(true);
    void refreshLookup(gridRows());
  }

  /**
   * Run the fill, then close the dialog it was started from.
   *
   * Closing on the way out is what puts the result in front of the organiser:
   * the outcome is a sentence under the grid, next to the rows it changed,
   * and a dialog still sitting over them would be hiding the answer.
   */
  async function confirmFill() {
    setFilling(true);
    try {
      await fillFromCivl();
    } finally {
      setFilling(false);
      setCivlOpen(false);
    }
  }

  async function importCsv(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    const text = await file.text();

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
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className={EDITOR_PANEL_CLASS}
    >
      {/* min-w-0: the panel and this Dialog are grid containers, and grid
          items default to min-width:auto — without the override the Tabulator's
          natural 13-column width wins over the panel's max-w-6xl and blows the
          dialog out sideways. Bounding the chain instead hands horizontal
          overflow to Tabulator's own scroller (which keeps the frozen name
          column pinned — an outer overflow-x wrapper would scroll it away). */}
      <Dialog
        id="pilots-edit-dialog"
        className="flex h-full min-h-0 w-full min-w-0 max-w-full flex-col gap-4"
      >
        <DialogHeader>
          <DialogTitle>Edit pilots</DialogTitle>
        </DialogHeader>

        {/* No standing prose above the grid: on a phone every line here is a
            row of the roster the organiser cannot see. What it used to say —
            tap a cell to edit it, nameless rows are dropped — the grid says
            better by being a grid, and by naming the row on save if a row
            with content has no name. The empty-grid placeholder still
            onboards a first-time admin, which is when it is worth the space. */}
        <TabulatorGrid
          id="pilots-grid"
          className="gc-grid min-h-0 w-full min-w-0 max-w-full flex-1 overflow-hidden rounded border border-border"
          initialColumns={() => gridColumns(compClasses)}
          initialData={() => pilots.map(pilotToRow)}
          options={{
            layout: "fitDataStretch",
            height: "100%",
            placeholder: EMPTY_GRID_PLACEHOLDER,
            // Editor popups (class list) must render inside the modal dialog,
            // otherwise the dialog paints over them.
            popupContainer: "#pilots-edit-dialog",
          }}
          tableRef={tableRef}
          events={{
            cellEdited: (cell) => {
              // Typing over a score makes it the organiser's number, so the
              // list and month it used to carry stop being true of it. They
              // are cleared here rather than at save time so the cell's
              // tooltip tells the truth the moment the edit lands.
              if (cell.getField() !== "wprs_points") return;
              cell.getRow().update({
                civl_ranking_slug: null,
                civl_ranking_date: null,
              });
            },
          }}
          onReady={() => setGridReady(true)}
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

        <DialogFooter>
          <div className="flex flex-wrap gap-2 sm:mr-auto">
            <Button
              variant="outline"
              size="sm"
              isDisabled={!gridReady}
              onPress={addRow}
            >
              Add row
            </Button>
            <TooltipTrigger>
              <Button
                variant="outline"
                size="sm"
                isDisabled={!gridReady}
                onPress={addTestPilots}
              >
                Add test pilots
              </Button>
              <Tooltip>
                Add 3 dummy pilots (Test Dummy 1, testdummy1@example.com, …) to try
                the system
              </Tooltip>
            </TooltipTrigger>
            <FileTrigger
              acceptedFileTypes={[".csv", ".tsv", ".txt"]}
              onSelect={(files) => void importCsv(files)}
            >
              <Button variant="outline" size="sm" isDisabled={!gridReady}>
                Import CSV
              </Button>
            </FileTrigger>
            <Button
              variant="outline"
              size="sm"
              isDisabled={!gridReady}
              onPress={exportCsv}
            >
              Export CSV
            </Button>
            {/* The trailing "…" is the app's mark for an action that asks
                something before it acts (see ScoresDownload's "Open in Google
                Sheets…"). It sits with the other grid-wide actions rather
                than above the footer, where its picker and label used to cost
                a phone a fifth of the dialog whether or not anyone used it. */}
            <Button
              variant="outline"
              size="sm"
              isDisabled={!gridReady}
              onPress={() => openCivlFill()}
            >
              Fill from CIVL…
            </Button>
          </div>
          <Button slot="close" variant="outline">
            Cancel
          </Button>
          <Button
            isDisabled={!gridReady}
            isPending={saving}
            pendingLabel="Saving"
            onPress={() => void save()}
          >
            Save
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Nested inside the editor's Modal, the way RouteEditorDialog nests
          AddWaypointDialog. */}
      {civlOpen ? (
        <CivlFillDialog
          lookup={lookup}
          rosterSize={lookupSize}
          isBusy={looking || filling}
          onClose={() => setCivlOpen(false)}
          onFill={() => void confirmFill()}
        />
      ) : null}
    </Modal>
  );
}

/**
 * The CIVL fill, in a dialog of its own: what filling will do, and the button
 * that does it.
 *
 * It had a list picker, because a pilot can hold a different rank in each of
 * CIVL's ten lists and something had to choose. Now the choice is made for
 * them — every list is read and each pilot is taken from the one where their
 * WPRS score is highest (see civl-ranking-match.ts for why points and not
 * rank) — so the dialog is a sentence and a button.
 */
function CivlFillDialog({
  lookup,
  rosterSize,
  isBusy,
  onClose,
  onFill,
}: {
  lookup: RankingLookup | null;
  /** Rows the last lookup asked about — the denominator of "18 of 24". */
  rosterSize: number;
  isBusy: boolean;
  onClose: () => void;
  onFill: () => void;
}) {
  // Nothing imported and nothing matched are the same answer to the only
  // question this dialog asks — "is there anything to fill?" — so they get
  // the same message rather than two that a reader has to tell apart.
  const holdsNothing = lookup !== null && lookup.matched_count === 0;
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="sm:max-w-lg"
    >
      <Dialog id="civl-fill-dialog" className="gap-3">
        <DialogHeader>
          <DialogTitle>Fill from CIVL rankings</DialogTitle>
        </DialogHeader>

        {lookup === null ? (
          <Loading className="text-sm">Reading the CIVL world rankings…</Loading>
        ) : holdsNothing ? (
          // Either nothing is imported (a local database, or the daily import
          // has never run) or this roster simply matches nobody. Both mean the
          // button has nothing to do, and neither is worth two messages.
          <p className="text-sm text-muted-foreground">
            No CIVL rankings match this roster. You can still type them in by
            hand.
          </p>
        ) : (
          <>
            {/* The acronym is expanded here because this is where an organiser
                meets it — it is also what the roster column is headed. Which
                CIVL list each number came from is not their problem: they no
                longer choose one, and the roster shows it per row anyway. */}
            <p className="text-sm text-muted-foreground">
              Add CIVL IDs and WPRS (World Pilot Ranking Scheme) points when
              missing
            </p>
            {/* The count is what the picker's "n of N" used to carry, and it
                is the part worth keeping: it says what pressing the button is
                about to be worth before it is pressed. */}
            <p className="text-sm text-muted-foreground">
              {lookup.matched_count} of {rosterSize}{" "}
              {rosterSize === 1 ? "pilot has" : "pilots have"} one.
            </p>
          </>
        )}

        <DialogFooter>
          <Button slot="close" variant="outline">
            Cancel
          </Button>
          {lookup !== null && !holdsNothing ? (
            <Button
              isPending={isBusy}
              pendingLabel="Filling from the rankings"
              onPress={onFill}
            >
              Fill
            </Button>
          ) : null}
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}

