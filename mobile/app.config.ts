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
 * A build setting from the environment (EAS sets them for a store build) or
 * from the repository's root `.env`, the file the website's Vite build reads
 * its own settings from. Never committed.
 */
function setting(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  try {
    const dotenv = readFileSync(join(__dirname, '..', '.env'), 'utf8');
    return new RegExp(`^${name}=(.+)$`, 'm').exec(dotenv)?.[1].trim();
  } catch {
    return undefined;
  }
}

/**
 * The Mapbox PUBLIC token (pk.…) the track map draws with. A public token
 * ships inside every app by design; the secret download token (sk.…) is never
 * here — CocoaPods reads it from ~/.netrc.
 */
const mapboxPublicToken = setting('REACT_NATIVE_MAPBOX_PUBLIC_TOKEN');

/**
 * Google sign-in, natively (docs/auth.md, "The native app"). Client ids are
 * not secrets — every app that signs in with Google carries its own — but
 * they come from the Google Cloud Console, so a build without them simply
 * offers no Google button. The web client id is the website's
 * GOOGLE_CLIENT_ID: the ID token is addressed to it, which is what the auth
 * worker checks. The iOS client id also names the URL scheme Google's sheet
 * returns through.
 */
const googleWebClientId = setting('GOOGLE_WEB_CLIENT_ID');
const googleIosClientId = setting('GOOGLE_IOS_CLIENT_ID');
const googleIosUrlScheme = googleIosClientId?.split('.').reverse().join('.');

/**
 * Sign in with Apple needs the capability on the bundle id, which only the
 * paid Apple Developer team can grant: a free Personal Team build that asked
 * for it would fail to sign. So it is on for store builds, and for a
 * development build only when APPLE_SIGN_IN=1 says the team signing it has
 * the capability.
 */
const appleSignIn = production || setting('APPLE_SIGN_IN') === '1';

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
    usesAppleSignIn: appleSignIn,
  },
  android: {
    package: production ? 'com.glidecomp.app' : 'com.glidecomp.app.dev',
  },
  plugins: [
    'expo-router',
    '@rnmapbox/maps',
    'expo-secure-store',
    ...(appleSignIn ? ['expo-apple-authentication'] : []),
    ...(googleIosUrlScheme
      ? [['@react-native-google-signin/google-signin', { iosUrlScheme: googleIosUrlScheme }] as [string, unknown]]
      : []),
  ],
  extra: {
    mapboxPublicToken,
    googleWebClientId,
    googleIosClientId,
    appleSignIn,
  },
  experiments: {
    typedRoutes: true,
  },
};

export default config;
