/**
 * The app's API client: the shared typed client (@glidecomp/client) over a
 * transport that carries the session (when there is one) and refuses writes
 * when this build may not make them, plus the retry rules the website uses
 * (issue #481): a dropped request or a 5xx is retried, and a 4xx is a real
 * answer that is never asked twice.
 */
import { createApi } from '@glidecomp/client/api';
import { fetchWithRetry } from '@glidecomp/client/retry';
import { guardWrites } from '@glidecomp/client/transport';

import { withSession } from '@/auth/session-fetch';

import { API_ORIGIN, WRITES_ALLOWED } from './config';

/** `fetch` for this build's API: the session attached, writes guarded. */
export const apiFetch = guardWrites(withSession(fetch, API_ORIGIN), WRITES_ALLOWED);

export const api = createApi(API_ORIGIN, apiFetch);

/** The server answered, and the answer was no. Never retried. */
export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'ApiError';
  }
}

/** A JSON request to an auth-worker route the typed client does not cover. */
export function authRequest(path: string, init: RequestInit = {}) {
  return (signal: AbortSignal) =>
    apiFetch(`${API_ORIGIN}/api/auth${path}`, {
      ...init,
      signal,
      headers: init.body ? { 'content-type': 'application/json', ...init.headers } : init.headers,
    });
}

export function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/**
 * How long one attempt may take before it counts as dropped. On a hill the
 * common failure is not a refusal but a request that never answers; without
 * a limit it would hang the screen for minutes instead of falling back to
 * what the phone already has. Longer than Android's 10 s connect timeout,
 * so a network that advertises IPv6 it cannot route still gets its IPv4
 * fallback inside one attempt (mobile/CLAUDE.md, "When the simulators
 * misbehave").
 */
const ATTEMPT_TIMEOUT_MS = 15_000;

type Responds = Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** One attempt, cut off at ATTEMPT_TIMEOUT_MS or when the caller gives up. */
async function attempt(request: (signal: AbortSignal) => Responds, outer?: AbortSignal): Responds {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTEMPT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  outer?.addEventListener('abort', onAbort);
  try {
    return await request(controller.signal);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

/**
 * Read a JSON body through the retry rules. Throws ApiError for any answer
 * that is not a success (after retrying 5xx), and rethrows a request that was
 * dropped or timed out on every attempt — which the query layer reports as
 * "no signal", never as "not found".
 */
export async function getJson<T>(
  request: (signal: AbortSignal) => Responds,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetchWithRetry(() => attempt(request, signal), { signal });
  if (!res.ok) throw new ApiError(res.status);
  return (await res.json()) as T;
}

/** The same rules as getJson, for a body that is a file rather than JSON. */
export async function getBytes(
  request: (signal: AbortSignal) => Responds,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const res = await fetchWithRetry(() => attempt(request, signal), { signal });
  if (!res.ok) throw new ApiError(res.status);
  return new Uint8Array(await res.arrayBuffer());
}
