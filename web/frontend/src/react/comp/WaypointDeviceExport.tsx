/**
 * "Get these on your device" (issue #312, stage 2), for the comp waypoints
 * page's full shared set: every supported file format, plus a scannable
 * XCTrack `XCTSK:` QR that Flyskyhy, XCTrack and most flight apps import.
 *
 * It is two rows of the page's ⋯ menu and one panel on the page (issue #863:
 * the page is for information, and every action goes in the bar). It was a
 * toolbar of two buttons above the list until 2026-11, and a titled card
 * before that.
 *
 * - **Download** (on a touch device, **Open in a flight app**) opens a second
 *   menu of the formats. On touch its rows are real links to the hosted file,
 *   so the OS hands it to a flight app; on a desktop they serialise and
 *   download client-side.
 * - **QR code** shows the QR on the page, at its head, and scrolls it into
 *   view. The QR is information, so it is on the page; the row that shows and
 *   hides it is the action.
 *
 * "Swap code & name" flips which identifier the device shows as the waypoint
 * label — applied uniformly to the files and the QR, from ONE piece of state.
 * It is offered where each output is chosen: as the first row of the formats
 * menu, and as a checkbox beside the QR.
 *
 * SSR-safe: the QR (which pulls in qrcode.react) is lazy-loaded to stay out of
 * the SSR/main entry bundle, nothing here touches window/document at module
 * scope, and the touch check runs in an effect, so the server and the first
 * client render agree.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  encodeXctskQR,
  swapCodeName,
  WAYPOINT_EXPORT_FORMATS,
  XCTSK_QR_MAX_BYTES,
  type WaypointFileRecord,
} from "@glidecomp/engine";
import { Checkbox } from "@/react/rac/checkbox";
import type { BarAction } from "@/react/rac/page-bar";
import { downloadFile } from "../lib/format";
import { slugify } from "./csv";
import { ArrowLeftRightIcon, DownloadIcon, QrCodeIcon, SmartphoneIcon } from "lucide-react";

const WaypointQR = lazy(() => import("./WaypointQR"));

const SWAP_LABEL = "Swap code & name — use the full name as the waypoint label on your device";

/**
 * The device rows for a page's ⋯ menu, and the panel they show on the page.
 * No records: no rows and no panel — a comp with nothing published has
 * nothing to put on a device.
 */
export function useWaypointDeviceExport({
  records,
  baseName,
  hostedUrl,
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
  /** Singular noun for the count, e.g. "waypoint" or "turnpoint". */
  noun?: string;
}): { actions: BarAction[]; panel: ReactNode } {
  const [showQR, setShowQR] = useState(false);
  const [swap, setSwap] = useState(false);
  // On a touch device, link to the hosted file so it opens in a flight app;
  // on desktop, keep the plain "save a file" behaviour. Detected client-side
  // only — reading window during render would break the SSR'd page.
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

  // The QR opens at the head of the page, and the reader may be far down the
  // list when they ask for it.
  const qrRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (showQR) qrRef.current?.scrollIntoView({ block: "start" });
  }, [showQR]);

  if (!records.length) return { actions: [], panel: null };

  function download(format: (typeof WAYPOINT_EXPORT_FORMATS)[number]) {
    downloadFile(
      `${slugify(baseName || "competition")}-waypoints.${format.extension}`,
      format.serialize(exported),
      format.mimeType
    );
  }

  const actions: BarAction[] = [
    {
      id: "device-files",
      icon: openInApp ? SmartphoneIcon : DownloadIcon,
      label: openInApp ? "Open in a flight app" : "Download",
      children: [
        // Swap rides with the format choice: picking a file and deciding what
        // the device will call each point is one decision, made in one place.
        {
          id: "swap",
          icon: ArrowLeftRightIcon,
          label: `Swap code & name: ${swap ? "on" : "off"}`,
          onAction: () => setSwap(!swap),
        },
        ...WAYPOINT_EXPORT_FORMATS.map(
          (fmt, i): BarAction =>
            openInApp && hostedUrl
              ? {
                  id: `format-${fmt.id}`,
                  label: fmt.label,
                  to: hostedUrl(fmt.id, swap),
                  target: "_blank",
                  group: i === 0,
                }
              : {
                  id: `format-${fmt.id}`,
                  label: fmt.label,
                  onAction: () => download(fmt),
                  group: i === 0,
                }
        ),
      ],
    },
    {
      id: "qr",
      icon: QrCodeIcon,
      label: showQR ? "Hide QR" : "QR code",
      disabled: qrTooBig,
      onAction: () => setShowQR(!showQR),
    },
  ];

  const panel = qrTooBig ? (
    <p className="mb-4 text-xs text-muted-foreground">
      Too many {noun}s ({exported.length}) to fit in a single QR code — download a file instead.
    </p>
  ) : showQR ? (
    // Clears the bar and the filter that sticks with it.
    <div ref={qrRef} className="mb-4 flex scroll-mt-36 flex-col items-center gap-2">
      <Checkbox isSelected={swap} onChange={setSwap} className="text-xs text-muted-foreground">
        {SWAP_LABEL}
      </Checkbox>
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
  ) : null;

  return { actions, panel };
}
