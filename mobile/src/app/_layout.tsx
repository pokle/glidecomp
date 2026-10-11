import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { QueryProvider } from '@/api/query-client';
import { startIdentityChecks } from '@/auth/session';
import { applyAppearance } from '@/settings/appearance';
import { startUnitsSync } from '@/settings/units-sync';

// Before the first frame, so a reader who chose dark never sees a light flash.
applyAppearance();

export default function RootLayout() {
  const scheme = useColorScheme();
  useEffect(() => {
    const stopIdentity = startIdentityChecks();
    const stopUnits = startUnitsSync();
    return () => {
      stopIdentity();
      stopUnits();
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
            sheetAllowedDetents: [0.6, 1],
            headerShown: true,
            title: 'Submit a track',
          }}
        />
      </Stack>
    </ThemeProvider>
    </QueryProvider>
  );
}
