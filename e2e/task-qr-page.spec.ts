/**
 * The task's QR code — a page under the task (issue #813), where it was a
 * full-screen, tap-to-dismiss overlay over the task page. Part of the "No
 * full-screen overlays" rule in CLAUDE.md: a figure at full size is a page,
 * with its own URL, left with the browser's Back.
 *
 * What this spec pins, on a phone and on a desktop:
 * - the task page LINKS to `/comp/:id/task/:id/qr` rather than opening an
 *   overlay, and Back from there returns to the task page;
 * - a reload of the URL rebuilds the page from nothing — it fetches the route
 *   itself, where the overlay was handed the encoded QR in memory;
 * - the code is large and on screen whole, and the page never scrolls
 *   sideways;
 * - a hidden comp's share key rides along into the page and its breadcrumbs,
 *   and the page 404s for anyone who has the id without the key.
 *
 * The QR page is public, so the first test never signs in. Runs against its
 * own comps (named through e2eCompName, so the pre-run sweep catches strays).
 */
import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page } from "./fixtures/test";
import { expectNoSidewaysScroll } from "./fixtures/layout";
import { e2eCompName, FRONTEND_URL, SUPER_ADMIN } from "./fixtures/stack";

const TASK_NAME = "Task 4";
const XCTSK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web/samples/comps/unungra-cup-2020-open-t4/task.xctsk"
);

interface Fixture {
  compId: string;
  taskId: string;
}

let open: Fixture;
let hidden: Fixture;

async function devLogin(page: Page) {
  const login = await page.request.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  expect(login.ok(), await login.text()).toBe(true);
  const token = login.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/);
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token[1], domain: "localhost", path: "/" },
    ]);
  }
}

test.beforeAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  const login = await api.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  expect(login.ok(), await login.text()).toBe(true);
  const xctsk = JSON.parse(await readFile(XCTSK, "utf8")) as unknown;

  const make = async (label: string, test: boolean): Promise<Fixture> => {
    const created = await api.post("/api/comp", {
      data: { name: e2eCompName(label), category: "hg", pilot_classes: ["open"], test },
    });
    expect(created.ok(), await created.text()).toBe(true);
    const compId = ((await created.json()) as { comp_id: string }).comp_id;
    const task = await api.post(`/api/comp/${compId}/task`, {
      data: { name: TASK_NAME, task_date: "2020-12-12", pilot_classes: ["open"], xctsk },
    });
    expect(task.ok(), await task.text()).toBe(true);
    return { compId, taskId: ((await task.json()) as { task_id: string }).task_id };
  };
  open = await make("Task QR Page", false);
  hidden = await make("Task QR Page Hidden", true);
  await api.dispose();
});

test.afterAll(async ({ playwright }) => {
  const api = await playwright.request.newContext({ baseURL: FRONTEND_URL });
  await api.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  for (const f of [open, hidden]) if (f) await api.delete(`/api/comp/${f.compId}`);
  await api.dispose();
});

const heading = (page: Page) => page.getByRole("heading", { level: 1, name: "QR code" });
// The code is an image named by its caption, which names the task.
const qr = (page: Page) =>
  page.getByRole("img", { name: `${TASK_NAME} · scan with XCTrack, Flyskyhy or any XCTSK-aware app` });

test("the task page links to the QR page; a reload keeps it and Back leaves it", async ({
  page,
}) => {
  await page.goto(`/comp/${open.compId}/task/${open.taskId}`);
  await expect(page.getByRole("heading", { level: 1, name: TASK_NAME })).toBeVisible();

  await page.getByRole("link", { name: "QR code" }).click();
  // Compared by ids: the page settles a bare-id URL on its slugged one.
  await expect(page).toHaveURL(
    new RegExp(`/comp/[^/]*${open.compId}/task/[^/]*${open.taskId}/qr$`)
  );
  await expect(heading(page)).toBeVisible();
  await expect(qr(page)).toBeVisible();
  // A page, not an overlay over the task page.
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Big enough for a camera across a table, and on screen whole.
  const viewport = page.viewportSize()!;
  const box = (await page.getByTestId("task-qr").boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(Math.min(viewport.width * 0.75, 400));
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  // Centred in its column: the gaps either side agree to within a pixel or two.
  const column = (await page.locator("figure", { has: page.getByTestId("task-qr") }).boundingBox())!;
  const left = box.x - column.x;
  const right = column.x + column.width - (box.x + box.width);
  expect(Math.abs(left - right)).toBeLessThanOrEqual(2);
  // A phone never scrolls this page sideways.
  await expectNoSidewaysScroll(page);

  // A reload has no task page underneath it: the page fetches the route itself.
  await page.reload();
  await expect(heading(page)).toBeVisible();
  await expect(qr(page)).toBeVisible();

  // Back is the browser's, and it returns to the task page it was opened from.
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/task/[^/]*${open.taskId}$`));
  await expect(page.getByRole("heading", { level: 1, name: TASK_NAME })).toBeVisible();
});

test("a hidden comp's QR page keeps its share key, and the id alone finds nothing", async ({
  page,
  browser,
}) => {
  const api = page.request;
  await devLogin(page);
  const { share_key } = (await (await api.get(`/api/comp/${hidden.compId}`)).json()) as {
    share_key: string | null;
  };
  expect(share_key).toBeTruthy();
  const keyed = `${hidden.compId}_${share_key}`;

  await page.goto(`/comp/${keyed}/task/${hidden.taskId}`);
  await expect(page.getByRole("heading", { level: 1, name: TASK_NAME })).toBeVisible();
  await page.getByRole("link", { name: "QR code" }).click();
  await expect(page).toHaveURL(
    new RegExp(`/comp/[^/]*${keyed}/task/[^/]*${hidden.taskId}/qr$`)
  );
  await expect(qr(page)).toBeVisible();
  // The trail back to the task keeps the key too.
  const crumb = page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", {
    name: TASK_NAME,
  });
  await expect(crumb).toHaveAttribute("href", new RegExp(`${keyed}/task/`));

  // Signed out: the shared link opens it, the bare id does not.
  const anon = await browser.newContext();
  try {
    const visitor = await anon.newPage();
    await visitor.goto(`${FRONTEND_URL}/comp/${keyed}/task/${hidden.taskId}/qr`);
    await expect(qr(visitor)).toBeVisible();

    await visitor.goto(`${FRONTEND_URL}/comp/${hidden.compId}/task/${hidden.taskId}/qr`);
    await expect(
      visitor.getByRole("heading", { level: 1, name: "Task not found" })
    ).toBeVisible();
    await expect(qr(visitor)).toHaveCount(0);
  } finally {
    await anon.close();
  }
});
