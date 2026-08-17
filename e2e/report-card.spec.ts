/**
 * The pilot report card — `/comp/:c/task/:t/pilot/:p` — as a BROWSER renders
 * it, which is the half nothing covered.
 *
 * What existed before this file: ssr.spec.ts asserts some explanation prose is
 * in the server HTML, and lazy-map-in-view.spec.ts asserts the map mounts.
 * Neither reaches the four rules CLAUDE.md sets for this page, and two of them
 * (the emphasis charts and the track-cleaning chart) are client-only by
 * design, so no server-side assertion can ever reach them:
 *
 *   (a) every section that states a rule names its inputs and prints the
 *       substituted arithmetic — the day-quality section asserted bare
 *       percentages for a year, the one figure a reader cannot check;
 *   (b) the page never re-derives GAP parameters from the comp record — it
 *       reads the published `ClassScore.gap_params`, because the scorer merged
 *       the TASK's overrides over the comp's and resolved "auto" against the
 *       route;
 *   (c) the charts are EMPHASIS charts sampled from the scorer's own
 *       functions: one accent dot for this pilot, muted ink for everyone else,
 *       and a curve that IS the formula rather than a fit through the dots;
 *   (d) a repaired track shows its repairs, drawn client-side off the tracklog
 *       the page already downloaded for the map.
 *
 * The fixture is a private scored competition (e2e/fixtures/scored-comp.ts) —
 * real tracklogs with both altitude channels, which (d) needs, and a field of
 * three, which (c) needs to have anyone to be muted against.
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { FRONTEND_URL, SUPER_ADMIN } from "./fixtures/stack";
import {
  createScoredComp,
  openClass,
  pilotIn,
  readFreshScore,
  registerPilot,
  spikedIgc,
  uploadTrack,
  type ScoredClass,
  type ScoredComp,
} from "./fixtures/scored-comp";

const BASE_URL = FRONTEND_URL;

/** The pilot whose tracklog carries a repairable altitude glitch (rule d). */
const REPAIRED_PILOT = "Dita Spike";

