/**
 * One turnpoint of a task's route (/comp/:c/task/:t/route/:n) — every field
 * it has, on a page of its own. ADMIN-ONLY and NOT SSR'd
 * (functions/comp/[[path]].ts serves it a noindex shell).
 *
 * It was a full-screen sheet over the route editor until #812, and is a page
 * for the reason every overlay became one (the overlays rule in CLAUDE.md):
 * Back, scroll, the keyboard and focus come from the browser. "Add turnpoint"
 * opens this page too, for the empty turnpoint it has just added.
 *
 * `:n` is the editor's row id (comp/route-draft.ts) — not the code, which is
 * edited here, and not the position, which a reorder changes.
 *
 * There is NO Cancel. Nothing here is saved: **every change goes straight into
 * the route's draft**, so Done and Back both keep it, and so does a reload;
 * the route editor's Save is what saves it, and its Cancel what throws the lot
 * away. Delete is the only way to lose a turnpoint here. (The sheet held a
 * draft of its own and applied it on the way out, because the editor behind
 * it repainted its map on every change; this page has no map, and a page's
 * way out is the browser's Back, which a draft held here would lose.) Done is
 * a kit form: coordinates that do not read as coordinates are refused under
 * their field.
 *
 * Start and goal settings are task-level (not a property of this turnpoint).
 * They are here when this turnpoint is the SSS or the last (goal), so the
 * cylinder you opened is where you change them. Type sits immediately above
 * those sections, because they depend on it.
 */
import { useMemo, useState } from "react";
import { useLocation, useParams } from "react-router-dom";
import { useFilter } from "react-aria-components";
import type { WaypointFileRecord } from "@glidecomp/engine";
import { NotFound } from "@/react/components/NotFound";
import { SectionHeader } from "../components/SectionHeader";
import { Breadcrumbs } from "@/react/rac/breadcrumbs";
import { Button, ToggleButton } from "@/react/rac/button";
import { ChoiceList } from "@/react/rac/choice-list";
import { NumberField, SearchField, TextField } from "@/react/rac/field";
import { Form, FormErrorBanner, SubmitButton } from "@/react/rac/form";
import { ListBox, ListBoxItem } from "@/react/rac/list-box";
import { AltitudeField, CoordsField, coordsProblem } from "../comp/fields";
import { underTaskRoute } from "../lib/crumbs";
import { compWaypointsPath, taskRouteTurnpointPath } from "../lib/slug";
import { useCanonicalPath } from "../lib/use-canonical-path";
import type { RouteRow } from "../comp/route-editor";
import { editTurnpoint, removeTurnpoint } from "../comp/route-draft";
import {
  RADIUS_PRESETS,
  draftWithRecord,
  radiusChipLabel,
  showGoalSettings,
  typeOptions,
  type TurnpointDraft,
} from "../comp/turnpoint-draft";
import { ADDING_TYPE, useRouteEditor, type RouteEditorState } from "../comp/use-route-editor";
import { routeEditorGate } from "../comp/RouteEditorGate";
import { RouteGoalSettings, RouteStartSettings } from "../comp/RouteSettings";


export function TaskRouteTurnpointPage() {
  const editor = useRouteEditor();
  const { rowId: rowParam } = useParams<{ rowId: string }>();
  const id = Number(rowParam);
  const { urlId, compName, taskId, taskName } = editor;
  // Removed on its way out: the page stays as it was until it has gone,
  // rather than flash "not found" for the turnpoint it has just removed.
  const [leaving, setLeaving] = useState<RouteRow | null>(null);

  const found = editor.draft.rows.find((r) => r.id === id) ?? null;
  const row = found ?? leaving;
  useCanonicalPath(
    row && editor.comp && editor.task && editor.current
      ? taskRouteTurnpointPath(urlId, compName, taskId, taskName, id)
      : null
  );

  const gate = routeEditorGate(editor);
  if (gate) return gate;
  // A turnpoint removed since the link was made, or never in this route.
  if (!row) return <NotFound title="Turnpoint not found" />;

  return (
    <TurnpointForm
      editor={editor}
      row={row}
      onDelete={() => {
        setLeaving(row);
        editor.update((d) => removeTurnpoint(d, row.id));
        editor.leave();
      }}
    />
  );
}

