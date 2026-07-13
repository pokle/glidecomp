/**
 * "Share task" + "QR code" buttons (issue #312, stage 2 UX). Reused wherever a
 * task appears — the competition hub's task card and the task detail page — so
 * pilots can grab the route from anywhere:
 *
 *  - "Share task" opens a dialog with a format dropdown (native .xctsk plus
 *    every waypoint file format) and the "swap code / name" option. On a phone
 *    each format opens straight into a flight app; on desktop it downloads.
 *  - "QR code" shows a full-screen, tap-to-dismiss XCTrack `XCTSK:` QR.
 *
 * Turnpoints can be passed inline (`records`, on the task page) or fetched on
 * demand from the task API (the comp hub card, which lists tasks without their
 * routes). SSR-safe: the QR pulls in qrcode.react only behind a lazy import.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import {
  encodeXctskQR,
  WAYPOINT_EXPORT_FORMATS,
  xctaskTurnpointsToRecords,
  type WaypointFileRecord,
  type XCTask,
} from "@glidecomp/engine";
import { Button } from "@/react/ui/button";
import { Checkbox } from "@/react/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/react/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/react/ui/dropdown-menu";
import { api } from "../../comp/api";
import { toast } from "../lib/toast";
import { Share2Icon, QrCodeIcon, ChevronDownIcon } from "lucide-react";

const FullScreenQR = lazy(() => import("./FullScreenQR"));

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
  records,
  size = "sm",
  qrFirst = false,
  primary,
}: {
  compId: string;
  taskId: string;
  taskName: string;
  /** Turnpoints if already loaded (task page); fetched on demand otherwise. */
  records?: WaypointFileRecord[];
  size?: "sm" | "default";
  /** Show the QR code button before Share task (role-based button order). */
  qrFirst?: boolean;
  /** Which of the two buttons is the primary action (role-based button order). */
  primary?: "share" | "qr";
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [swap, setSwap] = useState(false);
  const [qrValue, setQrValue] = useState<string | null>(null);
  const [qrLoading, setQrLoading] = useState(false);
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

  async function fetchRecords(): Promise<WaypointFileRecord[] | null> {
    if (records) return records;
    try {
      const res = await api.api.comp[":comp_id"].task[":task_id"].$get({
        param: { comp_id: compId, task_id: taskId },
      });
      if (!res.ok) throw new Error("unavailable");
      const data = (await res.json()) as unknown as { xctsk: XCTask | null };
      if (!data.xctsk) {
        toast.error("No route defined for this task yet");
        return null;
      }
      return xctaskTurnpointsToRecords(data.xctsk.turnpoints);
    } catch {
      toast.error("Could not load the task");
      return null;
    }
  }

  async function showQR() {
    setQrLoading(true);
    const recs = await fetchRecords();
    setQrLoading(false);
    if (!recs) return;
    if (recs.length === 0) {
      toast.error("This task has no turnpoints yet");
      return;
    }
    setQrValue(encodeXctskQR(recs));
  }

  const shareButton = (
    <Button
      key="share"
      type="button"
      variant={primary === "share" ? "default" : "outline"}
      size={size}
      onClick={() => setShareOpen(true)}
    >
      <Share2Icon className="size-4" aria-hidden />
      Share task
    </Button>
  );
  const qrButton = (
    <Button
      key="qr"
      type="button"
      variant={primary === "qr" ? "default" : "outline"}
      size={size}
      disabled={qrLoading}
      onClick={() => void showQR()}
    >
      <QrCodeIcon className="size-4" aria-hidden />
      QR code
    </Button>
  );

  return (
    <>
      {qrFirst ? (
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

      <Dialog open={shareOpen} onOpenChange={setShareOpen}>
        <DialogContent className="flex flex-col gap-3 sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="truncate">Share “{taskName}”</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {openInApp
              ? "Open the task straight into your flight app (XCTrack, Flyskyhy, SeeYou Navigator…), or scan the QR."
              : "Download the task in a format your instrument reads."}
          </p>

          <label className="flex w-fit items-center gap-2 text-xs text-muted-foreground">
            <Checkbox checked={swap} onCheckedChange={(c) => setSwap(c === true)} />
            Swap code &amp; name — use the full name as the waypoint label
          </label>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" variant="outline" size="sm" className="w-fit" />}
            >
              {openInApp ? "Open in app" : "Download"}
              <ChevronDownIcon className="size-4 opacity-60" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuGroup>
                {TASK_FORMATS.map((f) =>
                  openInApp ? (
                    <DropdownMenuItem
                      key={f.id}
                      render={<a href={hostedUrl(f.id)} target="_blank" rel="noopener noreferrer" />}
                    >
                      {f.label}
                    </DropdownMenuItem>
                  ) : (
                    // `download` (no value) forces a save and uses the server's
                    // Content-Disposition filename.
                    <DropdownMenuItem key={f.id} render={<a href={hostedUrl(f.id)} download />}>
                      {f.label}
                    </DropdownMenuItem>
                  )
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </DialogContent>
      </Dialog>

      {qrValue ? (
        <Suspense fallback={null}>
          <FullScreenQR
            value={qrValue}
            caption={`${taskName} · scan with XCTrack, Flyskyhy or any XCTSK-aware app`}
            onClose={() => setQrValue(null)}
          />
        </Suspense>
      ) : null}
    </>
  );
}
