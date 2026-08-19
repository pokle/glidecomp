/**
 * The two invariants CLAUDE.md calls "part of done", proven from the browser
 * against the real Workers: every mutation that can move a competition's
 * scores is (a) audit-logged in words a reader can check, and (b) followed by
 * a score bump, so the materialized `task_scores` row is recomputed instead of
 * being served stale forever.
 *
 * Nothing else in the suite covers either half:
 *
 *  - comp-detail.spec.ts drives the activity log, but its fixture is a SEEDED
 *    comp whose rows were written straight into D1, so the assertion has to
 *    accept "No activity yet". A handler that forgot `audit()` passes it.
 *  - track-submission.spec.ts covers what the report card SAYS while a score
 *    is stale, by intercepting the response and forcing `stale: true`. Real
 *    revalidation never runs in it.
 *
 * So a route that dropped its `audit()` or its `bumpAndRevalidateScores()`
 * call — the two lines easiest to leave out of a new handler, and invisible
 * for as long as nobody compares the numbers — went red nowhere. That is what
 * this file is for.
 *
 * The shape of every test here is the same three steps:
 *
 *   1. read the CURRENT score and remember it (never a value captured in
 *      `beforeAll`: these tests share one task, so each must baseline against
 *      whatever the test before it left behind, or it asserts about the wrong
 *      starting point the moment the order changes);
 *   2. make the change the way a scorekeeper does — through the page;
 *   3. assert the audit sentence is on the comp's activity log IN THE BROWSER,
 *      and poll the score until it is fresh again and demonstrably recomputed.
 *
 * Penalties are the exception and are driven over the API: they are settable
 * (`PATCH …/igc/:comp_pilot_id`) and the scores render them, but no screen
 * writes one today. Their audit + bump still has to hold, and this is the only
 * place that says so.
 *
 * The fixture — a private competition with one routed, scored task — is
 * e2e/fixtures/scored-comp.ts, which explains why it cannot be a seeded comp.
 */
import { readFile } from "fs/promises";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { FRONTEND_URL, SUPER_ADMIN, e2eCompName } from "./fixtures/stack";
import {
  createScoredComp,
  openClass,
  pilotIn,
  readFreshScore,
  readScore,
  FLYING_PILOTS,
  TASK_DATE,
  type ScoredComp,
} from "./fixtures/scored-comp";

/** The bundled comp the fixtures build from — see fixtures/scored-comp.ts. */
const SAMPLE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "web/samples/comps/unungra-cup-2020-open-t4"
);

const BASE_URL = FRONTEND_URL;

/**
 * Two pilots with no tracklog, one per test that needs one. They are separate
 * on purpose: a manual flight resolves its pilot to Landed, so recording one
 * for the pilot the status test marked Absent would quietly undo that test's
 * subject and make either test's failure read as the other's.
 */
const STATUS_PILOT = "Nina NoTrack";
const MANUAL_PILOT = "Milo Manual";

/** A landing point on the third leg — inside the route's bbox, short of goal. */
const MANUAL_LANDING = "-36.2212878474, 147.729549408";

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Sign a browser page in as the super admin (cookie plumbing as elsewhere). */
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

/**
 * Assert the comp's activity log shows `sentence` — read the way anybody else
 * reads it, off the comp page.
 *
 * A fresh page load, not the live view: nothing on the hub re-fetches the log
 * when a dialog elsewhere saves, and asserting against a component's optimism
 * would prove the UI's state rather than the database's.
 *
 * The full log, not the digest. One save can write SEVERAL entries (a settings
 * save describes every knob that moved, one line each, and updates the admin
 * list besides), so the sentence under test is regularly not among the three
 * the digest shows — expanding is the difference between a real assertion and
 * one that depends on how many siblings the mutation happened to have.
 */
async function expectAuditEntry(page: Page, compId: string, sentence: RegExp) {
  await expandedActivity(page, compId, sentence);
}

/** The expanded activity log, with `sentence` already asserted present. */
async function expandedActivity(page: Page, compId: string, sentence: RegExp) {
  await page.goto(`${BASE_URL}/comp/${compId}`);
  const activity = page.locator("#activity");
  const expand = activity.getByRole("button", { name: "Show all activity" });
  await expect(expand).toBeVisible({ timeout: 20_000 });
  await expand.click();
  await expect(activity.getByText(sentence).first()).toBeVisible({ timeout: 20_000 });
  return activity;
}

// ── The spec ────────────────────────────────────────────────────────────────

