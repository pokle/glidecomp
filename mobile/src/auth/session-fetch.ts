/**
 * Carry the session to the API, and nowhere else.
 *
 * Native `fetch` has a cookie jar of its own; it is switched off here
 * (`credentials: 'omit'`) so there is exactly one copy of the session — the
 * one in the secure store — and it is attached by hand, only to requests for
 * this build's API origin. A response that refreshes a cookie (the five-minute
 * `session_data` cache, the rolling session's new expiry, a rename that
 * re-issues the cached user) is folded back into the store, as a browser's
 * jar would.
 */
import { getCookie, getSetCookie, hasBetterAuthCookies, storageAdapter } from '@better-auth/expo/client';
import type { Fetch } from '@glidecomp/client/api';

import { COOKIE_KEY, secureStorage } from './client';

/** Better Auth's cookie prefix (auth-api's AUTH_COOKIE_PREFIX). */
const COOKIE_PREFIX = 'better-auth';

// The Expo plugin's own wrapper over the same object: reads and writes of one
// key are queued behind each other, whichever side makes them.
const store = storageAdapter(secureStorage);

/** The `Cookie` header for the stored session, or "" when signed out. */
export async function sessionCookie(): Promise<string> {
  return getCookie((await store.getItemAsync(COOKIE_KEY)) ?? '{}');
}

/** Whether a session cookie is stored at all — no network, no decision. */
export function hasStoredSession(): boolean {
  try {
    return getCookie(store.getItem(COOKIE_KEY) ?? '{}').includes('session_token');
  } catch {
    return false;
  }
}

/** Fold a response's Set-Cookie into the stored session. */
export async function absorbSetCookie(header: string | null): Promise<void> {
  if (!header || !hasBetterAuthCookies(header, COOKIE_PREFIX)) return;
  const previous = await store.getItemAsync(COOKIE_KEY);
  await store.setItemAsync(COOKIE_KEY, getSetCookie(header, previous ?? undefined));
}

/** Forget the stored session (sign-out, a deleted account, a real "no"). */
export async function clearStoredSession(): Promise<void> {
  await store.setItemAsync(COOKIE_KEY, '{}');
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

export function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/** `fetch` that sends the session to `origin`, and only there. */
export function withSession(base: Fetch, origin: string): Fetch {
  return async (input, init) => {
    if (!sameOrigin(urlOf(input), origin)) return base(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const cookie = await sessionCookie();
    if (cookie) headers.set('cookie', cookie);
    const res = await base(input, { ...init, headers, credentials: 'omit' });
    await absorbSetCookie(res.headers.get('set-cookie'));
    return res;
  };
}
