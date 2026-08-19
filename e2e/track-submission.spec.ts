/**
 * Submitting a track from the front door, end to end and SIGNED OUT.
 *
 * The whole point of the flow is that a pilot who has just landed does not
 * have to have an account, so every test here runs anonymously — which the
 * suite gives for free, since there is no shared storageState.
 *
 * The happy path needs a competition with a task dated TODAY and a pilot
 * carrying an identifier, neither of which the seeded sample comps have (their
 * tasks are dated to match their bundled tracklogs). So this creates its own
 * competition as the super admin, and removes it afterwards — see the
 * state-hygiene notes in e2e/fixtures/stack.ts.
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { resolve, dirname } from "path";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { FRONTEND_URL, SUPER_ADMIN, e2eCompName } from "./fixtures/stack";

/**
 * A tracklog with REAL fixes, and the route it was flown on.
 *
 * It has to be a file with B records: track quality assesses fixes, so a
 * header-only stub (which several bundled samples are — corryong's are
 * airScore-generated and carry none) is silently not assessed at all, and a
 * test written against one would pass no matter what the code did.
 *
 * Flown 12 December 2020 at Unungra. Uploading it against a task dated
 * yesterday is the same place on the wrong day, which is exactly one HARD
 * finding and nothing else.
 */
const SAMPLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web/samples/comps/unungra-cup-2020-open-t4"
);
const SAMPLE_IGC = resolve(SAMPLES, "ilinov_19362_121220.igc");
const SAMPLE_XCTSK = resolve(SAMPLES, "task.xctsk");

const BASE_URL = FRONTEND_URL;

/** Sign a browser page in as the super admin. Cookie plumbing as elsewhere. */
async function devLogin(page: Page): Promise<void> {
  const res = await page.request.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  if (!res.ok()) throw new Error(`Dev login failed: ${res.status()}`);
  const setCookie = res.headers()["set-cookie"];
  const token = setCookie?.match(/better-auth\.session_token=([^;]+)/)?.[1];
  if (token) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: token, domain: "localhost", path: "/" },
    ]);
  }
}

/** A minimal valid gzip IGC: manufacturer record + HFDTE, as the worker tests use. */
const FAKE_IGC_GZ = Buffer.from([
  0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x73, 0x8c, 0x70,
  0x0e, 0x31, 0x30, 0x30, 0x0c, 0x49, 0x2d, 0x2e, 0xe1, 0xe5, 0xf2, 0x70, 0x73,
  0x09, 0x71, 0x35, 0x30, 0x34, 0x30, 0x34, 0x32, 0xe3, 0xe5, 0x02, 0x00, 0x19,
  0xac, 0x90, 0xbb, 0x1a, 0x00, 0x00, 0x00,
]);

/**
 * The same file uncompressed, for the browser to pick: the form gzips what the
 * pilot chooses, so it must be handed plain IGC text, not the payload above.
 * Minimal SEC-04 shape — an A record and an HFDTE.
 */
const PLAIN_IGC = "AXCT001Test\r\nHFDTE010126\r\n";

const CIVL_ID = "e2e-9931";
const PILOT_EMAIL = "jane-e2e@test.local";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function yesterday(): string {
  return new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
}

/**
 * Choose a task in the picker by clicking its visible name.
 *
 * NOT `getByRole("radio").check()`. The kit hides the real input under a
 * styled span, so `check()` waits forever for it to become visible — unless
 * the radio is ALREADY selected, in which case it returns immediately without
 * clicking anything, which is how a test can appear to drive the picker while
 * doing nothing at all. RAC wraps each radio in a real <label>, so clicking
 * the name is both what a person does and what actually works.
 */
async function pickTask(page: Page, name: string): Promise<void> {
  await page.getByText(name, { exact: true }).click();
}

interface Fixture {
  compId: string;
  compName: string;
  taskId: string;
}