test.describe("the pilot report card", () => {
  let admin: APIRequestContext;
  let fixture: ScoredComp;
  let cls: ScoredClass;
  let cardUrl: string;
  /** The report card of the pilot whose track needed repairing. */
  let repairedCardUrl: string;

  test.beforeAll(async ({ playwright }) => {
    admin = await playwright.request.newContext({ baseURL: BASE_URL });
    const signIn = await admin.post("/api/auth/dev-login", { data: SUPER_ADMIN });
    expect(signIn.ok(), "super admin dev-login").toBeTruthy();
    fixture = await createScoredComp(admin, "report card");

    // A fourth pilot flying the same trace with an altitude glitch cut into
    // it, so there is a repaired track on this task to read a report card for.
    fixture.pilotIds.set(
      REPAIRED_PILOT,
      await registerPilot(admin, fixture.compId, REPAIRED_PILOT)
    );
    await uploadTrack(admin, fixture, REPAIRED_PILOT, spikedIgc());

    cls = openClass(await readFreshScore(admin, fixture));
    expect(
      cls.pilots.length,
      "a scored field — without one there is no report card to read"
    ).toBeGreaterThan(1);
    // The winner: the pilot most likely to carry every section (goal, time,
    // leading), so the page under test is the fullest one the fixture has.
    const you = cls.pilots[0];
    const card = (compPilotId: string) =>
      `${BASE_URL}/comp/${fixture.compId}/task/${fixture.taskId}/pilot/${compPilotId}`;
    cardUrl = card(you.comp_pilot_id);

    const repaired = pilotIn(cls, REPAIRED_PILOT);
    expect(repaired, "the repaired track must still score — quality passes it").toBeTruthy();
    repairedCardUrl = card(repaired!.comp_pilot_id);
  });

  test.afterAll(async () => {
    if (fixture?.compId) await admin.delete(`/api/comp/${fixture.compId}`);
    await admin.dispose();
  });

  test("(a) day quality names its inputs and prints the arithmetic", async ({ page }) => {
    await page.goto(cardUrl);

    const heading = page.getByRole("heading", { name: "Day quality — points on offer" });
    await expect(heading).toBeVisible({ timeout: 30_000 });
    const section = page.locator("section", { has: heading });

    // Launch validity: the counts on both sides of the ratio, and the
    // threshold they are measured against — not "launch validity 100%".
    await expect(section.getByText(/\d+ pilots? flew out of \d+ present/)).toBeVisible();
    await expect(
      section.getByText(/Nominal launch is 96%, so launch validity is full once/)
    ).toBeVisible();

    // Distance validity: the nominal distance, the nominal goal and the
    // minimum distance the formula used, plus what the field actually flew.
    await expect(
      section.getByText(/Measured against a [\d.]+ km nominal distance/)
    ).toBeVisible();
    await expect(section.getByText(/The field flew [\d.]+ km past the minimum/)).toBeVisible();

    // And a way out of the page for a reader who does not know GAP.
    await expect(
      section.getByRole("link", { name: /How day quality .* works/i })
    ).toHaveAttribute("href", "/scoring/gap#task-validity");
  });

  test("(b) the formula named is the one the task was scored with", async ({ page }) => {
    // The page fetches the comp record as well as the score, and still carries
    // a re-derivation fallback for score rows cached before `gap_params` was
    // published. Serve it a comp record that disagrees loudly: if anything on
    // the page is derived from the comp instead of read from the published
    // class score, the absurd number appears in the prose.
    const LIE_KM = 999;
    await page.route(/\/api\/comp\/[^/]+(\?|$)/, async (route) => {
      const res = await route.fetch();
      const body = (await res.json()) as { gap_params?: Record<string, unknown> | null };
      await route.fulfill({
        response: res,
        json: {
          ...body,
          gap_params: { ...(body.gap_params ?? {}), nominalDistance: LIE_KM * 1000 },
        },
      });
    });

    await page.goto(cardUrl);
    const heading = page.getByRole("heading", { name: "Day quality — points on offer" });
    await expect(heading).toBeVisible({ timeout: 30_000 });

    const published = (cls.gap_params!.nominalDistance / 1000).toFixed(1);
    await expect(
      page.getByText(`Measured against a ${published} km nominal distance`)
    ).toBeVisible();
    await expect(page.getByText(`${LIE_KM}.0 km nominal distance`)).toHaveCount(0);
  });

  test("(c) the charts single this pilot out, and are the formula not a fit", async ({
    page,
  }) => {
    await page.goto(cardUrl);
    await expect(
      page.getByRole("heading", { name: "Day quality — points on offer" })
    ).toBeVisible({ timeout: 30_000 });

    // Exactly one dot on a curve is this pilot's. More than one would mean the
    // accent is being painted on the field; none would mean the reader cannot
    // find themselves, which is the only reason the chart is here.
    const you = page.getByRole("img", { name: /— this pilot$/ });
    await expect(you.first()).toBeVisible();
    expect(await you.count(), "one accent dot per curve, and only one").toBeGreaterThan(0);

    // The curve is sampled from the scorer's own function. The field-analysis
    // charts say "a trend fitted through the dots" and these must never — the
    // difference between a formula and a regression is the whole claim.
    await expect(page.getByText(/fitted through the dots/)).toHaveCount(0);
    await expect(page.getByText(/The curve is the .*formula/).first()).toBeVisible();
  });

  test("(d) a repaired track shows its repairs, client-side", async ({ page }) => {
    await page.goto(repairedCardUrl);

    const heading = page.getByRole("heading", { name: "Track data cleaning" });
    await expect(heading).toBeVisible({ timeout: 30_000 });

    // The prose counts the repair before any chart exists — it is what the
    // server rendered, and it survives with no JS.
    await expect(
      page.getByText(/\d+ of \d+ GPS fixes .* carried an implausible altitude/)
    ).toBeVisible();

    // The chart is drawn from the tracklog the page downloads for the map, so
    // it appears only after that lands — and only in a browser. Its accessible
    // name carries the whole reading, which is also what a screen reader gets
    // in place of the three lines.
    const chart = page.getByRole("img", { name: /^Altitude against time\./ });
    await expect(chart).toBeVisible({ timeout: 30_000 });

    // A channel the file does not carry is NAMED, never drawn as a flat line
    // at zero — these tracklogs log no barometric altitude, so the legend has
    // to say so.
    await expect(chart).toHaveAttribute(
      "aria-label",
      /carries no barometric channel/
    );

    // The exact numbers live in the list either way — the chart is the shape
    // of the repair, the list is the record of it, and the list doubles as the
    // chart's controls.
    await expect(page.getByText(/\d+ fix(es)? · up to \d+ m off/).first()).toBeVisible();
  });
});
