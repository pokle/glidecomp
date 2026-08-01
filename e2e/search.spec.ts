/**
 * Site search on the competitions page, end to end.
 *
 * The query that matters is "elliot kangck" — two turnpoint codes from the
 * seeded Corryong Cup task, and nothing else. Nobody names the competition,
 * nobody names the task, and the page has to come back with the competition,
 * the task inside it, and the reason it matched.
 *
 * READ-ONLY against the seeded sample comp: the spec creates nothing and
 * changes nothing, so there is nothing to clean up (see the state-hygiene
 * notes in e2e/fixtures/stack.ts). The one write is the super-admin search
 * reindex, which rebuilds a derived index and touches no competition data.
 */
import { execSync } from "node:child_process";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { FRONTEND_URL, SUPER_ADMIN } from "./fixtures/stack";

const BASE_URL = FRONTEND_URL;
const COMP_NAME = "Corryong Cup 2026";
/** Two turnpoints of the seeded task 1 route (see web/samples/comps/…). */
const TURNPOINTS = "elliot kangck";

let compId: string;

test.beforeAll(async ({ playwright }) => {
  test.setTimeout(300_000);
  const api = await playwright.request.newContext({ baseURL: BASE_URL });

  const findComp = async (): Promise<string | null> => {
    const res = await api.get("/api/comp");
    if (!res.ok()) return null;
    const { comps } = (await res.json()) as {
      comps: Array<{ comp_id: string; name: string }>;
    };
    return comps.find((c) => c.name === COMP_NAME)?.comp_id ?? null;
  };

  let id = await findComp();
  if (!id) {
    execSync("bun run seed corryong-cup-2026", { stdio: "inherit", timeout: 240_000 });
    id = await findComp();
  }
  if (!id) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);
  compId = id;

  // The index normally keeps itself current, but a database that has just had
  // migration 0026 applied has a full queue and drains it over the following
  // hour (a cron plus a slice per search). A local run will not wait an hour,
  // so build it here — which is also the coverage for the admin lever.
  await reindexSearch(api);
  await api.dispose();
});

/** Rebuild the search index as super admin, until the queue is empty. */
async function reindexSearch(api: APIRequestContext) {
  const login = await api.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  expect(login.ok(), `dev-login failed: ${login.status()}`).toBeTruthy();

  for (let round = 0; round < 20; round++) {
    // `resume` after the first call: without it each call re-queues the whole
    // database and the queue never empties.
    const res = await api.post(
      `/api/admin/search/reindex${round === 0 ? "" : "?resume=true"}`
    );
    expect(res.ok(), `reindex failed: ${res.status()}`).toBeTruthy();
    const { remaining } = (await res.json()) as { remaining: number };
    if (remaining === 0) return;
  }
  throw new Error("search index did not finish rebuilding");
}

test.describe("site search", () => {
  test("finds a task by two of its turnpoints", async ({ page }) => {
    await page.goto("/comp");
    const box = page.getByRole("searchbox", {
      name: "Search competitions, tasks, pilots and turnpoints",
    });
    await box.fill(TURNPOINTS);

    // The competition it belongs to, even though nothing in the query named it.
    const comp = page.getByRole("link", { name: COMP_NAME, exact: false }).first();
    await expect(comp).toBeVisible({ timeout: 15_000 });

    // …and the reason it matched, spelled out rather than left to be guessed.
    await expect(page.getByText(/via .*ELLIOT/i).first()).toBeVisible();
    await expect(page.getByText(/KANGCK/i).first()).toBeVisible();
  });

  test("a turnpoint query counts the field instead of listing it", async ({ page }) => {
    await page.goto("/comp");
    await page
      .getByRole("searchbox", { name: "Search competitions, tasks, pilots and turnpoints" })
      .fill("kangck");
    await expect(page.getByText(/\d+ pilots?$/).first()).toBeVisible({ timeout: 15_000 });
  });

  test("the search is a linkable URL", async ({ page }) => {
    await page.goto("/comp");
    await page
      .getByRole("searchbox", { name: "Search competitions, tasks, pilots and turnpoints" })
      .fill(TURNPOINTS);
    await expect(page).toHaveURL(/\?q=elliot\+kangck/);

    // Opened cold, the same URL searches for the same thing.
    await page.goto(`/comp?q=${encodeURIComponent(TURNPOINTS)}`);
    await expect(page.getByText(/via .*ELLIOT/i).first()).toBeVisible({ timeout: 15_000 });
  });

  test("a word nothing matches says so, and does not fall back to the list", async ({
    page,
  }) => {
    await page.goto("/comp");
    await page
      .getByRole("searchbox", { name: "Search competitions, tasks, pilots and turnpoints" })
      .fill("zzzznotathing");
    await expect(page.getByText(/Nothing matches/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: COMP_NAME, exact: false })).toHaveCount(0);
  });

  test("a failed search is not reported as no results", async ({ page }) => {
    // Issue #481's rule, in the search box: a dropped request is not the fact
    // that nothing was found. Every attempt fails, so the retry runs out.
    await page.route("**/api/comp/search**", (route) => route.abort("failed"));
    await page.goto("/comp");
    await page
      .getByRole("searchbox", { name: "Search competitions, tasks, pilots and turnpoints" })
      .fill(TURNPOINTS);

    await expect(page.getByRole("alert")).toContainText(/Search is unavailable/, {
      timeout: 15_000,
    });
    await expect(page.getByText(/Nothing matches/)).toHaveCount(0);
  });
});
