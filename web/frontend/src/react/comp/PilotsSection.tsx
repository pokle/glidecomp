/**
 * The pilots page's roster editor (/comp/:id/pilots, admin-only): a LIST of
 * pilots, each opening a full-screen sheet, with a search box and a + riding
 * at the bottom of the screen.
 *
 * Mobile first (see the rule in CLAUDE.md). It replaced a read-only RAC table
 * and, behind an Edit button, a fourteen-column Tabulator grid in a dialog —
 * at every width, not below a breakpoint, for the reason the waypoints page
 * gives (comp/WaypointList.tsx): two editors are two code paths. What each
 * piece is for:
 *
 *   - comp/PilotList.tsx — a row per pilot: name, then class · glider ·
 *     points · whether their tracks can find them.
 *   - comp/PilotSheet.tsx — one pilot, saved the moment Done is pressed.
 *     Nothing on this page waits for a page-level Save, so there is none.
 *   - The bottom bar — search and +, side by side the way iOS Contacts puts
 *     them: in thumb reach while scrolling 150 pilots, which a search box at
 *     the top of the page is not. The search finds a pilot by any field
 *     (comp/pilot-search.ts); when it finds nobody, + opens a new pilot with
 *     the typed name already in it, so "search first, then add" is the natural
 *     order at a registration desk — and the way duplicates are avoided.
 *   - comp/RosterActions.tsx — the ⋯ menu's import, export, CIVL fill and
 *     test pilots, each previewing what it will write.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PlusIcon } from "lucide-react";
import { Badge } from "@/react/rac/badge";
import { Button } from "@/react/rac/button";
import { SearchField } from "@/react/rac/field";
import { Loading } from "@/react/rac/progress";
import { SimpleSelect } from "@/react/rac/select";
import { SectionHeader } from "../components/SectionHeader";
import { api } from "../../comp/api";
import { downloadFile } from "../lib/format";
import { toast } from "../lib/toast";
import { useBottomBar } from "../lib/use-bottom-bar";
import { fetchWithRetry } from "./types";
import { exportCsvContent, pilotToRow, slugify, type CompPilot } from "./csv";
import { filterPilots, queryWords } from "./pilot-search";
import { rosterTeams } from "./team-names";
import { PilotList } from "./PilotList";
import { PilotSheet } from "./PilotSheet";
import {
  CivlFillSheet,
  ImportCsvDialog,
  ImportReviewSheet,
  RosterActionsMenu,
} from "./RosterActions";
import type { ImportPlan } from "./roster-import";

type SortBy = "name" | "wprs_points";

/**
 * The roster in the chosen order. WPRS points run highest first — the order
 * the rankings are read in — with unscored pilots last: "no score" is not a
 * very bad one, and an organiser looking for their top seeds should not have
 * to scroll past everyone who has never been ranked.
 */
function sortPilots(pilots: CompPilot[], by: SortBy): CompPilot[] {
  const byName = (a: CompPilot, b: CompPilot) => a.name.localeCompare(b.name);
  if (by === "name") return [...pilots].sort(byName);
  return [...pilots].sort((a, b) => {
    if (a.wprs_points === null && b.wprs_points === null) return byName(a, b);
    if (a.wprs_points === null) return 1;
    if (b.wprs_points === null) return -1;
    return b.wprs_points - a.wprs_points || byName(a, b);
  });
}

/** The sheet open over the list, if any. */
type Editing = { pilot: CompPilot | null; initialName?: string } | null;

