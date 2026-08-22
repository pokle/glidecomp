/**
 * The one-turnpoint editor — every field of a single turnpoint, at full
 * screen.
 *
 * It was a centred `Modal` (TurnpointDetailsDialog) whose panel scrolled
 * internally inside a `max-h-[calc(100dvh-2rem)]` box: a scrolling form inside
 * a scrolling page, on the surface most likely to be used one-handed on a
 * hill. Now it is a `rac/full-screen-sheet.tsx`, which reads as a page on a
 * phone while keeping the route editor MOUNTED behind it. That last part is
 * the reason it is not a route of its own: the whole route is unsaved React
 * state, a sibling route would unmount it, and — because
 * `lib/use-unsaved-changes-guard.ts` intercepts every same-origin anchor click
 * while the route is dirty — a row that linked anywhere would prompt
 * "Discard route changes?" on the way in.
 *
 * There is NO Cancel. Nothing here is saved: the turnpoint joins a draft
 * route, and the route editor's own Cancel is what throws the lot away. A
 * draft inside a draft is the confusing part, so Done and the back gesture do
 * the same thing — keep the edits — and Delete is the only way to lose a
 * turnpoint.
 *
 * The draft is applied on the way OUT rather than per keystroke: the editor
 * re-runs `buildRoute` and repaints the map preview on every change to `rows`,
 * which is what draft-on-save exists to avoid.
 */
import { useMemo, useRef, useState } from "react";
import { useFilter } from "react-aria-components";
import type { WaypointFileRecord } from "@glidecomp/engine";
import { Button, ToggleButton } from "@/react/rac/button";
import { FullScreenSheet } from "@/react/rac/full-screen-sheet";
import { NumberField, SearchField, TextField } from "@/react/rac/field";
import { AltitudeField } from "./fields";
import { ChoiceList } from "@/react/rac/choice-list";
import { ListBox, ListBoxItem } from "@/react/rac/list-box";
import { formatCoords, parseCoords, type RouteRow } from "./route-editor";
import {
  RADIUS_PRESETS,
  TYPE_OPTIONS,
  radiusChipLabel,
  type TurnpointDraft,
} from "./turnpoint-draft";

