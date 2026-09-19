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
 * **Back closes it.** The sheet is React state rather than a route, so the
 * history stack cannot see it and Back would otherwise skip past it to the
 * previous page — from a waypoint's details, one Back left the whole editor
 * with its unsaved edits. `lib/use-back-dismiss.ts` gives it a history entry
 * of its own while it is open and pops that entry again on the way out; the
 * URL never changes, and nested sheets stack so Back walks out one layer at a
 * time.
 *
 * There is no `isOpen`: render the sheet when it is open and not when it is
 * not. Every caller already owns that state (or, for a lazily-imported sheet,
 * needs the component to not exist until then), and a sheet that is mounted
 * but closed would keep its content — a QR encoder, a whole chart — alive for
 * nothing.
 *
 * `className` styles the sheet's content box, which is `h-full w-full` and
 * otherwise unopinionated: a picture wants `flex items-center justify-center`,
 * a header-plus-body wants `flex flex-col` — and for that second shape,
 * {@link SheetHeader} / {@link SheetBody} / {@link SheetFooter} below are the
 * chrome, rather than each sheet spelling out its own. Padding belongs in
 * `className` too, since how much of the edge to spend depends on what is
 * being shown.
 *
 * **Padding inside a sheet is plain Tailwind.** The safe area is spent HERE,
 * once, by the `p-safe` below; a caller adding `px-gutter-safe` or
 * `pb-gutter-safe` on top counts the inset a second time
 * (`max(1rem, inset) + inset`), which in landscape is a visibly wider gutter
 * than the same chrome has anywhere else. Use `px-4` and let this component
 * own the notch.
 *
 * **A sheet needs a visible way out, and it should hold the focus.** Escape
 * alone is not a discoverable affordance (accessibility standard §4.1), and
 * without `autoFocus` a keyboard or screen-reader user lands on the dialog
 * container with the exit somewhere ahead of them. So every sheet carries a
 * Close or Done button and marks it `autoFocus` — in the header for the
 * header-plus-body shape, beside the picture otherwise. This note used to be
 * copied verbatim above five such buttons; it lives here now.
 *
 * Extracted from the three overlays that had grown the same shell: the
 * waypoint QR (#312), the task route glyph (#476) and the task-analysis
 * metric chart (#455).
 */
import type { ReactNode } from "react";
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  ModalOverlay,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { useBackDismiss } from "@/react/lib/use-back-dismiss";

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
   * actually pressed. It is never the way OUT on its own either: see the note
   * above about the Close button every sheet carries.
   */
  dismissOnPress?: boolean;
  className?: string;
  children: ReactNode;
}) {
  useBackDismiss(onClose);

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

/**
 * A sheet's title bar: what is on screen, and the way out of it.
 *
 * Fixed at the top while {@link SheetBody} scrolls under it, so Done is never
 * something a reader has to scroll to find. Both ways out live here rather
 * than in a footer, because a phone keyboard covers the bottom of the
 * viewport whenever a sheet with a form in it is doing its job, and an action
 * you must dismiss the keyboard to reach is one you have to discover twice.
 *
 * `action` is where the `autoFocus` button goes — see the note on
 * {@link FullScreenSheet} for why every sheet has one.
 *
 * Four sheets had each grown their own version of this bar, in two
 * vocabularies that disagreed about the gutter, the title's weight and
 * whether the body had a readable-width cap. The differences were all
 * accidental.
 */
export function SheetHeader({
  title,
  description,
  align = "start",
  leading,
  action,
  className,
}: {
  /** The sheet's name. Omit it where the body carries the heading instead. */
  title?: ReactNode;
  /**
   * One line under the title — a count, a status. Passed whole rather than as
   * text, so a live region (`role="status"`) stays the caller's to declare.
   */
  description?: ReactNode;
  /** Centre the title when the bar has a button on BOTH sides of it. */
  align?: "start" | "center";
  /** Left of the title: Cancel, or a Back that returns to a list. */
  leading?: ReactNode;
  /** Right of the title, and the way out. */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-3 border-b border-border px-4 py-3",
        // A description makes the title block taller than the buttons beside
        // it, and a centred button against a two-line title reads as detached.
        description ? "items-start" : "items-center",
        className
      )}
    >
      {leading}
      {title === undefined ? null : (
        <div className={cn("min-w-0 flex-1", align === "center" && "text-center")}>
          <h2 className="truncate text-base font-semibold">{title}</h2>
          {description}
        </div>
      )}
      {action === undefined ? null : (
        // ml-auto so the way out still sits right with no title to push it
        // there — a bar of just a Back and a Done is the altitude review's.
        <div className={cn("shrink-0", title === undefined && "ml-auto")}>{action}</div>
      )}
    </div>
  );
}

/**
 * The scrolling part of a sheet — everything between the header and the
 * footer.
 *
 * `max-w-2xl` and centred: a sheet is as wide as the device, and a form field
 * spanning a tablet in landscape is a line nobody can read along. The cap was
 * in two of the four sheets and missing from the other two, which is the only
 * reason waypoint fields stretched edge to edge while turnpoint ones did not.
 *
 * `min-h-0` is what makes it scroll rather than grow: in a flex column a
 * flex item's implicit `min-height: auto` lets its content push it past the
 * viewport, taking the header with it.
 *
 * Content layout stays the caller's (`flex flex-col gap-3` for a stack of
 * fields, nothing for a list) — this owns the width, the padding and the
 * scroll, which are the things that were drifting.
 */
export function SheetBody({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto min-h-0 w-full max-w-2xl flex-1 overflow-y-auto p-4",
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A sheet's bottom bar, for an action that belongs to the whole sheet rather
 * than to one row of it — the altitude review's "use the map's altitude for
 * all N".
 *
 * Read the keyboard note on {@link SheetHeader} before putting anything here
 * that a reader has to reach while typing: down here it is behind the
 * keyboard. This is for a bar that is reached once the typing is done.
 */
export function SheetFooter({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-2xl flex-wrap items-center gap-2 border-t border-border px-4 pt-3 pb-4",
        className
      )}
    >
      {children}
    </div>
  );
}
