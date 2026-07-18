/**
 * Record a manual flight for a track-less pilot (issue #306, FAI S7F §8.4).
 *
 * RAC EXPLORATION (see pages/TaskDetail.tsx): RAC Modal/Form/TextField/
 * NumberField/Select. The coordinates field uses RAC's `validate` so "must be
 * lat, lon" shows inline as the user types, not as a toast on save.
 *
 * Pre-scoped to one pilot (unlike SubmitTrackDialog, which picks the pilot
 * inside). The made-good distance is computed live by the SAME engine helpers
 * the server scores with, so the number shown before saving is the number that
 * will be scored.
 *
 * The form differs by scoring format — they are fundamentally different models:
 * - GAP: pick the last turnpoint reached + the landing point; a finish-time
 *   field appears when the last turnpoint is Goal (for time/speed points).
 * - Open distance: just the landing point — the score is the straight-line
 *   distance from the take-off cylinder exit, with no turnpoints or finish time.
 *
 * This is the accessible, non-map path required by docs/accessibility-standard.md
 * (a "lat, lon" field). A map picker is a planned follow-up.
 */
import { useMemo, useState } from "react";
import { Form } from "react-aria-components";
import type { XCTask } from "@glidecomp/engine";
import {
  taskForDistanceOrigin,
  distanceMadeGoodTo,
  manualOpenDistanceGeometry,
} from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { NumberField, TextField } from "@/react/rac/field";
import { Select, SelectItem } from "@/react/rac/select";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { parseCoords, formatCoords } from "./route-editor";
import type { DistanceOriginValue } from "./types";
import type { ManualFlightEntry } from "./types";

/** Human label for a turnpoint dropdown option. */
function turnpointLabel(task: XCTask, i: number): string {
  const tp = task.turnpoints[i];
  const isGoal = i === task.turnpoints.length - 1;
  const name = tp.waypoint.name || `TP${i + 1}`;
  if (isGoal) return `Goal — ${name}`;
  if (tp.type === "SSS") return `Start / SSS — ${name}`;
  if (tp.type === "TAKEOFF") return `Take-off — ${name}`;
  if (tp.type === "ESS") return `ESS — ${name}`;
  return `${i + 1}. ${name}`;
}