/**
 * A competition flying today, with one registered pilot who has a CIVL ID and
 * no linked account — the shape an organiser's spreadsheet import produces,
 * and the shape anonymous submission has to work against.
 */
async function createFixture(admin: APIRequestContext): Promise<Fixture> {
  const compName = e2eCompName("submit");
  const compRes = await admin.post("/api/comp", {
    data: { name: compName, category: "hg", pilot_classes: ["open"] },
  });
  expect(compRes.ok()).toBeTruthy();
  const { comp_id: compId } = (await compRes.json()) as { comp_id: string };

  // Created oldest-first ON PURPOSE, so the picker's most-recent-first order
  // is the endpoint's doing and not the insertion order leaking through.
  const olderRes = await admin.post(`/api/comp/${compId}/task`, {
    data: { name: "Yesterday's Task", task_date: yesterday(), pilot_classes: ["open"] },
  });
  expect(olderRes.ok()).toBeTruthy();

  const taskRes = await admin.post(`/api/comp/${compId}/task`, {
    data: { name: "Today's Task", task_date: today(), pilot_classes: ["open"] },
  });
  expect(taskRes.ok()).toBeTruthy();
  const { task_id: taskId } = (await taskRes.json()) as { task_id: string };

  const pilotRes = await admin.post(`/api/comp/${compId}/pilot`, {
    data: {
      registered_pilot_name: "Jane E2E",
      pilot_class: "open",
      registered_pilot_civl_id: CIVL_ID,
      registered_pilot_email: PILOT_EMAIL,
    },
  });
  expect(pilotRes.ok()).toBeTruthy();

  return { compId, compName, taskId };
}

