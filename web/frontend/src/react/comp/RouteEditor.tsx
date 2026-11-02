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
 * one, Delete lives on it, and "Reorder" turns the rows into Move up / Move
 * down. The syntax is still here, and still the fast way in for someone who
 * knows the waypoint codes — but behind a "Quick entry" button, on its own
 * page, applied by an explicit press that RECONCILES with the route rather
 * than rebuilding it (comp/route-reconcile.ts).
 *
 * **Everything here is a DRAFT until Save** (comp/route-draft.ts). Since #812
 * the editor is several pages over that one draft — a turnpoint
 * (/route/:n), Quick entry (/route/quick), Load from XContest
 * (/route/xcontest) and Add waypoint (/route/add-waypoint) were a full-screen
 * sheet each, or a dialog, until the overlays rule in CLAUDE.md made them
 * pages. The draft is in this tab's storage, so going to one of them and
 * back, or reloading, finds the route as it was left; see
 * comp/use-route-editor.ts for what asks before the work is lost.
 *
 * Every derived value (leg distances, crossing direction, the map preview) is
 * a useMemo over the draft's rows rather than an imperative write-back; Start
 * Speed Section gates and goal configuration are edited on the start and goal
 * turnpoints' pages and in collapsible sections below the list, so a whole
 * .xctsk is editable in one place; routes can be imported from a .xctsk file
 * or an XContest task code, and exported to a .xctsk file. Saving PATCHes the
 * task's xctsk (the server validates strictly and audit-logs the change), on
 * the kit form, so a refused save says why beside Save.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { FileTrigger } from "react-aria-components";
import {
  parseXCTaskAsync,
  toXctskJSON,
  type WaypointFileRecord,
  type XCTask,
} from "@glidecomp/engine";
import type { MapWaypoint } from "../../analysis/map-provider";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { Button, ToggleButton } from "@/react/rac/button";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Disclosure } from "@/react/rac/disclosure";
import { Form, FormErrorBanner, SubmitButton, type SubmitResponse } from "@/react/rac/form";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { downloadFile } from "../lib/format";
import { slugify } from "./csv";
import { underTask } from "../lib/crumbs";
import {
  taskPath,
  taskRouteAddWaypointPath,
  taskRouteQuickPath,
  taskRouteTurnpointPath,
  taskRouteXContestPath,
} from "../lib/slug";
import {
  assembleRouteTask,
  buildRoute,
  parseCoords,
  startConfigSummary,
  turnpointsToCSV,
  xctskForPatch,
} from "./route-editor";
import { TurnpointList } from "./TurnpointList";
import { parseTimeToken } from "./quick-task";
import { draftFromRecord, inferAddedType, missingAltitude } from "./turnpoint-draft";
import { newWaypointSearch } from "./AddWaypointForm";
import {
  appendBlank,
  appendTurnpoint,
  clearTurnpoints as clearRows,
  hasTurnpoints,
  isBlankRow,
  moveTurnpoint as moveRow,
  pruneBlankRows,
  type RouteDraft,
} from "./route-draft";
import {
  ADDING_TYPE,
  FROM_ROUTE,
  useLoadRoute,
  type RouteEditorState,
} from "./use-route-editor";
import { RouteGoalSettings, RouteStartSettings } from "./RouteSettings";

// Lazy so the map library (mapbox) and its CSS load only when the editor
// opens and never enter the SSR'd task-detail bundle.
const RouteMap = lazy(() => import("./RouteMap"));

