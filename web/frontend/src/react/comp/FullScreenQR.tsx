/**
 * A full-screen QR overlay (issue #312, stage 2 UX): tap anywhere — or press
 * Escape — to dismiss. Sized to fill the viewport so it's easy to show to
 * someone else's phone to scan.
 *
 * Lazy-loaded by its callers so `qrcode.react` stays out of the main/SSR entry
 * bundle; nothing here touches window/document at module scope.
 */
import { useEffect } from "react";
import { QRCodeSVG } from "qrcode.react";

export default function FullScreenQR({
  value,
  caption,
  onClose,
}: {
  value: string;
  caption?: string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="QR code"
      onClick={onClose}
      className="fixed inset-0 z-[100] flex cursor-pointer flex-col items-center justify-center gap-4 bg-black/90 p-6"
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
      {caption ? <p className="max-w-md text-center text-sm text-white/85">{caption}</p> : null}
      <p className="text-xs text-white/60">Tap anywhere to close</p>
    </div>
  );
}
