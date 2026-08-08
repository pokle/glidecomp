/**
 * The ⓘ affordance (rac/explain.tsx) on the two field-analysis pages.
 *
 * These pages used to state every method note inline: 300 words of Spearman's
 * ρ, column definitions and verdict thresholds before the comp table's first
 * row. That prose now hangs off the header that raises its question, behind a
 * ⓘ — which only works if three things hold, and each is easy to break by
 * accident:
 *
 *  1. the note is NOT in the visible reading flow any more;
 *  2. it IS one click away, on the right header, and dismissible by keyboard
 *     with focus returned to the trigger;
 *  3. it IS on paper — a popover cannot exist in print, so `HowToReadFootnote`
 *     renders the same components `hidden print:block`. Delete that block, or
 *     un-hide it, and the change either loses the explanation or undoes itself.
 *
 * (3) is the one nothing else guards: a normal screen-driven spec passes
 * happily while the printout has lost half its method.
 */
import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./fixtures/test";
import { SAMPLE_COMP_NAME } from "../web/workers/competition-api/src/sample";

const RANKING_HEADING = /Which behaviours went with better results/;

/** The seeded sample comp's analysis URLs, and its first analysed task's. */
async function analysisUrls(request: APIRequestContext) {
  const listRes = await request.get("/api/comp");
  expect(listRes.ok()).toBeTruthy();
  const { comps } = (await listRes.json()) as {
    comps: { comp_id: string; name: string; test: boolean }[];
  };
  const pub = comps.filter((c) => !c.test);
  const comp = pub.find((c) => c.name === SAMPLE_COMP_NAME) ?? pub[0];
  if (!comp) {
    throw new Error("No public sample comp seeded — run `bun run seed corryong-cup-2026`.");
  }
  const res = await request.get(`/api/comp/${comp.comp_id}/field-analysis`);
  expect(res.ok()).toBeTruthy();
  const analysis = (await res.json()) as { tasks: { task_id: string }[] };
  const task = analysis.tasks[0];
  if (!task) throw new Error(`No analysed task in ${comp.name}.`);
  return {
    comp: `/comp/${comp.comp_id}/analysis`,
    task: `/comp/${comp.comp_id}/analysis/task/${task.task_id}`,
  };
}

test("comp analysis: the column notes are behind their headers' ⓘ", async ({
  page,
  request,
}) => {
  const urls = await analysisUrls(request);
  await page.goto(urls.comp);
  await page.getByRole("heading", { name: RANKING_HEADING }).waitFor();

  // Out of the reading flow. Hidden, not absent: the print mirror holds it.
  await expect(
    page.getByText(/A behaviour that keeps its sign and its size/).first()
  ).toBeHidden();

  // One click away, on the header whose column it describes.
  const dayToDay = page.getByRole("button", { name: "About Day to day" }).first();
  await dayToDay.click();
  const popover = page.getByRole("dialog");
  await expect(popover).toContainText("A behaviour that keeps its sign and its size");
  await expect(popover).toContainText("hollow bar");

  // Esc dismisses, and focus comes back to the trigger rather than the top of
  // the document (WCAG 2.4.3).
  await page.keyboard.press("Escape");
  await expect(popover).toHaveCount(0);
  await expect(dayToDay).toBeFocused();

  // The verdict thresholds belong to the column that holds the verdict chip —
  // this table has no separate "What it means" column for them.
  await page.getByRole("button", { name: "About Against comp standings" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("clear pattern");
});

test("task analysis: ρ and coverage are behind the ranking's column ⓘs", async ({
  page,
  request,
}) => {
  const urls = await analysisUrls(request);
  await page.goto(urls.task);
  await page.getByRole("heading", { name: RANKING_HEADING }).waitFor();

  await expect(
    page.getByText(/a reading drawn from half the field/).first()
  ).toBeHidden();

  await page.getByRole("button", { name: "About Strength" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("Spearman");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "About Pilots measured" }).first().click();
  await expect(page.getByRole("dialog")).toContainText("half the field is thinner");
});

test("print carries every note that moved behind a ⓘ", async ({ page, request }) => {
  const urls = await analysisUrls(request);

  await page.goto(urls.comp);
  await page.getByRole("heading", { name: RANKING_HEADING }).waitFor();
  await page.emulateMedia({ media: "print" });
  for (const phrase of [
    "How to read the table",
    "A behaviour that keeps its sign and its size",
    "weighted by n, with the signs kept",
    "correlates it against their overall place",
    "clear pattern",
  ]) {
    await expect(page.getByText(phrase, { exact: false }).first()).toBeVisible();
  }
  // And the triggers themselves do not print — an ⓘ on paper invites a click
  // that cannot happen.
  await expect(page.getByRole("button", { name: "About Day to day" })).toBeHidden();

  await page.emulateMedia({ media: "screen" });
  await page.goto(urls.task);
  await page.getByRole("heading", { name: RANKING_HEADING }).waitFor();
  await page.emulateMedia({ media: "print" });
  for (const phrase of [
    "How to read the table",
    "half the field is thinner",
    "will look strong on luck alone",
    // The heatmap caption's own print mirror, a separate mechanism to the
    // footnote's — worth asserting once so both patterns are covered.
    "The columns start with the behaviours",
  ]) {
    await expect(page.getByText(phrase, { exact: false }).first()).toBeVisible();
  }
});
