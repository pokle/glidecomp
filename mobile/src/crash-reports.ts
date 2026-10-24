/**
 * Crash reports (stage 10): Sentry, only in a build that has `SENTRY_DSN`,
 * with every event and breadcrumb passed through `lib/crash-scrub.ts` first.
 * See mobile/RELEASING.md, "Crash reports".
 */
import * as Sentry from '@sentry/react-native';
import Constants from 'expo-constants';
import type { ComponentType } from 'react';

import { scrubBreadcrumb, scrubEvent } from '@/lib/crash-scrub';

const dsn = (Constants.expoConfig?.extra as { sentryDsn?: string } | undefined)?.sentryDsn;

/** Whether this build sends crash reports at all (Me → This build says so). */
export const CRASH_REPORTS = Boolean(dsn) && !__DEV__;

if (CRASH_REPORTS) {
  Sentry.init({
    dsn,
    sendDefaultPii: false,
    // Crashes only: no performance tracing, no session replay.
    tracesSampleRate: 0,
    attachScreenshot: false,
    attachViewHierarchy: false,
    beforeSend: (event) => scrubEvent(event as never),
    beforeBreadcrumb: (crumb) => scrubBreadcrumb(crumb as never),
  });
}

/** The root component, wrapped so a render crash is reported. Unchanged without a DSN. */
export function withCrashReports<P extends Record<string, unknown>>(Root: ComponentType<P>): ComponentType<P> {
  return CRASH_REPORTS ? Sentry.wrap(Root) : Root;
}
