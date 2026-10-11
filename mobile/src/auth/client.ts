/**
 * Better Auth on the phone: the same account as the website, its session
 * cookie kept in the platform's secure store (Keychain, Android Keystore)
 * rather than a cookie jar (docs/auth.md, "The native app").
 *
 * `authClient` makes the sign-in and sign-out calls. Every other request
 * carries the stored cookie through `withSession` (session-fetch.ts), which
 * reads and writes the same store under the same key, through the same
 * serialised storage the Expo plugin uses.
 */
import { expoClient } from '@better-auth/expo/client';
import { guardWrites } from '@glidecomp/client/transport';
import { createAuthClient } from 'better-auth/client';
import { emailOTPClient } from 'better-auth/client/plugins';
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';

import { API_ORIGIN, WRITES_ALLOWED } from '@/api/config';

/**
 * The secure store, readable after the phone's first unlock since it booted:
 * stage 5's background uploads send the cookie while the phone is locked.
 * The same options on every read and write, or iOS treats them as different
 * items.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
};

export const secureStorage = {
  getItem: (key: string) => SecureStore.getItem(key, OPTIONS),
  setItem: (key: string, value: string) => SecureStore.setItem(key, value, OPTIONS),
  getItemAsync: (key: string) => SecureStore.getItemAsync(key, OPTIONS),
  setItemAsync: (key: string, value: string) => SecureStore.setItemAsync(key, value, OPTIONS),
};

/** The plugin keeps the cookie under `${STORAGE_PREFIX}_cookie`. */
export const STORAGE_PREFIX = 'glidecomp';
export const COOKIE_KEY = `${STORAGE_PREFIX}_cookie`;

/**
 * The build's own URL scheme (`glidecomp`, or `glidecomp-dev` for a
 * development build), which the plugin sends as the request's origin; the
 * auth worker trusts both (APP_ORIGINS).
 */
const scheme = ([Constants.expoConfig?.scheme].flat()[0] as string | undefined) ?? 'glidecomp';

export const authClient = createAuthClient({
  baseURL: API_ORIGIN,
  basePath: '/api/auth',
  plugins: [expoClient({ scheme, storagePrefix: STORAGE_PREFIX, storage: secureStorage }), emailOTPClient()],
  // A development build never writes to production — signing in included.
  fetchOptions: { customFetchImpl: guardWrites(fetch, WRITES_ALLOWED) },
});
