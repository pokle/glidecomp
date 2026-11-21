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
 * mobile-first rule in CLAUDE.md. A visitor's six-column RAC Table went the
 * same way and for the same reason, a little later: it sat in its own
 * sideways-scrolling region, so the shape the editor had stopped using
 * survived for the PILOT, who is the one actually on the hill.
 *
 * **The editor is pages, over one draft** (#811). One waypoint, Add waypoint,
 * the map at full size and the altitude review were sheets and a dialog over
 * this page until 2026-11, and are pages of their own now (the overlays rule
 * in CLAUDE.md). What they edit is the waypoint FILE, saved as a set — so the
 * file is a draft in this tab's storage (comp/waypoints-draft.ts,
 * comp/use-waypoints-editor.ts) that every one of them reads and writes, and
 * Save here sends it.
 *
 * The read-only content (heading, list, download links) is server-rendered
 * via loadCompWaypoints so the page has real content for crawlers; the map
 * (mapbox) stays client-only — the server streams its "Loading map…"
 * fallback — and so does the draft, which only the browser has.
 *
 * List and map are laid out by the shared {@link MasterDetail}: the map is
 * the pinned pane on a phone (so a row's locate pin flies a map that is on
 * screen) and the sticky right-hand column on a wide screen. The pane is a
 * few centimetres tall there, so the map also opens at full size, on a page
 * of its own (pages/CompWaypointsMapPage.tsx) — enough room to walk a valley
 * dropping points one after another.
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
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { cn } from "@/react/lib/utils";
import { useNavigate } from "react-router-dom";
import { useInView } from "../lib/use-in-view";
import { NotFound } from "@/react/components/NotFound";
import {
  ImportIcon,
  MapPinPlusIcon,
  MapPinXIcon,
  Maximize2Icon,
  MountainIcon,
  PlusIcon,
  Undo2Icon,
} from "lucide-react";
import { cleanWaypointCodes, describeCodeChanges, parseWaypointFile } from "@glidecomp/engine";
import type { MapWaypoint } from "../../analysis/map-provider";
import { Button, LinkButton } from "@/react/rac/button";
import { Alert, AlertDescription } from "@/react/rac/alert";
import {
  DetailFoldButton,
  MasterDetail,
  useDetailFold,
} from "@/react/components/MasterDetail";
import { Loading, Spinner } from "@/react/rac/progress";
import { Page, PageBar, commitClass, type BarAction } from "@/react/rac/page-bar";
import { SearchField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton, refusal } from "@/react/rac/form";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { compPages, underComp } from "../lib/crumbs";
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
 * The map pane's noun — on its fold toggle ("Hide map" / "Show map") and, as
 * MasterDetail's default `storageKey`, the name the reader's answer is
 * remembered under. One constant because the toggle is rendered by this page
 * and the pane by MasterDetail: two literals could drift apart, and the fold
 * would then be remembered under a name nothing reads back.
 */
const MAP_LABEL = "map";

/**
 * Where the map pane sticks, over MasterDetail's own offsets, which are for a
 * bar with no second layer. The bar with the filter under it is 60 px, the
 * 48 px field and its 8 px, and the notch: 7.5rem clears it and its shadow.
 * Stacked, the pane sticks there; on a short screen the bar does not stick,
 * so the pane sticks at the top (the arbitrary variant sorts last, so it
 * wins). Side by side, the same, with a little air.
 * The bleed is the page's 1rem gutter at every width: MasterDetail's `page`
 * bleed is 1.5rem from `sm`, which would hang 8 px off each side of the
 * screen and scroll the page sideways.
 */
const PANE_WRAP = cn(
  // Whole class strings, because Tailwind scans for them.
  "top-[calc(7.5rem+env(safe-area-inset-top,0px))] max-sm:top-[calc(7.5rem+env(safe-area-inset-top,0px))]",
  "[@media(max-height:500px)]:top-0",
  "@5xl:top-[calc(8rem+env(safe-area-inset-top,0px))]",
  "sm:-mx-4 sm:px-4"
);

/**
 * Focus must not stop behind the bar or the pinned map (WCAG 2.4.11). A row
 * of the list is a `role="row"`, which MasterDetail's own clearances do not
 * name, and its buttons are cleared there for a bar with no filter — hence
 * the `!`. Stacked with the map showing: the bar, then the pane's 19rem
 * (`sm`: 23rem) cap and its padding. Folded, or side by side: the bar alone.
 * Whole class strings, because Tailwind scans for them.
 */
const CLEAR_OPEN =
  "[&_[role=row]]:scroll-mt-[28rem] [&_button]:scroll-mt-[28rem]! sm:[&_[role=row]]:scroll-mt-[32rem] sm:[&_button]:scroll-mt-[32rem]!";
const CLEAR_FOLDED = "[&_[role=row]]:scroll-mt-36 [&_button]:scroll-mt-36!";
const CLEAR_WIDE = "@5xl:[&_[role=row]]:scroll-mt-36 @5xl:[&_button]:scroll-mt-36!";

