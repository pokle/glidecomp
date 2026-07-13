/**
 * Shared "add a single waypoint" dialog.
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
import { Button } from "@/react/ui/button";
import { Input } from "@/react/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { toast } from "../lib/toast";
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
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [coords, setCoords] = useState("");
  const [altitude, setAltitude] = useState("");
  // Snap-to-peak: the candidate peak near the tap (null when none), whether the
  // coords currently reflect it, and the raw tap to revert to.
  const [peak, setPeak] = useState<PickedPeak | null>(null);
  const [snapped, setSnapped] = useState(false);
  const [tapCoords, setTapCoords] = useState("");
  const [tapAltitude, setTapAltitude] = useState("");

  // Seed the fields once each time the dialog opens (the false→true edge), from
  // whatever the map told us about the tapped point. Everything the map knows
  // pre-fills but stays fully editable: terrain elevation → altitude, nearest
  // rendered label → name, a short code derived from that name. All blank on
  // the Leaflet fallback, which reports no details. When a peak is near the tap
  // we snap-to-peak: a tight tap silently adopts the summit (revertible), a
  // looser one only offers it (see the status row under Coordinates). Both are
  // decided by peakSnapMode; nothing is committed until Add either way.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const placeName = details?.placeName ?? "";
      const tapAlt =
        details?.elevation !== undefined ? String(Math.round(details.elevation)) : "";
      const nearPeak = details?.peak ?? null;
      setCode(placeName ? suggestWaypointCode(placeName, takenCodes) : "");
      setName(placeName);
      setTapCoords(initialCoords);
      setTapAltitude(tapAlt);
      setPeak(nearPeak);
      if (nearPeak && peakSnapMode(nearPeak) === "auto") {
        setCoords(formatCoords(nearPeak.lat, nearPeak.lon));
        setAltitude(
          nearPeak.elevation !== undefined ? String(Math.round(nearPeak.elevation)) : tapAlt
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
    if (peak.elevation !== undefined) setAltitude(String(Math.round(peak.elevation)));
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
    const alt = Number(altitude);
    onAdd({
      code: finalCode,
      name: name.trim() || finalCode,
      latitude: c.lat,
      longitude: c.lon,
      altitude: altitude.trim() !== "" && Number.isFinite(alt) ? Math.round(alt) : 0,
      radius: DEFAULT_RADIUS,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="flex flex-col gap-3 sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Add waypoint</DialogTitle>
        </DialogHeader>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Code</span>
          <Input autoFocus placeholder="e.g. A01" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Name <span className="text-muted-foreground">— optional</span></span>
          <Input placeholder="e.g. Bordano Landing" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Coordinates (lat, lon)</span>
          <Input
            placeholder="-36.185, 147.891"
            spellCheck={false}
            value={coords}
            onChange={(e) => setCoords(e.target.value)}
          />
        </label>
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
                summit — {formatSnapDistance(peak.distanceM)} from your tap ·{" "}
                <button
                  type="button"
                  className="font-medium underline underline-offset-2 hover:text-foreground"
                  onClick={revertToTap}
                >
                  Use tapped point
                </button>
              </span>
            ) : (
              <span>
                <button
                  type="button"
                  className="font-medium text-foreground underline underline-offset-2 hover:text-primary"
                  onClick={applySnap}
                >
                  Snap to {peak.name} summit
                </button>{" "}
                ({formatSnapDistance(peak.distanceM)} away)
              </span>
            )}
          </p>
        )}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">Altitude (m) <span className="text-muted-foreground">— optional</span></span>
          <Input type="number" inputMode="numeric" value={altitude} onChange={(e) => setAltitude(e.target.value)} />
        </label>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>Cancel</DialogClose>
          <Button type="button" disabled={parseCoords(coords) === null} onClick={handleAdd}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
