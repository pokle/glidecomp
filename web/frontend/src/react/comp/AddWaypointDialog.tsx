/**
 * Shared "add a single waypoint" dialog.
 *
 * RAC EXPLORATION (see pages/TaskDetail.tsx): RAC Modal/TextField/NumberField
 * with inline coordinate validation.
 *
 * One small, single-purpose form — code, name, coordinates, altitude, with
 * snap-to-peak (#341) — used both by the competition waypoints editor
 * (CompWaypoints) and, inline, by the task route editor (RouteEditorDialog) so
 * an admin who's missing a point can create it without leaving the route they're
 * building. It deliberately does NOT manage the waypoint set (no grid, no file
 * import); that stays a competition-level concern on the waypoints page. The
 * dialog just births one record and hands it back via `onAdd`; the caller
 * decides where it goes (a grid row, or a PUT plus a new turnpoint).
 */
import { useEffect, useRef, useState } from "react";
import type { WaypointFileRecord } from "@glidecomp/engine";
import type { MapPickDetails, PickedPeak } from "../../analysis/map-provider";
import { Button } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { NumberField, TextField } from "@/react/rac/field";
import { toast } from "../lib/toast";
import { useUnits } from "../lib/units";
import {
  formatCoords,
  formatSnapDistance,
  parseCoords,
  peakSnapMode,
  suggestWaypointCode,
} from "./route-editor";

/** Radius (m) a freshly added waypoint gets until the admin changes it. */
const DEFAULT_RADIUS = 400;

