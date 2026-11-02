/**
 * "Share task" + "QR code" buttons (issue #312, stage 2 UX), on the task page,
 * so pilots can grab the route:
 *
 *  - "Share task" opens a dialog with a format menu (native .xctsk plus
 *    every waypoint file format) and the "swap code / name" option. On a phone
 *    each format opens straight into a flight app; on desktop it downloads.
 *  - "QR code" is a LINK to the task's QR page (`qrHref`,
 *    pages/TaskQrPage.tsx): an XCTrack `XCTSK:` QR at the size a camera wants.
 *    It was a full-screen, tap-to-dismiss overlay until issue #813 (see the
 *    overlays rule in CLAUDE.md), so Back now leaves it, and the page fetches
 *    the route itself rather than being handed it from here.
 *
 * RAC (see docs/2026-07-18-rac-adoption-guide.md): kit Modal/Menu/Checkbox. Menu
 * items are real links (RAC MenuItem href + download), with menu keyboard
 * semantics.
 */
import { useEffect, useState } from "react";
import { WAYPOINT_EXPORT_FORMATS } from "@glidecomp/engine";
import { Button, LinkButton } from "@/react/rac/button";
import { Checkbox } from "@/react/rac/checkbox";
import { Dialog, DialogHeader, DialogTitle, Modal } from "@/react/rac/dialog";
import { Menu, MenuItem, MenuTrigger } from "@/react/rac/menu";
import { Share2Icon, QrCodeIcon, ChevronDownIcon } from "lucide-react";

// The formats offered for a task: the native XCTrack task first, then every
// waypoint file format (which serialize the task's turnpoints).
const TASK_FORMATS: { id: string; label: string }[] = [
  { id: "xctsk", label: "XCTrack task (.xctsk)" },
  ...WAYPOINT_EXPORT_FORMATS.map((f) => ({ id: f.id, label: f.label })),
];

export function TaskExportButtons({
  compId,
  taskId,
  taskName,
  qrHref,
  size = "sm",
  qrFirst = false,
  primary,
  asMenu = false,
}: {
  compId: string;
  taskId: string;
  taskName: string;
  /** The task's QR page — build it with `taskQrPath()`, from `compUrlId()`. */
  qrHref: string;
  size?: "sm" | "default";
  /** Show the QR code button before Share task (role-based button order). */
  qrFirst?: boolean;
  /** Which of the two buttons is the primary action (role-based button order). */
  primary?: "share" | "qr";
  /**
   * Collapse the two buttons into ONE "Share" menu (Share / download… + QR
   * code) — the de-cluttered form. The share dialog and the QR page behave
   * identically either way.
   */
  asMenu?: boolean;
}) {
  const [shareOpen, setShareOpen] = useState(false);
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

  const shareButton = (
    <Button
      key="share"
      variant={primary === "share" ? "default" : "outline"}
      size={size}
      onPress={() => setShareOpen(true)}
    >
      <Share2Icon className="size-4" aria-hidden />
      Share task
    </Button>
  );
  const qrButton = (
    <LinkButton
      key="qr"
      variant={primary === "qr" ? "default" : "outline"}
      size={size}
      href={qrHref}
    >
      <QrCodeIcon className="size-4" aria-hidden />
      QR code
    </LinkButton>
  );

  return (
    <>
      {asMenu ? (
        <MenuTrigger>
          <Button variant="outline" size={size}>
            <Share2Icon className="size-4" aria-hidden />
            Share
            <ChevronDownIcon className="size-4 opacity-60" aria-hidden />
          </Button>
          <Menu>
            <MenuItem onAction={() => setShareOpen(true)}>
              Share / download task…
            </MenuItem>
            <MenuItem href={qrHref}>QR code</MenuItem>
          </Menu>
        </MenuTrigger>
      ) : qrFirst ? (
        <>
          {qrButton}
          {shareButton}
        </>
      ) : (
        <>
          {shareButton}
          {qrButton}
        </>
      )}

      <Modal isOpen={shareOpen} onOpenChange={setShareOpen}>
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
    </>
  );
}
