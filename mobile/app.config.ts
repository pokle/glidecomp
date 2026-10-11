import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ExpoConfig } from 'expo/config';

// Identifiers are decided in docs/2026-10-05-mobile-app-plan.md (stage 0,
// decision 6) and recorded in docs/mobile-accounts.md. They are hard to change
// after the first store upload.
//
// Every build is a DEVELOPMENT build unless APP_VARIANT=production (the EAS
// store profiles set it). Development builds get their own bundle id, name and
// scheme, so:
//  - a free Apple "Personal Team" signing a build for a phone registers
//    com.glidecomp.app.dev, and can never claim the store identifier the paid
//    team needs;
//  - a development build and the store or beta app sit side by side on one
//    phone, and a link meant for one never opens the other.
const production = process.env.APP_VARIANT === 'production';

/**
 * The Mapbox PUBLIC token (pk.…) the track map draws with. Never committed:
 * it comes from the environment (EAS sets it for a store build) or from the
 * repository's root `.env`, the file the website's Vite build reads its own
 * token from. A public token ships inside every app by design; the secret
 * download token (sk.…) is never here — CocoaPods reads it from ~/.netrc.
 */
function mapboxPublicToken(): string | undefined {
  const fromEnv = process.env.REACT_NATIVE_MAPBOX_PUBLIC_TOKEN;
  if (fromEnv) return fromEnv;
  try {
    const dotenv = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    return /^REACT_NATIVE_MAPBOX_PUBLIC_TOKEN=(.+)$/m.exec(dotenv)?.[1].trim();
  } catch {
    return undefined;
  }
}

const config: ExpoConfig = {
  name: production ? 'GlideComp' : 'GlideComp Dev',
  slug: 'glidecomp',
  scheme: production ? 'glidecomp' : 'glidecomp-dev',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: production ? 'com.glidecomp.app' : 'com.glidecomp.app.dev',
    // iPad gets its own split view in stage 9; until then it runs the phone
    // layout rather than a stretched one.
    supportsTablet: false,
  },
  android: {
    package: production ? 'com.glidecomp.app' : 'com.glidecomp.app.dev',
  },
  plugins: ['expo-router', '@rnmapbox/maps'],
  extra: {
    mapboxPublicToken: mapboxPublicToken(),
  },
  experiments: {
    typedRoutes: true,
  },
};

export default config;
