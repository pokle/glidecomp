/**
 * App-wide toasts, backed by sonner (the shadcn/ui toast). `toast` mirrors
 * the vanilla feedback.ts API (success/error/info/warning) so page code
 * ports over unchanged, and works from non-component code too.
 */
import { createPortal } from "react-dom";
import { toast as sonnerToast } from "sonner";
import { Toaster } from "@/react/ui/sonner";

// Coerce whatever a caller passes into a renderable string. API error
// handlers do `toast.error(err.error || fallback)` and `err.error` is only
// a string by convention — an object here would be rendered as a React
// child by sonner and crash the tree, killing the toast it was meant to show.
function asMessage(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

export const toast = {
  success: (message: string) => sonnerToast.success(asMessage(message)),
  error: (message: string) => sonnerToast.error(asMessage(message)),
  info: (message: string) => sonnerToast.info(asMessage(message)),
  warning: (message: string) => sonnerToast.warning(asMessage(message)),
};

export function AppToaster() {
  // Portal to <body>: #root is a stacking context (isolation: isolate, a
  // Base UI requirement), so a toaster rendered inside it paints below the
  // body-level dialog portals no matter its z-index — toasts fired while a
  // dialog is open would be hidden behind it. At body level sonner's own
  // z-index wins and toasts stay on top of open dialogs.
  return createPortal(<Toaster position="bottom-right" />, document.body);
}
