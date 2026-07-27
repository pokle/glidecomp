/**
 * Issue #481 — one bad round trip must not strand a page in a wrong state.
 *
 * This is the failure the comp-detail / comp-waypoints specs kept losing a
 * test to, roughly one full-suite run in five. The page loads, but the admin
 * affordance the spec waits on never appears, and the captured snapshot shows
 * either an app rendered signed out or a bare "Competition not found" —
 * on a comp that is right there and a session that is perfectly valid.
 *
 * The cause was never the dialog or the grid those specs were testing. Each
 * page load asks two questions — "who is this?" (`/api/auth/me`) and "what is
 * this comp?" (`/api/comp/:id`) — and a transient failure to *ask* was being
 * recorded as an *answer*: signed out, or not found. Both are terminal states
 * with nothing to re-fetch them, so a blip lasting milliseconds became a
 * wrong page that stayed wrong until a reload.
 *
 * Rather than wait for the race, these tests inject it: `page.route` fails one
 * specific request a fixed number of times and then gets out of the way. What
 * is asserted is only that the page arrives where it should — the retry counts
 * and backoffs live with the code, not here.
 *
 * Drives the seeded "Corryong Cup 2026" sample comp READ-ONLY, like the other
 * comp specs: nothing is created, nothing is saved.
 */
import { execSync } from "node:child_process";
import { test, expect, type Page } from "@playwright/test";
import { FRONTEND_URL, SUPER_ADMIN } from "./fixtures/stack";

const BASE_URL = FRONTEND_URL;
const COMP_NAME = "Corryong Cup 2026";

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
    execSync("bun run seed corryong-cup-2026", {
      stdio: "inherit",
      timeout: 240_000,
    });
    id = await findComp();
  }
  if (!id) throw new Error(`Sample comp "${COMP_NAME}" not found after seeding`);
  compId = id;

  await api.dispose();
});

/** Dev-login as the super-admin — same cookie plumbing as comp-detail.spec.ts. */
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
});

/**
 * Break the first `times` requests whose pathname is exactly `path`, then let
 * everything through.
 *
 * Matched exactly, not by substring: `/api/comp/:id` is a prefix of
 * `/api/comp/:id/scores`, `/api/comp/:id/audit` and several more, and a
 * substring matcher spends the injected fault on whichever of them the page
 * happens to send first — which is not the request under test.
 *
 * `times` matters for the comp fetch. Those pages re-run their load effect
 * when the signed-in user resolves, so a *single* injected fault is absorbed
 * by that incidental second fetch and the page recovers even unfixed — a test
 * that would pass against the bug it is meant to catch. Breaking both fetches
 * leaves the retry inside fetchWithRetry as the only thing that can save the
 * page, which is the behaviour under test.
 *
 * `mode` picks which of the two shapes seen in the wild to inject: a dropped
 * connection (the request never lands) or a 5xx (it lands and the server is
 * unhappy). They take different code paths, so both are worth covering.
 */
async function breakFirst(
  page: Page,
  path: string,
  mode: "drop" | "server-error",
  times = 1
): Promise<() => number> {
  let broken = 0;
  await page.route(
    (url) => url.pathname === path,
    async (route) => {
      if (broken < times) {
        broken++;
        if (mode === "drop") {
          await route.abort("connectionfailed");
        } else {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "transient" }),
          });
        }
        return;
      }
      await route.fallback();
    }
  );
  return () => broken;
}

test("a dropped /api/auth/me still resolves the signed-in admin view", async ({
  page,
}) => {
  const broken = await breakFirst(page, "/api/auth/me", "drop");

  await page.goto(`/comp/${compId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(COMP_NAME);

  // The Settings button is the comp page's admin sync point: it renders only
  // once /api/auth/me has resolved a user who administers this comp.
  await expect(
    page.getByRole("button", { name: "Settings", exact: true })
  ).toBeVisible({ timeout: 15_000 });
  expect(broken(), "the fault should actually have been injected").toBe(1);
});

test("a 5xx from /api/auth/me still resolves the signed-in admin view", async ({
  page,
}) => {
  const broken = await breakFirst(page, "/api/auth/me", "server-error");

  await page.goto(`/comp/${compId}`);
  await expect(
    page.getByRole("button", { name: "Settings", exact: true })
  ).toBeVisible({ timeout: 15_000 });
  expect(broken()).toBe(1);
});

test("a dropped comp fetch renders the comp, not 'Competition not found'", async ({
  page,
}) => {
  // The exact snapshot captured on the flake: a real comp reported missing.
  const broken = await breakFirst(page, `/api/comp/${compId}`, "drop", 2);

  await page.goto(`/comp/${compId}`);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(COMP_NAME, {
    timeout: 15_000,
  });
  await expect(page.getByText("Competition not found")).toHaveCount(0);
  expect(broken()).toBe(2);
});

test("the waypoints page says so when the comp fetch never lands", async ({
  page,
}) => {
  // This page fetched the comp with no retry and no catch at all, so when the
  // fetch failed it rendered a plausible lie: the Waypoints heading, "0
  // waypoints", "No waypoints yet", and no admin chrome — a comp that looks
  // empty and read-only rather than one that failed to load. That is the
  // shape #481 reported from comp-waypoints.spec.ts:283, whose beforeEach
  // waits on an "Upload file" button this rendering never produces.
  //
  // Every attempt is broken here, not a first few: this asserts the honest
  // *failure* rendering, which is deterministic. The recovery-by-retry
  // behaviour is covered by the comp-page test above and by the
  // fetchWithRetry unit tests.
  await breakFirst(page, `/api/comp/${compId}`, "drop", Number.MAX_SAFE_INTEGER);

  await page.goto(`/comp/${compId}/waypoints`);
  await expect(page.getByText("Competition not found")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText("0 waypoints")).toHaveCount(0);
});

test("a genuinely missing comp still says so", async ({ page }) => {
  // The retries must not turn a real 404 into a hang or a blank page.
  await page.goto("/comp/zzzzzzzz");
  await expect(page.getByText("Competition not found")).toBeVisible({
    timeout: 15_000,
  });
});