export function CompWaypoints() {
  const editor = useWaypointsEditor();
  const { comp, compId, urlId, compName, isAdmin, draft, dirty } = editor;
  const navigate = useNavigate();
  const leave = useLeave();
  const confirm = useConfirm();
  // The map's fold, owned here rather than by MasterDetail so its toggle can
  // ride the line above the list instead of taking a row of its own.
  const mapFold = useDetailFold(MAP_LABEL);

  // Settle the address bar on the canonical `${slug}-${id}` once the name loads.
  useCanonicalPath(compName ? compWaypointsPath(urlId, compName) : null);

  const rows = draft.rows;
  const altitudeCheck = useAltitudeCheck(editor);
  // Mapbox (764 KB) waits until the panel nears the viewport — see use-in-view.
  const [mapRef, mapInView] = useInView<HTMLDivElement>();
  // Armed by "Add from map": the next tap opens Add waypoint on that point,
  // and disarms it — on a map this small, the tap after that should pan.
  const [addMode, setAddMode] = useState(false);
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

  // Fly the map to a row's coordinates (bumping the key so a repeat press on
  // the same row re-centres). No-op when the row's coordinates aren't valid.
  const locate = useCallback((r: Pick<WpRow, "coords">) => {
    const c = parseCoords(r.coords);
    if (c) setFocus({ lat: c.lat, lon: c.lon, key: ++focusSeq.current });
  }, []);

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

  /** Arm the map for one tap, with the map on screen to take it. */
  function toggleAddFromMap() {
    if (!addMode && mapFold.collapsed) mapFold.onToggle();
    setAddMode(!addMode);
  }

  const mapFallback = (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  );

  const bareId = editor.bareId;

  // ⋯: the editing actions (an organiser's, once the waypoints are here),
  // then the device rows (everyone's), then the way to throw the draft away
  // — only while there is one to throw away.
  const actions: BarAction[] = [
    ...(editing
      ? [
          {
            id: "add",
            icon: PlusIcon,
            label: "Add waypoint",
            to: compWaypointsNewPath(urlId, compName),
          },
          {
            id: "add-from-map",
            icon: addMode ? MapPinXIcon : MapPinPlusIcon,
            label: addMode ? "Stop adding from map" : "Add from map",
            onAction: toggleAddFromMap,
          },
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

  return (
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
          {/* One line of state above the list, with the map's fold at its
              end: what the filter left, and whether there is anything to
              save. Both are live regions, so they are here before they have
              anything to say.

              `@container` because DetailFoldButton hides itself side by side
              with the same `@5xl:` query MasterDetail splits on, and a
              container query with no container ancestor never matches. */}
          <div className="@container mb-2">
            <div className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              {isAdmin ? <span role="status">{dirty ? "Unsaved changes" : ""}</span> : null}
              <span aria-live="polite">
                {query ? `${visibleRows.length} of ${rows.length} match` : ""}
              </span>
              <DetailFoldButton fold={mapFold} detailLabel={MAP_LABEL} className="ms-auto" />
            </div>
          </div>
          <MasterDetail
            detailLabel={MAP_LABEL}
            fold={mapFold}
            detailAriaLabel="Waypoint map"
            bleed="page"
            defaultMasterShare={0.5}
            // A map wants the whole line, not the chart pane's 35rem cap.
            paneWidthClassName="w-full"
            paneWrapClassName={PANE_WRAP}
            // Side by side the column starts lower than MasterDetail assumes.
            paneClassName="@5xl:max-h-[calc(100vh-9.5rem)]"
            detail={
              <div>
                {/* Explicit heights: Mapbox renders nothing into an unsized
                    container. Stacked they fit under the pane's caps with the
                    control row; side by side the taller map is the point. */}
                <div ref={mapRef} className="h-56 sm:h-72 @5xl:h-[520px]">
                  {!mapInView ? (
                    mapFallback
                  ) : (
                    <Suspense fallback={mapFallback}>
                      <RouteMap
                        task={null}
                        waypoints={mapWaypoints}
                        addMode={addMode}
                        fitNonce={fitNonce}
                        focus={focus}
                        placeSearch={isAdmin}
                        // Where the full-size map was left, if it was: one view
                        // across both pages (see waypointCameras).
                        initialCamera={waypointCameras.get(bareId) ?? null}
                        onCameraChange={(camera) => waypointCameras.set(bareId, camera)}
                        onWaypointPick={() => {}}
                        onMapPick={(lat, lon, details) => {
                          setAddMode(false);
                          navigate(
                            compWaypointsNewPath(urlId, compName, newWaypointSearch(lat, lon, details)));
                        }}
                      />
                    </Suspense>
                  )}
                </div>
                {isAdmin ? (
                  <div className="flex flex-wrap items-center gap-2 p-2">
                    {/* Add from map is a row of ⋯; armed, the map says so
                        here, beside it, with the way to stop. */}
                    {addMode ? (
                      <>
                        <span role="status" className="text-sm font-medium">
                          Tap the map to place…
                        </span>
                        <Button variant="outline" size="sm" onPress={() => setAddMode(false)}>
                          Stop
                        </Button>
                      </>
                    ) : null}
                    {/* Stacked on a phone the pane is capped at ~19rem, which
                        leaves the map a few centimetres to place a point in.
                        At full size it gets the whole screen, and Add from map
                        goes with it. A link beside the map it enlarges, not a
                        row of ⋯: its place says what it is. */}
                    <LinkButton
                      variant="outline"
                      size="sm"
                      // Contains the visible label (WCAG 2.5.3) while saying
                      // WHAT is maximised for anyone reading the link alone.
                      aria-label="Maximise map"
                      href={compWaypointsMapPath(urlId, compName)}
                    >
                      <Maximize2Icon className="size-4" aria-hidden="true" />
                      Maximise
                    </LinkButton>
                    <span className="text-xs text-muted-foreground">
                      {rows.length} waypoint{rows.length === 1 ? "" : "s"}
                      {invalidCount > 0 ? ` · ${invalidCount} need valid coordinates` : ""}
                    </span>
                  </div>
                ) : (
                  <p className="p-2 text-xs text-muted-foreground">{rows.length} waypoints</p>
                )}
              </div>
            }
            master={
              // One list, at every width, for everyone. An admin's rows open
              // the waypoint's page; a visitor's do not, and that is the only
              // difference (see WaypointList).
              <div className={cn(mapFold.collapsed ? CLEAR_FOLDED : CLEAR_OPEN, CLEAR_WIDE)}>
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
  );
}
