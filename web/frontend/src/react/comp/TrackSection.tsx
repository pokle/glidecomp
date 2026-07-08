/**
 * Tracks section on the task detail page — React port of setupTrackSection(),
 * renderTrackList(), setupTrackUpload() and openPenaltyDialog().
 */
import { useCallback, useEffect, useId, useState } from "react";
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
import { useConfirm } from "../lib/confirm";
import { formatFileSize } from "../lib/format";
import { SubmitTrackDialog } from "./SubmitTrackDialog";
import type { TrackInfo } from "./types";

export function TrackSection({
  compId,
  taskId,
  isAuthenticated,
  isAdmin,
  isClosed,
  canUploadOnBehalf,
  onTracksChanged,
}: {
  compId: string;
  taskId: string;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isClosed: boolean;
  canUploadOnBehalf: boolean;
  /** Called after any mutation that can change scores (upload/penalty/delete). */
  onTracksChanged: () => void;
}) {
  const confirm = useConfirm();
  const [tracks, setTracks] = useState<TrackInfo[]>([]);
  const [penaltyTrack, setPenaltyTrack] = useState<TrackInfo | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);

  const loadTracks = useCallback(async () => {
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].igc.$get({
        param: { comp_id: compId, task_id: taskId },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { tracks: TrackInfo[] };
      setTracks(data.tracks);
    } catch {
      // Non-critical — leave the list as-is
    }
  }, [compId, taskId]);

  useEffect(() => {
    void loadTracks();
  }, [loadTracks]);

  async function deleteTrack(track: TrackInfo) {
    const confirmed = await confirm({
      title: `Delete track for ${track.pilot_name}?`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!confirmed) return;
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].igc[
        ":comp_pilot_id"
      ].$delete({
        param: { comp_id: compId, task_id: taskId, comp_pilot_id: track.comp_pilot_id },
      });
      if (res.ok) {
        setTracks((prev) => prev.filter((t) => t.task_track_id !== track.task_track_id));
        onTracksChanged();
      } else {
        toast.error("Failed to delete track");
      }
    } catch {
      toast.error("Network error");
    }
  }

  return (
    <section>
      <h2 className="mt-8 text-lg font-bold">
        Tracks{" "}
        <span className="text-sm font-normal text-muted-foreground">
          {tracks.length} track{tracks.length !== 1 ? "s" : ""}
        </span>
        {isClosed ? (
          <span className="text-sm font-normal text-muted-foreground"> (Closed)</span>
        ) : null}
        {isAuthenticated && !isClosed ? (
          <>
            {" "}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setUploadOpen(true)}
            >
              Submit track
            </Button>
          </>
        ) : null}
      </h2>

      {tracks.length === 0 ? (
        <p className="mt-2 text-muted-foreground">No tracks uploaded yet</p>
      ) : (
        <ul className="mt-2 space-y-2 text-sm">
          {tracks.map((track) => (
            <li key={track.task_track_id}>
              <strong>{track.pilot_name}</strong>{" "}
              <span className="text-muted-foreground">{track.pilot_class}</span>
              {track.igc_pilot_name && track.igc_pilot_name !== track.pilot_name ? (
                <span className="text-muted-foreground"> (igc: {track.igc_pilot_name})</span>
              ) : null}
              {track.penalty_points !== 0 ? (
                <span className="text-destructive">
                  {" "}
                  {track.penalty_points < 0
                    ? `+${Math.abs(track.penalty_points)}`
                    : `-${track.penalty_points}`}{" "}
                  pts
                  {track.penalty_reason ? <span> {track.penalty_reason}</span> : null}
                </span>
              ) : null}
              <div className="text-muted-foreground">
                {new Date(track.uploaded_at).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                · {formatFileSize(track.file_size)}
                {track.uploaded_on_behalf && track.uploaded_by_name ? (
                  <span> · uploaded by {track.uploaded_by_name}</span>
                ) : null}
              </div>
              <a
                className="underline underline-offset-4"
                href={`/analysis.html?compId=${encodeURIComponent(compId)}&taskId=${encodeURIComponent(taskId)}&pilotId=${encodeURIComponent(track.comp_pilot_id)}`}
                title="View analysis"
                target="_blank"
                rel="noopener"
              >
                View
              </a>{" "}
              <a
                className="underline underline-offset-4"
                href={`/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(track.comp_pilot_id)}/download`}
                title="Download"
              >
                Download
              </a>
              {isAdmin && !isClosed ? (
                <>
                  {" "}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    title="Set penalty"
                    onClick={() => setPenaltyTrack(track)}
                  >
                    Penalty
                  </Button>{" "}
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    title="Delete track"
                    onClick={() => void deleteTrack(track)}
                  >
                    Delete
                  </Button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {penaltyTrack ? (
        <PenaltyDialog
          compId={compId}
          taskId={taskId}
          track={penaltyTrack}
          onClose={() => setPenaltyTrack(null)}
          onSaved={async () => {
            setPenaltyTrack(null);
            await loadTracks();
            onTracksChanged();
          }}
        />
      ) : null}

      {uploadOpen ? (
        <SubmitTrackDialog
          compId={compId}
          taskId={taskId}
          canUploadOnBehalf={canUploadOnBehalf}
          onClose={() => setUploadOpen(false)}
          onUploaded={async () => {
            await loadTracks();
            onTracksChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function PenaltyDialog({
  compId,
  taskId,
  track,
  onClose,
  onSaved,
}: {
  compId: string;
  taskId: string;
  track: TrackInfo;
  onClose: () => void;
  onSaved: () => void;
}) {
  const pointsId = useId();
  const reasonId = useId();
  const [points, setPoints] = useState(String(track.penalty_points));
  const [reason, setReason] = useState(track.penalty_reason ?? "");
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].igc[
        ":comp_pilot_id"
      ].$patch({
        param: { comp_id: compId, task_id: taskId, comp_pilot_id: track.comp_pilot_id },
        json: {
          penalty_points: parseFloat(points),
          penalty_reason: reason.trim() || null,
        },
      });
      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        toast.error(err.error || "Failed to set penalty");
        return;
      }
      onSaved();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Set Penalty</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">{track.pilot_name}</p>
        <form onSubmit={(e) => void save(e)} className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor={pointsId}>Penalty Points</FieldLabel>
            <Input
              id={pointsId}
              type="number"
              step="any"
              required
              value={points}
              onChange={(e) => setPoints(e.target.value)}
            />
            <FieldDescription>
              Positive = deduction, negative = bonus. 0 to clear.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={reasonId}>Reason</FieldLabel>
            <Input
              id={reasonId}
              maxLength={128}
              placeholder="e.g. Airspace violation"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
