/**
 * Competition waypoints (issue #312, stage 1): the list, for everyone, and
 * the editor's home page for the comp's organisers.
 *
 * A comp's shared waypoint database, edited here once and picked from when
 * building task routes. Admins upload a file (any of the supported formats),
 * fix up details a waypoint at a time, add points from the map or pasted
 * coordinates, and save. The set is stored per-comp (JSON blob) via
 * GET/PUT /api/comp/:id/waypoints.
 *
 * **It is ONE list of waypoints, at every width, for everyone** —
 * comp/WaypointList.tsx. An admin's row opens that waypoint's PAGE
 * (pages/CompWaypointPage.tsx); a visitor's flies the map. Admin and visitor
 * differ by what a row opens, not by what the page is.
 *
 * It was a Tabulator grid for admins until 2026-09-19, and the grid was the
 * app's standard for an editable table; what settled it is that GlideComp is
 * used from a hill with a phone, and on a phone the grid scrolled sideways
 * inside a page that scrolled down, under a map pane that stuck, with its
 * frozen Code column hiding whichever column sat beside it. See the
 * mobile-first rule in docs/interaction-guide.md. A visitor's six-column RAC Table went the
 * same way and for the same reason, a little later: it sat in its own
 * sideways-scrolling region, so the shape the editor had stopped using
 * survived for the PILOT, who is the one actually on the hill.
 *
 * **The editor is pages, over one draft** (#811). One waypoint, Add waypoint,
 * the map at full size and the altitude review were sheets and a dialog over
 * this page until 2026-11, and are pages of their own now (the overlays rule
 * in docs/interaction-guide.md). What they edit is the waypoint FILE, saved as a set — so the
 * file is a draft in this tab's storage (comp/waypoints-draft.ts,
 * comp/use-waypoints-editor.ts) that every one of them reads and writes, and
 * Save here sends it.
 *
 * The read-only content (heading, list, download links) is server-rendered
 * via loadCompWaypoints so the page has real content for crawlers; the map
 * (mapbox) stays client-only — it is drawn into its place once the page has
 * mounted (FloatingContent) — and so does the draft, which only the browser
 * has.
 *
 * List and map are laid out by the shared {@link MasterDetail}: the map is
 * the sticky right-hand column on a wide screen, and on a phone it FLOATS
 * over the list in a window the reader moves, sizes and puts away
 * (components/FloatingWindow.tsx; docs/interaction-guide.md 2.8). It was
 * pinned under the bar there until 28 November 2026, and held half the
 * screen; a row's locate pin brings a window that was put away back, clear
 * of the row.
 *
 * The map also opens at full size, on a page of its own
 * (/comp/:id/waypoints/map, `view="map"`) — enough room to walk a valley
 * dropping points one after another. That page is THIS component, so the
 * map on it is the same map, with its view and its pick state, and goes back
 * with them: the router keeps the instance because both routes render it,
 * with its {@link FloatingContent} first in the tree. It is the organisers'
 * (a visitor is sent to the list), as it was when it was a page of its own.
 *
 * Add from map: the next tap on the map opens Add waypoint on that point. On
 * the list it disarms after one tap, because the map is small; on the
 * full-size page it STAYS armed, to place several in a row, and armed is
 * `?add=1` in the URL so that coming back from Add waypoint finds it armed.
 * Armed on the list, the full-size page opens armed. A small window is a picture of the map and takes no touch, so arming it on
 * a phone brings the window up large.
 *
 * **Every action is in the page's bar** (issue #863; rac/page-bar.tsx), and
 * the page is the waypoints. For an organiser the bar holds Save — live only
 * while the draft differs from what is saved — and, under ⋯, Add waypoint,
 * Add from map, Upload file, Check altitudes, the device rows and, while
 * there are changes, Discard changes. A visitor's ⋯ has the device rows
 * alone. The filter is the bar's second layer, so it stays in reach down a
 * long list. Save was in a bar stuck to the foot of the screen until 2026-11;
 * nothing sticks to the bottom now.
 *
 * The form is the bar and the refusal under it, and nothing else. The filter
 * is inside the bar, so it is inside the form, and Enter in it must not be
 * Save: the field takes Enter for itself (`onSubmit`).
 *
 * Nothing is saved until Save. Leaving the editor by a link with edits
 * outstanding asks first; Back and a reload keep the draft for later.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/react/lib/utils";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useInView } from "../lib/use-in-view";
import { NotFound } from "@/react/components/NotFound";
import {
  ImportIcon,
  MapPinPlusIcon,
  MapPinXIcon,
  MountainIcon,
  PlusIcon,
  Undo2Icon,
} from "lucide-react";
import { cleanWaypointCodes, describeCodeChanges, parseWaypointFile } from "@glidecomp/engine";
import type { MapWaypoint } from "../../analysis/map-provider";
import { Button } from "@/react/rac/button";
import { Alert, AlertDescription } from "@/react/rac/alert";
import { MasterDetail } from "@/react/components/MasterDetail";
import {
  FloatSlot,
  FloatingContent,
  floatDragRow,
  useFloatingDetail,
} from "@/react/components/FloatingWindow";
import { floatMapClass } from "../comp/float-map";
import { Loading, Spinner } from "@/react/rac/progress";
import { Page, PageBar, commitClass, type BarAction, type BarAdd } from "@/react/rac/page-bar";
import { SearchField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton, refusal } from "@/react/rac/form";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { compPages, underComp, underCompWaypoints } from "../lib/crumbs";
import {
  compAltitudeReviewPath,
  compPath,
  compWaypointPath,
  compWaypointsMapPath,
  compWaypointsNewPath,
  compWaypointsPath,
} from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import { parseCoords } from "../comp/route-editor";
import { newWaypointSearch } from "../comp/AddWaypointForm";
import { WaypointList } from "../comp/WaypointList";
import { useWaypointDeviceExport } from "../comp/WaypointDeviceExport";
import {
  WAYPOINTS_DISCARD,
  useAltitudeCheck,
  useWaypointsEditor,
  waypointCameras,
} from "../comp/use-waypoints-editor";
import { DraftNotices } from "../comp/DraftNotices";
import { waypointsEditorGate } from "../comp/WaypointsEditorGate";
import {
  cleanCodes,
  fromRow,
  matchesFilter,
  replaceAll,
  validRecords,
  type WpRow,
} from "../comp/waypoints-draft";
import { useLeave } from "../lib/leave";

const RouteMap = lazy(() => import("../comp/RouteMap"));

/**
 * The map's noun, and the name the map's state is remembered under: the
 * floating window's place and size, and MasterDetail's split. It is the name
 * the pinned pane's fold was remembered under, so a reader who had hidden
 * that pane meets the window already put away.
 */
