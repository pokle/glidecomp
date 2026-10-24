import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { withCrashReports } from '@/crash-reports';
import { QueryProvider } from '@/api/query-client';
import { startIdentityChecks } from '@/auth/session';
import { applyAppearance } from '@/settings/appearance';
import { startUnitsSync } from '@/settings/units-sync';
import { startNotificationTaps } from '@/notifications/push';
import { startSubmissionQueue } from '@/submit/queue';

// Before the first frame, so a reader who chose dark never sees a light flash.
applyAppearance();

/**
 * The tabs are always the bottom of the stack. Without this, a cold start
 * straight into /submit — a tracklog shared from another app — made the
 * submit sheet the ROOT screen: no tabs under it, and nothing to dismiss to.
 */
export const unstable_settings = { anchor: '(tabs)' };

function RootLayout() {
  const scheme = useColorScheme();
  useEffect(() => {
    const stopIdentity = startIdentityChecks();
    const stopUnits = startUnitsSync();
    const stopQueue = startSubmissionQueue();
    const stopTaps = startNotificationTaps();
    return () => {
      stopIdentity();
      stopUnits();
      stopQueue();
      stopTaps();
    };
  }, []);
  return (
    <QueryProvider>
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        {/* Submit is a sheet over whatever is on screen (IA §2), not a stack
            of its own. /submit is also the website's URL for it, so a
            universal link lands here in stage 9. */}
        <Stack.Screen
          name="submit"
          options={{
            presentation: 'formSheet',
            sheetGrabberVisible: true,
            // Full height: the three steps and Submit are one form, and a
            // half-height sheet hid the button below the fold.
            sheetAllowedDetents: [1],
            headerShown: true,
            title: 'Submit a track',
          }}
        />
        {/* A push over the tabs, not a full-screen modal: the modal's own
            Done button sat under the status bar's battery on a real phone,
            leaving no way out. The native header's back button and the edge
            swipe always work. */}
        <Stack.Screen name="qr" options={{ headerShown: true, title: 'QR code', headerBackTitle: 'Back' }} />
      </Stack>
    </ThemeProvider>
    </QueryProvider>
  );
}

export default withCrashReports(RootLayout);