export function TurnpointSheet({
  mode,
  initial,
  waypointRecords,
  wpLoading,
  compId,
  onSave,
  onDelete,
  onClose,
}: {
  mode: "add" | "edit";
  initial: TurnpointDraft;
  waypointRecords: WaypointFileRecord[];
  wpLoading: boolean;
  compId: string;
  /** Apply the draft to the route: append (add) or patch (edit). */
  onSave: (draft: TurnpointDraft) => void;
  /** Remove this turnpoint from the route. Absent while adding. */
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TurnpointDraft>(initial);
  // The waypoint search query. Controlled so picking a waypoint can clear it
  // (see applyWaypoint) and so the filtering below can see it.
  const [wpQuery, setWpQuery] = useState("");
  const { contains } = useFilter({ sensitivity: "base" });
  const radius = Number(draft.radius);
  // Blank is "altitude unknown" and stays blank in the draft; the field spells
  // that NaN.
  const draftAltitudeM =
    String(draft.altitude ?? "").trim() === "" ? NaN : Number(draft.altitude);
  const label = draft.name || "turnpoint";

  // Everything that leaves this sheet keeps the edits — except a delete, which
  // must not then hand the deleted turnpoint back through onSave.
  const deletedRef = useRef(false);

  const patch = (p: Partial<TurnpointDraft>) => setDraft((d) => ({ ...d, ...p }));

  /**
   * Leave, keeping whatever was typed.
   *
   * A draft with neither a name nor coordinates is nothing to keep: dismissing
   * a freshly opened Add would otherwise leave a blank row in the list asking
   * to be filled in. Anything else is applied even when it's incomplete — the
   * list says what a turnpoint still needs, and the editor's Save stays blocked
   * until it has it, so a half-finished turnpoint is visible rather than lost.
   */
  function leave() {
    if (deletedRef.current) return onClose();
    const empty =
      String(draft.name).trim() === "" && String(draft.coords).trim() === "";
    if (!empty) onSave(draft);
    onClose();
  }

  // Load a competition waypoint's details into the draft (keep the type — a
  // waypoint doesn't carry one), and clear the search so the list collapses.
  const applyWaypoint = (rec: WaypointFileRecord) => {
    setDraft((d) => ({
      ...d,
      name: rec.code,
      description: rec.name !== rec.code ? rec.name : "",
      coords: formatCoords(rec.latitude, rec.longitude),
      radius: rec.radius > 0 ? rec.radius : d.radius,
      altitude: rec.altitude ? rec.altitude : "",
    }));
    setWpQuery("");
  };

  // All waypoints as keyed items, narrowed to the query. Matching happens here
  // — on code AND name, the same text each item exposes as its textValue.
  const wpItems = useMemo(() => {
    const all = waypointRecords.map((w, i) => ({
      id: `${w.code}-${i}`,
      record: w,
      text: w.name !== w.code ? `${w.code} ${w.name}` : w.code,
    }));
    const q = wpQuery.trim();
    // Empty query → no items, so the list stays out of the way until you
    // actually search.
    return q === "" ? [] : all.filter((it) => contains(it.text, q));
  }, [waypointRecords, wpQuery, contains]);

  return (
    <FullScreenSheet
      label={mode === "add" ? "Add turnpoint" : `Edit ${label}`}
      onClose={leave}
      className="flex flex-col"
    >
      {/* Title bar: the sheet's identity on the left, the way out on the
          right, where a phone's thumb already expects it. It stays put while
          the form scrolls, so Done is never something you scroll to find. */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
          {mode === "add" ? "Add turnpoint" : "Edit turnpoint"}
        </h2>
        <Button onPress={leave}>Done</Button>
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-3 overflow-y-auto p-4 pb-gutter-safe">
        {/* Load from a preset competition waypoint. */}
        {wpLoading ? (
          <p className="text-xs text-muted-foreground">
            Loading competition waypoints…
          </p>
        ) : waypointRecords.length === 0 ? (
          <p className="rounded border border-dashed border-border p-3 text-xs text-muted-foreground">
            This competition has no waypoints yet — enter the coordinates below,
            or{" "}
            <a
              href={`/comp/${compId}/waypoints`}
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-foreground"
            >
              manage all waypoints
            </a>
            .
          </p>
        ) : (
          // Type to filter, arrow-key/Enter to pick — but IN FLOW, not in a
          // popover (#638): a list that scrolls with the form can't be covered
          // by a phone keyboard.
          //
          // Deliberately NOT `SearchableChoiceList`: that binds a value and
          // shows it on a collapsed row. This is an ACTION — picking a
          // waypoint copies its details into the draft below and leaves
          // nothing selected, so re-picking the same one must fire again.
          <div className="flex flex-col gap-2">
            <SearchField
              label="Load from a waypoint"
              autoFocus={mode === "add"}
              placeholder={`Search ${waypointRecords.length} waypoints…`}
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
                  <p className="px-2 py-1.5 text-sm text-muted-foreground">
                    No matches
                  </p>
                )}
              >
                {(item: { id: string; record: WaypointFileRecord; text: string }) => (
                  <ListBoxItem
                    id={item.id}
                    textValue={item.text}
                    className="min-h-11 items-center gap-2"
                  >
                    <span className="font-medium">{item.record.code}</span>
                    {item.record.name !== item.record.code ? (
                      <span className="truncate text-muted-foreground">
                        {item.record.name}
                      </span>
                    ) : null}
                  </ListBoxItem>
                )}
              </ListBox>
            ) : null}
          </div>
        )}

        <TextField
          label="Code"
          value={draft.name}
          onChange={(v) => patch({ name: v })}
          placeholder="A01"
        />
        <TextField
          label="Name"
          description="Full descriptive name (optional)"
          value={draft.description}
          onChange={(v) => patch({ description: v })}
          placeholder="Bordano Landing"
        />
        {/* The visible label names it; `aria-labelledby` from that Label
            would beat an aria-label anyway, and the sheet title plus the Code
            field above already say which turnpoint. */}
        <ChoiceList
          label="Type"
          value={draft.type}
          onChange={(v) => patch({ type: v as RouteRow["type"] })}
          options={TYPE_OPTIONS}
        />
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
                // Chips set an absolute value; re-pressing the active one is a
                // no-op (the toggle-off event re-sets the same value).
                onChange={() => patch({ radius: preset })}
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
              onChange={(v) => patch({ radius: Number.isFinite(v) ? v : "" })}
              className="w-36"
            />
          </div>
        </div>
        <TextField
          label="Coordinates (lat, lon)"
          value={draft.coords}
          onChange={(v) => patch({ coords: v })}
          placeholder="-36.550979, 147.890395"
          validate={(v) =>
            v.trim() === "" || parseCoords(v)
              ? null
              : 'Enter "lat, lon" decimal degrees'
          }
        />
        <AltitudeField
          description="Waypoint altitude, optional"
          valueM={draftAltitudeM}
          onChange={(m) => patch({ altitude: Number.isFinite(m) ? m : "" })}
        />

        {/* No confirmation: this removes a turnpoint from a route that is
            still a draft, and the editor's Cancel puts the whole saved route
            back. */}
        {onDelete ? (
          <Button
            variant="destructive"
            className="mt-2 w-fit"
            onPress={() => {
              deletedRef.current = true;
              onDelete();
              onClose();
            }}
          >
            Delete turnpoint
          </Button>
        ) : null}
      </div>
    </FullScreenSheet>
  );
}
