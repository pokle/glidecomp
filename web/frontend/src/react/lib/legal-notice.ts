/**
 * The "our terms changed" toast — the notice /legal's Terms §11 promises.
 *
 * Terms §11 says a material change is announced on GlideComp at least 14 days
 * before it takes effect. This is that announcement: one toast, to signed-in
 * readers of the SPA, linking to /legal. It is shown until the reader closes
 * it or opens the page, remembered per VERSION (so the next change asks
 * again), and never after a hard cutoff 14 days from publication — past that
 * the change is in force and the notice has done its job.
 *
 * To announce a new change: set `PUBLISHED` to the day it goes live (and the
 * /legal "Last updated" date to match) and reword `message`. /legal prints the
 * effective date from the same constant. The date must differ from the last
 * notice's, or readers who closed that one never see this one.
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

/** How long a notice runs — the Terms §11 notice period. */
export const LEGAL_NOTICE_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "13 October 2026" for a YYYY-MM-DD date, read as UTC so every reader —
 *  and the prerendered /legal — prints the same day. */
export function formatLegalDate(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** The day a noticed change takes effect: the notice period after publication.
 *  /legal prints it, so the page and the toast cannot disagree. */
export function legalNoticeEffectiveDate(notice: LegalNotice): string {
  const start = Date.parse(`${notice.version}T00:00:00Z`);
  return new Date(start + LEGAL_NOTICE_DAYS * DAY_MS).toISOString().slice(0, 10);
}

const PUBLISHED = "2026-09-29";

export const LEGAL_NOTICE: LegalNotice = {
  version: PUBLISHED,
  message: `We're updating our Terms, including for competition organisers. The changes take effect on ${formatLegalDate(
    legalNoticeEffectiveDate({ version: PUBLISHED, message: "" })
  )}.`,
};

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
  const end = start + LEGAL_NOTICE_DAYS * DAY_MS;
  const t = now.getTime();
  return t >= start && t < end;
}
