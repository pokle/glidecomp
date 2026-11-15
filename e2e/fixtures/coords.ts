/**
 * The two halves of a CoordsField (web/frontend/src/react/comp/fields.tsx):
 * Latitude and Longitude, stacked in a group named after the point — the
 * group is "Coordinates" unless the page gives the point a name of its own
 * ("Landing point").
 */
import type { Locator, Page } from "@playwright/test";

export function coordsFields(
  scope: Page | Locator,
  group = "Coordinates"
): { lat: Locator; lon: Locator } {
  const g = scope.getByRole("group", { name: group, exact: true });
  return {
    lat: g.getByRole("textbox", { name: "Latitude", exact: true }),
    lon: g.getByRole("textbox", { name: "Longitude", exact: true }),
  };
}

/** Type a "lat, lon" pair into its two fields, a half each. */
export async function fillCoords(
  scope: Page | Locator,
  pair: string,
  group?: string
): Promise<void> {
  const [lat, lon = ""] = pair.trim().split(/[,\s]+/);
  const f = coordsFields(scope, group);
  await f.lat.fill(lat);
  await f.lon.fill(lon);
}

/**
 * Paste `text` into a field as the browser does: a `paste` event carrying it
 * on the clipboard, which the page may take over (a pair fills both halves)
 * or leave to the browser. Built by hand because a headless browser's real
 * clipboard is not reliably reachable from a test.
 */
export async function pasteInto(field: Locator, text: string): Promise<void> {
  await field.focus();
  const taken = await field.evaluate((el: HTMLInputElement, t: string) => {
    const data = new DataTransfer();
    data.setData("text/plain", t);
    return !el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })
    );
  }, text);
  // Not taken over: insert it where the browser would have.
  if (!taken) await field.page().keyboard.insertText(text);
}
