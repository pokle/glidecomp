/**
 * Comp waypoints page (/comp/:id/waypoints) — interaction coverage for its
 * RAC + Tabulator surfaces (converted 2026-07-21, see
 * docs/2026-07-18-rac-adoption-guide.md):
 *
 * - Admins get an inline **Tabulator** editable grid (the app's standard for
 *   editable tables — Tabulator policy). Cell edits mirror into React state
 *   (the "N waypoints" count, dirty Save button, coordinate validation).
 * - Anonymous visitors get the read-only RAC table instead.
 * - The device-export panel (RAC Menu of download formats, QR toggle, swap
 *   checkbox) and the RAC Add-waypoint dialog.
 * - One save round-trip against the real API, restored afterwards from the
 *   captured original so the seeded comp is left exactly as found.
 *
 * Drives the seeded "Corryong Cup 2026" sample comp. Every test except the
 * save round-trip is mutation-free (trackMutations pattern from
 * comp-detail.spec.ts); the round-trip restores via API in a finally block.
 *
 * RAC/Tabulator testing gotchas honoured here (rac-adoption-guide):
 * - Never wait on "networkidle" (freshness pollers elsewhere; DOM waits only).
 * - RAC checkboxes can't be *clicked* by role — the real input is visually
 *   hidden. Click the label text, assert by role (gotcha #13).
 * - The Tabulator grid renders rows virtually: only visible rows exist in the
 *   DOM, so counts are asserted via the page's "N waypoints" line (React
 *   state), not by counting .tabulator-row elements.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page, type Locator } from "@playwright/test";

const BASE_URL = "http://localhost:3000";
const COMP_NAME = "Corryong Cup 2026";
const SUPER_ADMIN = { name: "Tushar Pokle", email: "tushar.pokle@gmail.com" };

interface Waypoint {
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  altitude: number;
  radius: number;
}

let compId: string;
let waypoints: Waypoint[];

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
    execSync("bun run seed corryong-cup-2026", {
      stdio: "inherit",
      timeout: 240_000,
    });
    id = await findComp();
  }
  if (!id) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);
  compId = id;

  const wpRes = await api.get(`/api/comp/${compId}/waypoints`);
  expect(wpRes.ok()).toBe(true);
  waypoints = ((await wpRes.json()) as { waypoints: Waypoint[] }).waypoints;
  // The seed builds the comp waypoint set as the union of task turnpoints —
  // a seeded comp always has some.
  expect(waypoints.length).toBeGreaterThan(0);

  await api.dispose();
});

/**
 * Dev-login as the super-admin and open the waypoints page. Same cookie
 * plumbing as comp-detail.spec.ts.
 */
test.beforeEach(async ({ page }) => {
  const loginRes = await page.request.post("/api/auth/dev-login", {
    data: SUPER_ADMIN,
  });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(
      `Dev login failed: ${loginRes.status()} ${loginRes.statusText()} — ${body}`
    );
  }
  const setCookieHeader = loginRes.headers()["set-cookie"];
  if (setCookieHeader) {
    const tokenMatch = setCookieHeader.match(/better-auth\.session_token=([^;]+)/);
    if (tokenMatch) {
      await page.context().addCookies([
        {
          name: "better-auth.session_token",
          value: tokenMatch[1],
          domain: "localhost",
          path: "/",
        },
      ]);
    }
  }

  await page.goto(`/comp/${compId}/waypoints`);
  await expect(page.getByRole("heading", { level: 1, name: "Waypoints" })).toBeVisible();
  // Admin affordances appear once /api/auth/me + the comp fetch resolve — the
  // Upload button is the sync point that the admin view is active.
  await expect(page.getByRole("button", { name: "Upload file" })).toBeVisible({
    timeout: 15_000,
  });
});

/** Watches for any mutating call to the competition API for the page's life. */
function trackMutations(page: Page): () => boolean {
  let mutated = false;
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/comp")) mutated = true;
  });
  return () => mutated;
}

/** The (lazy-loaded) Tabulator grid's first row, once it has built. */
async function firstGridRow(page: Page): Promise<Locator> {
  const row = page.locator(".gc-grid .tabulator-row").first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

/** Commit a value into a Tabulator input-editor cell (click → type → Enter). */
async function editCell(cell: Locator, value: string) {
  await cell.click();
  const editor = cell.locator("input");
  await expect(editor).toBeVisible();
  await editor.fill(value);
  await editor.press("Enter");
}

test("admin grid: Tabulator builds, edits mirror to state, bad coords block save", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  const firstRow = await firstGridRow(page);
  // The admin view is the Tabulator grid — the read-only RAC table is gone.
  await expect(page.getByRole("grid", { name: "Waypoints" })).toHaveCount(0);
  // React state drives the count line and the pristine Save button.
  await expect(page.getByText(`${waypoints.length} waypoints`)).toBeVisible();
  const saveButton = page.getByRole("button", { name: /^(Save|Saved)$/ });
  await expect(saveButton).toHaveText("Saved");
  await expect(saveButton).toBeDisabled();

  // An in-grid edit mirrors into React state: the Save button turns dirty.
  await editCell(firstRow.locator('[tabulator-field="name"]'), "E2E Waypoint");
  await expect(firstRow.locator('[tabulator-field="name"]')).toHaveText("E2E Waypoint");
  await expect(saveButton).toHaveText("Save");
  await expect(saveButton).toBeEnabled();

  // Garbage coordinates flag the cell and the count line…
  const coordsCell = firstRow.locator('[tabulator-field="coords"]');
  await editCell(coordsCell, "not coordinates");
  await expect(coordsCell).toHaveClass(/gc-cell-invalid/);
  await expect(page.getByText("1 need valid coordinates")).toBeVisible();

  // …and Save refuses (client-side) instead of PUTting bad data.
  await saveButton.click();
  await expect(
    page.getByText("Every waypoint needs valid coordinates before saving")
  ).toBeVisible();

  expect(mutated()).toBe(false);
});

