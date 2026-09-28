/**
 * Shows the notice described in ./legal-notice.ts. Browser-only.
 */
import { toast as sonnerToast } from "sonner";
import type { AuthUser } from "@/auth/client";
import {
  LEGAL_NOTICE,
  LEGAL_NOTICE_DISMISSED_KEY,
  shouldShowLegalNotice,
} from "./legal-notice";

function readDismissed(): string | null {
  try {
    return localStorage.getItem(LEGAL_NOTICE_DISMISSED_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(version: string) {
  try {
    localStorage.setItem(LEGAL_NOTICE_DISMISSED_KEY, version);
  } catch {
    // Storage blocked (Safari private mode): the notice comes back next
    // load, which is the lesser evil than never showing it.
  }
}

/** Show the toast if this reader is due it. Browser-only; call after the
 *  toaster has mounted — sonner drops a toast published before it has. */
export function maybeShowLegalNotice(user: AuthUser | null, notice = LEGAL_NOTICE) {
  if (!user) return;
  // Automated browsers (every Playwright context sets this) never see it: a
  // toast that stays up would sit over whatever the e2e suite clicks next, and
  // a fixture cannot reach the contexts specs open for themselves.
  // e2e/legal-notice.spec.ts clears the flag to test the toast itself.
  if (navigator.webdriver) return;
  if (!shouldShowLegalNotice(notice, new Date(), readDismissed())) return;
  const dismiss = () => writeDismissed(notice.version);
  sonnerToast.info(notice.message, {
    id: "legal-notice",
    duration: Infinity,
    closeButton: true,
    onDismiss: dismiss,
    action: {
      label: "Read",
      onClick: () => {
        dismiss();
        window.location.assign("/legal");
      },
    },
  });
}
