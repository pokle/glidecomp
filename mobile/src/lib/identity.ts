/**
 * Who is signed in, decided the #481 way: a failure to ask is not an answer.
 *
 * The app asks the auth worker (`GET /api/auth/me`) at launch, on returning to
 * the foreground and when the signal comes back. On a hill most of those asks
 * fail, and a failure must never sign anyone out: that is a terminal state
 * nothing re-asks from, so a blip would cost a pilot their session until they
 * found signal AND an email to sign in with. Only a real answer decides.
 *
 * Pure, so the rules are unit-tested (__tests__/identity.test.ts); the store
 * that applies them is src/auth/session.ts.
 */
import type { AuthUser } from '@glidecomp/client/account';

export type Identity =
  /** No session on the phone. */
  | { kind: 'signed-out' }
  /** A session on the phone, and nobody has said yet whose it is. */
  | { kind: 'checking' }
  /**
   * Signed in as `user`. `confirmed` is false while the last ask failed:
   * the phone is still signed in, as of `checkedAt` (ms since epoch).
   */
  | { kind: 'signed-in'; user: AuthUser; confirmed: boolean; checkedAt: number };

/** What asking `/api/auth/me` came to. */
export type MeOutcome =
  /** The worker answered: this user, or nobody. */
  | { kind: 'answer'; user: AuthUser | null }
  /** The worker refused (a 4xx). Never retried. */
  | { kind: 'refused'; status: number }
  /** No answer: dropped, timed out, or a 5xx after every retry. */
  | { kind: 'unreachable' };

export function decideIdentity(previous: Identity, outcome: MeOutcome, now: number): Identity {
  switch (outcome.kind) {
    case 'answer':
      return outcome.user
        ? { kind: 'signed-in', user: outcome.user, confirmed: true, checkedAt: now }
        : { kind: 'signed-out' };
    case 'refused':
      // 401 says "this session is no session" — a real answer. Anything else
      // (a 429, a 403) is an answer to a different question: keep what we
      // have, and do not ask again until something new happens.
      return outcome.status === 401 ? { kind: 'signed-out' } : previous;
    case 'unreachable':
      return previous.kind === 'signed-in' ? { ...previous, confirmed: false } : previous;
  }
}

/** What launch shows before anyone has been asked. */
export function initialIdentity(
  hasSession: boolean,
  saved: { user: AuthUser; checkedAt: number } | null,
): Identity {
  if (!hasSession) return { kind: 'signed-out' };
  if (saved) return { kind: 'signed-in', user: saved.user, confirmed: false, checkedAt: saved.checkedAt };
  return { kind: 'checking' };
}
