/**
 * React Aria Components modal dialogs, styled to match ui/dialog.tsx.
 *
 * RAC composition: <DialogTrigger> (optional) → <Modal> (overlay + panel) →
 * <Dialog> (the ARIA dialog) → content. A Button with slot="close" anywhere
 * inside the Dialog closes it — no context wiring needed. Controlled usage
 * passes isOpen/onOpenChange to Modal, mirroring the Base UI open/onOpenChange
 * pattern the app already uses.
 */
import {
  Dialog as AriaDialog,
  Modal as AriaModal,
  DialogTrigger,
  Heading,
  ModalOverlay,
  type DialogProps as AriaDialogProps,
  type ModalOverlayProps,
} from "react-aria-components";

import { cn } from "@/react/lib/utils";
import { Button } from "./button";
import { XIcon } from "lucide-react";

/**
 * Overlay + centered panel. `className` styles the panel (width/height
 * overrides land here, like DialogContent before). Dismissable by outside
 * click/Esc by default, matching the Base UI dialogs it replaces — pass
 * isDismissable={false} for must-decide dialogs (see rac/confirm.tsx).
 */
export function Modal({
  className,
  children,
  isDismissable = true,
  ...props
}: Omit<ModalOverlayProps, "className"> & { className?: string }) {
  return (
    <ModalOverlay
      isDismissable={isDismissable}
      // Centering happens via the panel's auto margins, not items-center on
      // the overlay: flex centering clips the TOP of a panel taller than the
      // viewport (it overflows above the scroll origin, unreachable), while
      // auto margins collapse to 0 on overflow so the whole panel scrolls.
      className={cn(
        "fixed inset-0 isolate z-50 flex min-h-dvh justify-center overflow-y-auto bg-black/10 p-4 supports-backdrop-filter:backdrop-blur-xs",
        "data-entering:animate-in data-entering:fade-in-0 data-exiting:animate-out data-exiting:fade-out-0 data-entering:duration-100 data-exiting:duration-100"
      )}
      {...props}
    >
      <AriaModal
        data-slot="dialog-content"
        className={cn(
          "relative my-auto grid h-fit w-full max-w-[calc(100%-2rem)] gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 outline-none sm:max-w-sm",
          "data-entering:animate-in data-entering:fade-in-0 data-entering:zoom-in-95 data-exiting:animate-out data-exiting:fade-out-0 data-exiting:zoom-out-95 data-entering:duration-100 data-exiting:duration-100",
          className
        )}
      >
        {children}
      </AriaModal>
    </ModalOverlay>
  );
}

/**
 * The ARIA dialog itself. role="alertdialog" for confirm-style dialogs.
 * Renders the top-right ✕ automatically (like the old DialogContent), except
 * for alertdialogs — those are decisions, closed only by their buttons.
 */
export function Dialog({
  className,
  children,
  showClose,
  ...props
}: Omit<AriaDialogProps, "children"> & {
  children: React.ReactNode;
  showClose?: boolean;
}) {
  const withClose = showClose ?? props.role !== "alertdialog";
  return (
    <AriaDialog
      className={cn("grid gap-4 outline-none", className as string)}
      {...props}
    >
      {children}
      {withClose ? <DialogCloseIcon /> : null}
    </AriaDialog>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}

/** Dialog title — RAC Heading with slot="title" labels the dialog for AT. */
export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof Heading>) {
  return (
    <Heading
      slot="title"
      className={cn("text-base leading-none font-medium", className)}
      {...props}
    />
  );
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  );
}

/**
 * The top-right ✕. slot="close" wires it to the containing Dialog. It's
 * positioned against the panel, so in a dialog whose body scrolls, content
 * passes underneath it — hence the solid background: the button occludes what
 * slides behind rather than letting text show through the glyph.
 */
export function DialogCloseIcon() {
  return (
    <Button
      slot="close"
      variant="ghost"
      size="icon-sm"
      className="absolute top-2 right-2 z-20 bg-popover"
    >
      <XIcon />
      <span className="sr-only">Close</span>
    </Button>
  );
}

export { DialogTrigger };
