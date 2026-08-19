/**
 * A modal that fills the screen edge to edge — the full-bleed sibling of this
 * kit's {@link ./dialog.tsx Modal}, which is a centered panel and cannot be
 * talked into being anything else: its `className` styles the panel, while the
 * overlay's padding, background and centering are hardcoded.
 *
 * Built on RAC's modal primitives directly, so focus trapping, focus restore,
 * Escape and body scroll-locking all come from react-aria rather than
 * hand-rolled listeners — the reason the pattern was worth having in the first
 * place (issue #312), and the reason not to reach for a bare `fixed inset-0`.
 *
 * There is no `isOpen`: render the sheet when it is open and not when it is
 * not. Every caller already owns that state (or, for a lazily-imported sheet,
 * needs the component to not exist until then), and a sheet that is mounted
 * but closed would keep its content — a QR encoder, a whole chart — alive for
 * nothing.
 *
 * `className` styles the sheet's content box, which is `h-full w-full` and
 * otherwise unopinionated: a picture wants `flex items-center justify-center`,
 * a header-plus-body wants `flex flex-col`. Padding belongs here too, since
 * how much of the edge to spend depends on what is being shown.
 *
 * Extracted from the three overlays that had grown the same shell: the
 * waypoint QR (#312), the task route glyph (#476) and the field-analysis
 * metric chart (#455).
 */
import type { ReactNode } from "react";
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  ModalOverlay,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";

const BACKDROPS = {
  /** The app's own surface — for themed content. A chart or a diagram drawn
   * in `currentColor` over a `--background` halo is near-invisible on black in
   * light mode, and its label halos are wrong in both. */
  surface: "bg-background/95 backdrop-blur-sm",
  /** Near-black — for content that wants maximum contrast regardless of
   * theme, which in practice means something a camera has to read. */
  contrast: "bg-black/90",
} as const;

export function FullScreenSheet({
  label,
  onClose,
  backdrop = "surface",
  dismissOnPress = false,
  className,
  children,
}: {
  /** The dialog's accessible name. Say what is on screen, not "dialog". */
  label: string;
  onClose: () => void;
  backdrop?: keyof typeof BACKDROPS;
  /**
   * Make the whole sheet one big close target.
   *
   * ONLY for a sheet whose content is a picture — nothing inside it may be
   * clickable, or the dismiss fires on the way to the thing the reader
   * actually pressed. A sheet without this needs its own visible way out:
   * Escape alone is not a discoverable affordance (accessibility standard
   * §4.1), so give it a Close button, ideally `autoFocus` so a keyboard user
   * lands on the exit rather than on the dialog container.
   */
  dismissOnPress?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ModalOverlay
      isOpen
      isDismissable
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className={cn("fixed inset-0 z-[100]", BACKDROPS[backdrop])}
    >
      {/* The backdrop above stays edge to edge (viewport-fit=cover, issue
          #642); `p-safe` here keeps the sheet's CONTENT out of the notch, the
          rounded corners and the home indicator, without the callers — or
          their `className` padding, which composes on top of this — having to
          know about any of it. */}
      <AriaModal className="h-full w-full p-safe outline-none">
        <AriaDialog aria-label={label} className="h-full w-full outline-none">
          <div
            {...(dismissOnPress ? { onClick: onClose } : {})}
            className={cn(
              "h-full w-full",
              dismissOnPress && "cursor-pointer",
              className
            )}
          >
            {children}
          </div>
        </AriaDialog>
      </AriaModal>
    </ModalOverlay>
  );
}