function TurnpointForm({
  editor,
  row,
  onDelete,
}: {
  editor: RouteEditorState;
  row: RouteRow;
  onDelete: () => void;
}) {
  const location = useLocation();
  const { urlId, compName, taskId, taskName, openDistance, waypoints, wpLoading } = editor;
  const rows = editor.draft.rows;
  // Opened by "Add turnpoint", with the Type it started as (history state, so
  // a reload keeps it).
  const addingType = (location.state as Record<string, unknown> | null)?.[ADDING_TYPE] as
    | RouteRow["type"]
    | undefined;
  const adding = addingType !== undefined;
  const isLast = rows[rows.length - 1]?.id === row.id;
  const showGoal = showGoalSettings(
    adding ? { openDistance, addingType } : { openDistance, isLast }
  );

  // The waypoint search query. Controlled so picking a waypoint can clear it
  // and so the filtering below can see it.
  const [wpQuery, setWpQuery] = useState("");
  const { contains } = useFilter({ sensitivity: "base" });
  /** Said out loud when a change of Type sends this turnpoint to the end. */
  const [moveNote, setMoveNote] = useState("");

  const radius = Number(row.radius);
  // Blank is "altitude unknown" and stays blank in the draft; the field spells
  // that NaN.
  const altitudeM = String(row.altitude ?? "").trim() === "" ? NaN : Number(row.altitude);
  const label = row.name || "turnpoint";

  /** Change this turnpoint, in the draft, now. */
  const set = (patch: Partial<TurnpointDraft>) => {
    let moved = false;
    editor.update((d) => {
      const r = editTurnpoint(d, row.id, patch);
      moved = r.movedToEnd;
      return r.draft;
    });
    if (moved) setMoveNote(`${String(row.name).trim() || "Turnpoint"} is now last — the goal`);
  };

  // Load a competition waypoint's details into this turnpoint, and clear the
  // search so the list collapses. The conversion itself lives in
  // turnpoint-draft.ts.
  const applyWaypoint = (rec: WaypointFileRecord) => {
    set(draftWithRecord(row, rec));
    setWpQuery("");
  };

  // All waypoints as keyed items, narrowed to the query. Matching happens here
  // — on code AND name, the same text each item exposes as its textValue.
  const wpItems = useMemo(() => {
    const all = waypoints.map((w, i) => ({
      id: `${w.code}-${i}`,
      record: w,
      text: w.name !== w.code ? `${w.code} ${w.name}` : w.code,
    }));
    const q = wpQuery.trim();
    // Empty query → no items, so the list stays out of the way until you
    // actually search.
    return q === "" ? [] : all.filter((it) => contains(it.text, q));
  }, [waypoints, wpQuery, contains]);

  const title = adding ? "Add turnpoint" : "Edit turnpoint";

  return (
    <div className="max-w-2xl">
      <Breadcrumbs
        items={underTaskRoute(urlId, compName, taskId, taskName)}
        current={row.name || "Turnpoint"}
      />
      <Form
        validate={() => ({ coords: coordsProblem(String(row.coords)) })}
        // Nothing to send: every change is in the draft already.
        onSuccess={() => editor.leave()}
      >
        {/* Done where the sheet had it, top right: in reach without scrolling
            past the whole form. */}
        <SectionHeader as="h1" className="mt-2" title={title} action={<SubmitButton>Done</SubmitButton>} />
        <FormErrorBanner className="mt-3" />
        <p role="status" aria-live="polite" className="sr-only">
          {moveNote}
        </p>
        <div className="mt-4 flex flex-col gap-4">
          {/* Load from a preset competition waypoint. */}
          {wpLoading ? (
            <p className="text-xs text-muted-foreground">Loading competition waypoints…</p>
          ) : waypoints.length === 0 ? (
            <p className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
              This competition has no waypoints yet — enter the coordinates below, or{" "}
              <a
                href={compWaypointsPath(urlId, compName)}
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                manage all waypoints
              </a>
              .
            </p>
          ) : (
            // Type to filter, arrow-key/Enter to pick — IN FLOW, not in a
            // popover (#638): a list that scrolls with the form can't be
            // covered by a phone keyboard.
            //
            // Deliberately NOT `SearchableChoiceList`: that binds a value and
            // shows it on a collapsed row. This is an ACTION — picking a
            // waypoint copies its details into the turnpoint below and leaves
            // nothing selected, so re-picking the same one must fire again.
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
                  // Nothing stays selected; the pick is the whole event.
                  selectedKeys={[]}
                  onSelectionChange={(keys) => {
                    const key = keys === "all" ? null : [...keys][0];
                    if (key == null) return;
                    const item = wpItems.find((it) => it.id === String(key));
                    if (item) applyWaypoint(item.record);
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
          )}

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
          {/* Always metres: a cylinder's radius is the task's own number (the
              altitude rule in CLAUDE.md). */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Radius (m)</span>
            <div
              role="group"
              aria-label={`Radius of ${label} in metres`}
              className="flex flex-wrap items-center gap-1"
            >
              {RADIUS_PRESETS.map((preset) => (
                <ToggleButton
                  key={preset}
                  size="sm"
                  isSelected={radius === preset}
                  // Chips set an absolute value; re-pressing the active one is
                  // a no-op (the toggle-off event re-sets the same value).
                  onChange={() => set({ radius: preset })}
                  className="h-7 px-2 tabular-nums"
                  aria-label={`Set radius ${preset} metres`}
                >
                  {radiusChipLabel(preset)}
                </ToggleButton>
              ))}
              <NumberField
                aria-label={`Custom radius of ${label} in metres`}
                minValue={1}
                maxValue={50000}
                // Step stays 1: RAC snaps values to minValue + k·step, so a
                // larger step corrupts loaded radii (1000 → 1001, step 100).
                step={1}
                // Group thousands so the widest radius reads "50,000".
                formatOptions={{ useGrouping: true }}
                value={Number.isFinite(radius) ? radius : NaN}
                onChange={(v) => set({ radius: Number.isFinite(v) ? v : "" })}
                className="w-36"
              />
            </div>
          </div>
          <CoordsField value={String(row.coords)} onChange={(v) => set({ coords: v })} />
          <AltitudeField
            description="Waypoint altitude, optional"
            valueM={altitudeM}
            onChange={(m) => set({ altitude: Number.isFinite(m) ? m : "" })}
          />

          {/* S7F 2026 §6.2.1 altitude limits (issue #600). Not on the goal,
              which cannot have them (§6.2.3) — the elevated goal in the Goal
              settings is how a goal sets an altitude. */}
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
                description="Optional (FAI S7F §6.2.1). A crossing of this cylinder counts only between these altitudes, within 5 m. Leave both blank for no limits."
              />
            </section>
          ) : null}

          {/* Type sits here, not with the identity fields: Start and Goal
              settings appear or vanish from this choice, so the switch has to
              be the thing immediately above them. */}
          <ChoiceList
            label="Type"
            value={row.type}
            onChange={(v) => set({ type: v as RouteRow["type"] })}
            options={typeOptions({ lastIsGoal: showGoal })}
          />
          {row.type === "SSS" && !openDistance ? (
            <section className="flex flex-col gap-1 border-t border-border pt-3">
              <h2 className="text-sm font-medium">Start Speed Section (SSS)</h2>
              <RouteStartSettings editor={editor} />
            </section>
          ) : null}
          {(showGoal || row.type === "GOAL") && !openDistance ? (
            <section className="flex flex-col gap-1 border-t border-border pt-3">
              <h2 className="text-sm font-medium">Goal</h2>
              <RouteGoalSettings editor={editor} />
            </section>
          ) : null}

          {/* No confirmation: this removes a turnpoint from a route that is
              still a draft, and the route editor's Cancel puts the whole saved
              route back. Not while adding: an Add left empty is dropped. */}
          {!adding ? (
            <div className="mt-4 border-t border-border pt-4">
              <Button variant="destructive" className="w-fit" onPress={onDelete}>
                Delete turnpoint
              </Button>
            </div>
          ) : null}
          <p className="text-xs text-muted-foreground">
            Nothing is saved until you press Save on the route.
          </p>
        </div>
      </Form>
    </div>
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
