/**
 * Task route editor — the React replacement for the vanilla
 * analysis/task-editor on the task detail page (#270), and since #637 a
 * ROUTED PAGE (/comp/:c/task/:t/route) rather than a dialog over the task.
 *
 * It was the tallest modal in the app: a map, a turnpoint grid, start gates
 * and a goal panel inside a 100dvh panel that scrolled internally, which on a
 * phone means a scrolling region inside a scrolling region and a sticky title
 * bar spending height that the map wanted. As a page all of that is just the
 * page — one scroll, the browser's own back button, and a URL an organiser can
 * send to a co-admin.
 *
 * A whole route can be set here WITHOUT typing the quick-task syntax (#661).
 * The turnpoint list (comp/TurnpointList.tsx) is the editing surface: a row
 * opens that turnpoint's page, "Add turnpoint" opens the same page for a new
 * one, Delete lives on it, and "Reorder turnpoints" turns the rows into Move
 * up / Move down. The syntax is still here, and still the fast way in for
 * someone who knows the waypoint codes — but behind "Quick entry", on its own
 * page, applied by an explicit press that RECONCILES with the route rather
 * than rebuilding it (comp/route-reconcile.ts).
 *
 * **Everything here is a DRAFT until Save** (comp/route-draft.ts). Since #812
 * the editor is several pages over that one draft — a turnpoint
 * (/route/:n), Quick entry (/route/quick), Load from XContest
 * (/route/xcontest), Add waypoint (/route/add-waypoint) and, since #863, the
 * map at full size (/route/map). The draft is in this tab's storage, so going
 * to one of them and back, or reloading, finds the route as it was left; see
 * comp/use-route-editor.ts for what asks before the work is lost.
 *
 * **The page is for information, and every action is in the bar** (#863).
 * Save is the bar's commit button, live only while the draft differs from the
 * saved route; it was a bar stuck to the bottom of the screen. The row of
 * eleven buttons under the list is the ⋯ menu, with import and export behind
 * one row. "Discard changes" is in ⋯ only while there are changes; Back keeps
 * the draft. "Add turnpoint" stays under the list, where the new turnpoint
 * goes. Reorder is a MODE of the bar: the title names it and the commit
 * button becomes Done.
 *
 * Every derived value (leg distances, crossing direction, the map preview) is
 * a useMemo over the draft's rows rather than an imperative write-back; Start
 * Speed Section gates and goal configuration are edited on the start and goal
 * turnpoints' pages and in collapsible sections below the list, so a whole
 * .xctsk is editable in one place; routes can be imported from a .xctsk file
 * or an XContest task code, copied from another task's saved route
 * (/route/copy, pages/TaskRouteCopyPage.tsx, the same draft again), and
 * exported to a .xctsk file. Saving PATCHes the
 * task's xctsk (the server validates strictly and audit-logs the change), on
 * the kit form, so a refused save says why under the bar.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Maximize2Icon, PlusIcon } from "lucide-react";
import {
  parseXCTaskAsync,
  toXctskJSON,
  type WaypointFileRecord,
  type XCTask,
} from "@glidecomp/engine";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { Button, LinkButton } from "@/react/rac/button";
import { Disclosure } from "@/react/rac/disclosure";
import {
  Form,
  FormErrorBanner,
  SubmitButton,
  refusal,
  type SubmitResponse,
} from "@/react/rac/form";
import { Page, PageBar, commitClass, type BarAction } from "@/react/rac/page-bar";
import { api } from "../../comp/api";
import { openedHere, useLeave } from "../lib/leave";
import { fetchWithRetry } from "./types";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { downloadFile } from "../lib/format";
import { slugify } from "./csv";
import { underTask } from "../lib/crumbs";
import {
  taskPath,
  taskRouteCopyPath,
  taskRouteMapPath,
  taskRouteQuickPath,
  taskRouteTurnpointPath,
  taskRouteXContestPath,
} from "../lib/slug";
import {
  assembleRouteTask,
  parseCoords,
  startConfigSummary,
  turnpointsToCSV,
  xctskForPatch,
} from "./route-editor";
import { TurnpointList } from "./TurnpointList";
import { parseTimeToken } from "./quick-task";
import { inferAddedType, missingAltitude } from "./turnpoint-draft";
import {
  appendBlank,
  clearTurnpoints as clearRows,
  hasTurnpoints,
  isBlankRow,
  moveTurnpoint as moveRow,
  pruneBlankRows,
  type RouteDraft,
} from "./route-draft";
import {
  ADDING_TYPE,
  ROUTE_DISCARD,
  useLoadRoute,
  type RouteEditorState,
} from "./use-route-editor";
import { DraftNotices } from "./DraftNotices";
import { RouteMapPane, useRouteGeometry } from "./RouteMapPane";
import { RouteGoalSettings, RouteStartSettings } from "./RouteSettings";

/** The whole task the draft describes, or the problems that stop it being one. */
function assemble(editor: RouteEditorState, d: RouteDraft) {
  return assembleRouteTask(
    d.rows,
    {
      sssType: d.sssType,
      direction: d.direction,
      gates: d.gates,
      goalType: d.goalType,
      goalDeadline: d.goalDeadline,
      goalElevation: d.goalElevation ?? undefined,
    },
    { openDistance: editor.openDistance, base: d.baseTask, toUtc: editor.toUtcTime }
  );
}

