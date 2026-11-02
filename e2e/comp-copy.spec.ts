/**
 * Starting the next competition from one that exists — three pages:
 *
 *   /comp/:id/copy               (settings → "Copy to a new competition")
 *   /comp/:id/pilots/copy        (pilots ⋯ → "Copy from another competition…")
 *   /comp/:id/task/:t/route/copy (route editor → "Copy from another competition")
 *
 * What this spec pins:
 * - the clone is a page reached from the settings index, suggests next
 *   year's name, and lands on a NEW HIDDEN comp holding the settings,
 *   waypoints and pilots — and Back from it does not return to the form;
 * - copying pilots is a page whose step is in the URL; it lists a pilot
 *   already on the roster as already here, copies only the rest, and returns
 *   to the list;
 * - copying a route lists the nearest routes first and loads the chosen one
 *   into the editor as UNSAVED work, which Save then stores.
 *
 * The rules themselves (who is the same pilot, how near is measured, what a
 * clone leaves behind) are competition-api's comp-copy.test.ts and
 * route-sources.test.ts. In the `mobile` project too (e2e/fixtures/mobile.ts):
 * an organiser is as likely to start next year's comp from a phone.
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { e2eCompName, FRONTEND_URL } from "./fixtures/stack";

const ORGANISER = { name: "E2E Comp Copy", email: "e2e-comp-copy@test.local" };

const WAYPOINTS = [
  { code: "ELLIOT", name: "Mt Elliot", latitude: -36.186, longitude: 147.976, altitude: 1100, radius: 400 },
  { code: "CORRYG", name: "Corryong", latitude: -36.197, longitude: 147.902, altitude: 290, radius: 400 },
  { code: "KHANCO", name: "Khancoban", latitude: -36.217, longitude: 148.13, altitude: 300, radius: 400 },
];

const LAST_YEAR_PILOTS = [
  { registered_pilot_name: "Tom Smith", registered_pilot_civl_id: "12345", pilot_class: "open" },
  { registered_pilot_name: "Ana Müller", pilot_class: "open" },
];

let api: APIRequestContext;
/** Every comp this spec made, so afterAll can delete them. */
const made: string[] = [];

async function createComp(name: string): Promise<string> {
  const res = await api.post("/api/comp", {
    data: { name, category: "hg", pilot_classes: ["open"] },
  });
  expect(res.ok(), await res.text()).toBe(true);
  const id = ((await res.json()) as { comp_id: string }).comp_id;
  made.push(id);
  return id;
}

async function createTask(compId: string, name: string, xctsk?: unknown): Promise<string> {
  const res = await api.post(`/api/comp/${compId}/task`, {
    data: {
      name,
      task_date: new Date().toISOString().slice(0, 10),
      pilot_classes: ["open"],
      ...(xctsk ? { xctsk } : {}),
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { task_id: string }).task_id;
}

const ROUTE = {
  taskType: "CLASSIC",
  version: 1,
  turnpoints: WAYPOINTS.map((w, i) => ({
    ...(i === 0 ? { type: "TAKEOFF" as const } : {}),
    radius: 400,
    waypoint: { name: w.code, description: w.name, lat: w.latitude, lon: w.longitude },
  })),
};

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  const login = await api.post("/api/auth/dev-login", { data: ORGANISER });
  expect(login.ok(), await login.text()).toBe(true);
});

test.afterAll(async () => {
  for (const id of made) await api.delete(`/api/comp/${id}`);
  await api.dispose();
});

test.beforeEach(async ({ page }) => {
  const login = await page.request.post("/api/auth/dev-login", { data: ORGANISER });
  expect(login.ok(), await login.text()).toBe(true);
  const token = login.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token[1], domain: "localhost", path: "/" },
    ]);
  }
});

const h1 = (page: Page, name: string | RegExp) => page.getByRole("heading", { level: 1, name });

