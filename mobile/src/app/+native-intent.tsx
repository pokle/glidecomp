/**
 * Where a URL the operating system opens the app with goes, before the router
 * sees it. A tracklog shared or opened in GlideComp (stage 5) is not a route:
 * it is parked for the submit sheet, which then opens over whatever is on
 * screen. Everything else routes as it is.
 */
import { isIncomingFileUrl, receiveIncomingFile } from '@/submit/incoming';

export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  if (isIncomingFileUrl(path)) {
    receiveIncomingFile(path);
    return '/submit';
  }
  return path;
}
