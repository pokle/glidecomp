/**
 * The wait for a restarting stack covers a file's hooks, not only its tests.
 *
 * e2e/fixtures/test.ts makes everything wait for `/__ready` before it starts,
 * because `wrangler dev` exits over a severed connection and
 * web/scripts/dev-workers.sh takes a few seconds to bring it back. A plain auto
 * fixture only reaches tests: Playwright runs `beforeAll` before any
 * test-scoped fixture, so the `beforeAll` hooks of 29 specs, most of which sign
 * in and build a competition over the API, were not covered. CI run
 * 43686074965 lost a whole shard that way — wrangler died inside a
 * `beforeAll`, and the retry's `beforeAll` ran into the restart a second later.
 *
 * The fix is `auto: "all-hooks-included"`, a mode that is not in Playwright's
 * public types. Nothing else would notice if an upgrade stopped honouring it:
 * every spec would still pass, every day, until the next crash landed in a
 * hook. So this file asserts it, in each kind of hook it must reach.
 *
 * It needs nothing from the stack beyond its being up, which is why it runs in
 * one project only: what it checks is Playwright's, not the page's.
 */
import { test, expect, stackWaitInForce } from "./fixtures/test";

const COVERED =
  "the stack-up fixture must be set up for this hook — see the note on " +
  '`auto: "all-hooks-included"` in e2e/fixtures/test.ts';

test.beforeAll(() => {
  expect(stackWaitInForce(), `beforeAll: ${COVERED}`).toBe(true);
});

test.afterAll(() => {
  expect(stackWaitInForce(), `afterAll: ${COVERED}`).toBe(true);
});

test("a test runs behind the stack wait", () => {
  expect(stackWaitInForce()).toBe(true);
});

test.describe("inside a describe block", () => {
  test.beforeAll(() => {
    expect(stackWaitInForce(), `nested beforeAll: ${COVERED}`).toBe(true);
  });

  test("its hooks are covered too", () => {
    expect(stackWaitInForce()).toBe(true);
  });
});
