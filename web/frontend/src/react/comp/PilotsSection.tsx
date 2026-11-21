/**
 * The pilots page's roster editor (/comp/:id/pilots, admin-only): a LIST of
 * pilots, each opening that pilot's own page, under the page's bar: its +
 * and ⋯, and the search box and the sort that stick with it as the list
 * scrolls (rac/page-bar.tsx, issue #863).
 *
 * Mobile first (see the rule in docs/interaction-guide.md). It replaced a read-only RAC table
 * and, behind an Edit button, a fourteen-column Tabulator grid in a dialog —
 * at every width, not below a breakpoint, for the reason the waypoints page
 * gives (comp/WaypointList.tsx): two editors are two code paths. What each
 * piece is for:
 *
 *   - comp/PilotList.tsx — a row per pilot: name, then class · glider ·
 *     points · whether their tracks can find them.
 *   - pages/CompPilotPage.tsx (form: comp/PilotForm.tsx) — one pilot, on a
 *     page of its own, saved the moment its Save is pressed. Nothing on this
 *     page waits for a page-level Save, so there is none.
 *   - The search — in the bar's second layer, with the sort beside it. It sat
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
 *   - The bar's ⋯ — copy from another competition, the CIVL fill, CSV import
 *     and export, test pilots. The copy, the fill and the import are pages of
 *     their own (/pilots/copy, /pilots/civl-fill, /pilots/import; the last
 *     two are comp/RosterActions.tsx), each previewing what it will write.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Badge } from "@/react/rac/badge";
import { SearchField } from "@/react/rac/field";
import { Page, PageBar, type BarAction } from "@/react/rac/page-bar";
import { Loading, Spinner } from "@/react/rac/progress";
import { SimpleSelect } from "@/react/rac/select";
import { compPages, underComp } from "../lib/crumbs";
import { api } from "../../comp/api";
import { downloadFile } from "../lib/format";
import { ActionErrorBanner, useAction } from "@/react/rac/form";
import { fetchWithRetry } from "./types";
import { exportCsvContent, pilotToRow, slugify, type CompPilot } from "./csv";
import {
  bareCompId,
  compPilotPath,
  compPilotsCivlFillPath,
  compPilotsCopyPath,
  compPilotsImportPath,
} from "../lib/slug";
import { filterPilots, queryWords } from "./pilot-search";
import { groupByTeam, rosterTeams } from "./team-names";
import { PilotList } from "./PilotList";
import { rosterImportDraft } from "./RosterActions";
import {
  CopyIcon,
  FileSpreadsheetIcon,
  FlaskConicalIcon,
  IdCardIcon,
  ImportIcon,
} from "lucide-react";

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
  comp,
}: {
  compId: string;
  /** The competition: its name and classes, whether a pilot can join it by
   *  submitting a track, and what the title's menu needs (lib/crumbs.ts). */
  comp: {
    name: string;
    pilot_classes: string[];
    open_registration?: boolean;
    scoring_format?: string | null;
  };
}) {
  const compName = comp.name;
  const compClasses = comp.pilot_classes;
  const openRegistration = comp.open_registration;
  const [pilots, setPilots] = useState<CompPilot[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  // The ⋯ menu's "Add test pilots": its refusal shows first on the page,
  // under the bar the menu hangs off, never as a toast (rac/form.tsx,
  // `useAction`).
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
   * carrying the name that was searched for. A link, which the bar marks as
   * opened here (lib/leave.ts), so Back returns the list as it was left.
   */
  const add = pilots
    ? {
        label: nobodyMatches ? `Add a pilot named ${typedName}` : "Add pilot",
        to:
          compPilotPath(compId, compName, "new") +
          (nobodyMatches ? `?${new URLSearchParams({ name: typedName })}` : ""),
      }
    : undefined;

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

  // The trailing "…" marks an action that asks something before it acts
  // (see ScoresDownload's "Open in Google Sheets…").
  const actions: BarAction[] = pilots
    ? [
        {
          id: "copy",
          icon: CopyIcon,
          label: "Copy from another competition…",
          to: compPilotsCopyPath(compId, compName),
        },
        {
          id: "civl-fill",
          icon: IdCardIcon,
          label: "Fill from CIVL…",
          to: compPilotsCivlFillPath(compId, compName),
        },
        {
          id: "import",
          icon: ImportIcon,
          label: "Import CSV…",
          group: true,
          onAction: () => {
            // "Import CSV…" always starts at choosing a file: a file chosen
            // earlier and left unapplied is not what was asked for.
            rosterImportDraft.clear([bareCompId(compId)]);
            navigate(compPilotsImportPath(compId, compName));
          },
        },
        { id: "export", icon: FileSpreadsheetIcon, label: "Export CSV", onAction: exportCsv },
        {
          id: "test-pilots",
          icon: FlaskConicalIcon,
          label: "Add test pilots",
          group: true,
          disabled: addTestAction.pending,
          onAction: () => void addTestPilots(),
        },
      ]
    : [];

  return (
    <Page
      bar={
        <PageBar
          title="Pilots"
          trail={underComp(compId, compName)}
          related={compPages(compId, comp, true, "Pilots")}
          add={add}
          actions={actions}
          status={addTestAction.pending ? <Spinner label="Adding test pilots" /> : undefined}
          below={
            // Search and sort stick with the bar. A bar at the bottom had to
            // dodge the keyboard by hand; up here the keyboard never reaches it.
            <div className="flex items-center gap-2">
              <SearchField
                variant="floating"
                aria-label="Find a pilot"
                placeholder="Find a pilot"
                value={query}
                onChange={setQuery}
                className="min-w-0 flex-1"
              />
              {pilots && pilots.length > 1 ? (
                <SimpleSelect
                  label="Sort"
                  // Label beside the control, not above it: one line for one word.
                  className="shrink-0 flex-row items-center"
                  // As tall as the search field beside it, and no wider than
                  // its own words: a phone has the two side by side.
                  triggerClassName="h-12 min-w-0 rounded-full bg-card/95 pr-3 pl-4 text-base shadow-lg backdrop-blur-sm pointer-coarse:h-12 dark:bg-card/95"
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
          }
        />
      }
    >
      <ActionErrorBanner action={addTestAction} className="mb-3" />

      {/* Whether this list can grow on its own. It used to be true of every
          competition with nothing anywhere to say so — an organiser reading
          their own roster could not tell that anyone signed in could join it.
          This is the list the answer belongs to, because this is the list that
          changes. */}
      {openRegistration !== undefined ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
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
          {/* How many there are — the bar's title is the page's name alone —
              and, while a search narrows the list, how many of them it shows.
              Always in the DOM, so a screen reader hears the count change. */}
          <p role="status" className="mt-4 mb-2 text-sm text-muted-foreground">
            {searching
              ? `${shown.length} of ${pilots.length} pilots`
              : pilots.length > 0
                ? `${pilots.length} ${pilots.length === 1 ? "pilot" : "pilots"}`
                : ""}
          </p>

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
                  compPilotPath(compId, compName, pilot.comp_pilot_id, pilot.name));
              }
            }}
          />
        </>
      )}
    </Page>
  );
}