export function RouteEditor({ editor }: { editor: RouteEditorState }) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const leave = useLeave();
  const loadRoute = useLoadRoute(editor);
  const { draft, update, urlId, compName, taskId, taskName, openDistance, tz } = editor;
  const { rows } = draft;
  const taskDate = editor.task?.task_date ?? "";

  // A turnpoint that "Add turnpoint" opened and that was left empty is not a
  // turnpoint: drop it on the way back, as the sheet it replaced dropped an
  // Add dismissed untouched (route-draft.ts, isBlankRow).
  useEffect(() => {
    update(pruneBlankRows);
    // Once, as the page opens: the pages it opens are where rows are made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Into one of the editor's pages, marked so it can come back here by Back.
  const fromHere = openedHere();

  const [fillingAlts, setFillingAlts] = useState(false);

  /**
   * Reorder mode. Rows stop opening their page and carry Move up / Move down
   * instead — a mode rather than per-row chrome, so a list at rest is a name,
   * a summary and a chevron. The bar says which mode it is in: the title is
   * "Reorder" and the commit button is Done.
   */
  const [reordering, setReordering] = useState(false);
  /** The move just made: focus follows the turnpoint (see TurnpointList). */
  const [moved, setMoved] = useState<{
    rowId: number;
    delta: -1 | 1;
    nonce: number;
  } | null>(null);
  /** Said out loud for a screen reader, which sees no rows swap. */
  const [moveNote, setMoveNote] = useState("");

  // Inline "add a missing waypoint" flow. The map goes into add-mode so a tap
  // opens the Add waypoint page, seeded from the tap; the new point drops
  // straight into this route and is written to the competition only when the
  // route is saved.
  const [addMode, setAddMode] = useState(false);
  /** Said under the map: what the last tap on it did. */
  const [mapNote, setMapNote] = useState("");
  const mapSection = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  // The waypoints saved by this Save, for its message.
  const saving = useRef<{ turnpoints: number; newWaypoints: number }>({
    turnpoints: 0,
    newWaypoints: 0,
  });

  /** Validation + derived geometry: legs and directions are read from this. */
  const derived = useRouteGeometry(editor);
  const { errors, warnings } = derived.result;

  const turnpointPath = (id: number) =>
    taskRouteTurnpointPath(urlId, compName, taskId, taskName, id);

  /**
   * "Add turnpoint": a new, empty turnpoint of the type its place implies,
   * and its page to fill it in on. Left empty, it is dropped when this page
   * opens again.
   */
  function addTurnpoint() {
    const type = inferAddedType(rows.filter((r) => !isBlankRow(r)), { openDistance });
    let id = 0;
    update((d) => {
      const added = appendBlank(pruneBlankRows(d), type);
      id = added.id;
      return added.draft;
    });
    void navigate(turnpointPath(id), openedHere({ [ADDING_TYPE]: type }));
  }

  /**
   * Move a turnpoint one place: swap it with its neighbour.
   *
   * The whole of reordering, and deliberately so — see the issue and RAC
   * gotcha #4. It also says what happened, because the only other evidence is
   * two rows changing places, which a screen reader never sees.
   */
  function moveTurnpoint(id: number, delta: -1 | 1) {
    const { draft: next, to } = moveRow(draft, id, delta);
    if (to < 0) return;
    update(() => next);
    const name = String(next.rows[to].name).trim() || "Turnpoint";
    setMoveNote(`${name} moved to ${to + 1} of ${next.rows.length}`);
    setMoved((m) => ({ rowId: id, delta, nonce: (m?.nonce ?? 0) + 1 }));
  }

  // Quick entry needs waypoints to match names against; without any, its page
  // would be a dead end (and the empty state must not point at it).
  const showQuickTask = !editor.wpLoading && editor.waypoints.length > 0;

  async function importFile(file: File | undefined) {
    if (!file) return;
    let parsed: XCTask;
    try {
      parsed = await parseXCTaskAsync(await file.text());
    } catch {
      toast.error(`Could not read ${file.name} — is it a valid .xctsk task file?`);
      return;
    }
    if (parsed.turnpoints.length === 0) {
      toast.error(`${file.name} has no turnpoints`);
      return;
    }
    await loadRoute(parsed, file.name);
  }

  function exportFile() {
    const { task } = assemble(editor, draft);
    if (!task) {
      toast.error("Fix the route problems before exporting");
      return;
    }
    downloadFile(
      `${slugify(taskName)}.xctsk`,
      JSON.stringify(toXctskJSON(task)),
      "application/json"
    );
  }

  /** Export the turnpoints as a competition waypoint CSV file. */
  function exportCsv() {
    if (derived.result.turnpoints.length === 0) {
      toast.error("Add some turnpoints with valid coordinates first");
      return;
    }
    downloadFile(
      `${slugify(taskName)}-waypoints.csv`,
      turnpointsToCSV(derived.result.turnpoints),
      "text/csv"
    );
  }

  // Turnpoints that would get an altitude from "Fill altitudes from the map".
  const fillableAltCount = useMemo(
    () =>
      rows.filter((r) => missingAltitude(r.altitude) && parseCoords(r.coords) !== null)
        .length,
    [rows]
  );

  /**
   * Fill blank turnpoint altitudes with ground elevations from the Mapbox
   * terrain DEM (fetched directly at high zoom — see analysis/elevation.ts for
   * why we don't read them off the live map). Only missing altitudes are
   * touched, and nothing is saved until Save.
   */
  async function fillAltitudes() {
    const targets = rows.flatMap((r) => {
      const c = parseCoords(r.coords);
      return missingAltitude(r.altitude) && c
        ? [{ id: r.id, lat: c.lat, lon: c.lon }]
        : [];
    });
    if (targets.length === 0) return;
    setFillingAlts(true);
    try {
      // Dynamic import: browser-only module, loaded on press.
      const { fetchElevations } = await import("../../analysis/elevation");
      const elevations = await fetchElevations(targets);
      const byId = new Map<number, number>();
      targets.forEach((t, i) => {
        const e = elevations[i];
        if (e !== null) byId.set(t.id, Math.round(e));
      });
      if (byId.size === 0) {
        toast.error("Could not read terrain elevations from Mapbox");
        return;
      }
      // Apply against the draft as it is NOW, and only where the altitude is
      // still missing, so we never clobber a value edited while tiles
      // downloaded.
      let filled = 0;
      update((d) => ({
        ...d,
        rows: d.rows.map((r) => {
          const alt = byId.get(r.id);
          if (alt === undefined || !missingAltitude(r.altitude)) return r;
          filled += 1;
          return { ...r, altitude: alt };
        }),
      }));
      const missed = targets.length - filled;
      toast.success(
        `Filled ${filled} altitude${filled === 1 ? "" : "s"} from the map terrain` +
          (missed > 0 ? ` (${missed} unavailable)` : "")
      );
    } catch {
      toast.error("Could not read terrain elevations from Mapbox");
    } finally {
      setFillingAlts(false);
    }
  }

  /** Empty the turnpoint list (start the route over). */
  async function clearTurnpoints() {
    const ok = await confirm({
      title: "Clear all turnpoints?",
      message:
        "This removes every turnpoint from the editor. Loaded waypoints stay on the map, and nothing is saved until you press Save.",
      confirmLabel: "Clear",
    });
    if (ok) update(clearRows);
  }

  const taskPage = taskPath(urlId, compName, taskId, taskName);

  /**
   * Discard changes: throw the draft away, back to the saved route. Back
   * keeps it (Back means "not now"), so this is the way to discard it on
   * purpose — and it asks first, in the words the guard uses, because a draft
   * can be an afternoon's work restored from storage. The page stays: the
   * route on it is the saved one again.
   */
  async function discardChanges() {
    const ok = await confirm({
      ...ROUTE_DISCARD,
      message: "The route goes back to the one that was last saved.",
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (ok) editor.discard();
  }

  /**
   * Write the waypoints made here to the competition, ahead of the route, so
   * a saved route never names a waypoint that isn't stored. Waypoints are one
   * full-replace set (there's no append endpoint), so re-fetch the freshest
   * set and append these — a waypoint added elsewhere meanwhile isn't
   * clobbered. Audited server-side; not a scoring input.
   */
  async function persistPendingWaypoints(
    pending: WaypointFileRecord[]
  ): Promise<SubmitResponse | null> {
    // No fallback to the list this page loaded: when the freshest set cannot
    // be read, nothing is written. A PUT over a list that failed to arrive
    // replaced the competition's whole set with the new waypoints alone. (A
    // dropped connection throws, which the kit form says in its own words.)
    const res = await fetchWithRetry(() =>
      api.api.comp[":comp_id"].waypoints.$get({ param: { comp_id: editor.compId } })
    );
    if (!res.ok) {
      return refusal(
        "Could not read the competition’s waypoints, so nothing was saved. Try again."
      );
    }
    const base = ((await res.json()) as unknown as { waypoints: WaypointFileRecord[] })
      .waypoints;
    const put = await api.api.comp[":comp_id"].waypoints.$put({
      param: { comp_id: editor.compId },
      json: { waypoints: [...base, ...pending] },
    });
    if (!put.ok) return put;
    // Stored now: out of the draft's pending list, into the saved set, so a
    // retry after a refused route does not add them twice.
    update((d) => ({ ...d, pendingWaypoints: [] }));
    editor.addSavedWaypoints(pending);
    return null;
  }

  async function save(): Promise<SubmitResponse> {
    const { task, errors: problems } = assemble(editor, draft);
    if (!task) return refusal(problems.join(" "));
    const pending = draft.pendingWaypoints;
    if (pending.length > 0) {
      const refused = await persistPendingWaypoints(pending);
      if (refused) return refused;
    }
    saving.current = { turnpoints: task.turnpoints.length, newWaypoints: pending.length };
    return api.api.comp[":comp_id"].task[":task_id"].$patch({
      param: { comp_id: editor.compId, task_id: taskId },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      json: { xctsk: xctskForPatch(task) as any },
    });
  }

  const shownErrors = errors.slice(0, 10);
  const extraErrors = errors.length - shownErrors.length;
  const pendingCount = draft.pendingWaypoints.length;

  // The ⋯ menu: every action of the editor but Add turnpoint, which stays
  // under the list, where the new turnpoint goes.
  const actions: BarAction[] = [
    {
      id: "map",
      label: "New waypoint from the map",
      onAction: () => {
        setAddMode(true);
        // After the menu has closed and given focus back.
        setTimeout(() => mapSection.current?.scrollIntoView({ block: "start" }), 150);
      },
    },
    ...(showQuickTask
      ? [
          {
            id: "quick",
            label: "Quick entry",
            to: taskRouteQuickPath(urlId, compName, taskId, taskName),
          },
        ]
      : []),
    // Two turnpoints is the least that can be in the wrong order.
    ...(rows.length > 1
      ? [{ id: "reorder", label: "Reorder turnpoints", onAction: () => setReordering(true) }]
      : []),
    {
      // Always there so the capability can be found; not available when
      // every turnpoint already has an altitude.
      id: "fill",
      group: true,
      disabled: fillingAlts || fillableAltCount === 0,
      label: fillingAlts
        ? "Filling altitudes…"
        : fillableAltCount > 0
          ? `Fill ${fillableAltCount} altitude${fillableAltCount === 1 ? "" : "s"} from the map`
          : "Fill altitudes from the map",
      onAction: () => void fillAltitudes(),
    },
    {
      // Import and export the whole route: rare, so behind one row.
      id: "transfer",
      label: "Import or export",
      children: [
        { id: "import", label: "Import .xctsk…", onAction: () => fileInput.current?.click() },
        {
          id: "xcontest",
          label: "Load from XContest",
          to: taskRouteXContestPath(urlId, compName, taskId, taskName),
        },
        {
          id: "copy",
          label: "Copy from another competition…",
          to: taskRouteCopyPath(urlId, compName, taskId, taskName),
        },
        { id: "xctsk", label: "Export .xctsk", group: true, onAction: exportFile },
        { id: "csv", label: "Export .csv", onAction: exportCsv },
      ],
    },
    {
      id: "clear",
      label: "Clear turnpoints",
      destructive: true,
      group: true,
      disabled: !hasTurnpoints(draft),
      onAction: () => void clearTurnpoints(),
    },
    // Only while there is something to discard.
    ...(editor.dirty
      ? [
          {
            id: "discard",
            label: "Discard changes",
            destructive: true,
            onAction: () => void discardChanges(),
          },
        ]
      : []),
  ];

  return (
    <>
      <Page
        className="flex flex-col gap-5"
        bar={
          // The form is the bar and the refusal under it, and nothing else:
          // with the whole page inside it, Enter in the map's place search
          // would be Save. `contents`, so the bar still sticks to the page
          // and not to the form.
          <Form
            className="contents"
            onSubmit={save}
            onPendingChange={editor.setSaving}
            onSuccess={() => {
              const { turnpoints, newWaypoints } = saving.current;
              editor.markSaved();
              const wpNote =
                newWaypoints > 0
                  ? ` · ${newWaypoints} new waypoint${newWaypoints === 1 ? "" : "s"} added to the competition`
                  : "";
              toast.success(
                `Route saved: ${turnpoints} turnpoint${turnpoints === 1 ? "" : "s"}${wpNote} — scores will recompute`
              );
              // The task page is where the route is read.
              leave(taskPage);
            }}
          >
            <PageBar
              title={reordering ? "Reorder" : "Route"}
              fullTitle="Route"
              trail={underTask(urlId, compName, taskId, taskName)}
              actions={reordering ? [] : actions}
              commit={
                reordering ? (
                  <Button
                    className={commitClass}
                    onPress={() => {
                      setReordering(false);
                      setMoved(null);
                    }}
                  >
                    Done
                  </Button>
                ) : (
                  <SubmitButton
                    className={commitClass}
                    isDisabled={!editor.dirty || errors.length > 0}
                    pendingLabel="Saving"
                  >
                    Save
                  </SubmitButton>
                )
              }
            />
            <FormErrorBanner className="mx-auto w-full max-w-3xl px-gutter-safe pt-3" />
          </Form>
        }
      >
        {/* role=status so the state change is announced. */}
        <p role="status" className="px-1 text-sm text-muted-foreground">
          {reordering
            ? "Move turnpoints up or down, then press Done."
            : editor.dirty
              ? "Unsaved changes. Nothing is saved until you press Save."
              : "This is the saved route."}
        </p>

        {/* The quick-task grammar is no longer the first thing this page says:
            it moved, verbatim, onto the Quick entry page that uses it (#661). A
            first-time scorer meets a list of turnpoints. */}
        {openDistance ? (
          <p className="text-sm text-muted-foreground">
            Open distance: one Takeoff turnpoint, no goal. Scored from the
            take-off exit.
          </p>
        ) : null}

        {/* The saved route moved under a draft with edits in it: another
            organiser (or another tab) saved meanwhile. The draft is the
            reader's work and stays; Save would replace what they saved. */}
        <DraftNotices
          serverChanged={editor.serverChanged}
          notKept={editor.notKept}
          changed="The saved route has changed since these edits were started. Saving replaces it with the route below."
        />
        {/* Not "this competition has no waypoints" (#481): they failed to
            arrive, and saying so is the difference. */}
        {editor.wpError ? (
          <Alert variant="destructive">
            <AlertDescription>
              Could not load the competition’s waypoints, so none can be picked for this route.
              Reload the page to try again.
            </AlertDescription>
          </Alert>
        ) : null}

        {/* The turnpoint list — the editor's own (comp/TurnpointList.tsx), not
            the read-only listing the task page shows: rows here open the
            turnpoint's page, and in Reorder mode they carry Move up / Move
            down, at a size a finger can hit. */}
        <div className="flex flex-col gap-2 [&_[data-move-row]]:size-11">
          {rows.length > 0 ? (
            <TurnpointList
              rows={rows}
              task={derived.mapTask}
              rowIds={derived.result.rowIds}
              reordering={reordering}
              moved={moved}
              onOpen={(id) => void navigate(turnpointPath(id), fromHere)}
              onMove={moveTurnpoint}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              {showQuickTask
                ? "No turnpoints yet. Add them one at a time, tap a waypoint on the map, or use Quick entry in ⋯ to type the whole route."
                : "No turnpoints yet — use Add turnpoint, or import a task"}
            </p>
          )}
          {/* Reordering is the only thing said out loud: rows swapping places
              is invisible to a screen reader, and to anyone whose focus is on
              the button that did it. */}
          <p role="status" aria-live="polite" className="sr-only">
            {moveNote}
          </p>
          {/* Where the new turnpoint goes, so not in ⋯. */}
          {reordering ? null : (
            <Button
              variant="outline"
              className="h-11 justify-start gap-2 px-4"
              onPress={addTurnpoint}
            >
              <PlusIcon className="size-4" aria-hidden />
              Add turnpoint
            </Button>
          )}
          <p className="px-1 text-xs text-muted-foreground">
            Enter or exit is worked out from the route: a cylinder containing
            the previous point is an exit.
          </p>
        </div>

        {!openDistance ? (
          <>
            {/* Collapsed by default — the defaults suit most competitions. The
                badge is why that's safe: it reads the live configuration back
                on the header row, so an exit start (or a gate list) is never
                something you'd have to expand the panel to discover (#436).
                Same sentence the task page prints, from the same helper. The
                same controls also sit on the start and goal turnpoints' pages,
                which is where an organiser opening that cylinder looks. */}
            <Disclosure
              title="Start Speed Section (SSS)"
              headingLevel={2}
              badge={
                <span className="text-xs font-normal text-muted-foreground">
                  {startConfigSummary(
                    {
                      type: draft.sssType,
                      direction: draft.direction,
                      timeGates: draft.gates.flatMap((g) =>
                        parseTimeToken(g) !== null ? [`${editor.toUtcTime(g)}:00Z`] : []
                      ),
                    },
                    { timeZone: tz, taskDate }
                  )}
                </span>
              }
            >
              <RouteStartSettings editor={editor} missingSssWarning={!derived.hasSSSTurnpoint} />
            </Disclosure>

            <Disclosure title="Goal" headingLevel={2}>
              <RouteGoalSettings editor={editor} />
            </Disclosure>
          </>
        ) : null}

        {/* Map preview — below the list, showing the optimised route as it's
            edited. Tap a waypoint to add it, or (with "New waypoint from the
            map" in ⋯) tap empty space to make a new one, added to the
            competition when the route is saved. A drag on the map moves the
            map; a drag beside it scrolls the page. `scroll-mt` is the bar's
            height, for the scroll that ⋯ row makes. */}
        <section ref={mapSection} aria-label="Map" className="flex scroll-mt-20 flex-col gap-2">
          <RouteMapPane
            editor={editor}
            mapTask={derived.mapTask}
            addMode={addMode}
            setAddMode={setAddMode}
            onNote={setMapNote}
            className="flex h-80 flex-col overflow-hidden rounded-xl border border-border sm:h-96"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {/* Here, not in ⋯: it is this map, made larger. */}
            <LinkButton
              href={taskRouteMapPath(urlId, compName, taskId, taskName)}
              routerOptions={fromHere}
              variant="outline"
              className="h-11 gap-2 px-4"
            >
              <Maximize2Icon className="size-4" aria-hidden />
              Map at full size
            </LinkButton>
            <p role="status" className="text-sm text-muted-foreground">
              {mapNote ||
                (pendingCount > 0
                  ? `${pendingCount} new waypoint${pendingCount === 1 ? "" : "s"}, saved to the competition with the route.`
                  : "Tap a waypoint to add it to the route.")}
            </p>
          </div>
        </section>

        {shownErrors.length > 0 ? (
          <ul className="list-disc pl-5 text-sm text-danger">
            {shownErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
            {extraErrors > 0 ? <li>… and {extraErrors} more</li> : null}
          </ul>
        ) : null}
        {warnings.length > 0 ? (
          <ul className="text-sm text-caution">
            {warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        ) : null}
      </Page>

      {/* "Import .xctsk…" in ⋯ opens this: a menu row cannot be a file input. */}
      <input
        ref={fileInput}
        type="file"
        accept=".xctsk"
        className="hidden"
        aria-label="Import a .xctsk file"
        onChange={(e) => {
          void importFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </>
  );
}
