/**
 * Where a URL the operating system opens the app with goes, before the router
 * sees it.
 *
 * - A tracklog shared or opened in GlideComp (stage 5) is not a route: it is
 *   parked for the submit sheet, which then opens over whatever is on screen.
 * - A glidecomp.com link (stage 9, universal links) opens the matching
 *   screen — the app's routes are the website's URLs, and the few that
 *   differ are mapped by `appRouteForUrl` in @glidecomp/client/app-links,
 *   the same list the website's association files are built from. A link
 *   the app has no screen for (a scores.csv download) goes to the browser.
 * - Everything else (the app's own scheme) routes as it is.
 */
import { appRouteForUrl } from '@glidecomp/client/app-links';
import * as WebBrowser from 'expo-web-browser';

import { isIncomingFileUrl, receiveIncomingFile } from '@/submit/incoming';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (isIncomingFileUrl(path)) {
    receiveIncomingFile(path);
    return '/submit';
  }
  if (/^https?:\/\//i.test(path)) {
    const route = appRouteForUrl(path);
    if (route) return route;
    // Android cannot exclude a path from App Links, so a download lands here:
    // hand it to the in-app browser, which does not loop back to the app.
    void WebBrowser.openBrowserAsync(path);
    return '/';
  }
  return path;
}
