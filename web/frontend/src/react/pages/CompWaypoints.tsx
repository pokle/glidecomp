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
 * Nothing is saved until Save, which is why Save is in a bar that sticks to
 * the foot of the screen (the end of the work, always in reach). Leaving the
 * editor by a link with edits outstanding asks first; Back and a reload keep
 * the draft for later.
 */
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useInView } from "../lib/use-in-view";
import { NotFound } from "@/react/components/NotFound";
import { FileTrigger } from "react-aria-components";
import { Maximize2Icon } from "lucide-react";
import { cleanWaypointCodes, describeCodeChanges, parseWaypointFile } from "@glidecomp/engine";
import type { MapWaypoint } from "../../analysis/map-provider";
import { Button, LinkButton, ToggleButton } from "@/react/rac/button";
import { Alert, AlertDescription } from "@/react/rac/alert";
import {
  DetailFoldButton,
  MasterDetail,
  useDetailFold,
} from "@/react/components/MasterDetail";
import { Loading } from "@/react/rac/progress";
import { SearchField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton, refusal } from "@/react/rac/form";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { underComp } from "../lib/crumbs";
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
import { WaypointDeviceExport } from "../comp/WaypointDeviceExport";
import { CompSectionNav } from "../comp/CompSectionNav";
import {
  WAYPOINTS_DISCARD,
  useAltitudeCheck,
  useWaypointsEditor,
  waypointCameras,
} from "../comp/use-waypoints-editor";
import { DraftNotices } from "../comp/DraftNotices";
import { openedHere } from "../lib/leave";
import {
  cleanCodes,
  fromRow,
  matchesFilter,
  replaceAll,
  validRecords,
  type WpRow,
} from "../comp/waypoints-draft";

const RouteMap = lazy(() => import("../comp/RouteMap"));

/**
 * The map pane's noun — on its fold toggle ("Hide map" / "Show map") and, as
 * MasterDetail's default `storageKey`, the name the reader's answer is
 * remembered under. One constant because the toggle is rendered by this page
 * and the pane by MasterDetail: two literals could drift apart, and the fold
 * would then be remembered under a name nothing reads back.
 */
const MAP_LABEL = "map";

