/**
 * The prototype's route editor (/proto): the real one, under the page bar.
 *
 * Everything that IS the route editor is the app's own code, run on the
 * bundled Corryong Cup sample's real coordinates: the map (comp/RouteMap), the
 * turnpoint list with its Reorder mode (comp/TurnpointList), the start and
 * goal panels, Quick entry's field, the Add waypoint fields, and the draft
 * model with its validation (comp/route-draft, comp/route-editor). Only the
 * page chrome is new, which is the thing being tried:
 *
 * - Save is the bar's commit button, where it was a bar stuck to the bottom.
 * - Cancel is "Discard changes" in ⋯, and only while there are changes. Back
 *   keeps the draft, as it does today.
 * - The row of eleven buttons under the list is ⋯, with import and export
 *   behind one row. "Add turnpoint" stays under the list, where the new
 *   turnpoint goes.
 * - Reorder is a mode of the bar: the title names the mode and the trailing
 *   slot holds Done. Done is quiet, here and on a turnpoint's page, because it
 *   writes nothing: only Save does.
 *
 * Nothing is sent anywhere: Save remembers the route for this visit. Load
 * from XContest and Copy from another competition need the API and only say
 * so.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useFilter } from "react-aria-components";
import {
  parseXCTaskAsync,
  toXctskJSON,
  type WaypointFileRecord,
  type XCTask,
} from "@glidecomp/engine";
import { Maximize2Icon, PlusIcon } from "lucide-react";
import type { MapWaypoint } from "../../analysis/map-provider";
import { Button, LinkButton, ToggleButton } from "@/react/rac/button";
import { ChoiceList } from "@/react/rac/choice-list";
import { Disclosure } from "@/react/rac/disclosure";
import { NumberField, SearchField, TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton, refusal } from "@/react/rac/form";
import { ListBox, ListBoxItem } from "@/react/rac/list-box";
import {
  AddWaypointFields,
  buildNewWaypoint,
  newWaypointProblems,
  newWaypointSearch,
  readNewWaypointSeed,
  useNewWaypoint,
} from "../comp/AddWaypointForm";
import { slugify } from "../comp/csv";
import { AltitudeField, CoordsField, coordsProblems } from "../comp/fields";
import { GoalSettings } from "../comp/GoalSettings";
import { QuickTaskField } from "../comp/QuickTaskField";
import { parseTimeToken, quickTaskApply, quickTaskText } from "../comp/quick-task";
import {
  addNewWaypoint,
  appendBlank,
  appendTurnpoint,
  applyQuickEntry,
  clearTurnpoints,
  editTurnpoint,
  hasTurnpoints,
  isBlankRow,
  loadTask,
  moveTurnpoint,
  pruneBlankRows,
  removeTurnpoint,
  type RouteDraft,
} from "../comp/route-draft";
import {
  addMinutes,
  assembleRouteTask,
  buildRoute,
  parseCoords,
  startConfigSummary,
  turnpointsToCSV,
  type RouteRow,
} from "../comp/route-editor";
import { StartSettings } from "../comp/StartSettings";
import {
  NEW_ROW_RADIUS,
  RADIUS_PRESETS,
  draftFromRecord,
  draftWithRecord,
  inferAddedType,
  missingAltitude,
  radiusChipLabel,
  showGoalSettings,
  typeOptions,
  type TurnpointDraft,
} from "../comp/turnpoint-draft";
import { TurnpointList } from "../comp/TurnpointList";
import { useConfirm } from "../lib/confirm";
import { downloadFile } from "../lib/format";
import { openedHere, useLeave } from "../lib/leave";
import { toast } from "../lib/toast";
import { COMP, P, TASKS, accepted } from "./fixtures";
import {
  DoneButton,
  PageBar,
  ProtoPage,
  commitClass,
  pageClass,
  type BarAction,
  type Crumb,
} from "./PageBar";
import { Missing } from "./ProtoIndex";
import { stub } from "./parts";
import { discardRoute, routeTimes, saveRoute, useRoute } from "./route-store";

// Lazy, as in the app: the map library loads when a page with a map opens.
const RouteMap = lazy(() => import("../comp/RouteMap"));

/** History state the Add turnpoint page reads: the Type the new row started as. */
const ADDING_TYPE = "addingType";

