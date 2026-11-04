/**
 * The pilots page's roster editor (/comp/:id/pilots, admin-only): a LIST of
 * pilots, each opening that pilot's own page, under a search box and a +
 * that stay at the top of the screen as the list scrolls.
 *
 * Mobile first (see the rule in CLAUDE.md). It replaced a read-only RAC table
 * and, behind an Edit button, a fourteen-column Tabulator grid in a dialog —
 * at every width, not below a breakpoint, for the reason the waypoints page
 * gives (comp/WaypointList.tsx): two editors are two code paths. What each
 * piece is for:
 *
 *   - comp/PilotList.tsx — a row per pilot: name, then class · glider ·
 *     points · whether their tracks can find them.
 *   - pages/CompPilotPage.tsx (form: comp/PilotForm.tsx) — one pilot, on a
 *     page of its own, saved the moment Done is pressed. Nothing on this page
 *     waits for a page-level Save, so there is none.
 *   - The search bar — search and +, side by side, sticky at the top. It sat
 *     at the bottom of the screen like iOS Contacts' until 2026-11, which
 *     meant a fixed bar lifted over the keyboard by hand, and on an iPhone it
 *     once stuck halfway up the screen: the keyboard comes up from the
 *     bottom, and a bar at the top never has to dodge it. The search finds a
 *     pilot by any field (comp/pilot-search.ts); when it finds nobody, + opens
 *     a new pilot with the typed name already in it, so "search first, then
 *     add" is the natural order at a registration desk — and the way
 *     duplicates are avoided.
 *   - The search and the sort are in the URL (`?q=`, `?sort=`), so Back from
 *     a pilot's page returns to the list exactly as it was left.
 *   - comp/RosterActions.tsx — the ⋯ menu's import, export, CIVL fill and
 *     test pilots. The import and the fill are pages of their own
 *     (/pilots/import, /pilots/civl-fill), each previewing what it will write.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PlusIcon } from "lucide-react";
import { Badge } from "@/react/rac/badge";
import { Button } from "@/react/rac/button";
import { SearchField } from "@/react/rac/field";
import { Loading } from "@/react/rac/progress";
import { SimpleSelect } from "@/react/rac/select";
import { SectionHeader } from "../components/SectionHeader";
import { api } from "../../comp/api";
import { downloadFile } from "../lib/format";
import { openedHere } from "../lib/leave";
import { ActionErrorBanner, useAction } from "@/react/rac/form";
import { fetchWithRetry } from "./types";
import { exportCsvContent, pilotToRow, slugify, type CompPilot } from "./csv";
import {
  bareCompId,
  compPilotPath,
  compPilotsCivlFillPath,
  compPilotsImportPath,
} from "../lib/slug";
import { filterPilots, queryWords } from "./pilot-search";
import { groupByTeam, rosterTeams } from "./team-names";
import { PilotList } from "./PilotList";
import { RosterActionsMenu, rosterImportDraft } from "./RosterActions";

type SortBy = "name" | "wprs_points" | "team";
const SORTS: SortBy[] = ["name", "wprs_points", "team"];

/**
 * The roster in the chosen order. WPRS points run highest first — the order
 * the rankings are read in — with unscored pilots last: "no score" is not a
 * very bad one, and an organiser looking for their top seeds should not have
 * to scroll past everyone who has never been ranked.
 *
 * "Team" is a sort with headings: the pilots by name here, then filed under
 * their teams by `groupByTeam()` (comp/team-names.ts). One control rather
 * than a "Group by" beside "Sort": on a phone that is one dropdown, not two,
 * and of the six pairs two would make, team-then-name is the one team work
 * needs.
 */
