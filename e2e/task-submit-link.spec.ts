/**
 * Submit track on the TASK page is a link to the /submit page, not a dialog
 * (#820, the overlays rule in CLAUDE.md).
 *
 * What this holds, on a phone and on a desktop:
 *  - the task page's Submit track (the action row's and the Scores section's)
 *    goes to `/submit?comp=…&task=…`, and that page names the task;
 *  - a reload keeps the form on the same task, because the task is in the URL
 *    and not handed over in memory;
 *  - the browser's Back returns to the task page;
 *  - a hidden competition's share key rides in `?comp=`, so its organiser
 *    lands on a form that still resolves the comp, with the on-behalf picker
 *    the dialog used to offer them.
 *
 * Fresh competitions, created as the super admin and deleted afterwards (see
 * the state-hygiene notes in e2e/fixtures/stack.ts).
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { E2E_ORGANISER, FRONTEND_URL, SUPER_ADMIN, e2eCompName } from "./fixtures/stack";

const BASE_URL = FRONTEND_URL;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  if (!res.ok()) throw new Error(`Dev login failed: ${res.status()}`);
  const token = res.headers()["set-cookie"]?.match(/better-auth\.session_token=([^;]+)/)?.[1];
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token, domain: "localhost", path: "/" },
    ]);
  }
}

interface Fixture {
  compId: string;
  compName: string;
  taskId: string;
}

/** A competition with one task flying today and one registered pilot. */
async function createComp(
  admin: APIRequestContext,
  label: string,
  hidden: boolean
): Promise<Fixture> {
  const compName = e2eCompName(label);
  const compRes = await admin.post("/api/comp", {
    data: { name: compName, category: "hg", pilot_classes: ["open"], test: hidden },
  });
  expect(compRes.ok(), await compRes.text()).toBeTruthy();
  const { comp_id: compId } = (await compRes.json()) as { comp_id: string };

  // A real organiser, so the super admin is not the comp's only admin.
  const adminsRes = await admin.patch(`/api/comp/${compId}`, {
    data: { admin_emails: [E2E_ORGANISER.email] },
  });
  expect(adminsRes.ok(), "set organiser").toBeTruthy();

  const taskRes = await admin.post(`/api/comp/${compId}/task`, {
    data: { name: "Linked Task", task_date: today(), pilot_classes: ["open"] },
  });
  expect(taskRes.ok(), await taskRes.text()).toBeTruthy();
  const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

  const pilotRes = await admin.post(`/api/comp/${compId}/pilot`, {
    data: {
      registered_pilot_name: "Linda Link",
      pilot_class: "open",
      registered_pilot_civl_id: "e2e-8201",
    },
  });
  expect(pilotRes.ok(), await pilotRes.text()).toBeTruthy();

  return { compId, compName, taskId };
}

let admin: APIRequestContext;
let open: Fixture;
let hidden: Fixture;
let shareKey: string;

test.beforeAll(async ({ playwright }) => {
  admin = await playwright.request.newContext({ baseURL: BASE_URL });
  // Mint the organiser account (dev-login upserts), then take the super-admin
  // session back for the setup.
  expect((await admin.post("/api/auth/dev-login", { data: E2E_ORGANISER })).ok()).toBeTruthy();
  expect((await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN })).ok()).toBeTruthy();
  open = await createComp(admin, "submit link", false);
  hidden = await createComp(admin, "submit link hidden", true);
  const res = await admin.get(`/api/comp/${hidden.compId}`);
  expect(res.ok(), await res.text()).toBeTruthy();
  const { share_key } = (await res.json()) as { share_key: string | null };
  expect(share_key).toMatch(/^[a-z0-9]{12}$/);
  shareKey = share_key!;
});

test.afterAll(async () => {
  for (const f of [open, hidden]) {
    if (f?.compId) await admin.delete(`/api/comp/${f.compId}`);
  }
  await admin.dispose();
});

/**
 * The task step, collapsed to the one line that names the linked task (and
 * its class, which the task's title does not).
 */
function linkedTaskLine(page: Page, f: Fixture) {
  return page.getByText(`Linked Task (open) — ${f.compName}`, { exact: true });
}

test("Submit track on the task page is a page of its own: URL, reload and Back", async ({
  page,
}) => {
  const taskUrl = `${BASE_URL}/comp/${open.compId}/task/${open.taskId}`;
  await page.goto(taskUrl);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Linked Task", {
    timeout: 20_000,
  });
  // Both of the task page's Submit tracks — the action row's and the Scores
  // section's — are links to the same page. (Scoped to main: the site
  // header's own Submit track is a link to the bare /submit.)
  const links = page.getByRole("main").getByRole("link", { name: "Submit track" });
  // Mount-gated on a server-rendered page, so this waits for hydration.
  await expect(links.first()).toBeVisible({ timeout: 20_000 });
  await expect(links).toHaveCount(2);
  const want = `/submit?comp=${open.compId}&task=${open.taskId}`;
  for (const link of await links.all()) {
    await expect(link).toHaveAttribute("href", want);
  }
  // And no dialog: the old one opened over the page from a button.
  await expect(page.getByRole("main").getByRole("button", { name: "Submit track" })).toHaveCount(0);

  await links.first().click();
  await expect(page).toHaveURL(`${BASE_URL}${want}`);
  await expect(page.getByRole("heading", { level: 1, name: "Submit your track" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  // The task the pilot was looking at, named — not a list to pick it from.
  await expect(linkedTaskLine(page, open)).toBeVisible({ timeout: 20_000 });

  // A reload lands on the same form: the task is in the URL.
  await page.reload();
  await expect(page).toHaveURL(`${BASE_URL}${want}`);
  await expect(linkedTaskLine(page, open)).toBeVisible({ timeout: 20_000 });

  // Back is the browser's, and returns to the task page.
  await page.goBack();
  // The same task by its ids: the page may still have been on its bare-id URL
  // when it was opened, and only later replaced it with the canonical slug one.
  await expect
    .poll(() => new URL(page.url()).pathname)
    .toMatch(new RegExp(`^/comp/(?:[^/]*-)?${open.compId}/task/(?:[^/]*-)?${open.taskId}/?$`));
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Linked Task", {
    timeout: 20_000,
  });
});

test("a hidden competition's share key survives the trip to /submit", async ({ page }) => {
  await devLogin(page);
  await page.goto(`${BASE_URL}/comp/${hidden.compId}/task/${hidden.taskId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Linked Task", {
    timeout: 20_000,
  });

  const link = page.getByRole("main").getByRole("link", { name: "Submit track" }).first();
  await expect(link).toBeVisible({ timeout: 20_000 });
  const keyed = `${hidden.compId}_${shareKey}`;
  await expect(link).toHaveAttribute("href", `/submit?comp=${keyed}&task=${hidden.taskId}`);

  await link.click();
  await expect(page).toHaveURL(new RegExp(`/submit\\?comp=${keyed}&task=${hidden.taskId}$`));
  // The keyed id resolves the comp: the task is named, not "Selected task".
  await expect(linkedTaskLine(page, hidden)).toBeVisible({ timeout: 20_000 });
  // The organiser can still submit for a pilot, as the dialog let them: the
  // page works that out for itself, because nobody hands it over any more.
  const submittingFor = page.getByRole("button", { name: "Submitting for" });
  await expect(submittingFor).toBeVisible({ timeout: 20_000 });
  await submittingFor.click();
  await expect(page.getByText("Linda Link (open)")).toBeVisible({ timeout: 20_000 });

  await page.goBack();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Linked Task", {
    timeout: 20_000,
  });
});
