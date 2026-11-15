/**
 * "Share task" (issue #312, stage 2 UX), for the task page, so pilots can grab
 * the route: a dialog with a format menu (native .xctsk plus every waypoint
 * file format) and the "swap code / name" option. On a phone each format opens
 * straight into a flight app; on desktop it downloads.
 *
 * It is opened from the task page's ⋯ menu (#863: every action is in the
 * bar), which also holds "QR code" — a LINK to the task's QR page
 * (pages/TaskQrPage.tsx). Both were buttons in a row on the page, rendered
 * from here, which is why the file keeps its older name.
 *
 * RAC (see docs/2026-07-18-rac-adoption-guide.md): kit Modal/Menu/Checkbox. Menu
 * items are real links (RAC MenuItem href + download), with menu keyboard
 * semantics.
 */
import { useEffect, useState } from "react";
import { WAYPOINT_EXPORT_FORMATS } from "@glidecomp/engine";
import { Button } from "@/react/rac/button";
import { Checkbox } from "@/react/rac/checkbox";
import { Dialog, DialogHeader, DialogTitle, Modal } from "@/react/rac/dialog";
import { Menu, MenuItem, MenuTrigger } from "@/react/rac/menu";
import { ChevronDownIcon } from "lucide-react";

// The formats offered for a task: the native XCTrack task first, then every
// waypoint file format (which serialize the task's turnpoints).
const TASK_FORMATS: { id: string; label: string }[] = [
  { id: "xctsk", label: "XCTrack task (.xctsk)" },
  ...WAYPOINT_EXPORT_FORMATS.map((f) => ({ id: f.id, label: f.label })),
];

export function ShareTaskDialog({
  compId,
  taskId,
  taskName,
  isOpen,
  onOpenChange,
}: {
  compId: string;
  taskId: string;
  taskName: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [swap, setSwap] = useState(false);
  // Touch devices open the file straight into a flight app; desktop downloads.
  const [openInApp, setOpenInApp] = useState(false);
  useEffect(() => {
    setOpenInApp(
      typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches === true
    );
  }, []);

  const hostedUrl = (fmt: string) =>
    `/api/comp/${compId}/task/${taskId}/waypoints/${fmt}` +
    (swap && fmt !== "xctsk" ? "?swap=1" : "");

  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Dialog className="gap-3">
        <DialogHeader>
          <DialogTitle className="truncate">Share “{taskName}”</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {openInApp
            ? "Open the task straight into your flight app (XCTrack, Flyskyhy, SeeYou Navigator…), or scan the QR."
            : "Download the task in a format your instrument reads."}
        </p>

        <Checkbox
          isSelected={swap}
          onChange={setSwap}
          className="text-xs text-muted-foreground"
        >
          Swap code &amp; name — use the full name as the waypoint label
        </Checkbox>

        <MenuTrigger>
          <Button variant="outline" size="sm" className="w-fit">
            {openInApp ? "Open in app" : "Download"}
            <ChevronDownIcon className="size-4 opacity-60" aria-hidden />
          </Button>
          <Menu>
            {TASK_FORMATS.map((f) =>
              openInApp ? (
                <MenuItem
                  key={f.id}
                  href={hostedUrl(f.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {f.label}
                </MenuItem>
              ) : (
                // `download` (no value) forces a save and uses the server's
                // Content-Disposition filename.
                <MenuItem key={f.id} href={hostedUrl(f.id)} download="">
                  {f.label}
                </MenuItem>
              )
            )}
          </Menu>
        </MenuTrigger>
      </Dialog>
    </Modal>
  );
}