function sortPilots(pilots: CompPilot[], by: SortBy): CompPilot[] {
  const byName = (a: CompPilot, b: CompPilot) => a.name.localeCompare(b.name);
  if (by === "name" || by === "team") return [...pilots].sort(byName);
  return [...pilots].sort((a, b) => {
    if (a.wprs_points === null && b.wprs_points === null) return byName(a, b);
    if (a.wprs_points === null) return 1;
    if (b.wprs_points === null) return -1;
    return b.wprs_points - a.wprs_points || byName(a, b);
  });
}


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
  // The ⋯ menu's "Add test pilots": its refusal shows under the heading the
  // menu hangs off, never as a toast (rac/form.tsx, `useAction`).
  const addTestAction = useAction();
  // In the URL, so Back from a pilot's page returns the list as it was left.
  // Replaced, never pushed: a keystroke is not a place to go Back to.
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const sortBy: SortBy = SORTS.includes(params.get("sort") as SortBy)
    ? (params.get("sort") as SortBy)
    : "name";
  const setParam = (key: string, value: string, fallback: string) => {
    // From the address bar itself, not the render's copy: a sort and a
    // keystroke a moment apart must not each undo the other.
    const next = new URLSearchParams(window.location.search);
    if (value === fallback) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true, preventScrollReset: true });
  };
  const setQuery = (q: string) => setParam("q", q, "");
  const setSortBy = (v: SortBy) => setParam("sort", v, "name");
  const navigate = useNavigate();


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

  const teams = useMemo(() => rosterTeams(pilots ?? []), [pilots]);
  // "Team" is offered only while some pilot has one: on a roster with none it
  // would file everyone under "No team", which sorts nothing. Removing the
  // last team falls back to names rather than leaving that behind.
  const sort: SortBy = sortBy === "team" && teams.length === 0 ? "name" : sortBy;
  const shown = useMemo(
    () => (pilots ? sortPilots(filterPilots(pilots, query), sort) : []),
    [pilots, query, sort]
  );
  const groups = useMemo(
    () => (sort === "team" && pilots ? groupByTeam(shown, pilots) : undefined),
    [sort, shown, pilots]
  );
  const searching = queryWords(query).length > 0;
  const nobodyMatches = searching && shown.length === 0;
  const typedName = query.trim();

  /**
   * The +: a blank pilot — or, when the search found nobody, one already
   * carrying the name that was searched for.
   */
  const add = () =>
    navigate(
      compPilotPath(compId, compName, "new") +
        (nobodyMatches ? `?${new URLSearchParams({ name: typedName })}` : ""),
      openedHere()
    );

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
    const res = await addTestAction.run(() =>
      api.api.comp[":comp_id"].pilot.bulk.$post({
        param: { comp_id: compId },
        json: { pilots: rows, remove: [] },
      })
    );
    if (!res) return;
    replaceRoster(((await res.json()) as unknown as { pilots: CompPilot[] }).pilots);
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
              onImport={() => {
                // "Import CSV…" always starts at choosing a file: a file
                // chosen earlier and left unapplied is not what was asked for.
                rosterImportDraft.clear([bareCompId(compId)]);
                navigate(compPilotsImportPath(compId, compName), openedHere());
              }}
              onExport={exportCsv}
              onFillCivl={() =>
                navigate(compPilotsCivlFillPath(compId, compName), openedHere())
              }
              onAddTestPilots={() => void addTestPilots()}
            />
          ) : null
        }
      />
      <ActionErrorBanner action={addTestAction} className="mt-2" />

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
          {/* Search and +, sticky at the top of the screen, under the comp's
              section tabs (CompSectionNav, 37px), which stick too — and under
              the site header where that sticks as well (61px, wider screens).
              In a short landscape window neither sticks, so the bar goes to
              the very top. A bar at the bottom had to dodge the keyboard by
              hand; up here the keyboard never reaches it. */}
          <div className="sticky top-[37px] z-20 mt-4 bg-background/90 py-2 backdrop-blur sm:top-[98px] [@media(max-height:500px)]:top-0 print:hidden">
            <div className="flex items-center gap-3">
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
                className="size-12 shrink-0 rounded-full shadow-lg"
              >
                <PlusIcon className="size-6" aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="mt-2 mb-2 flex items-center justify-between gap-3">
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
                value={sort}
                onChange={(v) => setSortBy(v as SortBy)}
                options={[
                  { value: "name", label: "Name" },
                  { value: "wprs_points", label: "WPRS points" },
                  ...(teams.length > 0 ? [{ value: "team", label: "Team" }] : []),
                ]}
              />
            ) : null}
          </div>

          <PilotList
            pilots={shown}
            groups={groups}
            emptyMessage={
              searching
                ? `No pilot matches "${typedName}".`
                : "No pilots registered yet — pilots appear here when the organisers add them or when they submit a track."
            }
            onOpen={(id) => {
              const pilot = pilots.find((p) => p.comp_pilot_id === id);
              if (pilot) {
                navigate(
                  compPilotPath(compId, compName, pilot.comp_pilot_id, pilot.name),
                  openedHere()
                );
              }
            }}
          />
        </>
      )}
    </div>
  );
}
