/**
 * Record a manual flight for a track-less pilot (issue #306, FAI S7F §8.4).
 *
 * Pre-scoped to one pilot (unlike SubmitTrackDialog, which picks the pilot
 * inside). The admin picks the last turnpoint the pilot legally reached and
 * enters the landing point; the made-good distance is computed live by the
 * SAME engine helper the server scores with (distanceMadeGoodTo), so the
 * number shown before saving is the number that will be scored. When the last
 * turnpoint is Goal, a finish-time field appears to enable time/speed points.
 *
 * This is the accessible, non-map path required by docs/accessibility-standard.md
 * (numeric lat/lon). A map picker is a planned follow-up.
 */
import { useId, useMemo, useState } from "react";
import type { XCTask } from "@glidecomp/engine";
import { taskForDistanceOrigin, distanceMadeGoodTo } from "@glidecomp/engine";
import { Button } from "@/react/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/react/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/react/ui/field";
import { Input } from "@/react/ui/input";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { SimpleSelect } from "./fields";
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

function parseCoord(v: string): number | null {
  if (v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function ManualFlightDialog({
  compId,
  taskId,
  compPilotId,
  pilotName,
  task,
  distanceOrigin,
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
  /** Prefill for editing an existing manual flight. */
  existing?: ManualFlightEntry | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tpId = useId();
  const latId = useId();
  const lonId = useId();
  const durationId = useId();

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
  const [lat, setLat] = useState(existing ? String(existing.landing_lat) : "");
  const [lon, setLon] = useState(existing ? String(existing.landing_lon) : "");
  // Minutes:seconds is fiddly — collect whole minutes, the common granularity.
  const [durationMin, setDurationMin] = useState(
    existing?.duration_seconds != null ? String(Math.round(existing.duration_seconds / 60)) : ""
  );
  const [saving, setSaving] = useState(false);

  const madeGoal = lastIdx === goalIdx;

  // Live made-good, computed exactly as the server does: trim the task to the
  // distance origin, map the full-task index into that frame, then measure.
  const scoringTask = useMemo(
    () => taskForDistanceOrigin(task, distanceOrigin),
    [task, distanceOrigin]
  );
  const offset = task.turnpoints.length - scoringTask.turnpoints.length;

  const latNum = parseCoord(lat);
  const lonNum = parseCoord(lon);
  const coordsValid =
    latNum !== null && lonNum !== null &&
    latNum >= -90 && latNum <= 90 && lonNum >= -180 && lonNum <= 180;

  const madeGood = useMemo(() => {
    if (!coordsValid) return null;
    return distanceMadeGoodTo(scoringTask, lastIdx - offset, { lat: latNum!, lon: lonNum! });
  }, [scoringTask, offset, lastIdx, latNum, lonNum, coordsValid]);

  async function save() {
    if (!coordsValid) {
      toast.warning("Enter a valid landing latitude and longitude");
      return;
    }
    const durationSeconds =
      madeGoal && durationMin.trim() !== ""
        ? Math.round(Number(durationMin) * 60)
        : null;
    if (madeGoal && durationMin.trim() !== "" && !Number.isFinite(Number(durationMin))) {
      toast.warning("Enter the finish time in whole minutes");
      return;
    }

    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"]["manual-flight"][
        ":comp_pilot_id"
      ].$put({
        param: { comp_id: compId, task_id: taskId, comp_pilot_id: compPilotId },
        json: {
          last_reached_tp_index: lastIdx,
          landing_lat: latNum!,
          landing_lon: lonNum!,
          duration_seconds: durationSeconds,
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
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Record manual flight</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {pilotName} — for a pilot who flew but has no tracklog. Scored from the
          last turnpoint they reached and where they landed.
        </p>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Field>
            <FieldLabel htmlFor={tpId}>Last turnpoint reached</FieldLabel>
            <SimpleSelect
              value={String(lastIdx)}
              onChange={(v) => setLastIdx(Number(v))}
              options={task.turnpoints.map((_, i) => ({
                value: String(i),
                label: turnpointLabel(task, i),
              }))}
              ariaLabel="Last turnpoint reached"
            />
            <FieldDescription>
              The furthest turnpoint the pilot legally tagged, in order.
            </FieldDescription>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field>
              <FieldLabel htmlFor={latId}>Landing latitude</FieldLabel>
              <Input
                id={latId}
                inputMode="decimal"
                placeholder="-36.1234"
                value={lat}
                onChange={(e) => setLat(e.target.value)}
              />
            </Field>
            <Field>
              <FieldLabel htmlFor={lonId}>Landing longitude</FieldLabel>
              <Input
                id={lonId}
                inputMode="decimal"
                placeholder="147.1234"
                value={lon}
                onChange={(e) => setLon(e.target.value)}
              />
            </Field>
          </div>

          {madeGoal ? (
            <Field>
              <FieldLabel htmlFor={durationId}>Finish time (minutes)</FieldLabel>
              <Input
                id={durationId}
                inputMode="numeric"
                placeholder="e.g. 92"
                value={durationMin}
                onChange={(e) => setDurationMin(e.target.value)}
              />
              <FieldDescription>
                Speed-section time, for time and speed points. Optional.
              </FieldDescription>
            </Field>
          ) : null}

          <div
            className="rounded-md border border-border bg-muted/40 p-3 text-sm"
            aria-live="polite"
          >
            {madeGood !== null ? (
              <>
                <span className="font-medium">
                  {(madeGood / 1000).toFixed(1)} km made good
                </span>
                {madeGoal ? <span className="text-muted-foreground"> · in goal</span> : null}
              </>
            ) : (
              <span className="text-muted-foreground">
                Enter a landing point to see the made-good distance.
              </span>
            )}
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={saving || !coordsValid}>
              {saving ? "Saving…" : "Record flight"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
