/**
 * The one "Submit track" dialog, shared by every Submit track button (comp
 * hero, comp task list, task page). Always shows who the track will be
 * submitted for: "Myself" by default, with the registered-pilot dropdown when
 * the user may upload on behalf (admin, or registered pilot in a comp with
 * open_igc_upload). Picking an IGC file surfaces the pilot name from the
 * file's header, and auto-selects the matching registered pilot when there is
 * exactly one — visibly, so the user can correct it.
 *
 * RAC EXPLORATION (see pages/TaskDetail.tsx): RAC Modal/Dialog, Select and
 * FileTrigger — the file lives in state (a File object), not in a DOM input.
 */
import { useEffect, useRef, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { Button } from "@/react/rac/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { Label } from "@/react/rac/field";
import { SimpleSelect } from "@/react/rac/select";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";
import { compressIgc, type PilotListEntry } from "./types";

const SELF = "self";

/**
 * Whether the current user may submit tracks for other pilots: admins always;
 * registered pilots (matched by linked_email) when the comp has
 * open_igc_upload enabled.
 */
export function useCanUploadOnBehalf(
  compId: string,
  openIgcUpload: boolean,
  isAdmin: boolean
): boolean {
  const { user } = useUser();
  const [can, setCan] = useState(false);

  useEffect(() => {
    if (isAdmin) {
      setCan(true);
      return;
    }
    if (!user || !openIgcUpload || !compId) {
      setCan(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await api.api.comp[":comp_id"].pilot.$get({
          param: { comp_id: compId },
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { pilots: PilotListEntry[] };
        if (!cancelled) setCan(data.pilots.some((p) => p.linked_email === user.email));
      } catch {
        // Non-critical — default to self-only submission
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user, openIgcUpload, isAdmin, compId]);

  return can;
}

/**
 * Pull the pilot's name out of an IGC header (HFPLTPILOTINCHARGE / HOPLT…).
 * Returns null for missing or placeholder values ("not set", "unknown").
 */
function igcPilotNameFromText(text: string): string | null {
  const m = text.match(/^H[FOP]PLT[^:\r\n]*:[ \t]*(.+?)[ \t]*\r?$/im);
  const name = m?.[1]?.trim();
  if (!name || /^(not[ _-]?set|unknown|pilot)$/i.test(name)) return null;
  return name;
}

export function SubmitTrackDialog({
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
  const { user } = useUser();
  const [pilots, setPilots] = useState<
    Array<{ comp_pilot_id: string; name: string; pilot_class: string }>
  >([]);
  const [selected, setSelected] = useState(SELF);
  const [file, setFile] = useState<File | null>(null);
  const [igcPilotName, setIgcPilotName] = useState<string | null>(null);
  const [autoSelected, setAutoSelected] = useState(false);
  const [status, setStatus] = useState<{ message: string; isError: boolean } | null>(null);
  const [uploading, setUploading] = useState(false);
  // A manual pilot choice always wins over auto-detection.
  const userTouched = useRef(false);

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

  async function onFilePicked(files: FileList | null) {
    setStatus(null);
    setAutoSelected(false);
    const picked = files?.[0] ?? null;
    setFile(picked);
    if (!picked) {
      setIgcPilotName(null);
      return;
    }
    let name: string | null = null;
    try {
      name = igcPilotNameFromText(await picked.text());
    } catch {
      // Unreadable file — the upload step will report it.
    }
    setIgcPilotName(name);
    if (name && canUploadOnBehalf && !userTouched.current) {
      const norm = name.toLowerCase();
      const matches = pilots.filter((p) => p.name.trim().toLowerCase() === norm);
      if (matches.length === 1) {
        setSelected(matches[0].comp_pilot_id);
        setAutoSelected(true);
      }
    }
  }

  async function upload() {
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
    }
  }

  const selfLabel = user?.name ? `Myself (${user.name})` : "Myself";

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
          <DialogTitle>Submit track</DialogTitle>
        </DialogHeader>
        <SimpleSelect
          value={selected}
          onChange={(v) => {
            userTouched.current = true;
            setAutoSelected(false);
            setSelected(v || SELF);
          }}
          options={[
            { value: SELF, label: selfLabel },
            ...pilots.map((p) => ({
              value: p.comp_pilot_id,
              label: `${p.name} (${p.pilot_class})`,
            })),
          ]}
          disabled={!canUploadOnBehalf}
          ariaLabel="Submitting for"
          className="w-full"
        />
        <div className="flex flex-col gap-2">
          <Label>IGC File</Label>
          <div className="flex flex-wrap items-center gap-2">
            <FileTrigger
              acceptedFileTypes={[".igc"]}
              onSelect={(files) => void onFilePicked(files)}
            >
              <Button variant="outline" size="sm">
                {file ? "Change file…" : "Choose IGC file…"}
              </Button>
            </FileTrigger>
            {file ? (
              <span className="truncate text-sm text-muted-foreground">{file.name}</span>
            ) : null}
          </div>
        </div>
        {igcPilotName ? (
          <p className="text-sm text-muted-foreground">
            Pilot named in the IGC file: <strong>{igcPilotName}</strong>
            {autoSelected
              ? " — matched to a registered pilot above; change it if that's wrong."
              : null}
          </p>
        ) : null}
        {status ? (
          <p
            role={status.isError ? "alert" : "status"}
            className={status.isError ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
          >
            {status.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button slot="close" variant="outline">
            Cancel
          </Button>
          <Button isDisabled={uploading} onPress={() => void upload()}>
            {uploading ? "Uploading..." : "Upload"}
          </Button>
        </DialogFooter>
      </Dialog>
    </Modal>
  );
}
