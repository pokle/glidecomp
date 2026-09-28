/**
 * The "our terms changed" toast — the notice /legal's Terms §9 promises.
 *
 * Terms §9 says a material change is announced on GlideComp at least 14 days
 * before it takes effect. This is that announcement: one toast, to signed-in
 * readers of the SPA, linking to /legal. It is shown until the reader closes
 * it or opens the page, remembered per VERSION (so the next change asks
 * again), and never after a hard cutoff 14 days from publication — past that
 * the change is in force and the notice has done its job.
 *
 * To announce a new change: bump `version` to the new "Last updated" date and
 * reword `message`. Nothing else.
 *
 * Signed-in only: the terms bind account holders, and a result page read by
 * a visitor from a search engine should not open with a legal banner. The
 * static content pages (/, /about, /legal itself) never show it.
 *
 * This module is pure (no sonner, no DOM) so the e2e fixtures can import the
 * key and version; the toast itself is ./legal-notice-toast.ts.
 */

export interface LegalNotice {
  /** The /legal "Last updated" date this announces, as YYYY-MM-DD. */
  version: string;
  message: string;
}

export const LEGAL_NOTICE: LegalNotice = {
  version: "2026-09-28",
  message: "We've updated our Privacy Policy and Terms.",
};

/** How long a notice runs — the Terms §9 notice period. */
export const LEGAL_NOTICE_DAYS = 14;

export const LEGAL_NOTICE_DISMISSED_KEY = "glidecomp:legal-notice-dismissed";

/**
 * Pure decision, unit-tested: show while inside the notice window and not yet
 * dismissed for this version. The window starts at the version date (UTC) and
 * ends 14 days later, whatever the reader's time zone says.
 */
export function shouldShowLegalNotice(
  notice: LegalNotice,
  now: Date,
  dismissedVersion: string | null
): boolean {
  if (dismissedVersion === notice.version) return false;
  const start = Date.parse(`${notice.version}T00:00:00Z`);
  if (Number.isNaN(start)) return false;
  const end = start + LEGAL_NOTICE_DAYS * 24 * 60 * 60 * 1000;
  const t = now.getTime();
  return t >= start && t < end;
}
