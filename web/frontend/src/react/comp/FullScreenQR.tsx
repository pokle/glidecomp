/**
 * A full-screen QR overlay (issue #312, stage 2 UX): tap anywhere — or press
 * Escape — to dismiss. Sized to fill the viewport so it's easy to show to
 * someone else's phone to scan.
 *
 * The overlay shell (focus trapping, focus restore, Escape, body scroll-lock,
 * all from react-aria) is rac/full-screen-sheet.tsx, which this file's
 * original hand-rolled version became. The `contrast` backdrop is here rather
 * than the app's own surface because a QR wants maximum contrast for a camera.
 *
 * Lazy-loaded by its callers so `qrcode.react` stays out of the main/SSR entry
 * bundle; nothing here touches window/document at module scope.
 */
import { QRCodeSVG } from "qrcode.react";

import { FullScreenSheet } from "@/react/rac/full-screen-sheet";

export default function FullScreenQR({
  value,
  caption,
  onClose,
}: {
  value: string;
  caption?: string;
  onClose: () => void;
}) {
  return (
    <FullScreenSheet
      label="QR code"
      onClose={onClose}
      backdrop="contrast"
      // A QR is a picture: nothing inside is clickable, so the whole overlay
      // can be the close target.
      dismissOnPress
      className="flex flex-col items-center justify-center gap-4 p-6"
    >
      <div className="rounded-2xl bg-white p-5 shadow-2xl">
        <QRCodeSVG
          value={value}
          // Level L maximises capacity; scanned from a screen at close range.
          level="L"
          marginSize={2}
          size={512}
          style={{ width: "min(82vw, 72vh, 560px)", height: "auto" }}
        />
      </div>
      {caption ? (
        <p className="max-w-md text-center text-sm text-white/85">{caption}</p>
      ) : null}
      <p className="text-xs text-white/60">Tap anywhere to close</p>
    </FullScreenSheet>
  );
}
