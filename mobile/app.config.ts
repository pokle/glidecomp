import type { ExpoConfig } from 'expo/config';

// Identifiers are decided in docs/2026-10-05-mobile-app-plan.md (stage 0,
// decision 6) and recorded in docs/mobile-accounts.md. They are hard to change
// after the first store upload.
const config: ExpoConfig = {
  name: 'GlideComp',
  slug: 'glidecomp',
  scheme: 'glidecomp',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: 'com.glidecomp.app',
    // iPad gets its own split view in stage 9; until then it runs the phone
    // layout rather than a stretched one.
    supportsTablet: false,
  },
  android: {
    package: 'com.glidecomp.app',
  },
  plugins: ['expo-router'],
  experiments: {
    typedRoutes: true,
  },
};

export default config;
