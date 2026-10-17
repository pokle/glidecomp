/**
 * The upload queue (stage 5): every track is written to the phone first, then
 * sent, and kept until the server has answered.
 *
 * - **On disk, not in memory.** The gzipped tracklog and the queue's index
 *   live in the app's documents directory, so a track survives the app being
 *   closed, the phone restarting, and the operating system clearing caches.
 * - **Sent by the platform.** On iOS the upload runs in a background URL
 *   session, so a send already under way carries on when the pilot switches
 *   app. Android sends while the app is alive. Either way a track whose answer
 *   never arrived is still "waiting", and is sent again.
 * - **Tried again when it could now work**: at launch, when the app returns to
 *   the screen, when the signal comes back, and on a timer while anything
 *   waits. A 4xx is a real answer and is never sent twice (#481).
 *
 * Sending twice is possible — an upload that reached the server but whose
 * answer was lost is sent again. That replaces the track with the same file
 * (the server keeps the earlier copy) and emails the pilot a second time,
 * which is far better than a track that never arrives.
 *
 * The decisions are in lib/submission.ts; this file is the disk, the network
 * and the store the screens read.
 */
import { submissionRequest } from '@glidecomp/client/submit';
import { onlineManager } from '@tanstack/react-query';
import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { API_ORIGIN, WRITES_ALLOWED } from '@/api/config';
import { queryClient } from '@/api/query-client';
import { absorbSetCookie, sessionCookie } from '@/auth/session-fetch';
import { getIdentity, subscribeIdentity } from '@/auth/session';

import { rememberLast } from './last';
import {
  applyOutcome,
  classifyAttempt,
  isDue,
  keep,
  ordered,
  sendBlock,
  type AttemptOutcome,
  type Submission,
} from '@/lib/submission';

const DIR = new Directory(Paths.document, 'submissions');
const INDEX = new File(DIR, 'queue.json');

/**
 * Android only. Longer than any upload of an IGC needs, even on a poor
 * connection, but not forever: an answer that never comes leaves the track
 * waiting, to be sent again, rather than "sending" until the app is closed.
 *
 * Not on iOS, where the upload is the system's background transfer: with no
 * route to the server it does not fail, it waits for one and sends then —
 * even with the app suspended. Cancelling it would throw that away.
 */
const ANDROID_ATTEMPT_TIMEOUT_MS = 3 * 60_000;

/** How often to look for a waiting track that is due another try. */
const TICK_MS = 15_000;