test.describe("a scoring input changes: audit entry + recomputed scores", () => {
  let admin: APIRequestContext;
  let fixture: ScoredComp;

  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: BASE_URL });
    const signIn = await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN });
    expect(signIn.ok(), "super admin dev-login").toBeTruthy();
    fixture = await createScoredComp(admin, "scoring mutations", [
      STATUS_PILOT,
      MANUAL_PILOT,
    ]);

    // First read is the cold path and computes synchronously, so every test
    // starts from a materialized row rather than racing the first compute.
    const first = openClass(await readScore(admin, fixture));
    expect(
      first.pilots.length,
      "the three bundled tracklogs must all be scored — if this is 0 they were " +
        "withheld by track quality, and nothing below means anything"
    ).toBeGreaterThanOrEqual(FLYING_PILOTS.length);
  });

  test.afterAll(async () => {
    if (fixture?.compId) await admin.delete(`/api/comp/${fixture.compId}`);
    await admin.dispose();
  });

  test("comp settings: saving a GAP parameter is logged and rescores the task", async ({
    page,
  }) => {
    const before = openClass(await readFreshScore(admin, fixture));
    const winnerBefore = before.pilots[0];
    expect(winnerBefore, "a scored winner to compare against").toBeTruthy();

    await devLogin(page);
    await page.goto(`${BASE_URL}/comp/${fixture.compId}/settings/scoring`);
    await expect(page.getByRole("heading", { name: "Scoring" })).toBeVisible();

    // Nominal distance (§5.1) is the knob to prove the loop with: it is one
    // number, the class score publishes the value the scorer actually used,
    // and it drives distance validity — so a save that never reached the
    // scorer is visible twice over. (Nominal TIME is a worse subject than it
    // looks: for a long task flown slowly, time validity is already 1 and
    // stays 1 however the nominal moves, so the test would prove nothing.)
    await page.getByText("Advanced scoring settings").click();
    const nominalDistance = page.getByRole("textbox", { name: "Nominal distance (km)" });
    // Blank = auto, resolved per task against the route.
    await expect(nominalDistance).toHaveValue("");
    await nominalDistance.fill("200");
    // Commit the NumberField before saving: RAC parses on blur, so a Save
    // clicked straight out of a focused field can send the old number.
    await nominalDistance.press("Tab");
    await page.getByRole("button", { name: "Save" }).click();
    // A successful save navigates back up to the settings index.
    await expect(page.getByRole("link", { name: "Scoring" })).toBeVisible({
      timeout: 20_000,
    });

    const activity = await expandedActivity(
      page,
      fixture.compId,
      /Changed nominal distance from auto \(per task\) to 200 km/
    );

    // …and ONLY that. This comp's gap_params was still null, so the save is
    // also the first one — and the log used to announce the leading and
    // arrival points it was already being scored with (issue #633). The
    // audit log is the answer a pilot gets when their points move, so a knob
    // nobody touched must not appear in it.
    await expect(
      activity.getByText(/(Enabled|Disabled) (leading \(departure\)|arrival) points/)
    ).toHaveCount(0);

    // The published parameters are the scorer's own, so this changing is proof
    // the blob was recomputed FROM the new settings — not merely re-served.
    const after = openClass(await readFreshScore(admin, fixture));
    expect(after.gap_params?.nominalDistance).toBe(200_000);
    expect(before.gap_params?.nominalDistance).not.toBe(200_000);
    // …and the formula moved with it: a nominal distance far beyond what the
    // field flew is a lower distance validity, so every score comes down.
    expect(after.task_validity.distance).toBeLessThan(before.task_validity.distance);
    const winnerAfter = pilotIn(after, winnerBefore.pilot_name);
    expect(winnerAfter!.total_score).toBeLessThan(winnerBefore.total_score);
  });

  test("pilot status: Did Not Fly is logged and changes launch validity", async ({
    page,
  }) => {
    const before = openClass(await readFreshScore(admin, fixture));
    const presentBefore = before.validity_inputs?.num_present;
    expect(presentBefore, "validity_inputs.num_present").toBeGreaterThan(0);

    await devLogin(page);
    await page.goto(`${BASE_URL}/comp/${fixture.compId}/task/${fixture.taskId}`);

    // The manage grid mounts only after the admin check resolves, so sync on
    // the row control itself rather than on the page. The status control is
    // the kit's SimpleSelect — a RAC Select, not a native <select>, so it is
    // driven by opening it and picking the option (gotcha #13: `selectOption`
    // and `check()` do nothing here).
    const row = page.getByRole("row").filter({ hasText: STATUS_PILOT });
    const status = row.getByRole("button", {
      name: new RegExp(`Status for ${STATUS_PILOT}`),
    });
    await expect(status).toBeVisible({ timeout: 30_000 });
    await status.click();
    await page.getByRole("option", { name: "Did Not Fly" }).click();

    await expectAuditEntry(
      page,
      fixture.compId,
      new RegExp(`Set status for ${STATUS_PILOT} to "Did Not Fly"`)
    );

    // Did Not Fly is the S7F §10.1 lever, and the ONLY status that moves this
    // number: "pilots present" is those who flew plus those present who did
    // not fly, so a DNF adds to the denominator alone and the day gets less
    // valid. (Absent deliberately counts in neither bucket — marking a pilot
    // absent changes no other pilot's points, which is why it can't be the
    // subject of this test.)
    const after = openClass(await readFreshScore(admin, fixture));
    expect(after.validity_inputs?.num_present).toBe(presentBefore! + 1);
    expect(after.task_validity.launch).toBeLessThan(before.task_validity.launch);
  });

  test("manual flight: recording one is logged and seats the pilot in the scores", async ({
    page,
  }) => {
    const before = openClass(await readFreshScore(admin, fixture));
    expect(pilotIn(before, MANUAL_PILOT), "not scored before the flight is recorded")
      .toBeUndefined();

    await devLogin(page);
    await page.goto(`${BASE_URL}/comp/${fixture.compId}/task/${fixture.taskId}`);

    // Every routed row offers the button, so scope to this pilot's row.
    const row = page.getByRole("row").filter({ hasText: MANUAL_PILOT });
    const addFlight = row.getByRole("button", { name: "Add manual flight" });
    await expect(addFlight).toBeVisible({ timeout: 30_000 });
    await addFlight.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Record manual flight" })).toBeVisible();

    // Pick a turnpoint short of goal and land at it: the made-good distance
    // the dialog previews is computed by the same engine helpers the server
    // scores with, so a pilot seated with SOME distance is the whole claim.
    await dialog.getByRole("button", { name: /Last turnpoint reached/ }).click();
    await page.getByRole("listbox").getByRole("option", { name: "4. mur041" }).click();
    await dialog.getByRole("textbox", { name: "Landing point" }).fill(MANUAL_LANDING);
    // The live preview is the engine's own made-good number: seeing a distance
    // here is what says the coordinates parsed and the geometry ran.
    await expect(dialog.getByText(/km made good/)).toBeVisible();
    await dialog.getByRole("button", { name: "Record flight" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0, { timeout: 20_000 });

    await expectAuditEntry(
      page,
      fixture.compId,
      new RegExp(`Recorded manual flight for ${MANUAL_PILOT}`)
    );

    const after = openClass(await readFreshScore(admin, fixture));
    const scored = pilotIn(after, MANUAL_PILOT);
    expect(scored, "the manual flight must put the pilot in the scored field").toBeTruthy();
    expect(scored!.flown_distance).toBeGreaterThan(0);
  });

  test("penalty: an API-only mutation is logged and comes off the pilot's score", async ({
    page,
  }) => {
    // No screen writes a penalty today — the scores render one
    // (ScoresSection) and the endpoint accepts one, and that is the whole
    // surface. Driving it over the API keeps its audit + bump covered, and
    // keeps this file honest about where the gap is.
    const victim = FLYING_PILOTS[0].name;
    const reason = "E2E airspace infringement";
    const before = openClass(await readFreshScore(admin, fixture));
    const scoreBefore = pilotIn(before, victim);
    expect(scoreBefore, `${victim} must be scored before the penalty`).toBeTruthy();
    expect(
      scoreBefore!.total_score,
      "a penalty can only be seen coming off a score above zero"
    ).toBeGreaterThan(50);

    const res = await admin.patch(
      `/api/comp/${fixture.compId}/task/${fixture.taskId}/igc/${fixture.pilotIds.get(victim)}`,
      { data: { penalty_points: 50, penalty_reason: reason } }
    );
    expect(res.ok(), await res.text()).toBeTruthy();

    // Signed OUT on purpose: for a normal (non-`test`) comp the activity log
    // is the competition's public transparency record, so a penalty applied
    // over the API has to be readable by the pilot it was applied to.
    await expectAuditEntry(
      page,
      fixture.compId,
      new RegExp(`penalty for ${victim} to 50 pts: ${reason}`)
    );

    const after = openClass(await readFreshScore(admin, fixture));
    const scoreAfter = pilotIn(after, victim);
    expect(scoreAfter!.penalty_points).toBe(50);
    expect(scoreAfter!.penalty_reason).toBe(reason);
    // The deduction reaches the total, which is the only number a pilot reads.
    expect(scoreAfter!.total_score).toBeLessThan(scoreBefore!.total_score);
  });
});

