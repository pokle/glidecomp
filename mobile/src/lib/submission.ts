/**
 * The upload queue's decisions, kept apart from the disk and the network so
 * they can be tested directly (__tests__/submission.test.ts).
 *
 * A track is written to the phone before anything is sent, and stays there
 * until the server has answered. Until then the app says "waiting", never
 * "submitted": a track the app calls submitted that is still on the phone is
 * the worst thing it could tell a pilot before scoring closes
 * (docs/2026-09-22-ios-app-information-architecture.md, §16).
 *
 * The retry rules are #481's: a dropped request or a 5xx is not an answer and
 * is tried again; a 4xx is the server's real answer and is never sent twice.
 */
import {
  submitErrorFrom,
  type SubmitAcceptedWire,
  type SubmitAs,
  type SubmitError,
} from '@glidecomp/client/submit';

/**
 * - `waiting` — on the phone, not yet accepted. Includes a send in flight: a
 *   crash mid-send must leave it to be sent again, not lost.
 * - `sent` — the server stored it; `accepted` is what it said.
 * - `refused` — the server answered no; `failure` says why.
 */
export type SubmissionStatus = 'waiting' | 'sent' | 'refused';

export interface Submission {
  id: string;
  queuedAt: number;
  /** The account that queued it, or null for an anonymous submission. */
  accountId: string | null;
  compId: string;
  taskId: string;
  compName: string | null;
  taskName: string | null;
  /** The comp's zone, for the receipt's take-off and landing times. */
  timezone: string | null;
  as: SubmitAs;
  /** Who the track is for, in words: "Myself", a roster name, an identifier. */
  forLabel: string;
  fileName: string;
  rawBytes: number;
  /** The pilot the IGC header names, if any. */
  filePilotName: string | null;
  /** The gzipped tracklog's file name in the queue's own directory. */
  file: string;
  status: SubmissionStatus;
  attempts: number;
  lastAttemptAt: number | null;
  sentAt?: number;
  accepted?: SubmitAcceptedWire;
  failure?: SubmitError;
}

/** What one attempt came back with. `null` status: no answer at all. */
export type AttemptOutcome =
  | { kind: 'sent'; accepted: SubmitAcceptedWire }
  | { kind: 'refused'; failure: SubmitError }
  | { kind: 'retry' };

/**
 * Read one attempt's answer. A body that is not JSON is read as nothing: a
 * success still counts (the track is stored), and a refusal still gets a
 * sentence.
 */
export function classifyAttempt(status: number | null, body: string | null): AttemptOutcome {
  if (status === null || status >= 500) return { kind: 'retry' };
  let parsed: unknown = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {
    parsed = null;
  }
  if (status >= 200 && status < 300) {
    return { kind: 'sent', accepted: (parsed ?? {}) as SubmitAcceptedWire };
  }
  return { kind: 'refused', failure: submitErrorFrom(parsed) };
}

/** Apply an attempt's outcome to its submission. */
export function applyOutcome(sub: Submission, outcome: AttemptOutcome, now: number): Submission {
  const tried = { ...sub, attempts: sub.attempts + 1, lastAttemptAt: now };
  switch (outcome.kind) {
    case 'sent':
      return { ...tried, status: 'sent', sentAt: now, accepted: outcome.accepted, failure: undefined };
    case 'refused':
      return { ...tried, status: 'refused', failure: outcome.failure };
    case 'retry':
      return tried;
  }
}

/**
 * How long to leave a waiting track before trying again on a timer. The
 * queue also tries at once whenever the signal comes back or the app returns
 * to the screen, so this only paces a phone sitting on one bad connection.
 */
export function retryDelayMs(attempts: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attempts - 1), 10 * 60_000);
}

/**
 * Whether a waiting track may be sent now, and if not, why not. A track
 * queued while signed in goes with that account's session and no other: sent
 * as somebody else, it would file under them.
 */
export function sendBlock(sub: Submission, accountId: string | null): 'signed-out' | 'other-account' | null {
  if (sub.as.kind === 'anonymous') return null;
  if (accountId === null) return 'signed-out';
  if (accountId !== sub.accountId) return 'other-account';
  return null;
}

/** Due for a timed retry: waiting, and the last attempt was long enough ago. */
export function isDue(sub: Submission, now: number): boolean {
  if (sub.status !== 'waiting') return false;
  if (sub.lastAttemptAt === null) return true;
  return now - sub.lastAttemptAt >= retryDelayMs(sub.attempts);
}

/** How long a sent track's receipt stays in the list. */
export const KEEP_SENT_MS = 7 * 24 * 60 * 60_000;

/**
 * What the list keeps: everything not yet sent, however old — a track on the
 * phone is never quietly dropped — and receipts for a week.
 */
export function keep(sub: Submission, now: number): boolean {
  return sub.status !== 'sent' || now - (sub.sentAt ?? sub.queuedAt) < KEEP_SENT_MS;
}

/** Newest first, with anything still on the phone ahead of the receipts. */
export function ordered(subs: readonly Submission[]): Submission[] {
  const rank = (s: Submission) => (s.status === 'sent' ? 1 : 0);
  return [...subs].sort((a, b) => rank(a) - rank(b) || b.queuedAt - a.queuedAt);
}

/** "Task 3 — Canungra Classic", or what there is of it. */
export function submissionTitle(sub: Pick<Submission, 'taskName' | 'compName'>): string {
  if (sub.taskName && sub.compName) return `${sub.taskName} — ${sub.compName}`;
  return sub.taskName ?? sub.compName ?? 'Track';
}

/**
 * The status line a pilot reads for a track, in the words the IA asks for:
 * one still on the phone says so, and says it is not yet submitted.
 */
export function statusWords(
  sub: Submission,
  { sending, block }: { sending: boolean; block: ReturnType<typeof sendBlock> },
): { status: string; detail: string } {
  switch (sub.status) {
    case 'sent':
      return {
        status: sub.accepted?.replaced ? 'Replaced' : 'Submitted',
        detail: `For ${sub.forLabel}`,
      };
    case 'refused':
      return { status: 'Not accepted', detail: sub.failure?.error ?? 'We could not accept that track.' };
    case 'waiting':
      if (block === 'signed-out') {
        return { status: 'Waiting', detail: 'Sign in again to send it. It hasn’t been submitted yet.' };
      }
      if (block === 'other-account') {
        return {
          status: 'Waiting',
          detail: 'Queued by another account. Sign in as that account to send it.',
        };
      }
      if (sending) return { status: 'Sending…', detail: 'It hasn’t been submitted until this says so.' };
      return { status: 'Waiting for signal', detail: 'Saved on this phone. It hasn’t been submitted yet.' };
  }
}
