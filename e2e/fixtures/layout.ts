/**
 * Layout checks the specs share.
 *
 * "The page never scrolls sideways" (WCAG 1.4.10 reflow, and the reason a
 * phone needed pages rather than sheets) was written out by hand in a dozen
 * specs, two ways — and the one comparing against `window.innerWidth` could
 * not fail where it matters most: on a phone (the `mobile` project's device
 * emulation) the browser zooms out to fit content wider than the screen, so
 * `innerWidth` grows with the overflow it was meant to catch; on a desktop it
 * includes the vertical scrollbar. One check, against the document's own
 * client width.
 *
 * A failure names what crosses the edge, so it can be fixed from the CI log
 * alone: an overflow that only one browser build produces is otherwise a
 * number with nothing to point at.
 */
import { expect } from "./test";
import type { Page } from "@playwright/test";

/** The page does not scroll sideways: nothing in it is wider than the viewport. */
export async function expectNoSidewaysScroll(page: Page, where = "the page"): Promise<void> {
  const { overflow, culprits } = await page.evaluate(() => {
    const root = document.documentElement;
    const edge = root.clientWidth;
    const overflow = root.scrollWidth - edge;
    if (overflow <= 0) return { overflow, culprits: [] as string[] };
    // What reaches past the edge without an ancestor that clips it: those
    // are the boxes the document's scroll width is made of. Deepest first,
    // so the list starts with the element to fix rather than its wrappers.
    const clipped = (el: Element) => {
      for (let p = el.parentElement; p && p !== root; p = p.parentElement) {
        if (getComputedStyle(p).overflowX !== "visible") return true;
      }
      return false;
    };
    const past = Array.from(document.body.querySelectorAll<HTMLElement>("*")).filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > edge + 0.5 && getComputedStyle(el).position !== "fixed" && !clipped(el);
    });
    const leaves = past.filter((el) => !past.some((other) => other !== el && el.contains(other)));
    const culprits = leaves.slice(0, 8).map((el) => {
      const r = el.getBoundingClientRect();
      const cls = typeof el.className === "string" ? el.className.slice(0, 80) : "";
      const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
      return `<${el.tagName.toLowerCase()} class="${cls}"> right=${r.right.toFixed(1)} "${text}"`;
    });
    return { overflow, culprits };
  });
  expect(
    overflow,
    `${where} must not scroll sideways${culprits.length ? `; past the edge: ${culprits.join(" · ")}` : ""}`
  ).toBeLessThanOrEqual(0);
}