export function ManualFlightDialog({
  compId,
  taskId,
  compPilotId,
  pilotName,
  task,
  distanceOrigin,
  openDistance,
  existing,
  onClose,
  onSaved,
}: {
  compId: string;
  taskId: string;
  compPilotId: string;
  pilotName: string;
  /** The task route (turnpoints drive the dropdown + the made-good geometry). */
  task: XCTask;
  /** Comp distance origin — mirrors the server so the preview matches the score. */
  distanceOrigin: DistanceOriginValue;
  /** True for an open-distance comp — swaps to the take-off-exit distance form. */
  openDistance: boolean;
  /** Prefill for editing an existing manual flight. */
  existing?: ManualFlightEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const goalIdx = task.turnpoints.length - 1;
  // Default: the last reached is the previous report's, else the start (SSS or
  // first turnpoint) — the minimum for a pilot who launched.
  const startIdx = Math.max(
    0,
    task.turnpoints.findIndex((tp) => tp.type === "SSS")
  );
  const [lastIdx, setLastIdx] = useState<number>(
    existing ? existing.last_reached_tp_index : startIdx
  );
  // A single "lat, lon" field — the format Google Maps copies to the clipboard,
  // and the same one the route editor uses (a map picker can fill it later).
  const [coords, setCoords] = useState(
    existing ? formatCoords(existing.landing_lat, existing.landing_lon) : ""
  );
  // Minutes:seconds is fiddly — collect whole minutes, the common granularity.
  const [durationMin, setDurationMin] = useState<number>(
    existing?.duration_seconds != null ? Math.round(existing.duration_seconds / 60) : NaN
  );
  const [saving, setSaving] = useState(false);

  // GAP only: in goal when the last reached turnpoint is the goal.
  const madeGoal = !openDistance && lastIdx === goalIdx;

  // Live made-good, computed exactly as the server does. GAP trims the task to
  // the distance origin and measures along the course from the last turnpoint;
  // open distance measures the straight line from the take-off cylinder exit.
  const scoringTask = useMemo(
    () => taskForDistanceOrigin(task, distanceOrigin),
    [task, distanceOrigin]
  );
  const offset = task.turnpoints.length - scoringTask.turnpoints.length;

  const landing = parseCoords(coords);
  const coordsValid = landing !== null;

  const madeGood = useMemo(() => {
    if (!landing) return null;
    return openDistance
      ? manualOpenDistanceGeometry(task, landing).distance
      : distanceMadeGoodTo(scoringTask, lastIdx - offset, landing);
  }, [openDistance, task, scoringTask, offset, lastIdx, landing]);

  async function save() {
    if (!landing) {
      toast.warning('Enter the landing point as "latitude, longitude"');
      return;
    }
    const durationSeconds =
      madeGoal && Number.isFinite(durationMin) ? Math.round(durationMin * 60) : null;

    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"]["manual-flight"][
        ":comp_pilot_id"
      ].$put({
        param: { comp_id: compId, task_id: taskId, comp_pilot_id: compPilotId },
        json: {
          // Open distance has no turnpoints or finish time — the server ignores
          // the index and computes distance from the take-off exit.
          last_reached_tp_index: openDistance ? 0 : lastIdx,
          landing_lat: landing.lat,
          landing_lon: landing.lon,
          duration_seconds: openDistance ? null : durationSeconds,
        },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to record manual flight");
        return;
      }
      toast.success(`Manual flight recorded for ${pilotName}`);
      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="sm:max-w-lg"
    >
      <Dialog>
        <DialogHeader>
          <DialogTitle>Record manual flight</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {pilotName} — for a pilot who flew but has no tracklog.{" "}
          {openDistance
            ? "Scored as open distance from the take-off cylinder to where they landed."
            : "Scored from the last turnpoint they reached and where they landed."}
        </p>
        <Form
          className="flex flex-col gap-6"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {!openDistance ? (
            <Select
              label="Last turnpoint reached"
              description="The furthest turnpoint the pilot legally tagged, in order."
              selectedKey={String(lastIdx)}
              onSelectionChange={(k) => {
                if (k != null) setLastIdx(Number(k));
              }}
            >
              {task.turnpoints.map((_, i) => (
                <SelectItem key={i} id={String(i)}>
                  {turnpointLabel(task, i)}
                </SelectItem>
              ))}
            </Select>
          ) : null}

          <TextField
            label="Landing point"
            placeholder="-36.550979, 147.890395"
            description="Latitude, longitude — paste straight from Google Maps."
            value={coords}
            onChange={setCoords}
            // Inline validation: flags a malformed pair as the user types
            // (only once touched), instead of a toast at save time.
            validate={(v) =>
              v.trim() === "" || parseCoords(v) !== null
                ? null
                : 'Enter "latitude, longitude" decimal degrees'
            }
          />

          {madeGoal ? (
            <NumberField
              label="Finish time (minutes)"
              description="Speed-section time, for time and speed points. Optional."
              placeholder="e.g. 92"
              minValue={1}
              step={1}
              value={durationMin}
              onChange={setDurationMin}
            />
          ) : null}

          <div
            className="rounded-md border border-border bg-muted/40 p-3 text-sm"
            aria-live="polite"
          >
            {madeGood !== null ? (
              <>
                <span className="font-medium">
                  {(madeGood / 1000).toFixed(1)} km {openDistance ? "open distance" : "made good"}
                </span>
                {madeGoal ? <span className="text-muted-foreground"> · in goal</span> : null}
              </>
            ) : (
              <span className="text-muted-foreground">
                Enter a landing point to see the {openDistance ? "open distance" : "made-good distance"}.
              </span>
            )}
          </div>

          <DialogFooter>
            <Button slot="close" variant="outline">
              Cancel
            </Button>
            <Button type="submit" isDisabled={saving || !coordsValid}>
              {saving ? "Saving…" : "Record flight"}
            </Button>
          </DialogFooter>
        </Form>
      </Dialog>
    </Modal>
  );
}
