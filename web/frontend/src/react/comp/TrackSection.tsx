/**
 * Tracks section on the task detail page — React port of setupTrackSection(),
 * renderTrackList(), setupTrackUpload() and openPenaltyDialog().
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { Input } from "@base-ui/react/input";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { useConfirm } from "../lib/confirm";
import { formatFileSize } from "../lib/format";
import { SimpleSelect } from "./fields";
import { compressIgc, type TrackInfo } from "./types";

const SELF = "self";

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
      <h2>
        Tracks{" "}
        <span>
          {tracks.length} track{tracks.length !== 1 ? "s" : ""}
        </span>
        {isClosed ? <span> (Closed)</span> : null}
        {isAuthenticated && !isClosed ? (
          <>
            {" "}
            <button type="button" onClick={() => setUploadOpen(true)}>
              Submit track
            </button>
          </>
        ) : null}
      </h2>

      {tracks.length === 0 ? (
        <p>No tracks uploaded yet</p>
      ) : (
        <ul>
          {tracks.map((track) => (
            <li key={track.task_track_id}>
              <strong>{track.pilot_name}</strong> <span>{track.pilot_class}</span>
              {track.igc_pilot_name && track.igc_pilot_name !== track.pilot_name ? (
                <span> (igc: {track.igc_pilot_name})</span>
              ) : null}
              {track.penalty_points !== 0 ? (
                <span>
                  {" "}
                  {track.penalty_points < 0
                    ? `+${Math.abs(track.penalty_points)}`
                    : `-${track.penalty_points}`}{" "}
                  pts
                  {track.penalty_reason ? <span> {track.penalty_reason}</span> : null}
                </span>
              ) : null}
              <div>
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
                href={`/analysis.html?compId=${encodeURIComponent(compId)}&taskId=${encodeURIComponent(taskId)}&pilotId=${encodeURIComponent(track.comp_pilot_id)}`}
                title="View analysis"
                target="_blank"
                rel="noopener"
              >
                View
              </a>{" "}
              <a
                href={`/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc/${encodeURIComponent(track.comp_pilot_id)}/download`}
                title="Download"
              >
                Download
              </a>
              {isAdmin && !isClosed ? (
                <>
                  {" "}
                  <button
                    type="button"
                    title="Set penalty"
                    onClick={() => setPenaltyTrack(track)}
                  >
                    Penalty
                  </button>{" "}
                  <button
                    type="button"
                    title="Delete track"
                    onClick={() => void deleteTrack(track)}
                  >
                    Delete
                  </button>
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
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="Dialog-backdrop" />
        <Dialog.Popup className="Dialog-popup">
          <Dialog.Title className="Dialog-title">Set Penalty</Dialog.Title>
          <p>{track.pilot_name}</p>
          <form onSubmit={(e) => void save(e)}>
            <Field.Root className="Field">
              <Field.Label className="Field-label">Penalty Points</Field.Label>
              <Input
                type="number"
                step="any"
                required
                value={points}
                onValueChange={(v) => setPoints(v)}
              />
              <Field.Description className="Field-description">
                Positive = deduction, negative = bonus. 0 to clear.
              </Field.Description>
            </Field.Root>
            <Field.Root className="Field">
              <Field.Label className="Field-label">Reason</Field.Label>
              <Input
                maxLength={128}
                placeholder="e.g. Airspace violation"
                value={reason}
                onValueChange={(v) => setReason(v)}
              />
            </Field.Root>
            <Dialog.Close>Cancel</Dialog.Close>{" "}
            <button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </button>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * Single "Submit track" entry point on the task page. Defaults to submitting
 * the signed-in user's own track ("Myself"); when the user may upload on
 * behalf (admin, or registered pilot with open_igc_upload), the pilot
 * dropdown also lists registered pilots. "Myself" posts to /igc, a chosen
 * pilot to /igc/:comp_pilot_id.
 */
function SubmitTrackDialog({
  compId,
  taskId,
  canUploadOnBehalf,
  onClose,
  onUploaded,
}: {
  compId: string;
  taskId: string;
  canUploadOnBehalf: boolean;
  onClose: () => void;
  onUploaded: () => void;
}) {
  const [pilots, setPilots] = useState<
    Array<{ comp_pilot_id: string; name: string; pilot_class: string }>
  >([]);
  const [selected, setSelected] = useState(SELF);
  const [status, setStatus] = useState<{ message: string; isError: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!canUploadOnBehalf) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await api.api.comp[":comp_id"].pilot.$get({
          param: { comp_id: compId },
        });
        if (!res.ok) return;
        const data = (await res.json()) as {
          pilots: Array<{ comp_pilot_id: string; name: string; pilot_class: string }>;
        };
        if (!cancelled) setPilots(data.pilots);
      } catch {
        // Non-fatal: the user can still submit for themselves.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [compId, canUploadOnBehalf]);

  async function upload() {
    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setStatus({ message: "Select an IGC file", isError: true });
      return;
    }
    if (!file.name.toLowerCase().endsWith(".igc")) {
      setStatus({ message: "Please select an IGC file", isError: true });
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setStatus({ message: "File too large (max 5MB)", isError: true });
      return;
    }

    setUploading(true);
    setStatus({ message: "Compressing and uploading...", isError: false });

    try {
      const compressed = await compressIgc(file);
      const base = `/api/comp/${encodeURIComponent(compId)}/task/${encodeURIComponent(taskId)}/igc`;
      const url = selected === SELF ? base : `${base}/${encodeURIComponent(selected)}`;
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        body: compressed,
      });

      if (!res.ok) {
        const err = (await res.json()) as { error?: string };
        setStatus({ message: err.error || "Upload failed", isError: true });
        return;
      }

      const data = (await res.json()) as { replaced: boolean };
      setStatus({
        message: data.replaced
          ? "Track replaced successfully"
          : "Track uploaded successfully",
        isError: false,
      });
      onUploaded();
      // Close after a brief delay so the user sees success
      setTimeout(() => onClose(), 1000);
    } catch {
      setStatus({ message: "Network error. Please try again.", isError: true });
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="Dialog-backdrop" />
        <Dialog.Popup className="Dialog-popup">
          <Dialog.Title className="Dialog-title">Submit track</Dialog.Title>
          {canUploadOnBehalf ? (
            <div>
              <h3>Pilot</h3>
              <SimpleSelect
                value={selected}
                onChange={(v) => setSelected(v || SELF)}
                options={[
                  { value: SELF, label: "Myself" },
                  ...pilots.map((p) => ({
                    value: p.comp_pilot_id,
                    label: `${p.name} (${p.pilot_class})`,
                  })),
                ]}
                ariaLabel="Pilot"
              />
            </div>
          ) : null}
          <div>
            <label>
              IGC File <input ref={fileInputRef} type="file" accept=".igc" />
            </label>
          </div>
          {status ? (
            <p role={status.isError ? "alert" : "status"}>{status.message}</p>
          ) : null}
          <Dialog.Close>Cancel</Dialog.Close>{" "}
          <button type="button" disabled={uploading} onClick={() => void upload()}>
            {uploading ? "Uploading..." : "Upload"}
          </button>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