/** A refusal the page decided itself, in the shape the kit form reads. */
function refusal(message: string): SubmitResponse {
  return new Response(JSON.stringify({ error: message }), {
    status: 422,
    headers: { "Content-Type": "application/json" },
  });
}

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
  const fromHere = { state: { [FROM_ROUTE]: true } };

  const [fillingAlts, setFillingAlts] = useState(false);

  /**
   * Reorder mode. Rows stop opening their page and carry Move up / Move down
   * instead — a mode rather than per-row chrome, so a list at rest is a name,
   * a summary and a chevron.
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
  const [wpFitNonce, setWpFitNonce] = useState(0);
  // Fit the map to the waypoints once they have arrived.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || editor.wpLoading) return;
    fitted.current = true;
    setWpFitNonce((n) => n + 1);
  }, [editor.wpLoading]);

  // The waypoints saved by this Save, for its message.
  const saving = useRef<{ turnpoints: number; newWaypoints: number }>({
    turnpoints: 0,
    newWaypoints: 0,
  });

  /**
   * Validation + derived geometry, recomputed whenever the rows or the start
   * and goal settings change: legs and directions are read straight from this
   * memo at render time.
   */
  const derived = useMemo(() => {
    const result = buildRoute(rows, { openDistance });
    const hasSSSTurnpoint = result.turnpoints.some((tp) => tp.type === "SSS");

    // The goal config shapes the preview and the distances: a LINE goal is
    // drawn as the goal line + control semicircle, and the optimised route
    // ends on the line instead of the cylinder edge. Open-distance comps
    // hide the goal panel, so carry whatever the loaded task had.
    const goal = openDistance ? draft.baseTask?.goal : { type: draft.goalType };

    // Feed the map the turnpoints parsed so far — cylinders and the optimised
    // line update live as rows are edited, added, reordered or picked.
    const mapTask: XCTask | null =
      result.turnpoints.length > 0
        ? {
            taskType: draft.baseTask?.taskType || "CLASSIC",
            version: draft.baseTask?.version ?? 1,
            turnpoints: result.turnpoints,
            // The start's direction feeds the Enter/Exit inference the
            // turnpoint listing shows, so flipping it updates the list live.
            ...(openDistance ? {} : { sss: { type: draft.sssType, direction: draft.direction } }),
            ...(goal ? { goal } : {}),
          }
        : null;

    return { result, hasSSSTurnpoint, mapTask };
  }, [rows, openDistance, draft.baseTask, draft.goalType, draft.sssType, draft.direction]);

  const { errors, warnings } = derived.result;

  // Competition waypoints as map markers (index is the marker id, resolved
  // back to the record on pick so all details carry across).
  const waypointRecords = editor.waypoints;
  const mapWaypoints: MapWaypoint[] = useMemo(
    () =>
      waypointRecords.map((w, i) => ({
        id: String(i),
        code: w.code,
        name: w.name,
        lat: w.latitude,
        lon: w.longitude,
      })),
    [waypointRecords]
  );

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
    navigate(turnpointPath(id), { state: { [FROM_ROUTE]: true, [ADDING_TYPE]: type } });
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
  const showQuickTask = !editor.wpLoading && waypointRecords.length > 0;

  /** Pick from the map: the nearest marker, resolved to its record by id, and
   *  appended straight to the route (a map tap is an explicit add). */
  function pickWaypoint(wp: MapWaypoint) {
    const rec: WaypointFileRecord | undefined = waypointRecords[Number(wp.id)];
    if (!rec) return;
    update(
      (d) =>
        appendTurnpoint(d, {
          ...draftFromRecord(rec),
          type: inferAddedType(d.rows, { openDistance }),
        }).draft
    );
  }

  async function importFile(files: FileList | null) {
    const file = files?.[0];
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
    const result = buildRoute(rows, { openDistance });
    if (result.turnpoints.length === 0) {
      toast.error("Add some turnpoints with valid coordinates first");
      return;
    }
    downloadFile(
      `${slugify(taskName)}-waypoints.csv`,
      turnpointsToCSV(result.turnpoints),
      "text/csv"
    );
  }

  // Turnpoints that would get an altitude from "Fill altitudes from map".
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
    if (hasTurnpoints(draft)) {
      const ok = await confirm({
        title: "Clear all turnpoints?",
        message:
          "This removes every turnpoint from the editor. Loaded waypoints stay on the map, and nothing is saved until you press Save.",
        confirmLabel: "Clear",
      });
      if (!ok) return;
    }
    update(clearRows);
  }

  const taskPage = taskPath(urlId, compName, taskId, taskName);

  /**
   * Cancel: throw the draft away and go back to the task. Back would keep it
   * (Back means "not now"), so this is the way to discard it on purpose — and
   * it asks first, in the words the guard uses, because a draft can be an
   * afternoon's work restored from storage.
   */
  async function cancel() {
    if (editor.dirty) {
      const ok = await confirm({
        title: "Discard route changes?",
        message: "This route has unsaved changes. Leaving will discard them.",
        confirmLabel: "Discard changes",
        cancelLabel: "Keep editing",
        destructive: true,
      });
      if (!ok) return;
    }
    editor.discard();
    navigate(taskPage);
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
    let base = editor.savedWaypoints;
    try {
      const res = await api.api.comp[":comp_id"].waypoints.$get({
        param: { comp_id: editor.compId },
      });
      if (res.ok) {
        base = ((await res.json()) as unknown as { waypoints: WaypointFileRecord[] }).waypoints;
      }
    } catch {
      /* fall back to the list we already loaded */
    }
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

  return (
    // Wider than a settings form on purpose: the map and the turnpoint list
    // are the page, and `SettingsPage`'s max-w-2xl column would squeeze both.
    // The breadcrumb + title are built here rather than reusing SettingsPage
    // for the same reason.
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div>
        <Breadcrumbs items={underTask(urlId, compName, taskId, taskName)} current="Route" />
        <h1 className="mt-2 text-2xl font-bold">Route</h1>
      </div>
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
      {editor.serverChanged ? (
        <Alert>
          <AlertDescription>
            The saved route has changed since these edits were started. Saving
            replaces it with the route below.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* The turnpoint list — the editor's own (comp/TurnpointList.tsx), not
          the read-only listing the task page shows: rows here open the
          turnpoint's page, and in Reorder mode they carry Move up / Move
          down. */}
      <div className="flex flex-col gap-2">
        {rows.length > 0 ? (
          <TurnpointList
            rows={rows}
            task={derived.mapTask}
            rowIds={derived.result.rowIds}
            reordering={reordering}
            moved={moved}
            onOpen={(id) => navigate(turnpointPath(id), fromHere)}
            onMove={moveTurnpoint}
          />
        ) : (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {showQuickTask
              ? "No turnpoints yet — add them one at a time, or use Quick entry to type the whole route."
              : "No turnpoints yet — use Add turnpoint, or import a task"}
          </p>
        )}
        {/* Reordering is the only thing said out loud: rows swapping places
            is invisible to a screen reader, and to anyone whose focus is on
            the button that did it. */}
        <p role="status" aria-live="polite" className="sr-only">
          {moveNote}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onPress={addTurnpoint}>
            Add turnpoint
          </Button>
          {/* Two turnpoints is the least that can be in the wrong order. */}
          {rows.length > 1 ? (
            <ToggleButton
              size="sm"
              isSelected={reordering}
              onChange={(on) => {
                setReordering(on);
                if (!on) setMoved(null);
              }}
            >
              {reordering ? "Done reordering" : "Reorder"}
            </ToggleButton>
          ) : null}
          {showQuickTask ? (
            <Button
              variant="outline"
              size="sm"
              onPress={() =>
                navigate(taskRouteQuickPath(urlId, compName, taskId, taskName), fromHere)
              }
            >
              Quick entry
            </Button>
          ) : null}
          <Button variant="outline" size="sm" onPress={() => void clearTurnpoints()}>
            Clear turnpoints
          </Button>
          {/* Always visible so the capability is discoverable; disabled when
              every turnpoint already has an altitude. */}
          <Button
            variant="outline"
            size="sm"
            isDisabled={fillingAlts || fillableAltCount === 0}
            onPress={() => void fillAltitudes()}
          >
            {fillingAlts
              ? "Filling altitudes…"
              : fillableAltCount > 0
                ? `Fill ${fillableAltCount} altitude${fillableAltCount === 1 ? "" : "s"} from map`
                : "Fill altitudes from map"}
          </Button>
          {/* Import / export the whole route. */}
          <FileTrigger
            acceptedFileTypes={[".xctsk"]}
            onSelect={(files) => void importFile(files)}
          >
            <Button variant="outline" size="sm">
              Import .xctsk
            </Button>
          </FileTrigger>
          <Button
            variant="outline"
            size="sm"
            onPress={() =>
              navigate(taskRouteXContestPath(urlId, compName, taskId, taskName), fromHere)
            }
          >
            Load from XContest
          </Button>
          <Button variant="outline" size="sm" onPress={exportFile}>
            Export .xctsk
          </Button>
          <Button variant="outline" size="sm" onPress={exportCsv}>
            Export .csv
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
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
          edited. Tap a waypoint to add it, or (with Add from map on) tap empty
          space to make a new one (added to the competition when the route is
          saved). */}
      <div className="flex flex-col gap-2">
        <div className="h-64 overflow-hidden rounded border border-border sm:h-72 lg:h-96">
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                Loading map…
              </div>
            }
          >
            <RouteMap
              task={derived.mapTask}
              waypoints={mapWaypoints}
              addMode={addMode}
              fitNonce={wpFitNonce}
              placeSearch
              onWaypointPick={pickWaypoint}
              onMapPick={(lat, lon, details) => {
                // Leaving add-mode on would keep the crosshair when this page
                // comes back, so turn it off on the way out.
                setAddMode(false);
                navigate(
                  taskRouteAddWaypointPath(
                    urlId,
                    compName,
                    taskId,
                    taskName,
                    newWaypointSearch(lat, lon, details)
                  ),
                  fromHere
                );
              }}
            />
          </Suspense>
        </div>
        {/* Create a competition waypoint by tapping the map: the tap seeds a
            form (place name, terrain elevation, nearest peak) and, once
            confirmed, drops into the route and is saved to the competition. */}
        <div className="flex flex-wrap items-center gap-2">
          <ToggleButton size="sm" isSelected={addMode} onChange={setAddMode}>
            {addMode ? "Tap the map to place a waypoint…" : "Add from map"}
          </ToggleButton>
          {pendingCount > 0 ? (
            <span className="text-xs text-muted-foreground">
              {pendingCount} new — saved to the competition when you save the route
            </span>
          ) : null}
        </div>
      </div>

      {shownErrors.length > 0 ? (
        <ul className="list-disc pl-5 text-sm text-destructive">
          {shownErrors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
          {extraErrors > 0 ? <li>… and {extraErrors} more</li> : null}
        </ul>
      ) : null}
      {warnings.length > 0 ? (
        <ul className="text-sm text-amber-500">
          {warnings.map((w, i) => (
            <li key={i}>⚠ {w}</li>
          ))}
        </ul>
      ) : null}

      {/* Sticky to the BOTTOM OF THE SCREEN while the page is on it: this page
          is long, and a Save an admin has to scroll past the whole goal panel
          to reach is a Save they will not find on a phone. Sticky, not fixed:
          a fixed bar has to be moved around the keyboard by hand (the
          overlays rule in CLAUDE.md).

          A kit form, so a refused save says why beside Save rather than in a
          toast. Bottom chrome touching the viewport edge, so the background
          is full-bleed while the buttons clear the home indicator. */}
      <Form
        className="sticky bottom-0 z-20 border-t border-border bg-background/95 pt-3 pb-gutter-safe backdrop-blur-sm"
        onSubmit={save}
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
          navigate(taskPage);
        }}
      >
        <FormErrorBanner className="mb-3" />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {/* role=status so the state change is announced. */}
          <span role="status" className="mr-auto text-sm text-muted-foreground">
            {editor.dirty ? "Unsaved changes" : ""}
          </span>
          <Button variant="outline" onPress={() => void cancel()}>
            Cancel
          </Button>
          <SubmitButton isDisabled={errors.length > 0}>Save</SubmitButton>
        </div>
      </Form>
    </div>
  );
}
