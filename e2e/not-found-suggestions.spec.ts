/**
 * The 404 page's "did you mean …" repair, end to end.
 *
 * A public URL is `${slug}-${id}`, so when an id stops resolving the slug still
 * names what the visitor wanted. This drives the real repair path: take a live
 * pilot-score URL from the seeded sample comp, swap the ids for ones that don't
 * resolve while keeping every slug, and assert the page comes back offering the
 * URL that works now.
 *
 * READ-ONLY against the seeded sample comp — nothing is created, so there is
 * nothing to clean up (see the state-hygiene notes in e2e/fixtures/stack.ts).
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { FRONTEND_URL } from "./fixtures/stack";
import { pilotPath, taskPath } from "../web/frontend/src/react/lib/slug";

const BASE_URL = FRONTEND_URL;

/**
 * A sqid-shaped id that decodes to nothing anyone has: the alphabet is the 26
 * lowercase letters, so this is a well-formed segment the API will simply not
 * find — which is exactly the "link died" case, not the "malformed URL" one.
 */
const DEAD_ID = "zzzzzzzz";

interface Live {
  compId: string;
  compName: string;
  taskId: string;
  taskName: string;
  pilotId: string;
  pilotName: string;
}

/** A real comp/task/pilot triple out of whatever public comp is seeded. */
async function findLivePilotScore(request: APIRequestContext): Promise<Live> {
  const listRes = await request.get("/api/comp");
  expect(listRes.ok()).toBeTruthy();
  const { comps } = (await listRes.json()) as {
    comps: Array<{ comp_id: string; name: string; test: boolean }>;
  };
  for (const comp of comps.filter((c) => !c.test)) {
    const scoresRes = await request.get(`/api/comp/${comp.comp_id}/scores`);
    if (!scoresRes.ok()) continue;
    const scores = (await scoresRes.json()) as {
      standings: Array<{
        pilots: Array<{
          comp_pilot_id: string;
          pilot_name: string;
          tasks: Array<{ task_id: string }>;
        }>;
      }>;
    };
    const pilot = scores.standings.flatMap((s) => s.pilots).find((p) => p.tasks.length > 0);
    if (!pilot) continue;
    const taskId = pilot.tasks[0].task_id;
    const taskRes = await request.get(`/api/comp/${comp.comp_id}/task/${taskId}`);
    if (!taskRes.ok()) continue;
    const task = (await taskRes.json()) as { name: string };
    return {
      compId: comp.comp_id,
      compName: comp.name,
      taskId,
      taskName: task.name,
      pilotId: pilot.comp_pilot_id,
      pilotName: pilot.pilot_name,
    };
  }
  throw new Error("No seeded public comp with a scored pilot — run `bun run seed`.");
}

let live: Live;

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: BASE_URL });
  live = await findLivePilotScore(api);
  await api.dispose();
});

test.describe("404 → did you mean", () => {
  test("a dead pilot-score link offers the pilot's live URL", async ({ page }) => {
    const dead = pilotPath(
      DEAD_ID,
      live.compName,
      DEAD_ID,
      live.taskName,
      DEAD_ID,
      live.pilotName
    );
    await page.goto(`${BASE_URL}${dead}`);

    await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();

    const wanted = pilotPath(
      live.compId,
      live.compName,
      live.taskId,
      live.taskName,
      live.pilotId,
      live.pilotName
    );
    const suggestion = page.getByRole("link", { name: live.pilotName, exact: true });
    await expect(suggestion).toBeVisible();
    await expect(suggestion).toHaveAttribute("href", wanted);

    // …and following it lands on the real page.
    await suggestion.click();
    await expect(page).toHaveURL(new RegExp(`${wanted}$`));
    await expect(page.getByRole("heading", { name: live.pilotName })).toBeVisible();
  });

  test("a dead task link offers the task, and the comp behind it", async ({ page }) => {
    await page.goto(`${BASE_URL}${taskPath(DEAD_ID, live.compName, DEAD_ID, live.taskName)}`);

    await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
    await expect(
      page.getByRole("link", { name: live.taskName, exact: true })
    ).toHaveAttribute("href", taskPath(live.compId, live.compName, live.taskId, live.taskName));
    await expect(
      page.getByRole("link", { name: live.compName, exact: true }).first()
    ).toBeVisible();
  });

  test("the search box finds a competition from a URL that says nothing", async ({ page }) => {
    // A shape the router doesn't know at all — it reaches the SPA's catch-all.
    await page.goto(`${BASE_URL}/comp/${DEAD_ID}/nonexistent-section`);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    // Nothing in that address names a comp, task or pilot, so nothing is
    // suggested automatically…
    await expect(page.getByRole("heading", { name: "Did you mean…" })).toHaveCount(0);

    // …but the search box gets there.
    await page.getByRole("searchbox").fill(live.compName);
    await expect(page.getByRole("heading", { name: "Search results" })).toBeVisible();
    await expect(
      page.getByRole("link", { name: live.compName, exact: true }).first()
    ).toBeVisible();
  });

  test("a URL that matches nothing says so, and still offers the way out", async ({ page }) => {
    // Bare ids: well-formed, resolve to nothing, and carry no words to search.
    await page.goto(`${BASE_URL}/comp/${DEAD_ID}/task/${DEAD_ID}`);
    await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
    // Scoped to the page's own list — the header nav has a "Competitions" link
    // of its own.
    const elsewhere = page.getByRole("region", { name: "Elsewhere on GlideComp" });
    await expect(elsewhere.getByRole("link", { name: "Competitions" })).toBeVisible();
  });
});
