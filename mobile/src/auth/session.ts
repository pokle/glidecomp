/**
 * The signed-in account, as the app holds it (stage 4): the decision rules in
 * lib/identity.ts, applied to a store every screen reads with `useIdentity()`.
 *
 * The last confirmed user is kept beside the cookie in the secure store, so a
 * launch with no signal opens signed in, as that user, straight away — and
 * says it has not been able to check. Only a real answer from the auth
 * worker signs anyone out.
 */
import type { AuthUser } from '@glidecomp/client/account';
import { onlineManager } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { ApiError, authRequest, getJson } from '@/api/client';
import { queryClient } from '@/api/query-client';
import { decideIdentity, initialIdentity, type Identity, type MeOutcome } from '@/lib/identity';

import { forgetPushToken } from '@/notifications/push';

import { authClient, secureStorage } from './client';
import { clearStoredSession, hasStoredSession } from './session-fetch';

const USER_KEY = 'glidecomp_user';

function readSaved(): { user: AuthUser; checkedAt: number } | null {
  try {
    const raw = secureStorage.getItem(USER_KEY);
    const saved = raw ? (JSON.parse(raw) as { user?: AuthUser; checkedAt?: number }) : null;
    return saved?.user?.id ? { user: saved.user, checkedAt: saved.checkedAt ?? 0 } : null;
  } catch {
    return null;
  }
}

let identity: Identity = initialIdentity(hasStoredSession(), readSaved());
const listeners = new Set<() => void>();

function set(next: Identity): void {
  const previous = identity;
  identity = next;
  if (next.kind === 'signed-in') {
    void secureStorage
      .setItemAsync(USER_KEY, JSON.stringify({ user: next.user, checkedAt: next.checkedAt }))
      .catch(() => {});
  }
  if (next !== previous) listeners.forEach((l) => l());
}

export function getIdentity(): Identity {
  return identity;
}

export function subscribeIdentity(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useIdentity(): Identity {
  return useSyncExternalStore(subscribeIdentity, getIdentity, getIdentity);
}

/** The signed-in user's id, or null — for keying a query to the account. */
export function useUserId(): string | null {
  const current = useIdentity();
  return current.kind === 'signed-in' ? current.user.id : null;
}

/**
 * Forget this account on the phone: the cookie, the saved user, and every
 * cached answer — a comp read as its organiser carries `is_admin`, and a
 * hidden comp must not stay readable from the cache after signing out.
 */
async function forget(): Promise<void> {
  await clearStoredSession().catch(() => {});
  await secureStorage.setItemAsync(USER_KEY, '').catch(() => {});
  identity = { kind: 'signed-out' };
  listeners.forEach((l) => l());
  queryClient.clear();
}

let inFlight: Promise<void> | null = null;

/** Ask the auth worker who this is, and apply the answer (#481). */
export function refreshIdentity(): Promise<void> {
  if (!hasStoredSession()) {
    if (identity.kind !== 'signed-out') return forget();
    return Promise.resolve();
  }
  inFlight ??= (async () => {
    let outcome: MeOutcome;
    try {
      const { user } = await getJson<{ user: AuthUser | null }>(authRequest('/me'));
      outcome = { kind: 'answer', user };
    } catch (err) {
      outcome =
        err instanceof ApiError && err.status < 500
          ? { kind: 'refused', status: err.status }
          : { kind: 'unreachable' };
    }
    const next = decideIdentity(identity, outcome, Date.now());
    if (next.kind === 'signed-out') await forget();
    else set(next);
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/**
 * After a sign-in stored a cookie: the sign-in's own answer says who it is
 * (a real answer — the worker just made the session). Then ask /me anyway,
 * which also hands over the session cache cookie, and re-ask every query as
 * this account: organiser rows, hidden comps they run, their registrations.
 */
export async function completeSignIn(user: AuthUser | undefined): Promise<void> {
  if (user) set(decideIdentity(identity, { kind: 'answer', user }, Date.now()));
  else set({ kind: 'checking' });
  await refreshIdentity();
  await queryClient.invalidateQueries();
}

/**
 * Sign out here, and end the session on the server when there is signal to.
 * The plugin forgets the cookie before it asks, so a sign-out with no signal
 * still signs this phone out; the server's copy then lapses on its own.
 */
export async function signOut(): Promise<void> {
  // Before the session goes: the server only lets an account forget its own token.
  await forgetPushToken();
  try {
    await authClient.signOut();
  } catch {
    // No signal: this phone is signed out regardless.
  }
  await forget();
}

/** Delete the account (Apple guideline 5.1.1(v)); the website's own route. */
export async function deleteAccount(): Promise<void> {
  try {
    await getJson(authRequest('/delete-account', { method: 'POST', body: '{}' }));
  } catch (err) {
    // A retry after a dropped answer finds the account already gone (401):
    // ask who this is before reporting a failure that may not be one.
    await refreshIdentity();
    if (identity.kind === 'signed-out') return;
    throw err;
  }
  await forget();
}

/**
 * Ask again whenever asking could now succeed: the app comes back to the
 * foreground, or the signal returns while the answer is still outstanding.
 * Called once, from the root layout.
 */
export function startIdentityChecks(): () => void {
  void refreshIdentity();
  let lastAsked = Date.now();
  const appState = AppState.addEventListener('change', (status) => {
    // Once every few minutes is plenty: the five-minute session cache means
    // nothing changes faster than that anyway.
    if (status === 'active' && Date.now() - lastAsked > 5 * 60_000) {
      lastAsked = Date.now();
      void refreshIdentity();
    }
  });
  const online = onlineManager.subscribe((isOnline) => {
    const pending = identity.kind === 'checking' || (identity.kind === 'signed-in' && !identity.confirmed);
    if (isOnline && pending) {
      lastAsked = Date.now();
      void refreshIdentity();
    }
  });
  return () => {
    appState.remove();
    online();
  };
}
