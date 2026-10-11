/**
 * Open one of the website's explainers (`/scoring/gap#time-points`) in an
 * in-app browser: the reader stays in the app, and Done brings them back to
 * the row they were reading. An absolute URL (an official results page)
 * opens as it is.
 */
import * as WebBrowser from 'expo-web-browser';

import { SITE_ORIGIN } from '@/api/config';

export function openDoc(href: string): void {
  void WebBrowser.openBrowserAsync(/^https?:\/\//.test(href) ? href : `${SITE_ORIGIN}${href}`);
}
