/**
 * The suite's `test` and `expect` — Playwright's, plus one thing: no test, and
 * no `beforeAll` or `afterAll` hook, starts while the local Workers are between
 * lives.
 *
 * `wrangler dev` exits on its own when a client connection is severed
 * mid-request (see the long note in web/scripts/dev-workers.sh), so that script
 * supervises it and brings it back. Restarting takes several seconds, and
 * Playwright's `webServer` only ever waits for the stack ONCE, at startup —
 * after that a test scheduled into the gap runs against a closed port and fails
 * for a reason that has nothing to do with what it was testing. The whole run
 * used to go that way: one crash, and every remaining spec failed as collateral.
 *
 * So every test and every file-level hook waits for `/__ready` first. When the
 * stack is up — which is essentially always — that costs one localhost
 * request. When it is not, the test or hook waits instead of failing, and the
 * retry that follows a crash-time failure gets a live stack to run against.
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
/** One probe's limit. A hung port must not hold the wait past its deadline. */
const PROBE_TIMEOUT_MS = 5_000;

/** One probe. Any HTTP answer below 500 proves the whole stack is serving. */
async function stackIsUp(): Promise<boolean> {
  try {
    const res = await fetch(API_READY_URL, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
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
 * task-analysis compute): the auto fixture only guards the START of a test or
 * hook, so a poll that lands in a supervisor-restart gap mid-test should call
 * this and carry on rather than fail the attempt on a stack blip.
 */
export async function waitForStack(): Promise<number> {
  if (await stackIsUp()) return 0;

  const startedAt = Date.now();
  const deadline = startedAt + RECOVERY_TIMEOUT_MS;
  console.error(
    `\n[stack] ${API_READY_URL} is not answering — waiting up to ` +
      `${RECOVERY_TIMEOUT_MS / 1000}s for the Workers to come back before ` +
      `going on.`
  );

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (await stackIsUp()) {
      console.error("[stack] back up — continuing.\n");
      return Date.now() - startedAt;
    }
  }

  console.error(
    "[stack] still down after the wait. Going on anyway so the failure that " +
      "follows is on the record.\n"
  );
  return Date.now() - startedAt;
}

/**
 * The fixture's own budget: the whole wait, plus the last probe's timeout, plus
 * slack. It never decides anything — waitForStack() gives up first — but it has
 * to be at least that long, or the timeout would cut the wait short.
 */
const WAIT_BUDGET_MS = RECOVERY_TIMEOUT_MS + PROBE_TIMEOUT_MS + 5_000;

/** How many runnables the wait is guarding right now (see stackWaitInForce). */
let guarded = 0;

/**
 * True while a test or a hook is running behind the wait — i.e. the stack-up
 * fixture was set up for it and has not yet been torn down.
 *
 * It exists for e2e/stack-wait.spec.ts, which asserts it inside a `beforeAll`
 * and an `afterAll`. That is the only way to notice if a Playwright upgrade
 * stops honouring `auto: "all-hooks-included"` below: nothing else would fail,
 * and the hooks would quietly go back to running against a dead port.
 */
export function stackWaitInForce(): boolean {
  return guarded > 0;
}

export const test = base.extend<{ stackUp: void }>({
  stackUp: [
    async ({}, use) => {
      await waitForStack();
      guarded++;
      try {
        await use();
      } finally {
        guarded--;
      }
    },
    {
      // NOT `auto: true`. A plain auto fixture is test-scoped, and Playwright
      // runs a file's `beforeAll` hooks before ANY test-scoped fixture, so a
      // `beforeAll` that signed in and built a fixture over the API ran with no
      // wait at all. That is how CI run 43686074965 went red: wrangler died
      // inside task-scores-admin.spec.ts's `beforeAll`, and the retry's
      // `beforeAll` ran a second later, into the restart, and failed too.
      //
      // "all-hooks-included" is the mode Playwright's own trace recording uses
      // (playwright/lib/index.js): the fixture is set up before, and torn down
      // after, every `beforeAll` and `afterAll` hook as well as every test, in
      // every file. A WORKER-scoped auto fixture would not do: with
      // `workers: 1` the worker is reused from file to file, so it would run
      // once, before the first file's hooks, and never again until a failure
      // replaced the worker.
      //
      // The mode is missing from Playwright's public types (`auto?: boolean`),
      // hence the cast — and hence e2e/stack-wait.spec.ts, which fails if a
      // Playwright upgrade ever stops honouring it.
      auto: "all-hooks-included" as unknown as boolean,
      // A slot of its own, so waiting out a restart never comes out of the
      // test's or the hook's budget. Charged to the test, the wait would turn a
      // crash into a timeout further down, which reads as a product failure —
      // and a hook that calls `test.setTimeout()` would throw away any time
      // given back.
      timeout: WAIT_BUDGET_MS,
    },
  ],
});

/**
 * "This test only means something on a phone" (or, rarely, only at a desk) is
 * a TAG, not a skip — see PHONE_ONLY and DESKTOP_ONLY in e2e/fixtures/mobile.ts:
 *
 *   test("…", { tag: PHONE_ONLY }, async ({ page }) => {
 *
 * A skip inside the body ran only after the file's `beforeEach` had signed in
 * and loaded a page; a tag keeps the project from scheduling the test at all.
 */
export { PHONE_ONLY, DESKTOP_ONLY } from "./mobile";

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