/** What every page of the route editor shares: the task, its draft and its clock. */
function useScenario() {
  const { taskId = "" } = useParams();
  const task = TASKS.find((t) => t.id === taskId) ?? null;
  const route = useRoute(taskId);
  const times = useMemo(() => routeTimes(taskId), [taskId]);
  const taskPath = `${COMP.path}/task/${taskId}`;
  const routePath = `${taskPath}/route`;
  const trail: Crumb[] = [
    { label: "Competitions", to: `${P}/comp` },
    { label: COMP.name, to: COMP.path },
    { label: task?.name ?? "Task", to: taskPath },
  ];
  return {
    task,
    taskId,
    taskPath,
    routePath,
    trail,
    routeTrail: [...trail, { label: "Route", to: routePath }],
    ...route,
    ...times,
  };
}

type Scenario = ReturnType<typeof useScenario>;

/** The route as parsed so far: its problems, and the task the map and the list draw. */
function useDerived(draft: RouteDraft) {
  return useMemo(() => {
    const result = buildRoute(draft.rows, { openDistance: false });
    const mapTask: XCTask | null =
      result.turnpoints.length > 0
        ? {
            taskType: draft.baseTask?.taskType || "CLASSIC",
            version: draft.baseTask?.version ?? 1,
            turnpoints: result.turnpoints,
            sss: { type: draft.sssType, direction: draft.direction },
            goal: { type: draft.goalType },
          }
        : null;
    return {
      result,
      mapTask,
      hasSSSTurnpoint: result.turnpoints.some((tp) => tp.type === "SSS"),
    };
  }, [draft.rows, draft.baseTask, draft.goalType, draft.sssType, draft.direction]);
}

/** The start panel, bound to the draft (comp/RouteSettings.tsx does this for the real editor). */
function StartPanel({ s, missingSssWarning }: { s: Scenario; missingSssWarning?: boolean }) {
  const { draft, update } = s;
  const [genCount, setGenCount] = useState(4);
  const [genInterval, setGenInterval] = useState(15);
  const interval = Number.isFinite(genInterval) && genInterval > 0 ? genInterval : 15;
  return (
    <StartSettings
      sssType={draft.sssType}
      onSssTypeChange={(sssType) => update((d) => ({ ...d, sssType }))}
      direction={draft.direction}
      onDirectionChange={(direction) => update((d) => ({ ...d, direction }))}
      gates={draft.gates}
      onGateChange={(index, value) =>
        update((d) => ({ ...d, gates: d.gates.map((g, i) => (i === index ? value : g)) }))
      }
      onRemoveGate={(index) =>
        update((d) => ({ ...d, gates: d.gates.filter((_, i) => i !== index) }))
      }
      onAddGate={() =>
        update((d) => {
          const last = d.gates[d.gates.length - 1];
          return { ...d, gates: [...d.gates, last ? addMinutes(last, interval) : "12:00"] };
        })
      }
      genCount={genCount}
      onGenCountChange={setGenCount}
      genInterval={genInterval}
      onGenIntervalChange={setGenInterval}
      onGenerateSeries={() =>
        update((d) => {
          const count = Math.min(Math.max(Number.isFinite(genCount) ? genCount : 0, 1), 100);
          const first = d.gates[0] ?? "12:00";
          return {
            ...d,
            gates: Array.from({ length: count }, (_, i) => addMinutes(first, i * interval)),
          };
        })
      }
      timeZoneLabel={s.timeZoneLabel}
      timeZoneKnown
      missingSssWarning={missingSssWarning}
    />
  );
}

function GoalPanel({ s }: { s: Scenario }) {
  const { draft, update } = s;
  return (
    <GoalSettings
      goalType={draft.goalType}
      onGoalTypeChange={(goalType) => update((d) => ({ ...d, goalType }))}
      deadline={draft.goalDeadline}
      onDeadlineChange={(goalDeadline) => update((d) => ({ ...d, goalDeadline }))}
      timeZoneLabel={s.timeZoneLabel}
      elevation={draft.goalElevation ?? NaN}
      onElevationChange={(m) =>
        update((d) => ({ ...d, goalElevation: Number.isFinite(m) ? m : null }))
      }
      goalAltitudeKnown={!missingAltitude(draft.rows[draft.rows.length - 1]?.altitude ?? "")}
    />
  );
}

/**
 * The route's map, and what a tap on it does: a waypoint's marker adds that
 * waypoint to the route; with `addMode` on, a tap on bare ground opens Add
 * waypoint, seeded from the tap.
 */
