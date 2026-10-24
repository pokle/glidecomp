/**
 * Retry an async operation through transient failures.
 *
 * The pilot score page fans out to several concurrent DB-backed API calls
 * (comp, task, score, analysis) both server-side (loadPilotScoreDetail) and on
 * the client (loadDetail). A cold or heavily-loaded D1 can transiently fail one
 * of them — a 5xx, or a false 404 from a momentarily-empty read — which then
 * surfaces as a spurious "not found". That page is always reached via a link
 * that had the pilot, so a couple of quick retries absorb the hiccup; genuinely
 * missing data just costs the extra attempts before the same error surfaces.
 *
 * Retries on ANY thrown error (including a NotFoundError), because during a D1
 * blip a 404 is usually transient here. Pure (setTimeout only), so it runs the
 * same in workerd (SSR) and the browser.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  { attempts = 3, delayMs = 150 }: { attempts?: number; delayMs?: number } = {}
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        // Linear backoff (150ms, 300ms, …) — enough for a warming D1.
        await new Promise((resolve) => setTimeout(resolve, delayMs * (i + 1)));
      }
    }
  }
  throw lastErr;
}

const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_DELAY_MS = 400;

/**
 * The comp/task GET right after this same session's create/update write can
 * transiently 500 (e.g. D1 lock contention under the write that just
 * happened) even though the write itself succeeded. Retry before treating it
 * as a real failure.
 *
 * Only 5xx and dropped requests are retried. **Every 4xx is a real answer** and
 * is handed straight back: the server understood the request and declined it,
 * and asking twice more changes nothing. This used to read
 * `res.ok || res.status === 404` — 404 was the only 4xx spared, so a 401, a 403
 * or the 429 an API key gets when rate-limited cost three round trips and two
 * delays before returning the same verdict, and the retries pushed a
 * rate-limited caller further past its limit.
 *
 * A *dropped* request is retried too (issue #481). It used to escape as a
 * rejected promise: every caller wraps this in a try/catch that renders
 * "Competition not found", so a blip on the way to the API was reported to
 * the user as a missing competition — and stayed that way, since nothing
 * re-fetches.
 *
 * `signal` is for callers that supersede their own requests — the search box
 * types a new query over an old one. An abort is a decision, not a blip, so it
 * ends the retries immediately instead of costing three attempts and two
 * delays before the caller throws the answer away regardless.
 */
export async function fetchWithRetry<T extends { ok: boolean; status: number }>(
  fetcher: () => Promise<T>,
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  let lastRes: T | undefined;
  let lastErr: unknown;
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    if (options.signal?.aborted) throw options.signal.reason;
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, FETCH_RETRY_DELAY_MS));
    }
    try {
      const res = await fetcher();
      if (res.status < 500) return res;
      lastRes = res;
    } catch (err) {
      if (options.signal?.aborted) throw err;
      lastErr = err;
    }
  }
  // Out of attempts. Prefer handing back the last real response — callers
  // read its status — and only re-raise when every attempt was dropped.
  if (lastRes !== undefined) return lastRes;
  throw lastErr;
}
