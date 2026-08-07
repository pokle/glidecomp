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
import type {
  CellComponent,
  ColumnDefinition,
  RowComponent,
  RowRangeLookup,
  Tabulator,
} from "tabulator-tables";
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
  pilotDetails,
  searchRankedPilots,
  type RankedPilot,
  fillRankings,
  formatRankingMonth,
  listLabel,
  lookupRankings,
  rankingSource,
  type RankingList,
} from "./civl-rankings";
import { Select, SelectItem } from "@/react/rac/select";
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
 * The ranking sorts numerically with unranked pilots pinned last in BOTH
 * directions: "no ranking" is not a very good or a very bad one, and an
 * organiser sorting to find their top seeds should not have to scroll past
 * everyone who has never been ranked. Every other column is locale text.
 */
function sortPilots(pilots: CompPilot[], sort: SortDescriptor | undefined): CompPilot[] {
  if (!sort) return pilots;
  const dir = sort.direction === "descending" ? -1 : 1;
  const col = String(sort.column);
  return [...pilots].sort((a, b) => {
    if (col === "civl_ranking") {
      if (a.civl_ranking === null && b.civl_ranking === null) return 0;
      if (a.civl_ranking === null) return 1;
      if (b.civl_ranking === null) return -1;
      return (a.civl_ranking - b.civl_ranking) * dir;
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
            <Column id="civl_ranking" allowsSorting className="text-right">
              CIVL rank
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
                  {p.civl_ranking === null ? (
                    ""
                  ) : (
                    <>
                      {p.civl_ranking}{" "}
                      {/* A rank nobody can trace is a rank nobody can check —
                          the list and month it came from, or the fact that it
                          was set by hand. */}
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
 * loses track of whose row is being edited, and suggests ranked pilots as the
 * organiser types (see `suggest`).
 */
function gridColumns(
  compClasses: string[],
  /** Ranked pilots matching what has been typed so far, for the name column. */
  suggest: (term: string) => Promise<RankedPilot[]>
): ColumnDefinition[] {
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
      // An autocomplete over the CIVL rankings, and NOT a closed list:
      // freetext is what keeps the column a name field. Most rosters have
      // pilots who have never been ranked, and a cell that refused to hold
      // them would be a worse column than one with no suggestions at all.
      def.editor = "list";
      def.editorParams = {
        autocomplete: true,
        freetext: true,
        allowEmpty: true,
        // Ask the server per keystroke rather than filtering a cached list:
        // the rankings are ~2,000 names per list, and which list is being read
        // can change between one cell and the next.
        filterRemote: true,
        // @types/tabulator-tables types `valuesLookup` as RowRangeLookup (the
        // "active"/"visible"/"all" strings) only. Tabulator 6 also accepts a
        // (cell, filterTerm) function, which is the whole point of
        // filterRemote — so the ONE field is cast, leaving the rest checked.
        valuesLookup: (async (_cell: CellComponent, term: string) => {
          const pilots = await suggest(term ?? "");
          // The label carries what tells two pilots of the same name apart —
          // nation and world rank — while the VALUE stays the bare name,
          // because the cell is a name and has to read like one.
          return pilots.map((p) => ({
            label: `${p.pilot_name} · ${p.nation || "—"} · #${p.rank}`,
            value: p.pilot_name,
          }));
        }) as unknown as RowRangeLookup,
      };
    }
    if (c.key === "pilot_class") {
      def.editor = "list";
      def.editorParams = { values: compClasses };
    }
    if (c.key === "civl_ranking") {
      // A place in a list reads right-aligned, and the tooltip is where the
      // provenance the row is carrying invisibly becomes visible.
      def.hozAlign = "right";
      def.tooltip = (_e: MouseEvent, cell: CellComponent) => {
        const row = cell.getRow().getData() as ParsedRow;
        if (!row.civl_ranking) return "";
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
  // What the CIVL lists make of the rows currently in the grid. Null until the
  // first lookup answers; an empty array means we hold no rankings at all,
  // which is a different thing and says so in the UI.
  const [lists, setLists] = useState<RankingList[] | null>(null);
  const [listSlug, setListSlug] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  // How many rows that answer was about, so "18 of 24" counts the same rows
  // the matches came from rather than whatever the grid holds a moment later.
  const [lookupSize, setLookupSize] = useState(0);
  const selectedList = lists?.find((l) => l.slug === listSlug) ?? null;
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
   * Re-ask the lists about the grid as it stands now.
   *
   * Run when the grid is ready and again after ids are filled — the matches
   * are keyed by row index, so an answer about a previous state of the grid
   * would fill the wrong rows. Returns the lists so a caller can act on the
   * fresh answer rather than on state React has not committed yet.
   *
   * A failure is reported and nothing else: the rest of the editor works
   * perfectly well without rankings.
   */
  const refreshLookup = useCallback(
    async (rows: ParsedRow[]): Promise<RankingList[] | null> => {
      setLooking(true);
      try {
        const result = await lookupRankings(compId, rows);
        setLists(result.lists);
        setLookupSize(rows.length);
        setListSlug((current) => {
          // Keep the organiser's choice across a refresh; only fall back to
          // the suggested list when they have not picked one.
          if (current && result.lists.some((l) => l.slug === current)) return current;
          return result.default_slug;
        });
        return result.lists;
      } catch {
        setLists([]);
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

  /**
   * The name column's typeahead, and the memory that lets a pick fill a row.
   *
   * Tabulator's list editor hands `cellEdited` the chosen VALUE — here the
   * bare name — and not the item it came from, so the suggestions are kept
   * until the edit lands and the pilot is recovered from them.
   */
  const suggestionsRef = useRef<RankedPilot[]>([]);
  const listSlugRef = useRef<string | null>(null);
  listSlugRef.current = listSlug;

  const suggestPilots = useCallback(
    async (term: string): Promise<RankedPilot[]> => {
      const pilots = await searchRankedPilots(compId, term, listSlugRef.current);
      suggestionsRef.current = pilots;
      return pilots;
    },
    [compId]
  );

  /**
   * A name that came from the typeahead brings its pilot's details with it.
   *
   * Only an UNAMBIGUOUS name is acted on. Two ranked pilots sharing a name is
   * rare but real, and the cell records the name rather than which of them was
   * highlighted — so rather than guess, the row keeps the name and the
   * organiser fills the id themselves. Same rule the fill button follows.
   *
   * An id already in the row is never overwritten: it is someone's deliberate
   * answer, and a name is not evidence against it.
   */
  function applyPickedPilot(row: RowComponent, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    const hits = suggestionsRef.current.filter((p) => p.pilot_name === trimmed);
    if (hits.length !== 1) return;
    const current = row.getData() as ParsedRow;
    if (current.civl_id) return;
    row.update(pilotDetails(hits[0]));
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
    if (!table || !selectedList) return;
    const list = selectedList;

    const ids = fillCivlIds(gridRows(), list);
    await table.setData(ids.rows);

    // Re-ask about the grid as it now stands. On failure the ids are still in
    // (they are already in the grid) and the ranks are simply not attempted —
    // refreshLookup has reported the problem itself.
    const fresh = await refreshLookup(ids.rows);
    const refreshed = fresh?.find((l) => l.slug === list.slug) ?? null;
    if (!refreshed) {
      setStatus(
        `${ids.filled} CIVL ID${ids.filled === 1 ? "" : "s"} filled in from ` +
          `${list.name}. Could not read the rankings again, so no ranks were filled.`
      );
      return;
    }

    const ranks = fillRankings(ids.rows, refreshed);
    await table.setData(ranks.rows);

    const noId = ranks.rows.filter((r) => !r.civl_id).length;
    setStatus(
      `From ${list.name} (${formatRankingMonth(list.ranking_date)}): ` +
        `${ids.filled} CIVL ID${ids.filled === 1 ? "" : "s"} and ` +
        `${ranks.filled} ranking${ranks.filled === 1 ? "" : "s"} filled in. ` +
        (noId > 0
          ? `${noId} row${noId === 1 ? " has" : "s have"} no ID — that list has ` +
            `nobody by that exact name, or more than one. `
          : "") +
        "Rankings are copied, not looked up later: they stay as they are now."
    );
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
          initialColumns={() => gridColumns(compClasses, suggestPilots)}
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
              // A name picked from the typeahead brings its id and ranking.
              if (cell.getField() === "name") {
                applyPickedPilot(cell.getRow(), String(cell.getValue() ?? ""));
                return;
              }
              // Typing over a ranking makes it the organiser's number, so the
              // list and month it used to carry stop being true of it. They
              // are cleared here rather than at save time so the cell's
              // tooltip tells the truth the moment the edit lands.
              if (cell.getField() !== "civl_ranking") return;
              cell.getRow().update({
                civl_ranking_slug: null,
                civl_ranking_date: null,
              });
            },
          }}
          onReady={() => {
            setGridReady(true);
            void refreshLookup(gridRows());
          }}
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
              onPress={() => setCivlOpen(true)}
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
          AddWaypointDialog. It reads and writes the SAME lookup state, so the
          list chosen here is also the one the name typeahead searches. */}
      {civlOpen ? (
        <CivlFillDialog
          lists={lists}
          selected={selectedList}
          onSelect={setListSlug}
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
 * The CIVL fill, in a dialog of its own: which list to read, what reading it
 * will do, and the button that does it.
 *
 * It was a bar under the grid, and on a phone its label, picker and button
 * cost about a fifth of the editor's height — permanently, for a step most
 * rosters take once. Behind a button the grid gets that space back, and the
 * explanation gets room to be a sentence rather than a tooltip nobody on a
 * touchscreen can open.
 *
 * The picker shows every list we hold with the month it was published and how
 * many of these pilots it places. That count is the whole reason it is a
 * picker: it is how an organiser discovers they are looking at the Sport list
 * rather than being quietly given the wrong ranks.
 */
function CivlFillDialog({
  lists,
  selected,
  onSelect,
  rosterSize,
  isBusy,
  onClose,
  onFill,
}: {
  lists: RankingList[] | null;
  selected: RankingList | null;
  onSelect: (slug: string) => void;
  /** Rows the last lookup asked about — the denominator of "18 of 24". */
  rosterSize: number;
  isBusy: boolean;
  onClose: () => void;
  onFill: () => void;
}) {
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

        {lists === null ? (
          <Loading className="text-sm">Reading the CIVL world rankings…</Loading>
        ) : lists.length === 0 ? (
          // Nothing imported yet — a local database, or the daily import has
          // never run. Say so plainly rather than showing an empty picker.
          <p className="text-sm text-muted-foreground">
            No CIVL world rankings have been imported yet, so there is nothing
            to fill from. You can still type rankings in by hand.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Add CIVL IDs and rankings when missing
            </p>
            <Select
              label="CIVL list"
              aria-label="CIVL ranking list"
              selectedKey={selected?.slug ?? null}
              onSelectionChange={(key) => onSelect(String(key))}
              className="gap-1"
            >
              {lists.map((list) => (
                <SelectItem
                  key={list.slug}
                  id={list.slug}
                  // textValue is what the closed button and typeahead read, so
                  // it carries the counts too — they are the reason to choose
                  // a list.
                  textValue={`${list.name} · ${formatRankingMonth(list.ranking_date)} · ${list.matched_count} of ${rosterSize}`}
                >
                  {list.name} · {formatRankingMonth(list.ranking_date)} ·{" "}
                  {list.matched_count} of {rosterSize}{" "}
                  {rosterSize === 1 ? "pilot" : "pilots"}
                </SelectItem>
              ))}
            </Select>
          </>
        )}

        <DialogFooter>
          <Button slot="close" variant="outline">
            Cancel
          </Button>
          {lists !== null && lists.length > 0 ? (
            <Button
              isDisabled={!selected}
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
