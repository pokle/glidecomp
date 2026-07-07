/**
 * App-wide toasts, backed by sonner (the shadcn/ui toast). `toast` mirrors
 * the vanilla feedback.ts API (success/error/info/warning) so page code
 * ports over unchanged, and works from non-component code too.
 */
import { createPortal } from "react-dom";
import { toast as sonnerToast } from "sonner";
import { Toaster } from "@/react/ui/sonner";

export const toast = {
  success: (message: string) => sonnerToast.success(message),
  error: (message: string) => sonnerToast.error(message),
  info: (message: string) => sonnerToast.info(message),
  warning: (message: string) => sonnerToast.warning(message),
};

export function AppToaster() {
  // Portal to <body>: #root is a stacking context (isolation: isolate, a
  // Base UI requirement), so a toaster rendered inside it paints below the
  // body-level dialog portals no matter its z-index — toasts fired while a
  // dialog is open would be hidden behind it. At body level sonner's own
  // z-index wins and toasts stay on top of open dialogs.
  return createPortal(<Toaster position="bottom-right" />, document.body);
}