test("remove a row and add one via the RAC dialog (nothing saved)", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  const firstRow = await firstGridRow(page);
  const firstCode = (
    await firstRow.locator('[tabulator-field="code"]').innerText()
  ).trim();

  // Remove the first row: the count line (React state) drops by one.
  await firstRow.locator('span[title="Remove waypoint"]').click();
  await expect(page.getByText(`${waypoints.length - 1} waypoints`)).toBeVisible();
  await expect(
    page.locator('.gc-grid .tabulator-row [tabulator-field="code"]').first()
  ).not.toHaveText(firstCode);

  // Add a waypoint through the shared RAC dialog. Nothing joins the API until
  // Save — this stays a client-side row.
  await page.getByRole("button", { name: "Add waypoint" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Add waypoint" })).toBeVisible();
  await dialog.getByRole("textbox", { name: "Code" }).fill("E2E1");
  await dialog
    .getByRole("textbox", { name: "Coordinates (lat, lon)" })
    .fill("-36.5, 148.2");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  // Back to the original count, and the grid scrolled the new row into view.
  await expect(page.getByText(`${waypoints.length} waypoints`)).toBeVisible();
  await expect(
    page.locator('.gc-grid .tabulator-row [tabulator-field="code"]', {
      hasText: "E2E1",
    })
  ).toBeVisible();

  expect(mutated()).toBe(false);
});

test("save round-trip persists an edit, restore leaves the comp as found", async ({
  page,
}) => {
  // Capture the original set so the finally block can put it back verbatim.
  const origRes = await page.request.get(`/api/comp/${compId}/waypoints`);
  expect(origRes.ok()).toBe(true);
  const original = (await origRes.json()) as { waypoints: Waypoint[] };

  try {
    const firstRow = await firstGridRow(page);
    await editCell(firstRow.locator('[tabulator-field="name"]'), "E2E Renamed");

    const putDone = page.waitForResponse(
      (r) => r.url().includes("/waypoints") && r.request().method() === "PUT"
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    expect((await putDone).ok()).toBe(true);
    const saveButton = page.getByRole("button", { name: /^(Save|Saved)$/ });
    await expect(saveButton).toHaveText("Saved");
    await expect(saveButton).toBeDisabled();

    // A reload proves it persisted (the grid rebuilds from the API).
    await page.reload();
    const reloadedRow = await firstGridRow(page);
    await expect(reloadedRow.locator('[tabulator-field="name"]')).toHaveText(
      "E2E Renamed"
    );
  } finally {
    const restore = await page.request.put(`/api/comp/${compId}/waypoints`, {
      data: { waypoints: original.waypoints },
    });
    expect(restore.ok()).toBe(true);
  }
});

test("device export: download menu lists every format, QR + swap toggle", async ({
  page,
}) => {
  const mutated = trackMutations(page);

  // Desktop (fine pointer) shows the client-side "Download" menu.
  await page.getByRole("button", { name: "Download waypoints" }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  // All 8 engine export formats (WAYPOINT_EXPORT_FORMATS).
  await expect(menu.getByRole("menuitem")).toHaveCount(8);
  await expect(menu.getByRole("menuitem", { name: "SeeYou (.cup)" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // QR toggles on (caption + code render) and off again.
  await page.getByRole("button", { name: "QR code" }).click();
  await expect(page.getByText(/Scan with XCTrack, Flyskyhy/)).toBeVisible();
  await page.getByRole("button", { name: "Hide QR" }).click();
  await expect(page.getByText(/Scan with XCTrack, Flyskyhy/)).toHaveCount(0);

  // Swap checkbox: click the label text, read state by role (gotcha #13).
  const swap = page.getByRole("checkbox", { name: /Swap code & name/ });
  await expect(swap).not.toBeChecked();
  await page.getByText(/Swap code & name/).click();
  await expect(swap).toBeChecked();

  expect(mutated()).toBe(false);
});

test("anonymous visitors get the read-only table, no admin controls", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "Waypoints" })).toBeVisible();

  // The read-only RAC table, with real content.
  const table = page.getByRole("grid", { name: "Waypoints" });
  await expect(table).toBeVisible({ timeout: 15_000 });
  await expect(
    table.getByRole("rowheader", { name: waypoints[0].code }).first()
  ).toBeVisible();

  // No admin chrome, no Tabulator.
  await expect(page.getByRole("button", { name: "Upload file" })).toHaveCount(0);
  await expect(page.locator(".tabulator")).toHaveCount(0);

  // The device-export panel is for everyone.
  await expect(page.getByRole("button", { name: "Download waypoints" })).toBeVisible();
});
