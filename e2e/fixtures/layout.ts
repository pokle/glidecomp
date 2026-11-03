/**
 * Layout checks the specs share.
 *
 * "The page never scrolls sideways" (WCAG 1.4.10 reflow, and the reason a
 * phone needed pages rather than sheets) was written out by hand in a dozen
 * specs, two ways — and the one comparing against `window.innerWidth` is
 * weaker on a desktop, where that width includes the vertical scrollbar, so
 * an overflow narrower than the scrollbar passed. One check, against the
 * document's own client width.
 */
import { expect } from "./test";
import type { Page } from "@playwright/test";

/** The page does not scroll sideways: nothing in it is wider than the viewport. */
export async function expectNoSidewaysScroll(page: Page, where = "the page"): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow, `${where} must not scroll sideways`).toBeLessThanOrEqual(0);
}