test.describe("submitting a track without an account", () => {
  let admin: APIRequestContext;
  let fixture: Fixture;

  test.beforeAll(async ({ playwright }) => {
    // Dev-login as the super admin, who administers every comp. Same plumbing
    // as comp-detail.spec.ts; the context keeps the session cookie for us.
    admin = await playwright.request.newContext({ baseURL: FRONTEND_URL });
    const signIn = await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN });
    expect(signIn.ok(), "super admin dev-login").toBeTruthy();
    fixture = await createFixture(admin);
  });

  test.afterAll(async () => {
    if (fixture?.compId) {
      await admin.delete(`/api/comp/${fixture.compId}`);
    }
    await admin.dispose();
  });

  test("submitting is reachable from the nav on every page", async ({ page }) => {
    await page.goto(BASE_URL);
    // A plain anchor, not a scripted button: these pages are prerendered and
    // must stay useful with JS off.
    //
    // Explicit timeout because this is the FIRST test to hit `/`, and in dev
    // that page is compiled on demand by the Astro server — the default 5s is
    // the Astro cold start, not the assertion. It passes in 3s warm and has
    // failed at 5s cold.
    await expect(page.locator('nav a[href="/submit"]')).toBeVisible({
      timeout: 20_000,
    });
    // Deliberately NOT a third hero call to action — the nav carries it.
    await expect(page.locator('.hero-cta a[href="/submit"]')).toHaveCount(0);
  });

  test("a linked task names itself, and can still be changed", async ({ page }) => {
    // /submit?comp=&task= is the QR-code-on-the-hill case. It arrives as two
    // sqids, and used to render "Selected task" — which is precisely the
    // failure the step exists to prevent.
    await page.goto(
      `${BASE_URL}/submit?comp=${fixture.compId}&task=${fixture.taskId}`
    );
    // Positive assertion FIRST: it is the one that waits. Asserting the
    // absence of "Selected task" up front would pass on the placeholder that
    // is legitimately on screen for the moment before the lookup lands.
    await expect(
      page.getByText(new RegExp(`Today's Task.*${fixture.compName}`))
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Selected task")).toHaveCount(0);

    // And Change opens a list that has actually loaded. It used to sit on
    // "Finding competitions flying now…" for good, because the prefill made
    // the fetch return early.
    await page.getByRole("button", { name: "Change" }).click();
    const group = page.getByRole("radiogroup", { name: "Which task did you fly?" });
    await expect(group.getByRole("radio", { name: /Today's Task/ })).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText("Finding competitions flying now")).toHaveCount(0);
  });

  test("preselects the task flying today", async ({ page }) => {
    await page.goto(`${BASE_URL}/submit`);
    await expect(page.getByRole("heading", { name: "Submit your track" })).toBeVisible();
    // One choice out of a small visible set, so it is a radio group — and the
    // commonest answer is already made, because most pilots submit on the day.
    const todaysTask = page.getByRole("radio", { name: /Today's Task/ });
    await expect(todaysTask).toBeVisible();
    await expect(todaysTask).toBeChecked();
  });

  test("lists the most recent task at the top", async ({ page }) => {
    await page.goto(`${BASE_URL}/submit`);
    const group = page.getByRole("radiogroup", { name: "Which task did you fly?" });
    await expect(group.getByRole("radio").first()).toHaveAccessibleName(
      /Today's Task/
    );
    // Both are there — this is an order assertion, not a filter one.
    await expect(group.getByRole("radio", { name: /Yesterday's Task/ })).toBeVisible();
  });

  test("choosing a task does not take the other choices away", async ({ page }) => {
    // The picker is a list you can look at, not a modal that answers once and
    // shuts. Confirming your choice against the dates either side is the whole
    // reason the dates are printed.
    await page.goto(`${BASE_URL}/submit`);
    const group = page.getByRole("radiogroup", { name: "Which task did you fly?" });

    await pickTask(page, "Yesterday's Task");

    // Still on screen, with no Change button standing between the pilot and it.
    await expect(group.getByRole("radio", { name: /Today's Task/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Change" })).toHaveCount(0);

    // And changing your mind is one tap, not two.
    await pickTask(page, "Today's Task");
    await expect(group.getByRole("radio", { name: /Today's Task/ })).toBeChecked();
    await expect(
      group.getByRole("radio", { name: /Yesterday's Task/ })
    ).not.toBeChecked();
  });

  test("names the pilot class when the task title does not", async ({ page }) => {
    await page.goto(`${BASE_URL}/submit`);
    // The fixture task is "Today's Task" for class "open" — the title never
    // says "open", so the picker has to.
    await expect(page.getByRole("radio", { name: /Today's Task.*open/ })).toBeVisible();
  });

  test("accepts a track and reports what it received", async ({ request }) => {
    // The upload itself goes through the API: a FileTrigger cannot be driven
    // by a synthetic click, and what matters here is the contract the page
    // renders from.
    const res = await request.post(
      `/api/comp/${fixture.compId}/task/${fixture.taskId}/igc/open-submit`,
      {
        headers: {
          "x-pilot-ident-kind": "civl_id",
          "x-pilot-ident": CIVL_ID,
          "content-type": "application/octet-stream",
        },
        data: FAKE_IGC_GZ,
      }
    );
    expect(res.status()).toBe(201);
    const body = (await res.json()) as Record<string, any>;

    // Filed against the roster pilot, and says so — the pilot has to be able
    // to check they are not about to walk away having submitted as someone else.
    expect(body.pilot_name).toBe("Jane E2E");
    expect(body.matched_on).toBe("civl_id");
    // Enough about the flight to notice a wrong file before scoring runs.
    expect(body.flight_summary).not.toBeNull();
    expect(body.flight_summary.flight_date).toBe("2026-01-01");

    // And the track is on file, publicly, against that pilot. Asserted on the
    // track list rather than the rendered task page: this fixture task has no
    // route, so there is nothing for the page to score or show — the durable
    // fact is the submission itself.
    const tracks = await request.get(
      `/api/comp/${fixture.compId}/task/${fixture.taskId}/igc`
    );
    expect(tracks.ok()).toBeTruthy();
    const { tracks: list } = (await tracks.json()) as {
      tracks: { pilot_name: string; uploaded_by_name: string; active: boolean }[];
    };
    const mine = list.find((t) => t.pilot_name === "Jane E2E");
    expect(mine, "the anonymous submission is listed").toBeTruthy();
    expect(mine!.active).toBe(true);
    // Attributed honestly: there is no account to name.
    expect(mine!.uploaded_by_name).toBe("anonymous submission");
  });

  test("a pilot can submit through the page itself, and is shown the flight", async ({
    page,
  }) => {
    // The one test that exercises what a pilot actually does: pick the task,
    // say who they are, choose a file, press the button. Everything else in
    // this file tests a layer underneath, and a layer underneath can be
    // perfectly correct while the form is wired to nothing.
    await page.goto(`${BASE_URL}/submit`);

    await pickTask(page, "Today's Task");

    // Email is the default kind, so this is the path with no dropdown to
    // drive — the kind selector's options are asserted separately below.
    await page.getByRole("textbox", { name: "Email address" }).fill(PILOT_EMAIL);

    // FileTrigger keeps a real (hidden) input, which is the only handle a
    // synthetic click cannot fake but setInputFiles can drive.
    await page.locator('input[type="file"]').setInputFiles({
      name: "forged.igc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(PLAIN_IGC),
    });
    await expect(page.getByText("forged.igc")).toBeVisible();

    await page.getByRole("button", { name: "Submit track" }).click();

    // The summary is the whole point of the success state: it is where a
    // pilot notices they sent the wrong file.
    await expect(page.getByText(/Track (submitted|replaced) for Jane E2E/)).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText("2026-01-01")).toBeVisible(); // the file's own date
    await expect(
      page.getByRole("link", { name: "View provisional score card" })
    ).toBeVisible();
    // One destination, not two that look alike. The task page is a click on
    // from the report card for anyone who wants it.
    await expect(page.getByRole("link", { name: "Go to the task" })).toHaveCount(0);
  });

  test("a wrong identifier is shown in the page with a way to fix it", async ({
    page,
  }) => {
    await page.goto(`${BASE_URL}/submit`);
    await pickTask(page, "Today's Task");
    await page.getByRole("textbox", { name: "Email address" }).fill("nobody@nowhere.test");
    await page.locator('input[type="file"]').setInputFiles({
      name: "forged.igc",
      mimeType: "application/octet-stream",
      buffer: Buffer.from(PLAIN_IGC),
    });
    await page.getByRole("button", { name: "Submit track" }).click();

    await expect(page.getByText("We could not accept that track")).toBeVisible({
      timeout: 15_000,
    });
    // The organiser's address has to be a real mailto, not prose about one.
    await expect(page.locator('a[href^="mailto:"]')).toBeVisible();
  });

  test("an unknown identifier names the comp and the organiser to email", async ({
    request,
  }) => {
    const res = await request.post(
      `/api/comp/${fixture.compId}/task/${fixture.taskId}/igc/open-submit`,
      {
        headers: {
          "x-pilot-ident-kind": "civl_id",
          "x-pilot-ident": "not-a-real-id",
          "content-type": "application/octet-stream",
        },
        data: FAKE_IGC_GZ,
      }
    );
    expect(res.status()).toBe(404);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("no_pilot_match");
    // The pilot cannot fix a roster; the organiser can, so the answer has to be
    // able to reach them — the same name + mailto the comp page already shows.
    expect(body.comp.name).toBe(fixture.compName);
    expect(body.organisers.length).toBeGreaterThan(0);
    expect(body.organisers[0].email).toContain("@");
  });

  test("a name is never accepted as an identifier", async ({ request }) => {
    // Two people share a name, and names are on the public roster — matching
    // on one would mean typing nothing an attacker cannot already see.
    const res = await request.post(
      `/api/comp/${fixture.compId}/task/${fixture.taskId}/igc/open-submit`,
      {
        headers: {
          "x-pilot-ident-kind": "name",
          "x-pilot-ident": "Jane%20E2E",
          "content-type": "application/octet-stream",
        },
        data: FAKE_IGC_GZ,
      }
    );
    expect(res.status()).toBe(400);
    const body = (await res.json()) as Record<string, any>;
    expect(body.code).toBe("bad_identifier");
    expect(body.accepted_kinds).not.toContain("name");
  });

  test("lists the competition as open right now", async ({ request }) => {
    const res = await request.get("/api/comp/open-now");
    expect(res.ok()).toBeTruthy();
    expect(res.headers()["cache-control"]).toBe("public, max-age=60");
    const body = (await res.json()) as {
      window: { today: string };
      comps: { comp_id: string; suggested_task_id: string }[];
    };
    expect(body.window.today).toBe(today());
    const mine = body.comps.find((c) => c.comp_id === fixture.compId);
    expect(mine, "the comp flying today is listed").toBeTruthy();
    expect(mine!.suggested_task_id).toBe(fixture.taskId);
  });

  test("the organiser can close registration from the settings pages", async ({
    page,
  }) => {
    // Worth an e2e rather than a unit test: the risk is a checkbox that
    // renders but is not wired to the save, which only a real click finds.
    await devLogin(page);
    await page.goto(`${BASE_URL}/comp/${fixture.compId}/settings/access`);
    await expect(page.getByRole("heading", { name: "Access" })).toBeVisible({
      timeout: 15_000,
    });

    const box = page.getByLabel("Let pilots register themselves by submitting a track");
    await expect(box).toBeChecked(); // on by default, as the migration sets it
    // Click the visible label, not the input: the kit hides the real checkbox
    // under a styled span, so that is both what a person clicks and the only
    // thing Playwright can reach.
    await page
      .getByText("Let pilots register themselves by submitting a track")
      .click();
    await expect(box).not.toBeChecked();
    await page.getByRole("button", { name: /^Save/ }).click();

    await expect
      .poll(async () => {
        const res = await page.request.get(`/api/comp/${fixture.compId}`);
        return ((await res.json()) as { open_registration: boolean }).open_registration;
      })
      .toBe(false);

    // And the roster says so, which is the whole point of surfacing it there.
    await page.goto(`${BASE_URL}/comp/${fixture.compId}/pilots`);
    await expect(page.getByText("Registration closed")).toBeVisible();

    // Put it back so the rest of the file's expectations still hold.
    await page.request.patch(`/api/comp/${fixture.compId}`, {
      data: { open_registration: true },
    });
  });

  test("the score card waits rather than saying the pilot has no score", async ({
    page,
  }) => {
    // Straight after an upload the served score blob is the STALE pre-upload
    // one, which does not contain the new pilot. Telling somebody who has just
    // submitted that their score cannot be found reads as "your track did not
    // go in" — the worst answer available.
    //
    // That window is milliseconds wide in practice, so it cannot be produced
    // by racing the real revalidation. Intercepting the score response is the
    // only way to pin the behaviour deterministically.
    // A routed task with a real scored field — the report card refuses a
    // routeless task before it ever looks at the scores.
    const comps = (await (await admin.get("/api/comp")).json()) as {
      comps: { comp_id: string; test: boolean }[];
    };
    let target: { compId: string; taskId: string; pilotId: string } | null = null;
    for (const comp of comps.comps.filter((c) => !c.test)) {
      const detail = (await (await admin.get(`/api/comp/${comp.comp_id}`)).json()) as {
        tasks: { task_id: string; has_xctsk: boolean }[];
      };
      for (const t of detail.tasks.filter((t) => t.has_xctsk)) {
        const score = (await (
          await admin.get(`/api/comp/${comp.comp_id}/task/${t.task_id}/score`)
        ).json()) as { class_scores?: { pilots: { comp_pilot_id: string }[] }[] };
        const pilot = score.class_scores?.[0]?.pilots?.[0];
        if (pilot) {
          target = {
            compId: comp.comp_id,
            taskId: t.task_id,
            pilotId: pilot.comp_pilot_id,
          };
          break;
        }
      }
      if (target) break;
    }
    expect(target, "a seeded comp with a scored task — run `bun run seed`").toBeTruthy();

    // Serve a STALE score body that does not contain this pilot: exactly the
    // state the store is in for the moment after an upload. Intercepting is
    // the only way to hold that window open — racing the real revalidation
    // would be a flake, not a test.
    await page.route("**/api/comp/*/task/*/score*", async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as Record<string, unknown>;
      await route.fulfill({ response: res, json: { ...body, stale: true, class_scores: [] } });
    });

    await page.goto(
      `${BASE_URL}/comp/${target!.compId}/task/${target!.taskId}/pilot/${target!.pilotId}`
    );

    await expect(page.getByText(/Working out the scores/)).toBeVisible({
      timeout: 15_000,
    });
    // And a way out, so nobody is stranded on a spinner.
    await expect(page.getByRole("link", { name: "Go to the task" })).toBeVisible();
    // Emphatically NOT the dead end this replaced.
    await expect(page.getByText("No score found for this pilot")).toHaveCount(0);
  });

  test.describe("the organiser's own upload, from the manage grid", () => {
    // TaskScoresAdmin has its own upload path — no dialog, no shared form, a
    // FileTrigger straight onto the per-pilot endpoint. It had no test of any
    // kind, and had drifted: an invented 5 MB check on the UNCOMPRESSED file,
    // against a server that caps 2 MB decompressed.

    // The grid refuses to manage a task that cannot be scored, so it needs a
    // ROUTED task — the flow's own fixture task deliberately has none. Dated
    // yesterday so it never displaces "Today's Task" as the comp's suggestion,
    // which the picker tests above rely on.
    let gridTaskId: string;

    test.beforeAll(async () => {
      const xctsk = JSON.parse(await readFile(SAMPLE_XCTSK, "utf8")) as unknown;
      const res = await admin.post(`/api/comp/${fixture.compId}/task`, {
        data: {
          name: "Routed Task",
          task_date: yesterday(),
          pilot_classes: ["open"],
          xctsk,
        },
      });
      expect(res.ok(), "routed task for the manage grid").toBeTruthy();
      gridTaskId = ((await res.json()) as { task_id: string }).task_id;
    });

    /** Open the task page as an admin and wait for the grid to mount. */
    async function openGrid(page: Page): Promise<void> {
      await devLogin(page);
      await page.goto(`${BASE_URL}/comp/${fixture.compId}/task/${gridTaskId}`);
      // The grid mounts only after the admin check resolves, so sync on the
      // row's own control rather than on the page.
      await expect(page.getByRole("button", { name: /Upload track/ })).toBeVisible({
        timeout: 20_000,
      });
    }

    test("an oversized tracklog is refused here, with the limit and a remedy", async ({
      page,
    }) => {
      await openGrid(page);

      // 3 MB of IGC: an ordinary all-day flight at 1 Hz. It gzips to well
      // under the compressed cap, so only the decompressed cap catches it —
      // and the old 5 MB rule waved it straight through to a bare 400.
      const padding = "LPLT padding to make this a realistically long tracklog\r\n";
      const big = PLAIN_IGC + padding.repeat(Math.ceil((3 * 1024 * 1024) / padding.length));
      expect(big.length).toBeGreaterThan(3 * 1024 * 1024);

      // Nothing may reach the server: being told at the door is the point.
      let posted = 0;
      await page.route("**/api/comp/*/task/*/igc/*", async (route) => {
        posted += 1;
        await route.abort();
      });

      await page.locator('input[type="file"]').setInputFiles({
        name: "all-day.igc",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(big),
      });

      await expect(page.getByText(/over the 2 MB limit/)).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText(/Trim it to the flight/)).toBeVisible();
      expect(posted, "the file must not have been sent").toBe(0);
    });

    test("a track that will not be scored is not announced as a success", async ({
      page,
    }) => {
      await openGrid(page);

      // A real tracklog with B records, flown on 5 January — the fixture task
      // is dated today, so track quality HARD fails it on the wrong day and
      // the file is stored but withheld from scoring. The pilot it belongs to
      // is not on this screen, so the organiser is the only person who can
      // notice, and "Track uploaded" alone tells them the opposite.
      await page.locator('input[type="file"]').setInputFiles(SAMPLE_IGC);

      await expect(page.getByText(/will not be scored/)).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText(/Track uploaded for Jane E2E$/)).toHaveCount(0);
    });
  });

  test.describe("closing one task for submissions", () => {
    // A task-level stop, distinct from the comp's close_date. The risk worth
    // an e2e is a checkbox that renders but is not wired to the save, and a
    // page that keeps offering a button the server will refuse.

    test("the organiser closes it, and the task stops taking tracks", async ({
      page,
    }) => {
      await devLogin(page);
      await page.goto(`${BASE_URL}/comp/${fixture.compId}/task/${fixture.taskId}`);

      const settings = page.getByRole("button", { name: "Settings", exact: true });
      await expect(settings).toBeVisible({ timeout: 20_000 });
      await settings.click();

      const box = page.getByLabel("Closed for track submissions");
      await expect(box).not.toBeChecked(); // default 0, as the migration sets
      // The kit hides the real checkbox under a styled span, so the visible
      // label is both what a person clicks and the only thing Playwright can.
      await page.getByText("Closed for track submissions").click();
      await expect(box).toBeChecked();
      await page.getByRole("button", { name: /^Save/ }).click();

      await expect
        .poll(
          async () => {
            const res = await page.request.get(
              `/api/comp/${fixture.compId}/task/${fixture.taskId}`
            );
            return ((await res.json()) as { submissions_closed: boolean })
              .submissions_closed;
          },
          { timeout: 15_000 }
        )
        .toBe(true);

      // Said above the fold, so a pilot learns before choosing a file.
      await expect(page.getByText("Submissions closed")).toBeVisible();

      // A signed-OUT visitor gets the sentence, not a button that would 403.
      const visitor = await page.context().browser()!.newContext();
      const visitorPage = await visitor.newPage();
      await visitorPage.goto(
        `${BASE_URL}/comp/${fixture.compId}/task/${fixture.taskId}`
      );
      await expect(
        visitorPage.getByText("Submissions for this task are closed.")
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        visitorPage.getByRole("button", { name: "Submit track" })
      ).toHaveCount(0);

      // And /submit stops offering it — the only user-side coverage of the
      // open-now SQL change.
      await visitorPage.goto(`${BASE_URL}/submit`);
      await expect(
        visitorPage.getByRole("radiogroup", { name: "Which task did you fly?" })
      ).toBeVisible({ timeout: 20_000 });
      await expect(
        visitorPage.getByRole("radio", { name: /Today's Task/ })
      ).toHaveCount(0);
      await visitor.close();

      // The organiser still can — the stop is aimed at pilots, not at them.
      await expect(
        page.getByRole("button", { name: "Submit track" }).first()
      ).toBeVisible();

      // Put it back so the rest of the file's expectations still hold — and
      // CHECK that it went back. This task is shared with the test below,
      // which asserts the Submit button is offered; a silently failed restore
      // would surface there instead of here, as a mystery.
      const reopen = await page.request.patch(
        `/api/comp/${fixture.compId}/task/${fixture.taskId}`,
        { data: { submissions_closed: false } }
      );
      expect(reopen.ok(), "reopened the task for the tests that follow").toBeTruthy();
    });
  });

  test.describe("which registration is this?", () => {
    // A signed-in pilot whose account matches nothing on the roster used to be
    // given a SECOND entry, silently. Now they are asked.

    let strangerCompId: string;
    let strangerTaskId: string;

    test.beforeAll(async () => {
      // Its own comp: the shared fixture's roster would otherwise change
      // under the anonymous tests above.
      const compRes = await admin.post("/api/comp", {
        data: { name: e2eCompName("claim"), category: "hg", pilot_classes: ["open"] },
      });
      const { comp_id } = (await compRes.json()) as { comp_id: string };
      strangerCompId = comp_id;

      const taskRes = await admin.post(`/api/comp/${comp_id}/task`, {
        data: { name: "Claim Task", task_date: today(), pilot_classes: ["open"] },
      });
      strangerTaskId = ((await taskRes.json()) as { task_id: string }).task_id;

      // Registered with an address that is nobody's account — the mistyped
      // email at the heart of the whole problem.
      await admin.post(`/api/comp/${comp_id}/pilot`, {
        data: {
          registered_pilot_name: "Mistyped Pilot",
          pilot_class: "open",
          registered_pilot_email: "mistyped@nowhere.invalid",
        },
      });
    });

    test.afterAll(async () => {
      if (strangerCompId) await admin.delete(`/api/comp/${strangerCompId}`);
    });

    test("asks the pilot instead of quietly making a second entry", async ({
      page,
    }) => {
      await devLogin(page);
      await page.goto(
        `${BASE_URL}/submit?comp=${strangerCompId}&task=${strangerTaskId}`
      );

      // The question is asked while they are still choosing a file, not after
      // they press Submit.
      const group = page.getByRole("radiogroup", {
        name: "Which registration are you?",
      });
      await expect(group).toBeVisible({ timeout: 20_000 });
      await expect(
        group.getByRole("radio", { name: /Mistyped Pilot/ })
      ).toBeVisible();
      // The escape hatch is offered too, and nothing is preselected — a
      // preselected candidate is how a track gets filed against a stranger.
      await expect(
        group.getByRole("radio", { name: /None of these/ })
      ).toBeVisible();
      for (const r of await group.getByRole("radio").all()) {
        await expect(r).not.toBeChecked();
      }

      // And the promise about the audit log and the email is made UPFRONT.
      await expect(
        page.getByText(/recorded in the competition's public activity log/)
      ).toBeVisible();

      // Choosing the registration files the track against it — the roster
      // does not grow, which is the entire point.
      await page.getByText("Mistyped Pilot", { exact: true }).click();
      await page.locator('input[type="file"]').setInputFiles({
        name: "claimed.igc",
        mimeType: "application/octet-stream",
        buffer: Buffer.from(PLAIN_IGC),
      });
      await page.getByRole("button", { name: "Submit track" }).click();

      await expect(
        page.getByText(/Track (submitted|replaced) for Mistyped Pilot/)
      ).toBeVisible({ timeout: 20_000 });

      const roster = (await (
        await admin.get(`/api/comp/${strangerCompId}/pilot`)
      ).json()) as { pilots: unknown[] };
      expect(roster.pilots, "no duplicate registration").toHaveLength(1);
    });
  });

  test("the task page offers Submit track to a signed-out visitor", async ({ page }) => {
    await page.goto(`${BASE_URL}/comp/${fixture.compId}/task/${fixture.taskId}`);
    // This used to read "Sign in to submit your track".
    //
    // The explicit timeout is not padding. This page is server-rendered and
    // the button is behind the `mounted` gate, so it is legitimately absent
    // on first paint — the assertion is waiting for hydration, not for a
    // render. On the default 5s this failed on CI at 6.2s while every
    // neighbouring assertion in this file already used 15-20s.
    await expect(
      page.getByRole("button", { name: "Submit track" }).first()
    ).toBeVisible({ timeout: 20_000 });
  });
});
