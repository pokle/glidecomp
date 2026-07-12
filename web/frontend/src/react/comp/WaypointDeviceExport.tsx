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
import { DownloadIcon, QrCodeIcon, ChevronDownIcon, ExternalLinkIcon } from "lucide-react";

const WaypointQR = lazy(() => import("./WaypointQR"));

export function WaypointDeviceExport({
  records,
  baseName,
  hostedUrl,
  title = "Get these waypoints on your device",
  subtitle = "Open or download a file for your instrument, or scan the QR into your flight app (XCTrack, Flyskyhy, SeeYou Navigator and most others).",
  noun = "waypoint",
}: {
  records: WaypointFileRecord[];
  /** Used to name the downloaded file, e.g. the comp or task name. */
  baseName: string;
  /**
   * Builds the server URL that serves this set as an openable file, for a
   * given export-format id and swap state. On touch devices the menu links to
   * it (so the OS hands the file to a flight app) instead of saving a local
   * copy. When omitted, every device just downloads.
   */
  hostedUrl?: (formatId: string, swap: boolean) => string;
  title?: string;
  subtitle?: string;
  /** Singular noun for the count, e.g. "waypoint" or "turnpoint". */
  noun?: string;
}) {
  const [showQR, setShowQR] = useState(false);
  const [swap, setSwap] = useState(false);
  // On a touch device, link to the hosted file so it opens in a flight app;
  // on desktop, keep the plain "save a file" behaviour. Detected client-side
  // only — reading window during render would break the SSR task page.
  const [openInApp, setOpenInApp] = useState(false);
  useEffect(() => {
    setOpenInApp(
      !!hostedUrl &&
        typeof window !== "undefined" &&
        window.matchMedia?.("(pointer: coarse)").matches === true
    );
  }, [hostedUrl]);

  const exported = useMemo(() => (swap ? swapCodeName(records) : records), [swap, records]);
  const xctsk = useMemo(() => (exported.length ? encodeXctskQR(exported) : ""), [exported]);
  const qrTooBig = useMemo(
    () => (xctsk ? new TextEncoder().encode(xctsk).length > XCTSK_QR_MAX_BYTES : false),
    [xctsk]
  );

  function download(format: (typeof WAYPOINT_EXPORT_FORMATS)[number]) {
    if (!exported.length) return;
    downloadFile(
      `${slugify(baseName || "competition")}-waypoints.${format.extension}`,
      format.serialize(exported),
      format.mimeType
    );
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
                  aria-label={openInApp ? "Open waypoints in a flight app" : "Download waypoints"}
                />
              }
            >
              {openInApp ? (
                <ExternalLinkIcon className="size-4" aria-hidden />
              ) : (
                <DownloadIcon className="size-4" aria-hidden />
              )}
              {openInApp ? "Open in app" : "Download"}
              <ChevronDownIcon className="size-4 opacity-60" aria-hidden />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                {WAYPOINT_EXPORT_FORMATS.map((fmt) =>
                  openInApp && hostedUrl ? (
                    <DropdownMenuItem
                      key={fmt.id}
                      render={
                        <a href={hostedUrl(fmt.id, swap)} target="_blank" rel="noopener noreferrer" />
                      }
                    >
                      {fmt.label}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem key={fmt.id} onClick={() => download(fmt)}>
                      {fmt.label}
                    </DropdownMenuItem>
                  )
                )}
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