export function PilotsSection({
  compId,
  compName,
  compClasses,
  openRegistration,
  onCountChange,
  headingAs = "h2",
}: {
  compId: string;
  compName: string;
  compClasses: string[];
  /** Whether a pilot can join this comp by submitting a track. Shown here
   *  because the roster is the only place the consequence is visible. */
  openRegistration?: boolean;
  /** The roster's size, whenever it changes — for the page's section nav,
   *  whose "Pilots (n)" otherwise holds the count the page loaded with. */
  onCountChange?: (count: number) => void;
  /** "h1" when the section is the whole page (/comp/:id/pilots). */
  headingAs?: "h1" | "h2";
}) {
  const [pilots, setPilots] = useState<CompPilot[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [editing, setEditing] = useState<Editing>(null);
  const [importing, setImporting] = useState(false);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [fillingCivl, setFillingCivl] = useState(false);

  const barRef = useBottomBar();

  const loadPilots = useCallback(async () => {
    try {
      // Through fetchWithRetry: a dropped request is not an empty roster
      // (issue #481), and an empty roster is exactly what it would look like.
      const res = await fetchWithRetry(() =>
        api.api.comp[":comp_id"].pilot.$get({ param: { comp_id: compId } })
      );
      if (!res.ok) {
        setLoadError(true);
        return;
      }
      const data = (await res.json()) as unknown as { pilots: CompPilot[] };
      setPilots(data.pilots);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, [compId]);

  useEffect(() => {
    void loadPilots();
  }, [loadPilots]);

  /** The whole roster changed (a bulk write answered with all of it). */
  const replaceRoster = (roster: CompPilot[]) => setPilots(roster);

  // Through a ref, so a parent passing an inline callback does not re-run
  // this on every render.
  const countChanged = useRef(onCountChange);
  countChanged.current = onCountChange;
  const count = pilots?.length;
  useEffect(() => {
    if (count !== undefined) countChanged.current?.(count);
  }, [count]);

  const shown = useMemo(
    () => (pilots ? sortPilots(filterPilots(pilots, query), sortBy) : []),
    [pilots, query, sortBy]
  );
  const teams = useMemo(() => rosterTeams(pilots ?? []), [pilots]);
  const searching = queryWords(query).length > 0;
  const nobodyMatches = searching && shown.length === 0;
  const typedName = query.trim();

  /**
   * The +: a blank pilot — or, when the search found nobody, one already
   * carrying the name that was searched for.
   */
  const add = () =>
    setEditing({ pilot: null, initialName: nobodyMatches ? typedName : undefined });

  async function addTestPilots() {
    if (!pilots) return;
    // Numbering continues from the highest existing test dummy, so each
    // press adds three more; classes cycle so a multi-class comp gets some
    // in every class.
    let maxN = 0;
    for (const p of pilots) {
      const m =
        /^testdummy(\d+)@example\.com$/i.exec(p.email ?? "") ??
        /^test dummy (\d+)$/i.exec(p.name);
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10));
    }
    const rows = [1, 2, 3].map((i) => {
      const n = maxN + i;
      return {
        registered_pilot_name: `Test Dummy ${n}`,
        registered_pilot_email: `testdummy${n}@example.com`,
        pilot_class: compClasses[(n - 1) % compClasses.length] ?? "",
      };
    });
    try {
      const res = await api.api.comp[":comp_id"].pilot.bulk.$post({
        param: { comp_id: compId },
        json: { pilots: rows, remove: [] },
      });
      if (!res.ok) throw new Error(String(res.status));
      replaceRoster(((await res.json()) as unknown as { pilots: CompPilot[] }).pilots);
    } catch {
      toast.error("Could not add test pilots.");
    }
  }

  function exportCsv() {
    downloadFile(
      `pilots-${slugify(compName)}.csv`,
      exportCsvContent((pilots ?? []).map(pilotToRow)),
      "text/csv;charset=utf-8"
    );
  }

  return (
    <div className="max-w-2xl">
      <SectionHeader
        as={headingAs}
        className={headingAs === "h1" ? "mt-2" : undefined}
        title={<>Pilots {pilots && pilots.length > 0 ? `(${pilots.length})` : ""}</>}
        action={
          pilots ? (
            <RosterActionsMenu
              onImport={() => setImporting(true)}
              onExport={exportCsv}
              onFillCivl={() => setFillingCivl(true)}
              onAddTestPilots={() => void addTestPilots()}
            />
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
          <span>Change it in Competition settings.</span>
        </p>
      ) : null}

      {loadError ? (
        <p className="mt-4 text-muted-foreground">Could not load pilots</p>
      ) : pilots === null ? (
        <Loading className="mt-4">Loading pilots…</Loading>
      ) : (
        <>
          <div className="mt-4 mb-2 flex items-center justify-between gap-3">
            {/* Always in the DOM, so a screen reader hears the count change as
                the search narrows; empty while nothing is being searched,
                because the heading already says how many there are. */}
            <p role="status" className="text-sm text-muted-foreground">
              {searching ? `${shown.length} of ${pilots.length} pilots` : ""}
            </p>
            {pilots.length > 1 ? (
              <SimpleSelect
                label="Sort"
                // Label beside the control, not above it: one line for one word.
                className="flex-row items-center"
                value={sortBy}
                onChange={(v) => setSortBy(v as SortBy)}
                options={[
                  { value: "name", label: "Name" },
                  { value: "wprs_points", label: "WPRS points" },
                ]}
              />
            ) : null}
          </div>

          <PilotList
            pilots={shown}
            emptyMessage={
              searching
                ? `No pilot matches "${typedName}".`
                : "No pilots registered yet — pilots appear here when the organisers add them or when they submit a track."
            }
            onOpen={(id) => {
              const pilot = pilots.find((p) => p.comp_pilot_id === id);
              if (pilot) setEditing({ pilot });
            }}
          />
        </>
      )}

      {/* The search-and-add bar. Fixed to the bottom of the screen and lifted
          over the keyboard by useBottomBar; the outer layers let presses
          through to the rows beside its two controls. Lined up with the page's
          content column, so on a wide screen it sits under the list it belongs
          to rather than in the middle of the window. */}
      {/* Not while a sheet is open: it has nothing to offer there, and its +
          showed through the sheet's translucent backdrop. */}
      {pilots !== null && !editing && !plan && !fillingCivl ? (
        <div
          ref={barRef}
          className="pointer-events-none fixed inset-x-0 z-20 print:hidden"
          style={{ bottom: "var(--keyboard-inset, 0px)" }}
        >
          <div className="mx-auto max-w-6xl px-gutter-safe pt-2 pb-gutter-safe">
            <div className="pointer-events-auto flex max-w-2xl items-center gap-3">
              <SearchField
                variant="floating"
                aria-label="Find a pilot"
                placeholder="Find a pilot"
                value={query}
                onChange={setQuery}
                className="min-w-0 flex-1"
              />
              <Button
                aria-label={nobodyMatches ? `Add a pilot named ${typedName}` : "Add pilot"}
                onPress={add}
                className="size-12 rounded-full shadow-lg"
              >
                <PlusIcon className="size-6" aria-hidden="true" />
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {editing ? (
        <PilotSheet
          compId={compId}
          compClasses={compClasses}
          pilot={editing.pilot}
          initialName={editing.initialName}
          teams={teams}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setPilots((list) => [
              ...(list ?? []).filter((p) => p.comp_pilot_id !== saved.comp_pilot_id),
              saved,
            ]);
            setEditing(null);
          }}
          onRemoved={(removed) => {
            setPilots((list) =>
              (list ?? []).filter((p) => p.comp_pilot_id !== removed.comp_pilot_id)
            );
            setEditing(null);
          }}
        />
      ) : null}

      {importing && pilots ? (
        <ImportCsvDialog
          compClasses={compClasses}
          roster={pilots}
          onClose={() => setImporting(false)}
          onPlanned={(p) => {
            setImporting(false);
            setPlan(p);
          }}
        />
      ) : null}

      {plan ? (
        <ImportReviewSheet
          compId={compId}
          plan={plan}
          onClose={() => setPlan(null)}
          onApplied={(roster) => {
            setPlan(null);
            replaceRoster(roster);
          }}
        />
      ) : null}

      {fillingCivl && pilots ? (
        <CivlFillSheet
          compId={compId}
          roster={pilots}
          onClose={() => setFillingCivl(false)}
          onApplied={(roster) => {
            setFillingCivl(false);
            replaceRoster(roster);
          }}
        />
      ) : null}
    </div>
  );
}
