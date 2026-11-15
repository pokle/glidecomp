/**
 * Sharing a track to the installed app (issue #800), SIGNED OUT.
 *
 * On Android, a pilot who has just landed shares the IGC from XCTrack,
 * SeeYou Navigator or the Files app to GlideComp. Android POSTs it, as
 * multipart form data, to the manifest's `share_target.action`
 * (`/share-target`); the service worker (`public/sw.js`) is the only thing
 * that answers that path, stashes the file and redirects. Before #800 it
 * redirected to the account-only analysis page, so a signed-out pilot was
 * sent to sign in and the track never reached Submit track.
 *
 * The share is driven here exactly as Android sends it: a navigation that
 * POSTs multipart form data to `/share-target`. What Android adds before that
 * — matching the shared file's MIME type against the manifest's `accept`
 * list, and offering GlideComp in the share sheet at all — is held by the
 * manifest unit test (`src/share-target.test.ts`), because a browser cannot
 * be an Android share sheet.
 *
 * Every test starts on /comp, never on the analysis page: the worker used to
 * be registered by the analysis page alone, so an app installed from a comp
 * page and never opened answered a share with Pages' 405.
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { resolve, dirname } from "path";
import { readFile } from "fs/promises";
import { fileURLToPath } from "url";
import { E2E_ORGANISER, FRONTEND_URL, SUPER_ADMIN, e2eCompName } from "./fixtures/stack";

const SAMPLES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web/samples/comps/unungra-cup-2020-open-t4"
);

/** A minimal IGC the anonymous route accepts: an A record and an HFDTE. */
const PLAIN_IGC = "AXCT001Test\r\nHFDTE010126\r\n";
const PILOT_EMAIL = "share-e2e@test.local";

interface SharedFile {
  name: string;
  body: string;
  type?: string;
}

/**
 * Wait for the service worker the page registers, as Android's share would
 * meet it on an installed app.
 */
async function workerReady(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
}

/**
 * Share files to the app the way Android does: a navigation that POSTs them
 * as multipart form data to `/share-target`, field name `files`.
 */
async function share(page: Page, files: SharedFile[]): Promise<void> {
  await page.evaluate((files) => {
    const form = document.createElement("form");
    form.method = "POST";
    form.action = "/share-target";
    form.enctype = "multipart/form-data";
    const input = document.createElement("input");
    input.type = "file";
    input.name = "files";
    input.multiple = true;
    const picked = new DataTransfer();
    for (const f of files) {
      picked.items.add(
        new File([f.body], f.name, { type: f.type ?? "application/octet-stream" })
      );
    }
    input.files = picked.files;
    form.append(input);
    document.body.append(form);
    form.submit();
  }, files);
}

test.describe("sharing a track to the installed app", () => {
  test("a shared IGC opens Submit track with it chosen, and a reload keeps it", async ({
    page,
  }) => {
    await page.goto(`${FRONTEND_URL}/comp`);
    await workerReady(page);

    const igc = await readFile(resolve(SAMPLES, "ilinov_19362_121220.igc"), "utf8");
    await share(page, [{ name: "ilinov_19362_121220.igc", body: igc, type: "application/igc" }]);

    await page.waitForURL(/\/submit\?shared=1$/);
    await expect(page.getByRole("heading", { name: "Submit your track" })).toBeVisible();
    // Chosen: the file's name beside the button, which now offers to change it,
    // and the pilot the file itself names — read from the shared bytes.
    await expect(page.getByText("ilinov_19362_121220.igc")).toBeVisible();
    await expect(page.getByRole("button", { name: "Change file…" })).toBeVisible();
    await expect(page.getByText("Ilin Ilinov")).toBeVisible();

    // The share lives in the worker's cache, not in the page's memory, so a
    // reload (or Back from a page opened from this one) finds it again.
    await page.reload();
    await expect(page.getByText("ilinov_19362_121220.igc")).toBeVisible();
  });

  test("a shared task goes to the analysis page, not Submit track", async ({ page }) => {
    await page.goto(`${FRONTEND_URL}/comp`);
    await workerReady(page);

    const xctsk = await readFile(resolve(SAMPLES, "task.xctsk"), "utf8");
    await share(page, [{ name: "task.xctsk", body: xctsk, type: "application/xctsk" }]);

    // Signed out, the analysis page sends the visitor on to sign in; either
    // way the share did not land on the submit form.
    await page.waitForURL((url) => url.pathname !== "/comp");
    await expect(page).not.toHaveURL(/\/submit/);
    await expect(page).toHaveURL(/\/(analysis\.html|u\/me\/|signin)/);
  });

  test.describe("handing it in", () => {
    let admin: APIRequestContext;
    let compId: string | undefined;

    test.beforeAll(async ({ playwright }) => {
      admin = await playwright.request.newContext({ baseURL: FRONTEND_URL });
      expect((await admin.post("/api/auth/dev-login", { data: E2E_ORGANISER })).ok()).toBeTruthy();
      expect((await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN })).ok()).toBeTruthy();

      // A public comp flying today, with one pilot an anonymous upload can
      // find by email — the shape track-submission.spec.ts explains.
      const compRes = await admin.post("/api/comp", {
        data: {
          name: e2eCompName("share"),
          category: "hg",
          pilot_classes: ["open"],
          test: false,
        },
      });
      expect(compRes.ok()).toBeTruthy();
      compId = ((await compRes.json()) as { comp_id: string }).comp_id;
      expect(
        (
          await admin.patch(`/api/comp/${compId}`, {
            data: { admin_emails: [E2E_ORGANISER.email] },
          })
        ).ok()
      ).toBeTruthy();
      const taskRes = await admin.post(`/api/comp/${compId}/task`, {
        data: {
          name: "Shared Today",
          task_date: new Date().toISOString().slice(0, 10),
          pilot_classes: ["open"],
        },
      });
      expect(taskRes.ok()).toBeTruthy();
      const pilotRes = await admin.post(`/api/comp/${compId}/pilot`, {
        data: {
          registered_pilot_name: "Sharon Share",
          pilot_class: "open",
          registered_pilot_email: PILOT_EMAIL,
        },
      });
      expect(pilotRes.ok()).toBeTruthy();
    });

    test.afterAll(async () => {
      if (compId) await admin.delete(`/api/comp/${compId}`);
      await admin.dispose();
    });

    test("the shared track is submitted, and then forgotten", async ({ page }) => {
      await page.goto(`${FRONTEND_URL}/comp`);
      await workerReady(page);
      await share(page, [{ name: "shared.igc", body: PLAIN_IGC }]);
      await page.waitForURL(/\/submit\?shared=1$/);
      await expect(page.getByText("shared.igc")).toBeVisible();

      await page.getByText("Shared Today", { exact: true }).click();
      await page.getByRole("textbox", { name: "Email address" }).fill(PILOT_EMAIL);
      await page.getByRole("button", { name: "Submit track" }).click();
      await expect(page.getByText(/Track (submitted|replaced) for Sharon Share/)).toBeVisible({
        timeout: 15_000,
      });

      // Handed in, so it must not come back chosen the next time the page is
      // opened from history.
      await page.goto(`${FRONTEND_URL}/submit?shared=1`);
      await expect(page.getByRole("heading", { name: "Submit your track" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Choose IGC file…" })).toBeVisible();
      await expect(page.getByText("shared.igc")).toHaveCount(0);
    });
  });
});
