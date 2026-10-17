import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { QueryProvider } from '@/api/query-client';
import { startIdentityChecks } from '@/auth/session';
import { applyAppearance } from '@/settings/appearance';
import { startUnitsSync } from '@/settings/units-sync';
import { startSubmissionQueue } from '@/submit/queue';

// Before the first frame, so a reader who chose dark never sees a light flash.
applyAppearance();

/**
 * The tabs are always the bottom of the stack. Without this, a cold start
 * straight into /submit — a tracklog shared from another app — made the
 * submit sheet the ROOT screen: no tabs under it, and nothing to dismiss to.
 */
export const unstable_settings = { anchor: '(tabs)' };

export default function RootLayout() {
  const scheme = useColorScheme();
  useEffect(() => {
    const stopIdentity = startIdentityChecks();
    const stopUnits = startUnitsSync();
    const stopQueue = startSubmissionQueue();
    return () => {
      stopIdentity();
      stopUnits();
      stopQueue();
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
      </Stack>
    </ThemeProvider>
    </QueryProvider>
  );
}
