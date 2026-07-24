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
