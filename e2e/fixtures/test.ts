/**
 * The suite's `test` and `expect` — Playwright's, plus one thing: no test
 * starts while the local Workers are between lives.
 *
 * `wrangler dev` exits on its own when a client connection is severed
 * mid-request (see the long note in web/scripts/dev-workers.sh), so that script
 * supervises it and brings it back. Restarting takes several seconds, and
 * Playwright's `webServer` only ever waits for the stack ONCE, at startup —
 * after that a test scheduled into the gap runs against a closed port and fails
 * for a reason that has nothing to do with what it was testing. The whole run
 * used to go that way: one crash, and every remaining spec failed as collateral.
 *
 * So every test waits for `/__ready` first. When the stack is up — which is
 * essentially always — that costs one localhost request. When it is not, the
 * test waits instead of failing, and the retry that follows a crash-time failure
 * gets a live stack to run against.
 *
 * The wait is bounded. If the stack does not come back, the test proceeds and
 * fails on its own merits, and e2e/reporters/stack-health.ts says why.
 *
 * Import from here, not from `@playwright/test`, in every spec.
 */
import { test as base, expect } from "@playwright/test";
import { API_READY_URL } from "./stack";

/** How long a test will wait for a restarting stack before giving up on it. */
const RECOVERY_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 500;

/** One probe. Any HTTP answer below 500 proves the whole stack is serving. */
async function stackIsUp(): Promise<boolean> {
  try {
    const res = await fetch(API_READY_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

/**
 * Returns how long it waited, so the caller can give the time back.
 *
 * Exported for tests that POLL an API in a loop (e.g. waiting out a
 * field-analysis compute): the auto fixture only guards the START of a test,
 * so a poll that lands in a supervisor-restart gap mid-test should call this
 * and carry on rather than fail the attempt on a stack blip.
 */
export async function waitForStack(): Promise<number> {
  if (await stackIsUp()) return 0;

  const startedAt = Date.now();
  const deadline = startedAt + RECOVERY_TIMEOUT_MS;
  console.error(
    `\n[stack] ${API_READY_URL} is not answering — waiting up to ` +
      `${RECOVERY_TIMEOUT_MS / 1000}s for the Workers to come back before ` +
      `starting this test.`
  );

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (await stackIsUp()) {
      console.error("[stack] back up — continuing.\n");
      return Date.now() - startedAt;
    }
  }

  console.error(
    "[stack] still down after the wait. Running the test anyway so its own " +
      "failure is on the record.\n"
  );
  return Date.now() - startedAt;
}

export const test = base.extend<{ stackUp: void }>({
  stackUp: [
    async ({}, use, testInfo) => {
      // Waiting out a restart must not come out of the test's own budget —
      // otherwise the fixture converts a crash into a timeout further down the
      // test, which reads as a product failure.
      const waited = await waitForStack();
      if (waited > 0) testInfo.setTimeout(testInfo.timeout + waited);
      await use();
    },
    { auto: true },
  ],
});

export { expect };
export type {
  APIRequestContext,
  APIResponse,
  Browser,
  BrowserContext,
  Locator,
  Page,
  Request,
  Response,
  TestInfo,
} from "@playwright/test";
