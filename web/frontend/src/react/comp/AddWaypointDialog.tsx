/**
 * The task route editor's "add a single waypoint" dialog.
 *
 * The fields, their seeding from a map tap and the record they build are
 * comp/AddWaypointForm.tsx, shared with the waypoints editor — which shows
 * them on a page of its own since #811 (pages/CompWaypointNewPage.tsx). The
 * route editor keeps this dialog until its own turn under the overlays rule in
 * CLAUDE.md (#812), which will make it a page too and delete this file.
 *
 * It births one record and hands it back via `onAdd`; the route editor stages
 * it as a new turnpoint and writes it to the competition on save.
 */
import type { WaypointFileRecord } from "@glidecomp/engine";
import type { MapPickDetails } from "../../analysis/map-provider";
import { Button } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { toast } from "../lib/toast";
import { parseCoords } from "./route-editor";
import {
  AddWaypointFields,
  buildNewWaypoint,
  useNewWaypoint,
  type NewWaypointSeed,
} from "./AddWaypointForm";

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
        {/* Mounted only while open, so each opening seeds afresh. */}
        {open ? (
          <AddWaypointBody
            seed={{ coords: initialCoords, details }}
            takenCodes={takenCodes}
            onAdd={onAdd}
          />
        ) : null}
      </Dialog>
    </Modal>
  );
}

function AddWaypointBody({
  seed,
  takenCodes,
  onAdd,
}: {
  seed: NewWaypointSeed;
  takenCodes: string[];
  onAdd: (record: WaypointFileRecord) => void;
}) {
  const waypoint = useNewWaypoint(seed, takenCodes);
  const add = () => {
    const built = buildNewWaypoint(waypoint.state, takenCodes);
    if (!built) return;
    if (built.adjusted) toast.warning(built.adjusted);
    onAdd(built.record);
  };
  return (
    <>
      <AddWaypointFields seed={seed} waypoint={waypoint} autoFocus />
      <DialogFooter>
        <Button slot="close" variant="outline">
          Cancel
        </Button>
        <Button isDisabled={parseCoords(waypoint.state.coords) === null} onPress={add}>
          Add
        </Button>
      </DialogFooter>
    </>
  );
}
