/**
 * The one-turnpoint editor behind the route grid's Add and Edit.
 *
 * Split out of RouteEditorDialog, which held it below the dialog that opens
 * it. Draft-first: nothing here touches the route until Save, so cancelling
 * discards cleanly.
 */
import { useMemo, useState } from "react";
import { useFilter } from "react-aria-components";
import type { WaypointFileRecord } from "@glidecomp/engine";
import { Button, ToggleButton } from "@/react/rac/button";
import { ComboBox, ComboBoxItem } from "@/react/rac/combo-box";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { NumberField, TextField } from "@/react/rac/field";
import { SimpleSelect } from "@/react/rac/select";
import { formatCoords, parseCoords, type RouteRow } from "./route-editor";
import {
  RADIUS_PRESETS,
  TYPE_OPTIONS,
  radiusChipLabel,
  type TurnpointDraft,
} from "./turnpoint-draft";

/**
 * Add / edit one turnpoint. A self-contained dialog over a local draft: it
 * loads from a competition waypoint via the search field at the top, or takes
 * every field by hand (code, name, type, radius chips + custom NumberField,
 * coordinates, altitude). Nothing touches the route until Save — so adding is
 * draft-first (Cancel adds nothing) and editing is atomic (Cancel keeps the
 * turnpoint as it was). The parent's onSave appends (add) or patches (edit).
 */
export function TurnpointDetailsDialog({
  mode,
  initial,
  waypointRecords,
  wpLoading,
  compId,
  onSave,
  onClose,
}: {
  mode: "add" | "edit";
  initial: TurnpointDraft;
  waypointRecords: WaypointFileRecord[];
  wpLoading: boolean;
  compId: string;
  onSave: (draft: TurnpointDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<TurnpointDraft>(initial);
  // The waypoint ComboBox's query. Controlled so picking a waypoint can clear
  // it (see applyWaypoint) and so the filtering below can see it.
  const [wpQuery, setWpQuery] = useState("");
  const { contains } = useFilter({ sensitivity: "base" });
  const radius = Number(draft.radius);
  const label = draft.name || "turnpoint";

  const patch = (p: Partial<TurnpointDraft>) => setDraft((d) => ({ ...d, ...p }));

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

  // All waypoints as keyed items, narrowed to the query. ComboBox does no
  // filtering of its own for a controlled `items`, so match here — on code AND
  // name, the same text each item exposes as its textValue.
  const wpItems = useMemo(() => {
    const all = waypointRecords.map((w, i) => ({
      id: `${w.code}-${i}`,
      record: w,
      text: w.name !== w.code ? `${w.code} ${w.name}` : w.code,
    }));
    const q = wpQuery.trim();
    // Empty query → no items, so the popover stays shut until you actually
    // search. It also makes Esc work: RAC's Esc reverts the query to empty,
    // and an empty collection is what lets the popover close instead of
    // immediately reopening on the resulting input change.
    return q === "" ? [] : all.filter((it) => contains(it.text, q));
  }, [waypointRecords, wpQuery, contains]);

  const canSave = draft.name.trim() !== "" && parseCoords(draft.coords) != null;

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col p-0 sm:max-w-md"
    >
      <Dialog className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "Add turnpoint" : "Edit turnpoint"}
          </DialogTitle>
        </DialogHeader>

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
          // Type to filter, arrow-key/Enter to pick without leaving the field.
          // Matches float in a popover, so they can't be clipped or squashed by
          // this dialog's scroll container and they flip above the field when
          // there's no room below (short window, phone with the keyboard up).
          //
          // selectedKey is pinned to null: picking a waypoint copies its values
          // into the draft below rather than leaving the combobox "holding" a
          // selection, and re-picking the same one must fire again.
          <ComboBox
            label="Load from a waypoint"
            placeholder={`Search ${waypointRecords.length} waypoints…`}
            items={wpItems}
            inputValue={wpQuery}
            onInputChange={setWpQuery}
            selectedKey={null}
            onSelectionChange={(key) => {
              // With BOTH selectedKey and inputValue controlled, react-stately
              // hands us every commit and makes syncing inputValue our job
              // (useComboBoxState: "it's the user's responsibility to update
              // inputValue in onSelectionChange"). That includes key === null
              // on the Esc/blur revert — clearing the query there is what
              // actually lets the popover close, and what stops a stale query
              // sitting in a field that looks like it's still filtering.
              if (key == null) {
                setWpQuery("");
                return;
              }
              const item = wpItems.find((it) => it.id === key);
              if (item) applyWaypoint(item.record);
            }}
            // Only while searching: an empty collection must close the popover
            // when the query is empty, but stay open to say "No matches".
            allowsEmptyCollection={wpQuery.trim() !== ""}
            listClassName="max-h-48"
            renderEmptyState={() => (
              <p className="px-2 py-1.5 text-sm text-muted-foreground">
                No matches
              </p>
            )}
          >
            {(item: { id: string; record: WaypointFileRecord; text: string }) => (
              <ComboBoxItem id={item.id} textValue={item.text}>
                <span className="font-medium">{item.record.code}</span>
                {item.record.name !== item.record.code ? (
                  <span className="truncate text-muted-foreground">
                    {item.record.name}
                  </span>
                ) : null}
              </ComboBoxItem>
            )}
          </ComboBox>
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
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium">Type</span>
          <SimpleSelect
            value={draft.type}
            onChange={(v) => patch({ type: v as RouteRow["type"] })}
            options={TYPE_OPTIONS}
            ariaLabel={`Type of ${label}`}
            className="w-full [&_button]:w-full"
          />
        </div>
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
        <TextField
          label="Altitude (m)"
          description="Waypoint altitude, optional"
          value={String(draft.altitude ?? "")}
          onChange={(v) => patch({ altitude: v })}
          placeholder="0"
        />

        <DialogFooter className="mt-1">
          <Button slot="close" variant="outline">
            Cancel
          </Button>
          <Button
            isDisabled={!canSave}
            onPress={() => {
              onSave(draft);
              onClose();
            }}
          >
            {mode === "add" ? "Add turnpoint" : "Save"}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
