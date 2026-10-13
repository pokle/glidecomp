/**
 * Whether a URL the app was opened with is a file to submit, rather than a
 * link to a screen. Files arrive as `file://` (iOS copies an "Open in" file
 * into the app's Inbox) or `content://` (Android); every link to a screen is
 * the app's own scheme or, from stage 9, https.
 */
export function isIncomingFileUrl(url: string): boolean {
  return /^(file|content):\/\//i.test(url.trim());
}