// ── The other format: an open-distance comp's settings (issue #633) ──────────

/**
 * Any sentence naming a GAP parameter. The audit log for an open-distance
 * competition must contain none of them from a settings save: the dialog does
 * not offer a single one of these knobs for this format, so an organiser who
 * was never shown them cannot have moved them.
 */
const GAP_KNOB_SENTENCE =
  /(leading \(departure\) points|arrival points|HG distance difficulty|nominal (distance|time)|minimum distance|leading-time ratio|distance origin|jump-the-gun|ESS-but-not-goal|scoring class|GAP scoring parameters)/;

test.describe("an open-distance comp's settings save", () => {
  let admin: APIRequestContext;
  let compId: string;

  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: BASE_URL });
    const signIn = await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN });
    expect(signIn.ok(), "super admin dev-login").toBeTruthy();

    const compRes = await admin.post("/api/comp", {
      data: {
        name: e2eCompName("open distance settings"),
        category: "hg",
        pilot_classes: ["open"],
        scoring_format: "open_distance",
      },
    });
    expect(compRes.ok(), await compRes.text()).toBeTruthy();
    compId = ((await compRes.json()) as { comp_id: string }).comp_id;

    // An open-distance task is a single TAKEOFF turnpoint — the format's own
    // validation rejects a full route. Borrow the scored fixture's launch so
    // the comp has a located task (and therefore a derivable timezone).
    const route = JSON.parse(
      await readFile(resolve(SAMPLE_DIR, "task.xctsk"), "utf8")
    ) as { turnpoints: Array<{ waypoint: unknown }> };
    const taskRes = await admin.post(`/api/comp/${compId}/task`, {
      data: {
        name: "Open distance day",
        task_date: TASK_DATE,
        pilot_classes: ["open"],
        xctsk: {
          taskType: "OPEN-DISTANCE",
          version: 1,
          earthModel: "WGS84",
          turnpoints: [
            { type: "TAKEOFF", radius: 400, waypoint: route.turnpoints[0].waypoint },
          ],
        },
      },
    });
    expect(taskRes.ok(), await taskRes.text()).toBeTruthy();
  });

  test.afterAll(async () => {
    if (compId) await admin.delete(`/api/comp/${compId}`);
    await admin.dispose();
  });

  test("offers no GAP knobs, and logs no GAP changes when saved", async ({ page }) => {
    await devLogin(page);
    await page.goto(`${BASE_URL}/comp/${compId}/settings/scoring`);
    await expect(page.getByRole("heading", { name: "Scoring" })).toBeVisible();

    // The premise: this format hides the Advanced disclosure entirely, so
    // there is no way through this screen to change a GAP parameter…
    await expect(page.getByText("Advanced scoring settings")).toHaveCount(0);
    // The format picker (a RAC Select — its trigger is a button showing the
    // chosen option) confirms this really is the open-distance branch, so the
    // absence above is that branch's doing and not a page that failed to
    // render.
    await expect(
      page.getByText("Open distance — fly as far as possible").first()
    ).toBeVisible();

    // …and (unlike the old dialog, which submitted gap_params regardless —
    // issue #633) the page omits gap_params from its PATCH entirely, so the
    // save must not announce parameters of a formula this competition does
    // not score with at all.
    await page.getByRole("button", { name: "Save" }).click();
    // A successful save navigates back up to the settings index.
    await expect(page.getByRole("link", { name: "Scoring" })).toBeVisible({
      timeout: 20_000,
    });

    await page.goto(`${BASE_URL}/comp/${compId}`);
    const activity = page.locator("#activity");
    const expand = activity.getByRole("button", { name: "Show all activity" });
    await expect(expand).toBeVisible({ timeout: 20_000 });
    await expand.click();
    await expect(activity.getByText(GAP_KNOB_SENTENCE)).toHaveCount(0);
  });

  test("changing the Wing logs one sentence, in the words on the screen", async ({
    page,
  }) => {
    // Wing IS on screen whatever the scoring format — it is a global
    // competition setting on the General page, not a GAP one — and it is the
    // field that reaches gap_params.scoring. So it is the one way an
    // organiser here can move a GAP parameter, and the log has to report it
    // as what they did: the wing, named the way the radio group names it,
    // once.
    await devLogin(page);
    await page.goto(`${BASE_URL}/comp/${compId}/settings/general`);
    await expect(page.getByRole("radio", { name: "Hang Gliding" })).toBeChecked();

    // Click the visible name, not the radio's role — the kit hides the real
    // input under a styled span and wraps each radio in a real <label>. See
    // the same gotcha in track-submission.spec.ts.
    await page.getByText("Paragliding", { exact: true }).click();
    await page.getByRole("button", { name: "Save" }).click();
    // A successful save navigates back up to the settings index.
    await expect(page.getByRole("link", { name: "General" })).toBeVisible({
      timeout: 20_000,
    });

    const activity = await expandedActivity(
      page,
      compId,
      /Changed wing from Hang Gliding to Paragliding/
    );
    // No "Changed scoring class from HG to PG" beside it, and no other GAP
    // sentence: the wing's line is the whole record.
    await expect(activity.getByText(GAP_KNOB_SENTENCE)).toHaveCount(0);
  });
});
