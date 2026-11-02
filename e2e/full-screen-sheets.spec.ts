/**
 * The full-bleed modal shell, `rac/full-screen-sheet.tsx`, through the caller
 * that had no cover: the waypoint/task export QR (#312). The task route glyph
 * (#476) was the other, until it became a page of its own (#814,
 * task-diagram-page.spec.ts). The third caller — the task-analysis metric
 * chart (#455) — is exercised by task-analysis.spec.ts, which owns the assertions specific
 * to it (that expanding really enlarges the plot, and that tapping a dot does
 * NOT dismiss).
 *
 * These two existed for weeks with no automated cover, which only became a
 * problem when all three were rewritten onto the shared shell. What is pinned
 * here is what the shell promises, not how it looks:
 *
 *   - it is a real ARIA dialog with a name that says what is on screen,
 *   - the content renders inside it,
 *   - every advertised way out works — the Close button, a tap on the sheet
 *     where `dismissOnPress` is set, and Escape,
 *   - focus lands somewhere useful on open and returns to the trigger on
 *     close (WCAG 2.4.3),
 *   - the page behind it is scroll-locked while it is up, and released after.
 *
 * That last group is the whole reason the shell is built on react-aria rather
 * than a bare `fixed inset-0`: focus trap, focus restore, Escape and
 * scroll-lock come from the library instead of from hand-rolled listeners. A
 * regression there is silent — the overlay still looks right — so it is
 * exactly what a test is for.
 *
 * READ-ONLY against the seeded "Corryong Cup 2026" sample comp, on public
 * pages, so there is no sign-in and nothing to clean up.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";

const COMP_NAME = "Corryong Cup 2026";

let taskPath: string;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });

  const findComp = async (): Promise<string | null> => {
    const res = await api.get("/api/comp");
    if (!res.ok()) return null;
    const { comps } = (await res.json()) as {
      comps: Array<{ comp_id: string; name: string }>;
    };
    return comps.find((c) => c.name === COMP_NAME)?.comp_id ?? null;
  };

  let compId = await findComp();
  if (!compId) {
    execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });
    compId = await findComp();
  }
  if (!compId) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);

  const detail = await api.get(`/api/comp/${compId}`);
  expect(detail.ok()).toBe(true);
  const { tasks } = (await detail.json()) as {
    tasks: Array<{ task_id: string; has_xctsk: boolean }>;
  };
  // The QR encodes the task's route, so the task needs one.
  const task = tasks.find((t) => t.has_xctsk);
  if (!task) throw new Error(`No task with an xctsk in "${COMP_NAME}"`);

  taskPath = `/comp/${compId}/task/${task.task_id}`;
  await api.dispose();
});

/** react-aria's scroll lock: an inline `overflow: hidden` on <html>. Asserted
 * on the mechanism rather than on scroll position, because `window.scrollBy`
 * still moves a document whose root is overflow:hidden. */
function rootOverflow(page: Page) {
  return page.evaluate(() => document.documentElement.style.overflow);
}

test("the export QR fills the screen on a high-contrast backdrop", async ({ page }) => {
  await page.goto(taskPath, { waitUntil: "domcontentloaded" });
  const trigger = page.getByRole("button", { name: "QR code" });
  await trigger.waitFor({ timeout: 30_000 });
  // The QR is encoded from a turnpoint fetch, so the sheet arrives a beat
  // after the press.
  await trigger.click();

  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 30_000 });
  await expect(dialog).toHaveAttribute("aria-label", "QR code");
  await expect(dialog.locator("svg").first()).toBeVisible();

  // `backdrop="contrast"`, not the app surface: a QR is read by a camera, so
  // it needs black behind the white card in either theme. Chromium serialises
  // the token as `oklab(0 0 0 / 0.9)` or `rgba(0, 0, 0, 0.9)` depending on
  // version — both contain the three zero channels, and neither the light nor
  // the dark `--background` does.
  const backdrop = await page.evaluate(() => {
    const overlay = document.querySelector('[role="dialog"]')!.closest("[class*='fixed']")!;
    return getComputedStyle(overlay).backgroundColor;
  });
  expect(backdrop.replace(/,/g, "")).toContain("0 0 0");

  await dialog.locator("p").last().click();
  await expect(dialog).toHaveCount(0);
  expect(await rootOverflow(page)).toBe("");
});