function RouteMapPane({
  s,
  mapTask,
  addMode,
  setAddMode,
  onNote,
  className,
}: {
  s: Scenario;
  mapTask: XCTask | null;
  addMode: boolean;
  setAddMode: (on: boolean) => void;
  /** Said under the map: what the last tap did. */
  onNote: (note: string) => void;
  className: string;
}) {
  const navigate = useNavigate();
  const { waypoints, update } = s;
  const mapWaypoints: MapWaypoint[] = useMemo(
    () =>
      waypoints.map((w, i) => ({
        id: String(i),
        code: w.code,
        name: w.name,
        lat: w.latitude,
        lon: w.longitude,
      })),
    [waypoints]
  );
  return (
    <div className={className}>
      {/* The mode says so above the map, in the page's flow, where it cannot
          sit on the map's own controls. */}
      {addMode ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-card py-1 pr-1 pl-4">
          <p role="status" className="min-w-0 flex-1 text-sm font-medium">
            Tap the map to place a new waypoint
          </p>
          <Button variant="ghost" className="h-11 px-4" onPress={() => setAddMode(false)}>
            Cancel
          </Button>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Loading map…
            </div>
          }
        >
          <RouteMap
            task={mapTask}
            waypoints={mapWaypoints}
            addMode={addMode}
            fitNonce={1}
            placeSearch
            onWaypointPick={(wp) => {
              const rec: WaypointFileRecord | undefined = waypoints[Number(wp.id)];
              if (!rec) return;
              let place = 0;
              update((d) => {
                const added = appendTurnpoint(d, {
                  ...draftFromRecord(rec),
                  type: inferAddedType(d.rows, { openDistance: false }),
                }).draft;
                place = added.rows.length;
                return added;
              });
              onNote(`Added ${rec.code} as turnpoint ${place}.`);
            }}
            onMapPick={(lat, lon, details) => {
              // Off on the way out, or the crosshair is still there on return.
              setAddMode(false);
              void navigate(
                `${s.routePath}/add-waypoint${newWaypointSearch(lat, lon, details)}`,
                openedHere()
              );
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}

export function RoutePage() {
  const s = useScenario();
  const { draft, dirty, update, waypoints } = s;
  const { rows } = draft;
  const confirm = useConfirm();
  const navigate = useNavigate();
  const leave = useLeave();
  const derived = useDerived(draft);
  const { errors, warnings } = derived.result;

  // A turnpoint that Add turnpoint opened and that was left empty is not one.
  useEffect(() => {
    update(pruneBlankRows);
    // Once, as the page opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [reordering, setReordering] = useState(false);
  const [moved, setMoved] = useState<{ rowId: number; delta: -1 | 1; nonce: number } | null>(null);
  const [moveNote, setMoveNote] = useState("");
  const [addMode, setAddMode] = useState(false);
  const [mapNote, setMapNote] = useState("");
  const [fillingAlts, setFillingAlts] = useState(false);
  const mapSection = useRef<HTMLElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  /** What the Save in flight is saving, for its message. */
  const saving = useRef({ turnpoints: 0, newWaypoints: 0 });

  const fillable = useMemo(
    () =>
      rows.filter((r) => missingAltitude(r.altitude) && parseCoords(r.coords) !== null).length,
    [rows]
  );

  if (!s.task) return <Missing />;
  const taskName = s.task.name;

  const assemble = () =>
    assembleRouteTask(
      rows,
      {
        sssType: draft.sssType,
        direction: draft.direction,
        gates: draft.gates,
        goalType: draft.goalType,
        goalDeadline: draft.goalDeadline,
        goalElevation: draft.goalElevation ?? undefined,
      },
      { openDistance: false, base: draft.baseTask, toUtc: s.toUtc }
    );

  function addTurnpoint() {
    const type = inferAddedType(rows.filter((r) => !isBlankRow(r)), { openDistance: false });
    let id = 0;
    update((d) => {
      const added = appendBlank(pruneBlankRows(d), type);
      id = added.id;
      return added.draft;
    });
    void navigate(`${s.routePath}/${id}`, openedHere({ [ADDING_TYPE]: type }));
  }

  function move(id: number, delta: -1 | 1) {
    const { draft: next, to } = moveTurnpoint(draft, id, delta);
    if (to < 0) return;
    update(() => next);
    const name = String(next.rows[to].name).trim() || "Turnpoint";
    setMoveNote(`${name} moved to ${to + 1} of ${next.rows.length}`);
    setMoved((m) => ({ rowId: id, delta, nonce: (m?.nonce ?? 0) + 1 }));
  }

  /** Blank altitudes filled from the Mapbox terrain, as the app does it. */
  async function fillAltitudes() {
    const targets = rows.flatMap((r) => {
      const c = parseCoords(r.coords);
      return missingAltitude(r.altitude) && c ? [{ id: r.id, lat: c.lat, lon: c.lon }] : [];
    });
    if (targets.length === 0) return;
    setFillingAlts(true);
    try {
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
      toast.success(`Filled ${filled} altitude${filled === 1 ? "" : "s"} from the map terrain`);
    } catch {
      toast.error("Could not read terrain elevations from Mapbox");
    } finally {
      setFillingAlts(false);
    }
  }

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
    if (
      hasTurnpoints(draft) &&
      !(await confirm({
        title: `Replace the route with ${file.name}?`,
        message: "The turnpoints, start and goal in the editor are replaced. Nothing is saved until you press Save.",
        confirmLabel: "Replace",
      }))
    )
      return;
    update((d) => loadTask(d, parsed, s.ctx));
    toast.success(`Loaded ${parsed.turnpoints.length} turnpoints from ${file.name}`);
  }

  function exportXctsk() {
    const { task } = assemble();
    if (!task) return toast.error("Fix the route problems before exporting");
    downloadFile(`${slugify(taskName)}.xctsk`, JSON.stringify(toXctskJSON(task)), "application/json");
  }

  function exportCsv() {
    if (derived.result.turnpoints.length === 0)
      return toast.error("Add some turnpoints with valid coordinates first");
    downloadFile(
      `${slugify(taskName)}-waypoints.csv`,
      turnpointsToCSV(derived.result.turnpoints),
      "text/csv"
    );
  }

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
    { id: "quick", label: "Quick entry", to: `${s.routePath}/quick` },
    ...(rows.length > 1
      ? [{ id: "reorder", label: "Reorder turnpoints", onAction: () => setReordering(true) }]
      : []),
    {
      id: "fill",
      group: true,
      disabled: fillingAlts || fillable === 0,
      label: fillingAlts
        ? "Filling altitudes…"
        : fillable > 0
          ? `Fill ${fillable} altitude${fillable === 1 ? "" : "s"} from the map`
          : "Fill altitudes from the map",
      onAction: () => void fillAltitudes(),
    },
    {
      id: "transfer",
      label: "Import or export",
      children: [
        { id: "import", label: "Import .xctsk…", onAction: () => fileInput.current?.click() },
        { id: "xcontest", label: "Load from XContest", onAction: stub("Load from XContest") },
        {
          id: "copy",
          label: "Copy from another competition…",
          onAction: stub("Copy from another competition"),
        },
        { id: "xctsk", label: "Export .xctsk", group: true, onAction: exportXctsk },
        { id: "csv", label: "Export .csv", onAction: exportCsv },
      ],
    },
    {
      id: "clear",
      label: "Clear turnpoints",
      destructive: true,
      group: true,
      disabled: !hasTurnpoints(draft),
      onAction: async () => {
        const ok = await confirm({
          title: "Clear all turnpoints?",
          message:
            "This removes every turnpoint from the editor. Loaded waypoints stay on the map, and nothing is saved until you press Save.",
          confirmLabel: "Clear",
        });
        if (ok) update(clearTurnpoints);
      },
    },
    ...(dirty
      ? [
          {
            id: "discard",
            label: "Discard changes",
            destructive: true,
            onAction: async () => {
              const ok = await confirm({
                title: "Discard route changes?",
                message: "The route goes back to the one that was last saved.",
                confirmLabel: "Discard changes",
                cancelLabel: "Keep editing",
                destructive: true,
              });
              if (ok) discardRoute(s.taskId);
            },
          },
        ]
      : []),
  ];

  return (
    <>
      {/* The form is the bar and the refusal under it, and nothing else: with
          the whole page inside it, Enter in the place search would be Save.
          `contents`, so the bar still sticks to the page and not to the form. */}
      <Form
        className="contents"
        onSubmit={() => {
          const { task, errors: problems } = assemble();
          if (!task) return Promise.resolve(refusal(problems.join(" ")));
          saving.current = {
            turnpoints: task.turnpoints.length,
            newWaypoints: draft.pendingWaypoints.length,
          };
          return accepted();
        }}
        onSuccess={() => {
          const { turnpoints, newWaypoints } = saving.current;
          saveRoute(s.taskId);
          toast.success(
            `Route saved: ${turnpoints} turnpoint${turnpoints === 1 ? "" : "s"}` +
              (newWaypoints > 0
                ? ` · ${newWaypoints} new waypoint${newWaypoints === 1 ? "" : "s"} added to the competition`
                : "")
          );
          leave(s.taskPath);
        }}
      >
        <PageBar
          title={reordering ? "Reorder" : "Route"}
          fullTitle="Route"
          trail={s.trail}
          actions={reordering ? [] : actions}
          commit={
            reordering ? (
              <DoneButton
                onPress={() => {
                  setReordering(false);
                  setMoved(null);
                }}
              />
            ) : (
              <SubmitButton className={commitClass} isDisabled={!dirty || errors.length > 0}>
                Save
              </SubmitButton>
            )
          }
        />
        <FormErrorBanner className="mx-auto w-full max-w-3xl px-gutter-safe pt-3" />
      </Form>

      <div className={pageClass}>
        <p role="status" className="px-1 text-sm text-muted-foreground">
          {reordering
            ? "Move turnpoints up or down, then press Done."
            : dirty
              ? "Unsaved changes. Nothing is saved until you press Save."
              : "This is the saved route."}
        </p>

        {/* The list is the app's own. Its Move up and Move down are 28 px
            there (issue #860); here they are brought up to 44. */}
        <div className="flex flex-col gap-2 [&_[data-move-row]]:size-11">
          {rows.length > 0 ? (
            <TurnpointList
              rows={rows}
              task={derived.mapTask}
              rowIds={derived.result.rowIds}
              reordering={reordering}
              moved={moved}
              onOpen={(id) => void navigate(`${s.routePath}/${id}`, openedHere())}
              onMove={move}
            />
          ) : (
            <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
              No turnpoints yet. Add them one at a time, tap a waypoint on the map, or use Quick
              entry in ⋯ to type the whole route.
            </p>
          )}
          <p role="status" aria-live="polite" className="sr-only">
            {moveNote}
          </p>
          {/* Where the new turnpoint goes, so not in ⋯. */}
          {reordering ? null : (
            <Button variant="outline" className="h-11 justify-start gap-2 px-4" onPress={addTurnpoint}>
              <PlusIcon className="size-4" />
              Add turnpoint
            </Button>
          )}
          <p className="px-1 text-xs text-muted-foreground">
            Enter or exit is worked out from the route: a cylinder containing the previous point
            is an exit.
          </p>
        </div>

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
                    parseTimeToken(g) !== null ? [`${s.toUtc(g)}:00Z`] : []
                  ),
                },
                { timeZone: s.timeZone, taskDate: s.taskDate }
              )}
            </span>
          }
        >
          <StartPanel s={s} missingSssWarning={!derived.hasSSSTurnpoint} />
        </Disclosure>
        <Disclosure title="Goal" headingLevel={2}>
          <GoalPanel s={s} />
        </Disclosure>

        <section ref={mapSection} aria-label="Map" className="flex scroll-mt-20 flex-col gap-2">
          <RouteMapPane
            s={s}
            mapTask={derived.mapTask}
            addMode={addMode}
            setAddMode={setAddMode}
            onNote={setMapNote}
            className="flex h-80 flex-col overflow-hidden rounded-xl border border-border sm:h-96"
          />
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <LinkButton
              href={`${s.routePath}/map`}
              routerOptions={openedHere()}
              variant="outline"
              className="h-11 gap-2 px-4"
            >
              <Maximize2Icon className="size-4" />
              Map at full size
            </LinkButton>
            <p role="status" className="text-sm text-muted-foreground">
              {mapNote ||
                (draft.pendingWaypoints.length > 0
                  ? `${draft.pendingWaypoints.length} new waypoint${draft.pendingWaypoints.length === 1 ? "" : "s"}, saved to the competition with the route.`
                  : "Tap a waypoint to add it to the route.")}
            </p>
          </div>
        </section>

        {errors.length > 0 ? (
          <ul className="list-disc pl-5 text-sm text-destructive">
            {errors.slice(0, 10).map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        ) : null}
        {warnings.length > 0 ? (
          <ul className="text-sm text-amber-500">
            {warnings.map((w, i) => (
              <li key={i}>⚠ {w}</li>
            ))}
          </ul>
        ) : null}
      </div>

      <input
        ref={fileInput}
        type="file"
        accept=".xctsk"
        className="hidden"
        onChange={(e) => {
          void importFile(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </>
  );
}

/** The route's map with the screen to itself: the bar, then nothing but the map. */
export function RouteMapPage() {
  const s = useScenario();
  const derived = useDerived(s.draft);
  const [addMode, setAddMode] = useState(false);
  const [note, setNote] = useState("");
  if (!s.task) return <Missing />;
  const count = s.draft.rows.filter((r) => !isBlankRow(r)).length;
  return (
    <>
      <PageBar
        title="Route map"
        trail={s.routeTrail}
        actions={[
          {
            id: "new",
            label: addMode ? "Stop placing a waypoint" : "New waypoint from the map",
            onAction: () => setAddMode(!addMode),
          },
        ]}
      />
      {/* The bar's height, then the rest of the screen: the page does not
          scroll, so every drag belongs to the map. */}
      <div className="mx-auto flex h-[calc(100dvh-3.75rem-env(safe-area-inset-top,0px))] w-full max-w-3xl flex-col pb-safe">
        <RouteMapPane
          s={s}
          mapTask={derived.mapTask}
          addMode={addMode}
          setAddMode={setAddMode}
          onNote={setNote}
          className="flex min-h-0 flex-1 flex-col overflow-hidden border-y border-border sm:rounded-xl sm:border"
        />
        <p role="status" className="shrink-0 px-gutter-safe py-2 text-sm text-muted-foreground">
          {note || `${count} turnpoint${count === 1 ? "" : "s"}. Tap a waypoint to add it to the route.`}
          {s.dirty ? " Unsaved: Save is on Route." : ""}
        </p>
      </div>
    </>
  );
}

export function TurnpointPage() {
  const s = useScenario();
  const { turnpointId } = useParams();
  const leave = useLeave();
  // Removed on its way out: the page stays as it was until it has gone.
  const [leaving, setLeaving] = useState<RouteRow | null>(null);
  const id = Number(turnpointId);
  const row = s.draft.rows.find((r) => r.id === id) ?? leaving;
  if (!s.task || !row) return <Missing />;
  return (
    <TurnpointForm
      s={s}
      row={row}
      onDelete={() => {
        setLeaving(row);
        s.update((d) => removeTurnpoint(d, row.id));
        leave(s.routePath);
      }}
    />
  );
}

function TurnpointForm({ s, row, onDelete }: { s: Scenario; row: RouteRow; onDelete: () => void }) {
  const location = useLocation();
  const leave = useLeave();
  const { waypoints } = s;
  const rows = s.draft.rows;
  const addingType = (location.state as Record<string, unknown> | null)?.[ADDING_TYPE] as
    | RouteRow["type"]
    | undefined;
  const adding = addingType !== undefined;
  const isLast = rows[rows.length - 1]?.id === row.id;
  const showGoal = showGoalSettings(
    adding ? { openDistance: false, addingType } : { openDistance: false, isLast }
  );
  const [wpQuery, setWpQuery] = useState("");
  const { contains } = useFilter({ sensitivity: "base" });
  const [moveNote, setMoveNote] = useState("");

  const radius = Number(row.radius);
  const altitudeM = String(row.altitude ?? "").trim() === "" ? NaN : Number(row.altitude);
  const label = row.name || "turnpoint";

  /** Change this turnpoint, in the draft, now. */
  const set = (patch: Partial<TurnpointDraft>) => {
    let movedToEnd = false;
    s.update((d) => {
      const r = editTurnpoint(d, row.id, patch);
      movedToEnd = r.movedToEnd;
      return r.draft;
    });
    if (movedToEnd) setMoveNote(`${String(row.name).trim() || "Turnpoint"} is now last — the goal`);
  };

  const wpItems = useMemo(() => {
    const all = waypoints.map((w, i) => ({
      id: `${w.code}-${i}`,
      record: w,
      text: w.name !== w.code ? `${w.code} ${w.name}` : w.code,
    }));
    const q = wpQuery.trim();
    return q === "" ? [] : all.filter((it) => contains(it.text, q));
  }, [waypoints, wpQuery, contains]);

  return (
    <Form
      validate={() => coordsProblems("coords", String(row.coords))}
      // Nothing to send: every change is in the draft already.
      onSuccess={() => leave(s.routePath)}
    >
      <ProtoPage
        bar={
          <PageBar
            title={row.name || (adding ? "New turnpoint" : "Turnpoint")}
            fullTitle={adding ? "Add turnpoint" : `Edit turnpoint ${row.name}`.trim()}
            trail={s.routeTrail}
            commit={<DoneButton submit />}
          />
        }
      >
        <FormErrorBanner />
        <p role="status" aria-live="polite" className="sr-only">
          {moveNote}
        </p>
        <div className="flex flex-col gap-2">
          <SearchField
            label="Load from a waypoint"
            autoFocus={adding}
            placeholder={`Search ${waypoints.length} waypoints…`}
            value={wpQuery}
            onChange={setWpQuery}
          />
          {wpQuery.trim() !== "" ? (
            <ListBox
              aria-label="Matching waypoints"
              selectionMode="single"
              selectedKeys={[]}
              onSelectionChange={(keys) => {
                const key = keys === "all" ? null : [...keys][0];
                const item = key == null ? null : wpItems.find((it) => it.id === String(key));
                if (!item) return;
                set(draftWithRecord(row, item.record));
                setWpQuery("");
              }}
              items={wpItems}
              className="max-h-64"
              renderEmptyState={() => (
                <p className="px-2 py-1.5 text-sm text-muted-foreground">No matches</p>
              )}
            >
              {(item: { id: string; record: WaypointFileRecord; text: string }) => (
                <ListBoxItem id={item.id} textValue={item.text} className="min-h-11 items-center gap-2">
                  <span className="font-medium">{item.record.code}</span>
                  {item.record.name !== item.record.code ? (
                    <span className="truncate text-muted-foreground">{item.record.name}</span>
                  ) : null}
                </ListBoxItem>
              )}
            </ListBox>
          ) : null}
        </div>

        <TextField
          label="Code"
          name="name"
          value={row.name}
          onChange={(v) => set({ name: v })}
          placeholder="A01"
        />
        <TextField
          label="Name"
          name="description"
          description="Full descriptive name (optional)"
          value={row.description}
          onChange={(v) => set({ description: v })}
          placeholder="Bordano Landing"
        />
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Radius (m)</span>
          <div
            role="group"
            aria-label={`Radius of ${label} in metres`}
            className="flex flex-wrap items-center gap-2"
          >
            {RADIUS_PRESETS.map((preset) => (
              <ToggleButton
                key={preset}
                isSelected={radius === preset}
                onChange={() => set({ radius: preset })}
                className="h-11 px-4 tabular-nums"
                aria-label={`Set radius ${preset} metres`}
              >
                {radiusChipLabel(preset)}
              </ToggleButton>
            ))}
            <NumberField
              aria-label={`Custom radius of ${label} in metres`}
              minValue={1}
              maxValue={50000}
              step={1}
              formatOptions={{ useGrouping: true }}
              value={Number.isFinite(radius) ? radius : NaN}
              onChange={(v) => set({ radius: Number.isFinite(v) ? v : "" })}
              className="w-full"
            />
          </div>
        </div>
        <CoordsField value={String(row.coords)} onChange={(v) => set({ coords: v })} />
        <AltitudeField
          description="Waypoint altitude, optional"
          valueM={altitudeM}
          onChange={(m) => set({ altitude: Number.isFinite(m) ? m : "" })}
        />
        {!(showGoal || row.type === "GOAL") ? (
          <section className="flex flex-col gap-3 border-t border-border pt-3">
            <h2 className="text-sm font-medium">Altitude limits</h2>
            <AltitudeField
              label="Lower limit"
              valueM={row.altitudeLimits?.lower ?? NaN}
              onChange={(m) => set({ altitudeLimits: withLimit(row.altitudeLimits, "lower", m) })}
            />
            <AltitudeField
              label="Upper limit"
              valueM={row.altitudeLimits?.upper ?? NaN}
              onChange={(m) => set({ altitudeLimits: withLimit(row.altitudeLimits, "upper", m) })}
              description="Optional (FAI S7F §6.2.1). A crossing of this cylinder counts only between these altitudes, within 5 m."
            />
          </section>
        ) : null}
        <ChoiceList
          label="Type"
          value={row.type}
          onChange={(v) => set({ type: v as RouteRow["type"] })}
          options={typeOptions({ lastIsGoal: showGoal })}
        />
        {row.type === "SSS" ? (
          <section className="flex flex-col gap-1 border-t border-border pt-3">
            <h2 className="text-sm font-medium">Start Speed Section (SSS)</h2>
            <StartPanel s={s} />
          </section>
        ) : null}
        {showGoal || row.type === "GOAL" ? (
          <section className="flex flex-col gap-1 border-t border-border pt-3">
            <h2 className="text-sm font-medium">Goal</h2>
            <GoalPanel s={s} />
          </section>
        ) : null}
        {/* At the foot of the form, away from Done, as on every form here. No
            question: the route is still a draft, and Discard changes on Route
            puts the saved one back. */}
        {!adding ? (
          <Button variant="destructive" className="mt-4 h-11 self-start px-5" onPress={onDelete}>
            Delete turnpoint
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Nothing is saved until you press Save on the route.
        </p>
      </ProtoPage>
    </Form>
  );
}

/** One limit set (or cleared, for NaN), dropping the object once both are gone. */
function withLimit(
  current: TurnpointDraft["altitudeLimits"],
  which: "lower" | "upper",
  metres: number
): TurnpointDraft["altitudeLimits"] {
  const next = { ...current };
  if (Number.isFinite(metres)) next[which] = metres;
  else delete next[which];
  return next.lower === undefined && next.upper === undefined ? undefined : next;
}

/** A new competition waypoint, started from a tap on the map. */
export function AddWaypointPage() {
  const s = useScenario();
  const [searchParams] = useSearchParams();
  const leave = useLeave();
  // Where it started, read once: the fields are the reader's from here on.
  const [seed] = useState(() => readNewWaypointSeed(searchParams));
  const [taken] = useState(() => s.waypoints.map((w) => w.code));
  const waypoint = useNewWaypoint(seed, taken);
  if (!s.task) return <Missing />;
  return (
    <Form
      validate={() => newWaypointProblems(waypoint.state)}
      onSuccess={() => {
        const built = buildNewWaypoint(
          waypoint.state,
          s.waypoints.map((w) => w.code)
        );
        if (!built) return;
        if (built.adjusted) toast.warning(built.adjusted);
        s.update((d) => addNewWaypoint(d, built.record, { openDistance: false }));
        toast.success(`Added ${built.record.code} to the route. Save to keep it.`);
        leave(s.routePath);
      }}
    >
      <ProtoPage
        bar={
          <PageBar
            title="Add waypoint"
            trail={s.routeTrail}
            cancel={() => leave(s.routePath)}
            commit={
              <SubmitButton className={commitClass} pendingLabel="Adding">
                Add
              </SubmitButton>
            }
          />
        }
      >
        <FormErrorBanner />
        <AddWaypointFields seed={seed} waypoint={waypoint} />
      </ProtoPage>
    </Form>
  );
}

/** The whole route as one typed line. */
export function QuickEntryPage() {
  const s = useScenario();
  const confirm = useConfirm();
  const leave = useLeave();
  const { draft } = s;
  // The route as a line, read once: the line is the reader's from here on.
  const [initialText] = useState(() =>
    quickTaskText(
      draft.rows
        .filter((r) => !isBlankRow(r))
        .map((r) => ({
          name: String(r.name),
          radius: Number(r.radius) || NEW_ROW_RADIUS,
          type: r.type === "GOAL" ? "" : r.type,
        })),
      {
        start: {
          direction: draft.direction,
          type: draft.sssType,
          gates: draft.gates.filter((g) => parseTimeToken(g) !== null),
        },
      }
    )
  );
  const [text, setText] = useState(initialText);
  const [known] = useState(() => draft.rows.map((r) => String(r.name)));
  const parsed = useMemo(
    () => quickTaskApply(text, s.waypoints, { defaultRadius: NEW_ROW_RADIUS, knownNames: known }),
    [text, s.waypoints, known]
  );
  if (!s.task) return <Missing />;
  return (
    <Form
      // Nothing to send: the route joins the draft, saved with the route.
      onSuccess={() => {
        s.update((d) => applyQuickEntry(d, parsed, { openDistance: false }));
        leave(s.routePath);
      }}
    >
      <ProtoPage
        bar={
          <PageBar
            title="Quick entry"
            trail={s.routeTrail}
            cancel={async () => {
              if (
                text !== initialText &&
                !(await confirm({
                  title: "Discard this text?",
                  message: "The route in the editor hasn't changed. Anything typed here will be lost.",
                  confirmLabel: "Discard",
                  cancelLabel: "Keep editing",
                  destructive: true,
                }))
              )
                return;
              leave(s.routePath);
            }}
            commit={
              <SubmitButton className={commitClass} isDisabled={parsed.picks.length === 0}>
                Use route
              </SubmitButton>
            }
          />
        }
      >
        <FormErrorBanner />
        <p className="text-sm text-muted-foreground">
          Type waypoints in order, each with a radius — e.g.{" "}
          <span className="font-medium">ell 400m kang 1.5k</span>. The start takes its settings the
          same way: <span className="font-medium">sss exit 14:00 15:00</span>.
        </p>
        <QuickTaskField
          waypoints={s.waypoints}
          defaultRadius={NEW_ROW_RADIUS}
          value={text}
          onChange={setText}
          knownNames={known}
          timeZoneLabel={s.timeZoneLabel}
        />
        <p className="text-sm text-muted-foreground">
          Only sets the order, radii, types and the start — coordinates, altitudes and names are
          unchanged.
        </p>
      </ProtoPage>
    </Form>
  );
}
