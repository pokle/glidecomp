import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ConfigPlugin } from 'expo/config-plugins';
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

/**
 * Keep Sign in with Apple's entitlement out of a build that cannot have it.
 * Prebuild applies `expo-apple-authentication`'s plugin to any app that has
 * the package installed, whatever `plugins` says, and that plugin adds the
 * entitlement unconditionally — which a Personal Team then refuses to sign.
 * It is a run-once plugin, so recording it as already run is what skips it.
 */
const withoutAppleSignIn: ConfigPlugin = (config) => {
  const internal = (config._internal ??= {});
  const history = (internal.pluginHistory ??= {});
  history['expo-apple-authentication'] = { name: 'expo-apple-authentication', version: 'skipped' };
  return config;
};

/**
 * "Open in GlideComp" for a tracklog (stage 5). IGC has no system type on
 * either platform, so the app declares one.
 *
 * iOS: an imported type for the `.igc` extension, and a document type that
 * lists the app as one that can open it — which puts GlideComp in the share
 * sheet of Files, Mail and an instrument's app. `LSSupportsOpeningDocumentsInPlace`
 * off makes iOS hand over a copy (in the app's Inbox) rather than the original.
 * If an instrument's app exports a type of its own for `.igc`, iOS prefers
 * that one, so its identifier goes in `IGC_TYPES` too.
 */
const IGC_TYPES = ['com.glidecomp.igc'];

/**
 * Android: Open with (VIEW) and Share (SEND). An IGC file has no registered
 * MIME type, so apps label it in several ways; these are the ones that do not
 * also claim every photo on the phone. A SEND is turned into a VIEW by
 * modules/share-intake, so both arrive the same way.
 */
/**
 * Universal links (stage 9): glidecomp.com links open the app. The paths are
 * the shared list in @glidecomp/client/app-links, which the website's
 * association files are built from too.
 *
 * iOS needs the Associated Domains capability on the bundle id, which a free
 * Personal Team cannot have — the same reason Sign in with Apple is gated. So
 * it is on for store builds, and for a development build only when
 * UNIVERSAL_LINKS=1 says the signing team has it.
 */
const universalLinks = production || setting('UNIVERSAL_LINKS') === '1';

/**
 * Notifications (stage 9) need the Expo project's id, which names the app to
 * Expo's push service. Not a secret; it comes from `eas init` on the Mac.
 * Without it the app offers notifications and says they are not set up.
 */
const easProjectId = setting('EAS_PROJECT_ID');

/**
 * Crash reports (stage 10, mobile/RELEASING.md). The DSN only says where
 * reports go; it is not a secret. Without it the app sends none.
 * `SENTRY_ORG`/`SENTRY_PROJECT` (and the secret `SENTRY_AUTH_TOKEN`, an EAS
 * secret) let a store build upload its source maps, so a report's stack
 * names our files rather than the bundle's offsets.
 */
const sentryDsn = setting('SENTRY_DSN');
const sentryOrg = setting('SENTRY_ORG');
const sentryProject = setting('SENTRY_PROJECT');
const LINK_HOST = 'glidecomp.com';
const ANDROID_LINK_PATHS: { path?: string; pathPrefix?: string }[] = [
  { path: '/comp' },
  { pathPrefix: '/comp/' },
  { path: '/submit' },
  { path: '/signin/app' },
];

const IGC_MIME_TYPES = ['application/octet-stream', 'application/x-igc', 'application/vnd.fai.igc', 'text/plain', 'text/x-igc'];

const config: ExpoConfig = {
  name: production ? 'GlideComp' : 'GlideComp Dev',
  slug: 'glidecomp',
  scheme: production ? 'glidecomp' : 'glidecomp-dev',
  version: '0.1.0',
  // EAS Update (stage 10): an update reaches only builds whose native side it
  // matches, which the fingerprint hashes. See mobile/RELEASING.md.
  runtimeVersion: { policy: 'fingerprint' },
  ...(easProjectId ? { updates: { url: `https://u.expo.dev/${easProjectId}` } } : {}),
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: production ? 'com.glidecomp.app' : 'com.glidecomp.app.dev',
    // iPad gets its own split view in stage 9; until then it runs the phone
    // layout rather than a stretched one.
    supportsTablet: false,
    usesAppleSignIn: appleSignIn,
    ...(universalLinks ? { associatedDomains: [`applinks:${LINK_HOST}`] } : {}),
    infoPlist: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'IGC tracklog',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: IGC_TYPES,
        },
      ],
      UTImportedTypeDeclarations: [
        {
          UTTypeIdentifier: IGC_TYPES[0],
          UTTypeDescription: 'IGC tracklog',
          UTTypeConformsTo: ['public.data'],
          UTTypeTagSpecification: { 'public.filename-extension': ['igc', 'IGC'] },
        },
      ],
      LSSupportsOpeningDocumentsInPlace: false,
    },
  },
  android: {
    package: production ? 'com.glidecomp.app' : 'com.glidecomp.app.dev',
    intentFilters: [
      {
        action: 'VIEW',
        category: ['DEFAULT'],
        data: IGC_MIME_TYPES.map((mimeType) => ({ scheme: 'content', mimeType })),
      },
      // A file manager that names the file rather than its type. A filter of
      // its own: Android merges the <data> of one filter, so a path pattern
      // beside the MIME types would restrict every one of them to it.
      {
        action: 'VIEW',
        category: ['DEFAULT'],
        data: [
          { scheme: 'content', mimeType: '*/*', pathPattern: '.*\\\\.igc' },
          { scheme: 'content', mimeType: '*/*', pathPattern: '.*\\\\.IGC' },
        ],
      },
      {
        action: 'SEND',
        category: ['DEFAULT'],
        data: IGC_MIME_TYPES.map((mimeType) => ({ mimeType })),
      },
      // App Links: verified against https://glidecomp.com/.well-known/assetlinks.json.
      {
        action: 'VIEW',
        autoVerify: true,
        category: ['BROWSABLE', 'DEFAULT'],
        data: ANDROID_LINK_PATHS.map((p) => ({ scheme: 'https', host: LINK_HOST, ...p })),
      },
    ],
  },
  plugins: [
    'expo-router',
    '@rnmapbox/maps',
    'expo-secure-store',
    ['expo-notifications', { defaultChannel: 'default' }],
    ...(sentryDsn && sentryOrg && sentryProject
      ? [['@sentry/react-native/expo', { organization: sentryOrg, project: sentryProject }] as [string, unknown]]
      : []),
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
    sentryDsn,
    ...(easProjectId ? { eas: { projectId: easProjectId } } : {}),
  },
  experiments: {
    typedRoutes: true,
  },
};

export default appleSignIn ? config : withoutAppleSignIn(config);
