import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { useColorScheme } from 'react-native';

import { QueryProvider } from '@/api/query-client';

export default function RootLayout() {
  const scheme = useColorScheme();
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
