/**
 * "Get these on your device" panel (issue #312, stage 2). Shared by the comp
 * waypoints page (the full shared set) and the task page (a task's turnpoints):
 * a Download menu covering every supported file format plus a scannable
 * XCTrack `XCTSK:` QR that Flyskyhy, XCTrack and most flight apps import.
 *
 * A "swap code / name" toggle flips which identifier the device shows as the
 * waypoint label — applied uniformly to the files and the QR.
 *
 * SSR-safe: the task page is server-rendered, so the QR (which pulls in
 * qrcode.react) is lazy-loaded to stay out of the SSR/main entry bundle, and
 * nothing here touches window/document at module scope.
 */
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  encodeXctskQR,
  swapCodeName,
  WAYPOINT_EXPORT_FORMATS,
  XCTSK_QR_MAX_BYTES,
  type WaypointFileRecord,
} from "@glidecomp/engine";
import { Button } from "@/react/ui/button";
import { Checkbox } from "@/react/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/react/ui/dropdown-menu";
import { downloadFile } from "../lib/format";
import { slugify } from "./csv";
import { DownloadIcon, QrCodeIcon, ChevronDownIcon, Share2Icon } from "lucide-react";

const WaypointQR = lazy(() => import("./WaypointQR"));

export function WaypointDeviceExport({
  records,
  baseName,
  title = "Get these waypoints on your device",
  subtitle = "Open or download a file for your instrument, or scan the QR into your flight app (XCTrack, Flyskyhy, SeeYou Navigator and most others).",
  noun = "waypoint",
}: {
  records: WaypointFileRecord[];
  /** Used to name the downloaded file, e.g. the comp or task name. */
  baseName: string;
  title?: string;
  subtitle?: string;
  /** Singular noun for the count, e.g. "waypoint" or "turnpoint". */
  noun?: string;
}) {
  const [showQR, setShowQR] = useState(false);
  const [swap, setSwap] = useState(false);
  // Can this browser hand a file to the OS share sheet (mobile)? Detected on the
  // client only — reading `navigator` during render would break the SSR task page.
  const [canShareFiles, setCanShareFiles] = useState(false);
  useEffect(() => {
    setCanShareFiles(typeof navigator !== "undefined" && typeof navigator.canShare === "function");
  }, []);

  const exported = useMemo(() => (swap ? swapCodeName(records) : records), [swap, records]);
  const xctsk = useMemo(() => (exported.length ? encodeXctskQR(exported) : ""), [exported]);
  const qrTooBig = useMemo(
    () => (xctsk ? new TextEncoder().encode(xctsk).length > XCTSK_QR_MAX_BYTES : false),
    [xctsk]
  );

  async function openOrDownload(format: (typeof WAYPOINT_EXPORT_FORMATS)[number]) {
    if (!exported.length) return;
    const filename = `${slugify(baseName || "competition")}-waypoints.${format.extension}`;
    const content = format.serialize(exported);
    // On mobile, offer the file to the OS share sheet so it can open straight
    // into a flight app (XCTrack, Flyskyhy, SeeYou Navigator…) rather than only
    // saving. Desktop / unsupported browsers fall through to a plain download.
    if (typeof navigator !== "undefined" && typeof navigator.canShare === "function") {
      try {
        const file = new File([content], filename, { type: format.mimeType });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: filename });
          return;
        }
      } catch (err) {
        // The user dismissed the sheet — don't also download behind their back.
        if ((err as { name?: string })?.name === "AbortError") return;
        // Anything else (share not actually supported for this file) → download.
      }
    }
    downloadFile(filename, content, format.mimeType);
  }

  if (!records.length) return null;

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={canShareFiles ? "Open waypoints in an app" : "Download waypoints"}
                />
              }
            >
              {canShareFiles ? (
                <Share2Icon className="size-4" aria-hidden />
              ) : (
                <DownloadIcon className="size-4" aria-hidden />
              )}
              {canShareFiles ? "Open / save" : "Download"}
              <ChevronDownIcon className="size-4 opacity-60" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                {WAYPOINT_EXPORT_FORMATS.map((fmt) => (
                  <DropdownMenuItem key={fmt.id} onClick={() => void openOrDownload(fmt)}>
                    {fmt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant={showQR ? "default" : "outline"}
            size="sm"
            aria-pressed={showQR}
            disabled={qrTooBig}
            onClick={() => setShowQR((s) => !s)}
          >
            <QrCodeIcon className="size-4" aria-hidden />
            {showQR ? "Hide QR" : "QR code"}
          </Button>
        </div>
      </div>

      <label className="mt-3 flex w-fit items-center gap-2 text-xs text-muted-foreground">
        <Checkbox checked={swap} onCheckedChange={(c) => setSwap(c === true)} />
        Swap code &amp; name — use the full name as the waypoint label on your device
      </label>

      {qrTooBig ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Too many {noun}s ({exported.length}) to fit in a single QR code — download a file instead.
        </p>
      ) : null}

      {showQR && !qrTooBig ? (
        <div className="mt-4 flex flex-col items-center gap-2">
          <Suspense
            fallback={
              <div className="flex size-[280px] items-center justify-center text-sm text-muted-foreground">
                Generating QR…
              </div>
            }
          >
            <WaypointQR value={xctsk} />
          </Suspense>
          <p className="text-center text-xs text-muted-foreground">
            Scan with XCTrack, Flyskyhy or any app that reads XCTSK task QRs · {exported.length}{" "}
            {noun}
            {exported.length === 1 ? "" : "s"}
          </p>
        </div>
      ) : null}
    </div>
  );
}