export function CompWaypoints() {
  const editor = useWaypointsEditor();
  const { comp, compId, urlId, compName, isAdmin, draft, dirty } = editor;
  const navigate = useNavigate();
  const confirm = useConfirm();
  // The map's fold, owned here rather than by MasterDetail so its toggle can
  // ride the toolbar above instead of taking a row of its own (see the row).
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

  // The filter box, which narrows a long list. Nothing re-orders the list:
  // the file's own order is the order, for a visitor as for an organiser.
  const [filter, setFilter] = useState("");

  // Fly the map to a row's coordinates (bumping the key so a repeat press on
  // the same row re-centres). No-op when the row's coordinates aren't valid.
  const locate = useCallback((r: Pick<WpRow, "coords">) => {
    const c = parseCoords(r.coords);
    if (c) setFocus({ lat: c.lat, lon: c.lon, key: ++focusSeq.current });
  }, []);

  if (editor.notFound) return <NotFound title="Competition not found" />;

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
  const fromHere = openedHere();

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
      navigate(compAltitudeReviewPath(urlId, compName), fromHere);
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
    navigate(compPath(urlId, compName));
  }

  const mapFallback = (
    <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
      Loading map…
    </div>
  );

  /**
   * The map's fold toggle. Rides the END of the device-export row rather than
   * sitting beside it: an expanded QR makes that block tall and wide, and a
   * sibling would be pushed under the QR, floating above the map as though it
   * belonged to something else.
   */
  const mapFoldButton = (
    <DetailFoldButton fold={mapFold} detailLabel={MAP_LABEL} className="ms-auto" />
  );

  const bareId = editor.bareId;

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
      <Breadcrumbs items={underComp(urlId, compName)} current="Waypoints" />
      {/* The heading keeps the row to itself. Four buttons beside an h1 is the
          app's convention for a section with ONE manage action; here they
          wrapped under the title on a phone and read as page chrome, so the
          editing toolbar sits with the list it edits and Save sits at the
          bottom of the page — where the work ends. */}
      <h1 className="mt-1 text-2xl font-bold">Waypoints</h1>

      <CompSectionNav
        compId={urlId}
        compName={compName}
        taskCount={comp?.tasks?.length}
        waypointCount={comp ? (comp.waypoint_count ?? editor.saved.length) : undefined}
        pilotCount={comp?.pilot_count}
        scoringFormat={comp?.scoring_format}
        isAdmin={isAdmin}
      />

      {/* ONE row of buttons above the list. On the left, the pilot's
          download + QR (issue #312 stage 2) — visible to everyone, and keyed
          off the SAVED set rather than the editor's rows: a comp with nothing
          published has nothing to put on a device, and the scorer setting one
          up for the first time has one job, upload a file or add points from
          the map. On the right, the map's own fold toggle, which MasterDetail
          would otherwise give a whole row to for one right-aligned button.

          `@container` because DetailFoldButton hides itself side by side with
          the same `@5xl:` query MasterDetail splits on, and a container query
          with no container ancestor never matches. */}
      {!editor.loading ? (
        <div className="@container mb-4 mt-4">
          {editor.saved.length > 0 ? (
            <WaypointDeviceExport
              records={editor.saved}
              baseName={compName}
              noun="waypoint"
              hostedUrl={(fmt, swap) =>
                `/api/comp/${compId}/waypoints/${fmt}${swap ? "?swap=1" : ""}`
              }
              trailing={mapFoldButton}
            />
          ) : (
            // Nothing published yet, so no device buttons to share the row
            // with — the toggle keeps the right-hand end it would have had.
            <div className="flex">{mapFoldButton}</div>
          )}
        </div>
      ) : null}

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
        <MasterDetail
          detailLabel={MAP_LABEL}
          fold={mapFold}
          detailAriaLabel="Waypoint map"
          bleed="page"
          defaultMasterShare={0.5}
          // A map wants the whole line, not the chart pane's 35rem cap.
          paneWidthClassName="w-full"
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
                          compWaypointsNewPath(urlId, compName, newWaypointSearch(lat, lon, details)),
                          fromHere
                        );
                      }}
                    />
                  </Suspense>
                )}
              </div>
              {isAdmin ? (
                <div className="flex flex-wrap items-center gap-2 p-2">
                  <ToggleButton size="sm" isSelected={addMode} onChange={setAddMode}>
                    {addMode ? "Tap the map to place…" : "Add from map"}
                  </ToggleButton>
                  {/* Stacked on a phone the pane is capped at ~19rem, which
                      leaves the map a few centimetres to place a point in.
                      At full size it gets the whole screen, and Add from map
                      goes with it. */}
                  <LinkButton
                    variant="outline"
                    size="sm"
                    // Contains the visible label (WCAG 2.5.3) while saying
                    // WHAT is maximised for anyone reading the link alone.
                    aria-label="Maximise map"
                    href={compWaypointsMapPath(urlId, compName)}
                    routerOptions={fromHere}
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
            <div>
              {/* The editing actions, at the head of the thing they edit. */}
              {isAdmin ? (
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <FileTrigger
                    acceptedFileTypes={[".wpt", ".cup", ".csv", ".txt", ".gpx", ".kml"]}
                    onSelect={(files) => void loadFile(files?.[0] ?? null)}
                  >
                    <Button variant="outline" size="sm">
                      Upload file
                    </Button>
                  </FileTrigger>
                  <LinkButton
                    variant="outline"
                    size="sm"
                    href={compWaypointsNewPath(urlId, compName)}
                    routerOptions={fromHere}
                  >
                    Add waypoint
                  </LinkButton>
                  {/* ONE altitude action, and it reports nothing until it is
                      pressed. There used to be a "Fill altitudes from map"
                      beside it — an action that answered blanks without
                      asking — and a status line saying whether any blanks were
                      left. The check does the fill's job better (it shows what
                      it would write before writing it), and the status line
                      was a verdict on a set nobody had asked about yet. */}
                  <Button
                    variant="outline"
                    size="sm"
                    isDisabled={rows.length === 0}
                    isPending={altitudeCheck.checking}
                    pendingLabel="Checking altitudes"
                    onPress={() => void checkAltitudes()}
                  >
                    Check altitudes
                  </Button>
                </div>
              ) : null}
              {/* Filter box — narrows a long set, for an admin and a visitor
                  alike. Nothing re-orders: the file's own order is the order. */}
              {rows.length > 0 ? (
                <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <SearchField
                    aria-label="Filter waypoints"
                    placeholder="Filter by code, name or coordinates…"
                    value={filter}
                    onChange={setFilter}
                    className="min-w-40 flex-1 sm:max-w-xs"
                  />
                  {query ? (
                    <span className="text-xs text-muted-foreground" aria-live="polite">
                      {visibleRows.length} of {rows.length} match
                    </span>
                  ) : null}
                </div>
              ) : null}
              {/* One list, at every width, for everyone. An admin's rows open
                  the waypoint's page; a visitor's do not, and that is the only
                  difference (see WaypointList). */}
              <WaypointList
                rows={visibleRows}
                emptyMessage={
                  rows.length > 0 && query ? `No waypoints match “${filter.trim()}”.` : undefined
                }
                onOpen={
                  isAdmin
                    ? (id) => navigate(compWaypointPath(urlId, compName, id), fromHere)
                    : undefined
                }
                onLocate={locate}
              />
            </div>
          }
        />
      )}

      {/* Save, at the end of the work rather than up beside the title — and
          sticky to the BOTTOM OF THE SCREEN while the list is on it: the list
          and the map are both taller than a phone, so a Save an admin has to
          scroll past them to reach is a Save they will not find. Sticky, not
          fixed: a fixed bar has to be moved around the keyboard by hand (the
          overlays rule in CLAUDE.md).

          A kit form, so a refused save says why beside the button rather than
          in a toast. */}
      {isAdmin && !editor.loading && !editor.loadError ? (
        <Form
          className="sticky bottom-0 z-20 mt-6 border-t border-border bg-background/95 pt-3 pb-gutter-safe backdrop-blur-sm print:hidden"
          onSubmit={async () => {
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
          onSuccess={() => {
            const waypoints = saving.current;
            editor.markSaved(waypoints);
            toast.success(`Saved ${waypoints.length} waypoint${waypoints.length === 1 ? "" : "s"}`);
          }}
        >
          <FormErrorBanner className="mb-3" />
          {/* Save first, hint beside it — the /settings save-form order, and
              it leaves the bottom-RIGHT corner to the floating Preview-as
              pill, which would otherwise sit on top of the button. */}
          <div className="flex flex-wrap items-center gap-3">
            <SubmitButton isDisabled={!dirty}>Save</SubmitButton>
            {/* Back and a reload keep the draft (comp/waypoints-draft.ts), so
                this is the way to throw it away on purpose. */}
            {dirty ? (
              <Button variant="outline" onPress={() => void discard()}>
                Discard changes
              </Button>
            ) : null}
            {/* The hint doubles as the explanation for what Save will do;
                role=status so the state change is announced. */}
            <span role="status" className="text-sm text-muted-foreground">
              {dirty ? "Unsaved changes" : ""}
            </span>
          </div>
        </Form>
      ) : null}
    </main>
  );
}
