/**
 * What the waypoints specs share (comp-waypoints.spec.ts and
 * waypoint-altitude-review.spec.ts): the seeded comp, a super-admin session,
 * the editor's list, and the sessionStorage draft its pages edit (#811).
 */
import { execSync } from "node:child_process";
import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { SUPER_ADMIN } from "./stack";

export const COMP_NAME = "Corryong Cup 2026";

export interface Waypoint {
  code: string;
  name: string;
  latitude: number;
  longitude: number;
  altitude?: number;
  radius: number;
}

/** The seeded comp's id and its saved waypoints, seeding it if needed. */
export async function seededWaypoints(
  api: APIRequestContext
): Promise<{ compId: string; waypoints: Waypoint[] }> {
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

  const wpRes = await api.get(`/api/comp/${id}/waypoints`);
  expect(wpRes.ok()).toBe(true);
  const waypoints = ((await wpRes.json()) as { waypoints: Waypoint[] }).waypoints;
  // The seed builds the comp waypoint set as the union of task turnpoints — a
  // seeded comp always has some.
  expect(waypoints.length).toBeGreaterThan(0);
  return { compId: id, waypoints };
}

/** Dev-login as the super-admin. Same cookie plumbing as comp-detail.spec.ts. */
export async function signInAsSuperAdmin(page: Page): Promise<void> {
  const loginRes = await page.request.post("/api/auth/dev-login", { data: SUPER_ADMIN });
  if (!loginRes.ok()) {
    const body = await loginRes.text();
    throw new Error(`Dev login failed: ${loginRes.status()} ${loginRes.statusText()} — ${body}`);
  }
  const setCookieHeader = loginRes.headers()["set-cookie"];
  const tokenMatch = setCookieHeader?.match(/better-auth\.session_token=([^;]+)/);
  if (tokenMatch) {
    await page.context().addCookies([
      { name: "better-auth.session_token", value: tokenMatch[1], domain: "localhost", path: "/" },
    ]);
  }
}

/** The editor list's rows, and the altitude review's. Both are RAC GridLists. */
export const editorRows = (page: Page) =>
  page.getByRole("grid", { name: "Edit waypoints" }).getByRole("row");
export const reviewRows = (page: Page) =>
  page.getByRole("grid", { name: "Waypoints to look at" }).getByRole("row");

/** The row for one waypoint code. */
export const waypointRow = (page: Page, code: string) =>
  editorRows(page).filter({ hasText: code }).first();

/** A page's h1. */
export const h1 = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name });

/** The list's URL, and one of its pages', by the ids in them (the slug settles late). */
export const listUrl = /\/comp\/[^/]+\/waypoints$/;
export const waypointUrl = /\/comp\/[^/]+\/waypoints\/\d+$/;
export const reviewUrl = /\/comp\/[^/]+\/waypoints\/altitudes(\?all=1)?$/;
export const reviewWaypointUrl = /\/comp\/[^/]+\/waypoints\/altitudes\/\d+$/;

/**
 * On the editor's list, settled: every row there. The list is keyed by row
 * id, and rebuilds when the page's fetch (and then the draft) lands, so every
 * row detaches a moment after the first paint — a test whose next act is a
 * click (rather than an auto-retrying assertion) would catch that.
 */
export async function onEditorList(page: Page, rows: number): Promise<void> {
  await expect(page).toHaveURL(listUrl, { timeout: 20_000 });
  await expect(page.getByRole("button", { name: "Upload file" })).toBeVisible({ timeout: 20_000 });
  await expect(editorRows(page)).toHaveCount(rows, { timeout: 20_000 });
}

/** The first row of the editor's list, once it is there. */
export async function firstWaypointRow(page: Page): Promise<Locator> {
  const row = editorRows(page).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  return row;
}

/** Watches for any mutating call to the competition API for the page's life. */
export function trackMutations(page: Page): () => boolean {
  let mutated = false;
  page.on("request", (r) => {
    if (r.method() !== "GET" && r.url().includes("/api/comp")) mutated = true;
  });
  return () => mutated;
}
