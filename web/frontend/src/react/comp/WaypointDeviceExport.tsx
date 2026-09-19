/**
 * "Get these on your device" controls (issue #312, stage 2). Used by the comp
 * waypoints page for the full shared set: a Download menu covering every
 * supported file format plus a scannable XCTrack `XCTSK:` QR that Flyskyhy,
 * XCTrack and most flight apps import.
 *
 * It is a TOOLBAR — two buttons and nothing else — not the titled card it was
 * until 2026-09-19. The card spent a heading and two sentences of prose
 * explaining what the two buttons already say, and on a phone that pushed the
 * waypoints themselves below the fold on the page whose whole job is to list
 * them. The words went; the buttons stayed exactly where they were.
 *
 * A "swap code / name" toggle flips which identifier the device shows as the
 * waypoint label — applied uniformly to the files and the QR, from ONE piece
 * of state. It is offered where each output is chosen rather than standing
 * permanently above both: as a checkbox item at the head of the download menu,
 * and as a checkbox inside the expanded QR section.
 *
 * RAC (see docs/2026-07-18-rac-adoption-guide.md): kit Button/ToggleButton/
 * Checkbox/Menu. On touch devices the menu items are real links to the hosted
 * file (so the OS hands it to a flight app); on desktop they serialize and
 * download client-side via onAction. The swap item is a one-item
 * `MenuSection` with `selectionMode="multiple"`, so it is a real
 * `menuitemcheckbox` with `shouldCloseOnSelect={false}` — the menu stays open,
 * and the format hrefs beneath it re-render against the new swap state.
 *
 * SSR-safe: the QR (which pulls in qrcode.react) is lazy-loaded to stay out of
 * the SSR/main entry bundle, and nothing here touches window/document at
 * module scope.
 */
import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  encodeXctskQR,
  swapCodeName,
  WAYPOINT_EXPORT_FORMATS,
  XCTSK_QR_MAX_BYTES,
  type WaypointFileRecord,
} from "@glidecomp/engine";
import { Button, ToggleButton } from "@/react/rac/button";
import { Checkbox } from "@/react/rac/checkbox";
import { Menu, MenuItem, MenuSection, MenuSeparator, MenuTrigger } from "@/react/rac/menu";
import { cn } from "@/react/lib/utils";
import { downloadFile } from "../lib/format";
import { slugify } from "./csv";
import {
  CheckIcon,
  DownloadIcon,
  QrCodeIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
} from "lucide-react";

const WaypointQR = lazy(() => import("./WaypointQR"));

const SWAP_LABEL = "Swap code & name — use the full name as the waypoint label on your device";

export function WaypointDeviceExport({
  records,
  baseName,
  hostedUrl,
  trailing,
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
  /**
   * One more control for the END of the button row — the waypoints page's map
   * fold. It belongs in the row rather than beside this component because an
   * expanded QR makes this block tall AND wide: as a sibling it would be
   * pushed onto a line of its own, under the QR, and read as belonging to
   * whatever came next instead of to the toolbar.
   */
  trailing?: ReactNode;
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
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <MenuTrigger>
          <Button
            variant="outline"
            size="sm"
            aria-label={openInApp ? "Open waypoints in a flight app" : "Download waypoints"}
          >
            {openInApp ? (
              <ExternalLinkIcon className="size-4" aria-hidden />
            ) : (
              <DownloadIcon className="size-4" aria-hidden />
            )}
            {openInApp ? "Open in app" : "Download"}
            <ChevronDownIcon className="size-4 opacity-60" aria-hidden />
          </Button>
          <Menu>
            {/* Swap rides with the format choice: picking a file and deciding
                what the device will call each point is one decision, made in
                one place. `shouldCloseOnSelect={false}` keeps the menu open so
                the hrefs below re-render against the new state. */}
            <MenuSection
              selectionMode="multiple"
              selectedKeys={swap ? ["swap"] : []}
              onSelectionChange={(keys) => setSwap(keys !== "all" && new Set(keys).has("swap"))}
              shouldCloseOnSelect={false}
            >
              <MenuItem id="swap" textValue={SWAP_LABEL}>
                {({ isSelected }) => (
                  <>
                    <CheckIcon
                      className={cn("size-4 shrink-0", isSelected ? "opacity-100" : "opacity-0")}
                      aria-hidden
                    />
                    Swap code &amp; name
                  </>
                )}
              </MenuItem>
            </MenuSection>
            <MenuSeparator />
            {WAYPOINT_EXPORT_FORMATS.map((fmt) =>
              openInApp && hostedUrl ? (
                <MenuItem
                  key={fmt.id}
                  href={hostedUrl(fmt.id, swap)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {fmt.label}
                </MenuItem>
              ) : (
                <MenuItem key={fmt.id} onAction={() => download(fmt)}>
                  {fmt.label}
                </MenuItem>
              )
            )}
          </Menu>
        </MenuTrigger>
        <ToggleButton size="sm" isSelected={showQR} onChange={setShowQR} isDisabled={qrTooBig}>
          <QrCodeIcon className="size-4" aria-hidden />
          {showQR ? "Hide QR" : "QR code"}
        </ToggleButton>
        {trailing}
      </div>

      {qrTooBig ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Too many {noun}s ({exported.length}) to fit in a single QR code — download a file instead.
        </p>
      ) : null}

      {showQR && !qrTooBig ? (
        <div className="mt-4 flex flex-col items-center gap-2">
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
      ) : null}
    </div>
  );
}
