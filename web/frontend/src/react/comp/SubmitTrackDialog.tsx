/**
 * The compact "Submit track" overlay, for the task page.
 *
 * It is a wrapper: the flow itself lives in SubmitTrackForm, which the
 * `/submit` page renders as page content. Opened from here, comp and task are
 * already known, so those steps collapse and what is left is the two-field
 * form this dialog has always been. That is also why the dialog is the TASK
 * page's form only — its two callers are pages/TaskDetail.tsx and
 * comp/TaskScoresPublic.tsx, both on that page; the comp page still has to ask
 * which task, so it links to /submit?comp= instead.
 *
 * The one behavioural difference between the two presentations lives here: a
 * clean success closes the dialog after a beat, but a success carrying
 * track-quality findings never auto-closes — the dialog would take the warning
 * away before it was read. The page has nothing to close and so needs neither
 * rule.
 *
 * RAC (see docs/2026-07-18-rac-adoption-guide.md): kit Modal/Dialog and
 * FileTrigger — the file lives in state (a File object), not in a DOM input.
 */
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  Modal,
} from "@/react/rac/dialog";
import { api } from "../../comp/api";
import { useUser } from "../lib/user";
import { SubmitTrackForm, type SubmitTrackResult } from "./SubmitTrackForm";
import type { PilotListEntry } from "./types";

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

export function SubmitTrackDialog({
  compId,
  taskId,
  compName,
  taskName,
  canUploadOnBehalf,
  onClose,
  onUploaded,
}: {
  compId: string;
  taskId: string;
  compName?: string;
  taskName?: string;
  canUploadOnBehalf: boolean;
  onClose: () => void;
  onUploaded: () => void;
}) {
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
        <SubmitTrackForm
          compact
          prefill={{ compId, taskId, compName, taskName }}
          canUploadOnBehalf={canUploadOnBehalf}
          onDone={onClose}
          onUploaded={(result: SubmitTrackResult) => {
            onUploaded();
            // A finding has to be read before the dialog can take it away.
            if (result.trackQuality.findings.length === 0) {
              setTimeout(onClose, 1500);
            }
          }}
        />
      </Dialog>
    </Modal>
  );
}