const MAP_LABEL = "map";

/**
 * Where the map column sticks, side by side, over MasterDetail's own offset,
 * which is for a bar with no second layer: this bar has the filter under it.
 * Stacked there is no pane (the map floats).
 */
const PANE_WRAP = "@5xl:top-[calc(8rem+env(safe-area-inset-top,0px))]";

/**
 * Focus must not stop behind the bar (WCAG 2.4.11), which is about 7.25rem
 * with the filter under it. A row of the list is a `role="row"`, which
 * MasterDetail's own clearances do not name, and its buttons are cleared
 * there for a bar with no filter — hence the `!`. The floating window clears
 * itself, by the page's scroll padding (FloatingWindow.tsx). Whole class
 * strings, because Tailwind scans for them.
 */
const CLEAR = "[&_[role=row]]:scroll-mt-36 [&_button]:scroll-mt-36!";

/**
 * `view="map"` is the same page with the map alone, at full size
 * (/comp/:id/waypoints/map): see the note at the top.
 */
export function CompWaypoints({ view = "list" }: { view?: "list" | "map" } = {}) {
  const editor = useWaypointsEditor();
  const { comp, compId, urlId, compName, isAdmin, draft, dirty, bareId } = editor;
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const leave = useLeave();
  const confirm = useConfirm();
  // On a phone the map is a floating window. Held here because the page lays
  // the map out for where it is, and brings it back when a row asks it a
  // question.
  const float = useFloatingDetail(MAP_LABEL);
  const { reveal } = float;
  const mode = float.mode;

  // Settle the address bar on the canonical `${slug}-${id}` once the name loads.
  useCanonicalPath(
    compName ? (view === "map" ? compWaypointsMapPath : compWaypointsPath)(urlId, compName) : null
  );

  const rows = draft.rows;
  const altitudeCheck = useAltitudeCheck(editor);
  // Mapbox (764 KB) waits until the panel nears the viewport — see use-in-view.
  const [mapRef, mapInView] = useInView<HTMLDivElement>();
  // Armed by "Add from map": the next tap opens Add waypoint on that point.
  // On the list it disarms — on a map this small, the tap after that should
  // pan. On the full-size page it stays armed, in the URL (see the top).
  const [listAddMode, setListAddMode] = useState(false);
  const addMode = view === "map" ? searchParams.get("add") === "1" : listAddMode;
  const setAddMode = (on: boolean) => {
    if (view === "map") {
      setSearchParams(on ? { add: "1" } : {}, { replace: true, state: location.state });
    } else setListAddMode(on);
  };
  // Armed on the list, the full-size page opens armed (`fullTo`, below): the
  // arming went there with the map, so the list does not keep it as well.
  useEffect(() => {
    if (view === "map") setListAddMode(false);
  }, [view]);
  const [fitNonce, setFitNonce] = useState(0);
  // Fly-to-waypoint request from a row's pin (see `locate`).
  const [focus, setFocus] = useState<{ lat: number; lon: number; key: number } | null>(null);
  const focusSeq = useRef(0);
  // The records the save in flight is sending: the new baseline once it lands.
  const saving = useRef<ReturnType<typeof validRecords>>([]);
  // "Upload file" is a row of ⋯, and a menu row cannot be a file input.
  const fileInput = useRef<HTMLInputElement>(null);

  // The filter box, which narrows a long list. Nothing re-orders the list:
  // the file's own order is the order, for a visitor as for an organiser.
  const [filter, setFilter] = useState("");

  // The list, to find a row's element by its key (see `locate`).
  const listRef = useRef<HTMLDivElement>(null);

  // Fly the map to a row's coordinates (bumping the key so a repeat press on
  // the same row re-centres). No-op when the row's coordinates aren't valid.
  // A row is a question put to the map: if the window was put away, this is
  // the moment it is wanted, and away from the row that was pressed.
  const locate = useCallback(
    (r: Pick<WpRow, "id" | "coords">) => {
      const c = parseCoords(r.coords);
      if (!c) return;
      reveal(listRef.current?.querySelector(`[role="row"][data-key="${r.id}"]`));
      setFocus({ lat: c.lat, lon: c.lon, key: ++focusSeq.current });
    },
    [reveal]
  );

  // The pilot's download + QR (issue #312 stage 2) — for everyone, and keyed
  // off the SAVED set rather than the editor's rows: a comp with nothing
  // published has nothing to put on a device.
  const hostedUrl = useCallback(
    (fmt: string, swap: boolean) => `/api/comp/${compId}/waypoints/${fmt}${swap ? "?swap=1" : ""}`,
    [compId]
  );
  const device = useWaypointDeviceExport({
    records: editor.loading ? [] : editor.saved,
    baseName: compName,
    noun: "waypoint",
    hostedUrl,
  });

  if (editor.notFound) return <NotFound title="Competition not found" />;

  /** The waypoints are here, and an organiser may edit them. */
  const editing = isAdmin && !editor.loading && !editor.loadError;
  const invalidCount = rows.filter((r) => fromRow(r) === null).length;
  const query = filter.trim().toLowerCase();
  const visibleRows = query ? rows.filter((r) => matchesFilter(r, query)) : rows;

  // Map markers from the rows with valid coordinates.
  const mapWaypoints: MapWaypoint[] = rows.flatMap((r) => {
    const c = parseCoords(r.coords);
    return c
      ? [{ id: String(r.id), code: r.code || "?", name: r.name || r.code || "?", lat: c.lat, lon: c.lon }]
      : [];
  });

  /** Into one of the editor's pages, marked so it can come back here by Back. */

  async function loadFile(file: File | null) {
    if (!file) return;
    try {
      const { waypoints, format } = parseWaypointFile(await file.text(), file.name);
      if (waypoints.length === 0) {
        toast.error(`No waypoints found in ${file.name}`);
        return;
      }
      if (rows.length > 0) {
        const ok = await confirm({
          title: "Replace the current waypoints?",
          message: `Loading ${file.name} replaces all ${rows.length} waypoints currently in the editor. Nothing is saved until you press Save.`,
          confirmLabel: "Replace",
        });
        if (!ok) return;
      }
      // Codes can't hold a space or a comma (they separate turnpoints when a
      // route is written as text), and they have to be unique to name a
      // turnpoint at all. Clean on the way in, and say what changed.
      const { waypoints: cleaned, changes } = cleanWaypointCodes(waypoints);
      editor.update((d) => replaceAll(d, cleaned));
      setFitNonce((n) => n + 1);
      toast.success(
        `Loaded ${cleaned.length} waypoint${cleaned.length === 1 ? "" : "s"} (${format}) from ${file.name}`
      );
      const note = describeCodeChanges(changes);
      if (note) toast.warning(note);
    } catch {
      toast.error(`Could not read ${file.name} as a waypoint file`);
    }
  }

  /**
   * Compare EVERY waypoint's altitude with the terrain under it, then open the
   * review on what it found — changing nothing. The check questions values
   * that are already there, so it must not apply itself; the review page
   * shows both altitudes side by side and leaves the decision to the reader.
   */
  async function checkAltitudes() {
    if (await altitudeCheck.run()) {
      navigate(compAltitudeReviewPath(urlId, compName));
    }
  }

  /**
   * Throw the edits away and leave for the competition, as the route
   * editor's Cancel leaves for the task: Back and a reload keep the draft,
   * so this is the way to discard it on purpose — and staying on the page
   * afterwards only looked as if nothing had happened.
   */
  async function discard() {
    const ok = await confirm({
      ...WAYPOINTS_DISCARD,
      confirmLabel: "Discard changes",
      cancelLabel: "Keep editing",
      destructive: true,
    });
    if (!ok) return;
    editor.discard();
    leave(compPath(urlId, compName));
  }

  /**
   * Arm the map for one tap, with a map on screen to take it. The small
   * window is a picture, which takes no touch, so a window that is small or
   * put away comes up large and live.
   */
  function toggleAddFromMap() {
    if (!addMode && (mode === "small" || mode === "tucked")) reveal(null, "large");
    setAddMode(!addMode);
  }

  const mapFallback = (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  );

  // The two ways to add a waypoint are buttons of the bar, beside ⋯, and not
  // rows inside it (owner's decision, 28 November 2026): adding is what an
  // organiser comes to this page to do, and a menu hid both.
  const addFromMap: BarAdd = {
    label: addMode ? "Stop adding from map" : "Add from map",
    glyph: addMode ? MapPinXIcon : MapPinPlusIcon,
    onAction: () => undefined,
  };
  const adds: BarAdd[] | undefined = editing
    ? [
        { label: "Add waypoint", to: compWaypointsNewPath(urlId, compName) },
        { ...addFromMap, onAction: toggleAddFromMap },
      ]
    : undefined;

  // ⋯: the editing actions (an organiser's, once the waypoints are here),
  // then the device rows (everyone's), then the way to throw the draft away
  // — only while there is one to throw away.
  const actions: BarAction[] = [
    ...(editing
      ? [
          {
            id: "upload",
            icon: ImportIcon,
            label: "Upload file",
            onAction: () => fileInput.current?.click(),
          },
          // ONE altitude action, and it reports nothing until it is pressed.
          // There used to be a "Fill altitudes from map" beside it — an
          // action that answered blanks without asking — and a status line
          // saying whether any blanks were left. The check does the fill's
          // job better (it shows what it would write before writing it), and
          // the status line was a verdict on a set nobody had asked about.
          {
            id: "check-altitudes",
            icon: MountainIcon,
            label: "Check altitudes",
            disabled: rows.length === 0 || altitudeCheck.checking,
            onAction: () => void checkAltitudes(),
          },
        ]
      : []),
    ...device.actions.map((a, i) => (i === 0 && editing ? { ...a, group: true } : a)),
    ...(editing && dirty
      ? [
          {
            id: "discard",
            icon: Undo2Icon,
            label: "Discard changes",
            destructive: true,
            group: true,
            onAction: () => void discard(),
          },
        ]
      : []),
  ];

  // The map and what goes with it: ONE subtree for the column, the floating
  // window and the full-size page, so the map (its view, whether it is armed
  // to place a point) is the same map in all three. `mode` says which it is
  // in, and the layout follows: null in the column, then the window's size,
  // or "full".
  /** A map the reader can work: not the small window's picture. */
  const live = mode !== "small" && mode !== "tucked";
  // Everyone may open the map at full size (owner's decision, 28 November
  // 2026). It was the organisers' alone while it was only a place to add
  // points from.
  const fullTo =
    editor.loading || editor.loadError ? undefined : compWaypointsMapPath(urlId, compName);
  const countLine = isAdmin
    ? `${rows.length} waypoint${rows.length === 1 ? "" : "s"}${
        invalidCount > 0 ? ` · ${invalidCount} need valid coordinates` : ""
      }`
    : `${rows.length} waypoints`;
  // Add from map is a row of ⋯; armed, the map says so beside it, with the
  // way to stop.
  const placing =
    addMode && live ? (
      <>
        <span
          role="status"
          className={cn("text-sm font-medium", mode != null && "min-w-0 flex-1")}
        >
          Tap the map to place…
        </span>
        <Button
          variant={mode == null ? "outline" : "ghost"}
          size={mode == null ? "sm" : undefined}
          className={mode == null ? undefined : "h-11 px-4"}
          onPress={() => setAddMode(false)}
        >
          Stop
        </Button>
      </>
    ) : null;
  const detail = (
    <>
      <div
        ref={mapRef}
        className={cn(
          mode == null
            ? // The column, side by side. An explicit height: Mapbox renders
              // nothing into an unsized container.
              "h-[520px]"
            : // The window, or the page, is the frame: the map fills it.
              "relative min-h-0 flex-1 overflow-hidden",
          // The column has the way to the full-size page in its corner only
          // for an organiser; a visitor's keeps the map's own controls there.
          (mode != null || fullTo) && floatMapClass(mode)
        )}
      >
        {mode == null && !mapInView ? (
          mapFallback
        ) : (
          <Suspense fallback={mapFallback}>
            <RouteMap
              task={null}
              waypoints={mapWaypoints}
              addMode={addMode}
              fitNonce={fitNonce}
              focus={focus}
              // Not on the small window's picture, which takes no input.
              placeSearch={isAdmin && live}
              // The map's top right corner has the size buttons.
              searchBelow
              // The same ground in view when the window changes size.
              keepView
              // Where the map was left when it was last mounted, if it was:
              // coming back from Add waypoint or a waypoint's page.
              initialCamera={waypointCameras.get(bareId) ?? null}
              onCameraChange={(camera) => waypointCameras.set(bareId, camera)}
              onWaypointPick={() => {}}
              onMapPick={(lat, lon, details) => {
                // On the list one tap places one point; the full-size page
                // stays armed for the next.
                if (view !== "map") setAddMode(false);
                navigate(
                  compWaypointsNewPath(urlId, compName, newWaypointSearch(lat, lon, details)));
              }}
            />
          </Suspense>
        )}
      </div>
      {mode == null ? (
        isAdmin ? (
          <div className="flex flex-wrap items-center gap-2 p-2">
            {placing}
            <span className="text-xs text-muted-foreground">{countLine}</span>
          </div>
        ) : (
          <p className="p-2 text-xs text-muted-foreground">{countLine}</p>
        )
      ) : mode === "large" && placing ? (
        // The window can be held by its last row, as by its grabber:
        // anywhere but the button (FloatingContent reads the mark).
        <div
          {...floatDragRow}
          className={cn(
            floatDragRow.className,
            "flex min-h-11 shrink-0 items-center gap-2 border-t border-border bg-card pr-1 pl-3"
          )}
        >
          {placing}
        </div>
      ) : mode === "full" ? (
        <>
          {placing ? (
            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card py-1 pr-1 pl-4">
              {placing}
            </div>
          ) : null}
          <p className="shrink-0 border-t border-border px-gutter-safe py-2 text-xs text-muted-foreground">
            {rows.length} waypoint{rows.length === 1 ? "" : "s"} · nothing is saved until you
            press Save
          </p>
        </>
      ) : null}
    </>
  );
  // First in the tree on the list AND on the full-size page, so the router
  // keeps it, and the map in it, when the reader goes between them. While
  // the waypoints are not here its place is held by null, so the page after
  // it keeps its own place and the bar is not mounted again.
  const floatingContent = (
    <FloatingContent
      float={float}
      label="map"
      ariaLabel="Waypoint map"
      // The filter is the bar's second layer.
      tallBar
      // Armed, the full-size page opens armed.
      fullTo={fullTo && addMode ? `${fullTo}?add=1` : fullTo}
      // It leaves the page as the bar's Back does: the full-size map is a
      // page (guide 2.1).
      onLeaveFull={() => leave(compWaypointsPath(urlId, compName))}
    >
      {detail}
    </FloatingContent>
  );

  if (view === "map") {
    const trail = underCompWaypoints(urlId, compName);
    // A visitor sees the map too, read-only: only an organiser waits for a
    // draft, and nobody is sent away.
    const visitor =
      !editor.notFound && !editor.loading && !editor.userLoading && !!editor.comp && !isAdmin;
    const gate = visitor
      ? null
      : waypointsEditorGate(editor, { title: "Waypoint map", trail });
    if (gate) {
      return (
        <>
          {null}
          {gate}
        </>
      );
    }
    return (
      <>
        {floatingContent}
        {/* The page is the bar and the map (issue #863): `fill`, so the page
            does not scroll and every drag belongs to the map, which is as
            wide and as tall as the screen under the bar. Add from map is
            the bar's one action, and the bar's Back is the way out. */}
        <Page
          fill="viewport"
          bar={
            <PageBar
              title="Waypoint map"
              trail={trail}
              add={
                editing ? [{ ...addFromMap, onAction: () => setAddMode(!addMode) }] : undefined
              }
            />
          }
        >
          <FloatSlot
            float={float}
            kind="full"
            role="region"
            aria-label="Waypoint map"
            className="flex min-h-0 w-full flex-1 flex-col overflow-hidden border-t border-border"
          />
        </Page>
      </>
    );
  }

  return (
    <>
      {editor.loading || editor.loadError ? null : floatingContent}
    <Page
      width="wide"
      bar={
        // The form is the bar and the refusal under it (see the note at the
        // top). `contents`, so the bar still sticks to the page and not to
        // the form. It is there for a visitor too, with nothing to submit, so
        // the bar is not built again when an organiser's session resolves.
        <Form
          className="contents"
          onSubmit={async () => {
            if (!editing) return undefined;
            if (draft.rows.some((r) => fromRow(r) === null)) {
              return refusal("Every waypoint needs valid coordinates before saving");
            }
            // Backstop for codes typed by hand: clean here rather than fight
            // the field keystroke by keystroke, and show the result in the
            // list, so what is saved is what is on screen.
            const { draft: cleaned, changes } = cleanCodes(draft);
            if (changes.length > 0) {
              editor.update(() => cleaned);
              const note = describeCodeChanges(changes);
              if (note) toast.warning(note);
            }
            const waypoints = validRecords(cleaned.rows);
            saving.current = waypoints;
            return api.api.comp[":comp_id"].waypoints.$put({
              param: { comp_id: compId },
              json: { waypoints },
            });
          }}
          onPendingChange={editor.setSaving}
          onSuccess={(res) => {
            // Nothing was sent (a visitor's form has nothing to send).
            if (!res) return;
            const waypoints = saving.current;
            editor.markSaved(waypoints);
            toast.success(`Saved ${waypoints.length} waypoint${waypoints.length === 1 ? "" : "s"}`);
          }}
        >
          <PageBar
            title="Waypoints"
            trail={underComp(urlId, compName)}
            related={compPages(urlId, comp, isAdmin, "Waypoints")}
            actions={actions}
            add={adds}
            status={altitudeCheck.checking ? <Spinner label="Checking altitudes" /> : undefined}
            commit={
              // Live only while the draft differs from what is saved.
              editing ? (
                <SubmitButton className={commitClass} isDisabled={!dirty} pendingLabel="Saving">
                  Save
                </SubmitButton>
              ) : undefined
            }
            below={
              // Narrows a long set, for an organiser and a visitor alike.
              // Nothing re-orders: the file's own order is the order.
              <SearchField
                variant="floating"
                aria-label="Filter waypoints"
                placeholder="Filter by code, name or coordinates…"
                value={filter}
                onChange={setFilter}
                // Enter is the field's own, and does nothing: without this it
                // would submit the form the bar is in, and that is Save.
                onSubmit={() => {}}
              />
            }
          />
          <FormErrorBanner className="mx-auto w-full max-w-6xl px-gutter-safe pt-3" />
        </Form>
      }
    >
      {editing ? (
        <input
          ref={fileInput}
          type="file"
          accept=".wpt,.cup,.csv,.txt,.gpx,.kml"
          aria-label="Upload a waypoint file"
          className="hidden"
          onChange={(e) => {
            void loadFile(e.target.files?.[0] ?? null);
            // So that choosing the same file again is a change.
            e.target.value = "";
          }}
        />
      ) : null}

      {/* The QR, when ⋯ asks for it: information, so it is on the page. */}
      {device.panel}

      {isAdmin ? (
        <DraftNotices
          className="mb-4"
          serverChanged={editor.serverChanged}
          notKept={editor.notKept}
          changed="The saved waypoints have changed since these edits were started. Saving replaces them with the list below."
        />
      ) : null}
      {/* Not "this competition has no waypoints" (#481): they failed to
          arrive, and an empty editor's Save would replace the real ones. */}
      {editor.loadError ? (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>
            Could not load the waypoints. Reload the page to try again.
          </AlertDescription>
        </Alert>
      ) : null}

      {editor.loading ? (
        <Loading className="text-sm">Loading waypoints…</Loading>
      ) : editor.loadError ? null : (
        <>
          {/* One line of state above the list: what the filter left, and
              whether there is anything to save. Both are live regions, so
              they are here before they have anything to say. While the map
              floats, the count that is under it in the column is here. */}
          <div className="mb-2 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {isAdmin ? <span role="status">{dirty ? "Unsaved changes" : ""}</span> : null}
            <span aria-live="polite">
              {query ? `${visibleRows.length} of ${rows.length} match` : ""}
            </span>
            {mode != null ? <span className="ms-auto">{countLine}</span> : null}
          </div>
          <MasterDetail
            detailLabel={MAP_LABEL}
            detailAriaLabel="Waypoint map"
            floating={float}
            defaultMasterShare={0.5}
            // A map wants the whole line, not the chart pane's 35rem cap.
            paneWidthClassName="w-full"
            paneWrapClassName={PANE_WRAP}
            // Side by side the column starts lower than MasterDetail assumes.
            paneClassName="@5xl:max-h-[calc(100vh-9.5rem)]"
            // No `detail`: the pane is the map's place, side by side. The map
            // itself is rendered once, above, and is moved there, into its
            // window or onto its own page (FloatingContent).
            master={
              // One list, at every width, for everyone. An admin's rows open
              // the waypoint's page; a visitor's do not, and that is the only
              // difference (see WaypointList).
              <div ref={listRef} className={CLEAR}>
                <WaypointList
                  rows={visibleRows}
                  emptyMessage={
                    rows.length > 0 && query ? `No waypoints match “${filter.trim()}”.` : undefined
                  }
                  onOpen={
                    isAdmin
                      ? (id) => navigate(compWaypointPath(urlId, compName, id))
                      : undefined
                  }
                  onLocate={locate}
                />
              </div>
            }
          />
        </>
      )}
    </Page>
    </>
  );
}