test("Copy to a new competition makes a hidden copy with the waypoints and pilots", async ({
  page,
}, testInfo) => {
  const sourceName = e2eCompName(`Copy Source ${testInfo.project.name} 2026`);
  const source = await createComp(sourceName);
  expect((await api.put(`/api/comp/${source}/waypoints`, { data: { waypoints: WAYPOINTS } })).ok()).toBe(true);
  expect(
    (await api.post(`/api/comp/${source}/pilot/bulk`, { data: { pilots: LAST_YEAR_PILOTS, remove: [] } })).ok()
  ).toBe(true);

  await page.goto(`/comp/${source}/settings`);
  await page.getByRole("link", { name: /Copy to a new competition/ }).click();
  await expect(page).toHaveURL(new RegExp(`/comp/[^/]*${source}[^/]*/copy$`));
  await expect(h1(page, "Copy to a new competition")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Next year's name, suggested.
  const name = page.getByRole("textbox", { name: "Name" });
  await expect(name).toHaveValue(sourceName.replace("2026", "2027"));
  await expect(page.getByRole("checkbox", { name: /Waypoints/ })).toBeChecked();
  await expect(page.getByRole("checkbox", { name: /Pilots/ })).toBeChecked();

  await page.getByRole("button", { name: "Create copy" }).click();

  // The new comp, on its keyed URL (it starts hidden).
  await expect(page).not.toHaveURL(new RegExp(source));
  await expect(page).toHaveURL(/\/comp\/[^/]+_[a-z0-9]+$/, { timeout: 20_000 });
  await expect(h1(page, sourceName.replace("2026", "2027"))).toBeVisible({ timeout: 20_000 });
  const copyId = page.url().match(/-([^-/_]+)_[a-z0-9]+$/)?.[1];
  expect(copyId, page.url()).toBeTruthy();
  made.push(copyId!);

  const comp = (await (await api.get(`/api/comp/${copyId}`)).json()) as {
    test: boolean;
    waypoint_count: number;
    pilot_count: number;
    tasks: unknown[];
  };
  expect(comp).toMatchObject({ test: true, waypoint_count: 3, pilot_count: 2, tasks: [] });

  // Back skips the used form: it was replaced by the comp it made.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/comp/[^/]*${source}[^/]*/settings$`));
});

test("Copy pilots from another competition adds only the pilots not already here", async ({
  page,
}, testInfo) => {
  const lastYear = await createComp(e2eCompName(`Pilots Last Year ${testInfo.project.name}`));
  expect(
    (await api.post(`/api/comp/${lastYear}/pilot/bulk`, { data: { pilots: LAST_YEAR_PILOTS, remove: [] } })).ok()
  ).toBe(true);
  const thisYear = await createComp(e2eCompName(`Pilots This Year ${testInfo.project.name}`));
  expect(
    (
      await api.post(`/api/comp/${thisYear}/pilot/bulk`, {
        data: {
          pilots: [{ registered_pilot_name: "T. Smith", registered_pilot_civl_id: "12345", pilot_class: "open" }],
          remove: [],
        },
      })
    ).ok()
  ).toBe(true);

  await page.goto(`/comp/${thisYear}/pilots`);
  await expect(page.getByRole("grid", { name: "Pilots" }).getByRole("row").first()).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Roster actions" }).click();
  await page.getByRole("menuitem", { name: "Copy from another competition…" }).click();

  await expect(page).toHaveURL(/\/pilots\/copy$/);
  await expect(h1(page, "Copy pilots from another competition")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("link", { name: new RegExp(`Pilots Last Year ${testInfo.project.name}`) }).click();

  // The chosen competition is in the URL: a reload keeps the review.
  await expect(page).toHaveURL(new RegExp(`/pilots/copy\\?from=${lastYear}$`));
  await expect(h1(page, /^Copy pilots from /)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("main")).toContainText("1 to copy · 1 already here");
  await expect(page.getByRole("main")).toContainText(
    "Already on this roster as T. Smith (same CIVL ID)"
  );
  await page.reload();
  await expect(page.getByRole("main")).toContainText("1 to copy · 1 already here", {
    timeout: 20_000,
  });

  await page.getByRole("button", { name: "Copy 1 pilot" }).click();
  await expect(page).toHaveURL(/\/pilots$/, { timeout: 20_000 });
  const rows = page.getByRole("grid", { name: "Pilots" }).getByRole("row");
  await expect(rows.filter({ hasText: "Ana Müller" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Tom Smith" })).toHaveCount(0);
});

test("Copy a route lists the nearest first and loads the choice as unsaved work", async ({
  page,
}, testInfo) => {
  // Last year's route, flown from the same hill as this comp's waypoints.
  const lastYear = await createComp(e2eCompName(`Route Last Year ${testInfo.project.name}`));
  await createTask(lastYear, "Elliot to Khancoban", ROUTE);
  const thisYear = await createComp(e2eCompName(`Route This Year ${testInfo.project.name}`));
  expect((await api.put(`/api/comp/${thisYear}/waypoints`, { data: { waypoints: WAYPOINTS } })).ok()).toBe(true);
  const task = await createTask(thisYear, "Day 1");

  await page.goto(`/comp/${thisYear}/task/${task}/route`);
  await page.getByRole("link", { name: "Copy from another competition" }).click();
  await expect(page).toHaveURL(/\/route\/copy$/);
  await expect(h1(page, "Copy a route")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("status").filter({ hasText: "Nearest to this competition’s waypoints first." })).toBeVisible({
    timeout: 20_000,
  });

  // Narrow to this run's comp, so other specs' routes cannot get in the way.
  await page
    .getByRole("searchbox", { name: "Search by competition or task name" })
    .fill(`Route Last Year ${testInfo.project.name}`);
  await expect(page).toHaveURL(/[?&]q=/);
  const row = page.getByRole("link", { name: /Elliot to Khancoban/ });
  await expect(row).toContainText("under 1 km away");
  await expect(row).toContainText("ELLIOT → CORRYG → KHANCO");
  await row.click();

  // Back in the editor, with the route loaded and not yet saved.
  await expect(page).toHaveURL(/\/route\?from_comp=.+&from_task=.+$/, { timeout: 20_000 });
  const turnpoints = page.getByRole("grid", { name: /^Turnpoints/ }).getByRole("row");
  await expect(turnpoints).toHaveCount(3, { timeout: 20_000 });
  expect(((await (await api.get(`/api/comp/${thisYear}/task/${task}`)).json()) as { xctsk: unknown }).xctsk).toBeNull();

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/task/[^/]*${task}$`), { timeout: 20_000 });
  const saved = (await (await api.get(`/api/comp/${thisYear}/task/${task}`)).json()) as {
    xctsk: { turnpoints: Array<{ waypoint: { name: string } }> } | null;
  };
  expect(saved.xctsk?.turnpoints.map((t) => t.waypoint.name)).toEqual(["ELLIOT", "CORRYG", "KHANCO"]);
});
