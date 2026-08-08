/**
 * The map panels load lazily (`lib/use-in-view` gates the 764 KB Mapbox
 * bundle on an IntersectionObserver). The failure that gate can have is
 * silent and total: a panel that says "Loading map…" for the rest of the
 * page's life, with the bundle never even requested.
 *
 * It happened for real. Both map pages render a *loading state first* and only
 * render the map's container once their data arrives — so a gate that looks
 * for the element once, on mount, never finds it. A direct (server-rendered)
 * load of the pilot page hid it, because SSR seeds the data and the container
 * is there in the first render; tapping through from the task page did not.
 *
 * Hence: navigate the way a visitor does, and assert the map actually mounts.
 * Mutation-free — drives the seeded sample comp read-only. No Mapbox token is
 * needed: this asserts the component mounts (the placeholder goes away), not
 * that tiles paint.
 */
import { test, expect } from "./fixtures/test";
import { FRONTEND_URL } from "./fixtures/stack";

const COMP_NAME = "Corryong Cup 2026";

let compId: string;
let taskId: string;
let pilotName: string;

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  const { comps } = (await (await api.get("/api/comp")).json()) as {
    comps: Array<{ comp_id: string; name: string }>;
  };
  const comp = comps.find((c) => c.name === COMP_NAME);
  if (!comp) throw new Error(`Sample comp "${COMP_NAME}" not found — run \`bun run seed\``);
  compId = comp.comp_id;

  const { tasks } = (await (await api.get(`/api/comp/${compId}`)).json()) as {
    tasks: Array<{ task_id: string }>;
  };
  taskId = tasks[0].task_id;

  const score = (await (
    await api.get(`/api/comp/${compId}/task/${taskId}/score`)
  ).json()) as { class_scores: Array<{ pilots: Array<{ pilot_name: string }> }> };
  // Rank 1, so the link is on the task page's public top-three.
  pilotName = score.class_scores[0].pilots[0].pilot_name;
  await api.dispose();
});

test("the pilot score map mounts when the page is reached by a link, not just directly", async ({
  page,
}) => {
  await page.goto(`${FRONTEND_URL}/comp/${compId}/task/${taskId}`);
  await page.getByRole("link", { name: pilotName }).first().click();
  await page.waitForURL(/\/pilot\//);
  await expect(page.getByRole("heading", { name: pilotName })).toBeVisible();

  // The gate opened and the lazy chunk mounted: the placeholder is gone.
  await expect(page.getByText(/^Loading map/)).toHaveCount(0, { timeout: 30_000 });
});

test("the waypoints map mounts once the waypoints have loaded", async ({ page }) => {
  await page.goto(`${FRONTEND_URL}/comp/${compId}/waypoints`);
  await expect(page.getByRole("heading", { name: "Waypoints" })).toBeVisible();
  await expect(page.getByText(/^Loading map/)).toHaveCount(0, { timeout: 30_000 });
});
