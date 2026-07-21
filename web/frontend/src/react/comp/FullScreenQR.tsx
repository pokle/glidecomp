/**
 * A full-screen QR overlay (issue #312, stage 2 UX): tap anywhere — or press
 * Escape — to dismiss. Sized to fill the viewport so it's easy to show to
 * someone else's phone to scan.
 *
 * Built on the RAC modal primitives directly (not the kit Modal, whose panel
 * styling doesn't fit a full-bleed overlay) so focus trapping, focus restore,
 * Escape handling and body scroll-locking all come from react-aria instead of
 * hand-rolled listeners.
 *
 * Lazy-loaded by its callers so `qrcode.react` stays out of the main/SSR entry
 * bundle; nothing here touches window/document at module scope.
 */
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  ModalOverlay,
} from "react-aria-components";
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
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className="fixed inset-0 z-[100] bg-black/90"
    >
      <AriaModal className="h-full w-full outline-none">
        <AriaDialog aria-label="QR code" className="h-full w-full outline-none">
          {/* The whole overlay is one big close target — any tap dismisses. */}
          <div
            onClick={onClose}
            className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-4 p-6"
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
          </div>
        </AriaDialog>
      </AriaModal>
    </ModalOverlay>
  );
}
