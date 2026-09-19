/**
 * The one-waypoint editor — every field of a single waypoint, at full screen.
 *
 * The phone half of the waypoints page. A 145-row spreadsheet with eight
 * columns is the right tool on a desktop and the wrong one on a phone: the
 * grid scrolls sideways inside a page that scrolls down, beneath a map pane
 * that sticks, and the frozen Code column hides the columns next to it. So a
 * phone gets a LIST of waypoints (WaypointList) whose rows open this.
 *
 * Deliberately the same shape as comp/TurnpointSheet: a draft applied on the
 * way OUT, no Cancel, and Remove as the only way to lose the waypoint. The
 * draft matters here for the same reason it does there — the page repaints its
 * map markers from `rows` on every change, which per-keystroke editing would
 * do on every letter of a name.
 *
 * Metric throughout, like the grid it stands in for: this is the waypoint FILE
 * edited in place, so altitude and radius are both the file's own metres and
 * the labels say so (see the altitude rule in CLAUDE.md).
 */
import { useState } from "react";
import { MapPinIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/react/rac/button";
import { FullScreenSheet } from "@/react/rac/full-screen-sheet";
import { NumberField, TextField } from "@/react/rac/field";
import { formatCylinderRadius } from "../lib/units";
import { parseCoords } from "./route-editor";
import { RADIUS_PRESETS, radiusChipLabel } from "./turnpoint-draft";

/** The editable fields of one waypoint, as strings — the grid's row shape. */
export interface WaypointDraft {
  code: string;
  name: string;
  coords: string;
  /** Metres, as typed. Blank means the file has no altitude for this point. */
  altitude: string;
  /** Metres. */
  radius: string;
}

export function WaypointSheet({
  initial,
  onDone,
  onRemove,
  onLocate,
}: {
  initial: WaypointDraft;
  /** Apply the draft and close. */
  onDone: (draft: WaypointDraft) => void;
  onRemove: () => void;
  /** Fly the page's map to these coordinates, if they parse. */
  onLocate: (coords: string) => void;
}) {
  const [draft, setDraft] = useState<WaypointDraft>(initial);
  const set = <K extends keyof WaypointDraft>(key: K, value: WaypointDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const coordsValid = parseCoords(draft.coords) !== null;
  const altNumber = Number(draft.altitude);
  const radiusNumber = Number(draft.radius);

  return (
    <FullScreenSheet
      label={`${initial.code || "Waypoint"} details`}
      onClose={() => onDone(draft)}
      className="flex flex-col"
    >
      <div className="flex items-center gap-3 border-b border-border px-gutter-safe pt-3 pb-2">
        <h2 className="min-w-0 flex-1 truncate text-lg font-bold">
          {draft.code || "Waypoint"}
        </h2>
        {/* autoFocus so a keyboard user lands on the way out rather than on
            the dialog container — Escape alone is not a discoverable
            affordance (accessibility standard §4.1). */}
        <Button autoFocus onPress={() => onDone(draft)}>
          Done
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-gutter-safe py-4">
        <div className="flex flex-col gap-4">
          <TextField
            label="Code"
            value={draft.code}
            onChange={(v) => set("code", v)}
            description="The short name a pilot's instrument shows, and how a route names this point."
          />
          <TextField
            label="Name"
            value={draft.name}
            onChange={(v) => set("name", v)}
            description="Optional. The longer description."
          />
          <div>
            <TextField
              label="Coordinates"
              value={draft.coords}
              onChange={(v) => set("coords", v)}
              className="font-mono"
              isInvalid={!coordsValid}
              errorMessage={coordsValid ? undefined : "Enter coordinates as “lat, lon”"}
            />
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              isDisabled={!coordsValid}
              onPress={() => onLocate(draft.coords)}
            >
              <MapPinIcon className="size-4" aria-hidden="true" />
              Show on the map
            </Button>
          </div>
          {/* Metres, stated: the grid's header says "Alt (m)" for the same
              reason, and this is the same number. */}
          <NumberField
            label="Altitude (m)"
            value={draft.altitude.trim() === "" || !Number.isFinite(altNumber) ? Number.NaN : altNumber}
            onChange={(v) => set("altitude", Number.isNaN(v) ? "" : String(Math.round(v)))}
            formatOptions={{ maximumFractionDigits: 0, useGrouping: false }}
            description="Leave it empty if the altitude is unknown. Zero means sea level."
          />
          <div>
            <NumberField
              label="Radius (m)"
              value={Number.isFinite(radiusNumber) ? radiusNumber : Number.NaN}
              onChange={(v) => set("radius", Number.isNaN(v) ? "" : String(Math.round(v)))}
              formatOptions={{ maximumFractionDigits: 0, useGrouping: false }}
            />
            {/* The same chips the turnpoint sheet offers, and the same reason:
                these are the radii an organiser actually sets. */}
            <div className="mt-2 flex flex-wrap gap-2">
              {RADIUS_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  variant="outline"
                  size="sm"
                  onPress={() => set("radius", String(preset))}
                >
                  {radiusChipLabel(preset)}
                </Button>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-8 border-t border-border pt-4">
          <Button variant="destructive" onPress={onRemove}>
            <Trash2Icon className="size-4" aria-hidden="true" />
            Remove this waypoint
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Nothing is saved until you press Save on the waypoints page.
          </p>
        </div>
      </div>
    </FullScreenSheet>
  );
}

/** One waypoint's radius for a list row — always metric, never a preference. */
export function radiusLabel(radius: string): string {
  const n = Number(radius);
  return Number.isFinite(n) ? formatCylinderRadius(n).withUnit : radius;
}