export function AddWaypointDialog({
  open,
  initialCoords = "",
  details,
  takenCodes = [],
  onAdd,
  onCancel,
}: {
  open: boolean;
  /** Seed coordinates ("lat, lon") from a map tap; "" when opened via a button. */
  initialCoords?: string;
  /** Seed from the map tap: terrain elevation, place name, nearby peak. */
  details?: MapPickDetails;
  /** Existing codes, so a name-derived code suggestion stays unique. */
  takenCodes?: string[];
  /** Called with the assembled record when the admin confirms. */
  onAdd: (record: WaypointFileRecord) => void;
  onCancel: () => void;
}) {
  const units = useUnits();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [coords, setCoords] = useState("");
  const [altitude, setAltitude] = useState<number>(NaN);
  // Snap-to-peak: the candidate peak near the tap (null when none), whether the
  // coords currently reflect it, and the raw tap to revert to.
  const [peak, setPeak] = useState<PickedPeak | null>(null);
  const [snapped, setSnapped] = useState(false);
  const [tapCoords, setTapCoords] = useState("");
  const [tapAltitude, setTapAltitude] = useState<number>(NaN);

  // Seed the fields once each time the dialog opens (the false→true edge), from
  // whatever the map told us about the tapped point. Everything the map knows
  // pre-fills but stays fully editable: terrain elevation → altitude, nearest
  // rendered label → name, a short code derived from that name. All blank when
  // the map reports no details. When a peak is near the tap
  // we snap-to-peak: a tight tap silently adopts the summit (revertible), a
  // looser one only offers it (see the status row under Coordinates). Both are
  // decided by peakSnapMode; nothing is committed until Add either way.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const placeName = details?.placeName ?? "";
      const tapAlt =
        details?.elevation !== undefined ? Math.round(details.elevation) : NaN;
      const nearPeak = details?.peak ?? null;
      setCode(placeName ? suggestWaypointCode(placeName, takenCodes) : "");
      setName(placeName);
      setTapCoords(initialCoords);
      setTapAltitude(tapAlt);
      setPeak(nearPeak);
      if (nearPeak && peakSnapMode(nearPeak) === "auto") {
        setCoords(formatCoords(nearPeak.lat, nearPeak.lon));
        setAltitude(
          nearPeak.elevation !== undefined ? Math.round(nearPeak.elevation) : tapAlt
        );
        setSnapped(true);
      } else {
        setCoords(initialCoords);
        setAltitude(tapAlt);
        setSnapped(false);
      }
    }
    wasOpen.current = open;
  }, [open, initialCoords, details, takenCodes]);

  // Apply the offered peak (offer → snapped), or revert to the raw tap
  // (snapped → offer). The coordinates field stays a plain input, so a manual
  // edit still wins; these only reset its value.
  function applySnap() {
    if (!peak) return;
    setCoords(formatCoords(peak.lat, peak.lon));
    if (peak.elevation !== undefined) setAltitude(Math.round(peak.elevation));
    setSnapped(true);
  }
  function revertToTap() {
    setCoords(tapCoords);
    setAltitude(tapAltitude);
    setSnapped(false);
  }

  function handleAdd() {
    const c = parseCoords(coords);
    if (!c) {
      toast.error('Enter coordinates as "lat, lon" decimal degrees');
      return;
    }
    const finalCode = code.trim() || "WP";
    onAdd({
      code: finalCode,
      name: name.trim() || finalCode,
      latitude: c.lat,
      longitude: c.lon,
      altitude: Number.isFinite(altitude) ? Math.round(altitude) : 0,
      radius: DEFAULT_RADIUS,
    });
  }

  // A short "we pre-filled these" note when the dialog was opened from a map
  // tap (details present). It names what the map supplied; every field stays
  // editable. A nearby peak gets its own richer status row under Coordinates.
  const filledNote = (() => {
    if (!details) return "";
    const parts: string[] = [];
    if (initialCoords) parts.push("coordinates");
    if (details.elevation !== undefined) parts.push("elevation");
    if (details.placeName) parts.push("name");
    if (parts.length === 0) return "";
    const list =
      parts.length === 1
        ? parts[0]
        : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
    return details.placeName
      ? `Filled ${list} from the map — adjust anything below.`
      : `Filled ${list} from the map — add a code and name below.`;
  })();

  return (
    <Modal
      isOpen={open}
      onOpenChange={(o) => {
        if (!o) onCancel();
      }}
    >
      <Dialog className="gap-3">
        <DialogHeader>
          <DialogTitle>Add waypoint</DialogTitle>
        </DialogHeader>
        {filledNote ? (
          <p
            className="-mt-1 flex items-start gap-1.5 rounded-md bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <span aria-hidden="true">📍</span>
            <span>{filledNote}</span>
          </p>
        ) : null}
        <TextField
          label="Code"
          placeholder="e.g. A01"
          autoFocus
          value={code}
          onChange={setCode}
        />
        <TextField
          label={
            <>
              Name <span className="font-normal text-muted-foreground">— optional</span>
            </>
          }
          placeholder="e.g. Bordano Landing"
          value={name}
          onChange={setName}
        />
        <TextField
          label="Coordinates (lat, lon)"
          placeholder="-36.185, 147.891"
          spellCheck="false"
          value={coords}
          onChange={setCoords}
          validate={(v) =>
            v.trim() === "" || parseCoords(v) !== null
              ? null
              : 'Enter "lat, lon" decimal degrees'
          }
        />
        {peak && (
          <p
            className="-mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground"
            aria-live="polite"
          >
            <span aria-hidden="true">⛰</span>
            {snapped ? (
              <span>
                Snapped to{" "}
                <span className="font-medium text-foreground">{peak.name}</span>{" "}
                summit — {formatSnapDistance(peak.distanceM, units)} from your tap ·{" "}
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs font-medium underline underline-offset-2"
                  onPress={revertToTap}
                >
                  Use tapped point
                </Button>
              </span>
            ) : (
              <span>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs font-medium underline underline-offset-2"
                  onPress={applySnap}
                >
                  Snap to {peak.name} summit
                </Button>{" "}
                ({formatSnapDistance(peak.distanceM, units)} away)
              </span>
            )}
          </p>
        )}
        <NumberField
          label={
            <>
              Altitude (m){" "}
              <span className="font-normal text-muted-foreground">— optional</span>
            </>
          }
          value={altitude}
          onChange={setAltitude}
          step={1}
        />
        <DialogFooter>
          <Button slot="close" variant="outline">
            Cancel
          </Button>
          <Button isDisabled={parseCoords(coords) === null} onPress={handleAdd}>
            Add
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