function load(): Submission[] {
  try {
    if (!INDEX.exists) return [];
    const parsed = JSON.parse(INDEX.textSync()) as Submission[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let items: Submission[] = [];
let loaded = false;
const sending = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: { items: Submission[]; sending: ReadonlySet<string> } = { items, sending: new Set() };

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const now = Date.now();
  items = load().filter((s) => keep(s, now));
  snapshot = { items: ordered(items), sending: new Set() };
}

function persist() {
  try {
    if (!DIR.exists) DIR.create({ intermediates: true });
    INDEX.write(JSON.stringify(items));
  } catch {
    // Nothing useful to do: the in-memory queue still sends, and the next
    // change writes again.
  }
}

function changed() {
  persist();
  snapshot = { items: ordered(items), sending: new Set(sending) };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  ensureLoaded();
  return snapshot;
}

/** Every track on the phone and every recent receipt, newest first. */
export function useSubmissions() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** One submission, and whether it is being sent this moment. */
export function useSubmission(id: string | null) {
  const { items: all, sending: inFlight } = useSubmissions();
  const sub = id ? (all.find((s) => s.id === id) ?? null) : null;
  return { sub, sending: sub ? inFlight.has(sub.id) : false };
}

function fileOf(sub: Pick<Submission, 'file'>): File {
  return new File(DIR, sub.file);
}

/** The gzipped tracklog a submission holds, for sending it again. */
export async function queuedBytes(sub: Submission): Promise<Uint8Array> {
  return fileOf(sub).bytes();
}

export type NewSubmission = Omit<
  Submission,
  'id' | 'queuedAt' | 'file' | 'status' | 'attempts' | 'lastAttemptAt' | 'sentAt' | 'accepted' | 'failure'
>;

/**
 * Write a track to the phone and start sending it. Resolves once it is safe
 * on disk — not when it has been sent; the caller watches `useSubmission`.
 */
export async function enqueue(input: NewSubmission, gz: Uint8Array): Promise<Submission> {
  ensureLoaded();
  const id = Crypto.randomUUID();
  const sub: Submission = {
    ...input,
    id,
    queuedAt: Date.now(),
    file: `${id}.igc.gz`,
    status: 'waiting',
    attempts: 0,
    lastAttemptAt: null,
  };
  if (!DIR.exists) DIR.create({ intermediates: true });
  const file = fileOf(sub);
  file.create({ overwrite: true });
  file.write(gz);
  items = [...items, sub];
  changed();
  void send(sub.id);
  return sub;
}

/** Take a track off the phone: a receipt cleared, or a waiting one withdrawn. */
export function remove(id: string) {
  const sub = items.find((s) => s.id === id);
  if (!sub) return;
  try {
    const file = fileOf(sub);
    if (file.exists) file.delete();
  } catch {
    // Already gone.
  }
  items = items.filter((s) => s.id !== id);
  changed();
}

function update(id: string, next: (s: Submission) => Submission) {
  items = items.map((s) => (s.id === id ? next(s) : s));
  changed();
}

function header(headers: Record<string, string>, name: string): string | null {
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

/** One attempt at one track. */
async function attempt(sub: Submission): Promise<AttemptOutcome> {
  const { path, headers } = submissionRequest(sub.compId, sub.taskId, sub.as);
  const cookie = sub.as.kind === 'anonymous' ? '' : await sessionCookie();
  const controller = new AbortController();
  const timer =
    Platform.OS === 'android' ? setTimeout(() => controller.abort(), ANDROID_ATTEMPT_TIMEOUT_MS) : undefined;
  try {
    const res = await fileOf(sub).upload(`${API_ORIGIN}${path}`, {
      httpMethod: 'POST',
      headers: { ...headers, ...(cookie ? { cookie } : {}) },
      sessionType: 'background',
      signal: controller.signal,
    });
    await absorbSetCookie(header(res.headers, 'set-cookie'));
    return classifyAttempt(res.status, res.body);
  } catch {
    // No answer: dropped, timed out, or no signal at all.
    return classifyAttempt(null, null);
  } finally {
    clearTimeout(timer);
  }
}

/** Send one waiting track now, if nothing stops it. */
export async function send(id: string): Promise<void> {
  ensureLoaded();
  const sub = items.find((s) => s.id === id);
  // The write guard, for the one write that does not go through `apiFetch`:
  // a development build reading production never sends (mobile/CLAUDE.md).
  if (!sub || sub.status !== 'waiting' || sending.has(id) || !WRITES_ALLOWED) return;
  const current = getIdentity();
  if (sendBlock(sub, current.kind === 'signed-in' ? current.user.id : null)) return;

  sending.add(id);
  changed();
  const outcome = await attempt(sub);
  sending.delete(id);
  if (!items.some((s) => s.id === id)) {
    // Withdrawn while it was being sent.
    changed();
    return;
  }
  update(id, (s) => applyOutcome(s, outcome, Date.now()));
  if (outcome.kind === 'sent') {
    if (sub.as.kind === 'anonymous') {
      rememberLast({
        compId: sub.compId,
        taskId: sub.taskId,
        identifierKind: sub.as.identifierKind,
        identifierValue: sub.as.identifierValue,
      });
    }
    try {
      const file = fileOf(sub);
      if (file.exists) file.delete();
    } catch {
      // The receipt is what matters; a stray file is cleared with it.
    }
    void queryClient.invalidateQueries({ queryKey: ['myFlights'] });
    void queryClient.invalidateQueries({ queryKey: ['registrations'] });
    // A first track can register the pilot or claim an entry: yesterday's
    // "which one are you?" is no longer the answer.
    void queryClient.invalidateQueries({ queryKey: ['registrationState', sub.compId] });
    void queryClient.invalidateQueries({ queryKey: ['task', sub.compId, sub.taskId] });
    void queryClient.invalidateQueries({ queryKey: ['taskScore', sub.compId, sub.taskId] });
    void queryClient.invalidateQueries({ queryKey: ['compScores', sub.compId] });
  }
}

/** Send everything that is waiting and due. `force` ignores the back-off. */
export async function sendWaiting({ force = false }: { force?: boolean } = {}): Promise<void> {
  ensureLoaded();
  const now = Date.now();
  // One at a time: a hillside connection does better with one upload than
  // with several competing for it.
  for (const sub of items.filter((s) => (force ? s.status === 'waiting' : isDue(s, now)))) {
    await send(sub.id);
  }
}

/**
 * Keep the queue moving. Called once, from the root layout.
 */
export function startSubmissionQueue(): () => void {
  ensureLoaded();
  void sendWaiting({ force: true });
  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') void sendWaiting({ force: true });
  });
  const online = onlineManager.subscribe((isOnline) => {
    if (isOnline) void sendWaiting({ force: true });
  });
  // Signing in again releases tracks that were waiting for their account.
  const identity = subscribeIdentity(() => void sendWaiting({ force: true }));
  const tick = setInterval(() => {
    if (AppState.currentState === 'active') void sendWaiting();
  }, TICK_MS);
  return () => {
    appState.remove();
    online();
    identity();
    clearInterval(tick);
  };
}
