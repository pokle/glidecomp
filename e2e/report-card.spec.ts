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
 * A fifth concern joined them with issue #666: this page is PUBLIC, and the
 * link it offers into the analysis viewer now opens for a reader with no
 * session. That is a gate, so it is tested as one — see the "signed out"
 * block at the foot of the file.
 *
 * The fixture is a private scored competition (e2e/fixtures/scored-comp.ts) —
 * real tracklogs with both altitude channels, which (d) needs, and a field of
 * three, which (c) needs to have anyone to be muted against.
 */
import { test, expect, type APIRequestContext, type Page } from "./fixtures/test";
import { FRONTEND_URL, SUPER_ADMIN, e2eCompName } from "./fixtures/stack";
import { installMapbox } from "./fixtures/mapbox";
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
  /** The pilot `cardUrl` belongs to — the analysis deep link names them. */
  let cardPilot: { comp_pilot_id: string; pilot_name: string };
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
    cardPilot = you;
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

    // The curve is sampled from the scorer's own function. The task-analysis
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
  /**
   * The anonymous reader (issue #666).
   *
   * The report card is public and server-rendered, so most of its readers have
   * no session — the pilot who was sent the link, their club, a meet director
   * on somebody else's laptop. Under the map it offers "Open full track in the
   * analysis map", and that link used to be drawn for signed-in visitors only,
   * because the analysis viewer bounced everyone else to sign-in.
   *
   * What changed is deliberately one URL shape wide: `?compId=…&taskId=…`
   * (plus `pilotId`) opens with no session, and nothing else does. The three
   * tests here are the three halves of that claim — it works, it is narrow,
   * and it still cannot see a hidden `test` comp.
   *
   * These tests run in the default context, which carries no session at all,
   * so "signed out" needs no arranging.
   */
  test.describe("signed out", () => {
    test("the report card offers the analysis map, and it opens this pilot's track", async ({
      page,
      context,
    }) => {
      const mapbox = await installMapbox(context);
      await page.goto(cardUrl);

      const link = page.getByRole("link", {
        name: "Open full track in the analysis map (opens in a new tab)",
      });
      await expect(link).toBeVisible({ timeout: 30_000 });
      // `pilotId` is what narrows the viewer to this one track, which is what
      // keeps its panel in single-track mode. Without it the reader lands on
      // the whole field and the per-track tabs are replaced by a score table
      // the report card already showed them.
      await expect(link).toHaveAttribute(
        "href",
        `/analysis?compId=${fixture.compId}&taskId=${fixture.taskId}` +
          `&pilotId=${cardPilot.comp_pilot_id}`
      );

      // Follow it here rather than in the new tab it asks for — the URL is the
      // thing under test, and a second tab only complicates the assertions.
      await page.goto((await link.getAttribute("href"))!);

      // Not bounced. This is the assertion the whole issue is about.
      await expect(page).toHaveURL(/\/analysis\?compId=/);

      // The task arrived: the breadcrumbs are only built once it resolved.
      await expect(page.locator("#breadcrumbs")).toContainText("Task 4", {
        timeout: 60_000,
      });

      // And the pilot's track was parsed and analysed, under their registered
      // name rather than whatever the IGC header says.
      await expect(page.locator("#event-panel-container")).toContainText(
        cardPilot.pilot_name,
        { timeout: 60_000 }
      );

      // All six single-track tabs — the tooling the report card does not have.
      // The panel is a sidebar over the map, collapsed to zero width until the
      // reader opens it from the "Analysis" control. Collapsed is not the same
      // as absent: it keeps its markup (and enough of a box to look "visible"
      // to a bounding-box check), so its own `aria-hidden` is what says
      // whether it is open.
      const panel = page.locator("#waypoint-sidebar");
      if ((await panel.getAttribute("aria-hidden")) !== "false") {
        await page.getByRole("button", { name: "Toggle analysis panel" }).click();
      }
      await expect(panel).toHaveAttribute("aria-hidden", "false");
      const tabs = page.locator("#tab-row-single");
      for (const name of ["Task", "Score", "Events", "Glides", "Climbs", "Sinks"]) {
        await expect(tabs.getByRole("tab", { name, exact: true })).toBeVisible();
      }

      // The page is read-only in the one way that matters to a visitor: every
      // control that would reload into a URL this gate does not allow is
      // hidden, rather than left to throw the reader back out to sign-in.
      const gated = page.locator("[data-requires-account]");
      expect(await gated.count(), "the sample loaders should be marked").toBeGreaterThan(0);
      for (const el of await gated.all()) {
        await expect(el).toHaveClass(/\bhidden\b/);
      }

      mapbox.assertComplete();
    });

    test("every other way into the analysis page still asks for a sign-in", async ({
      page,
    }) => {
      const link = `compId=${fixture.compId}&taskId=${fixture.taskId}`;
      const gated = [
        // The bare page — the personal library and the file tooling.
        "",
        // The bundled samples and the mobile share target.
        "?track=2025-01-05-Tushar-Corryong.igc",
        "?task=buje",
        "?sampleComp=corryong-cup-2026-open-t1",
        "?shared=1",
        // The personal library proper.
        "?storedTrack=whatever",
        "?storedTask=buje",
        "?u=someone",
        // Half a competition link is not a competition link.
        `?compId=${fixture.compId}`,
        `?taskId=${fixture.taskId}`,
        // And a real one cannot be used to smuggle the rest past the gate.
        `?${link}&storedTrack=whatever`,
        `?${link}&track=2025-01-05-Tushar-Corryong.igc`,
      ];

      for (const query of gated) {
        await page.goto(`/analysis${query}`);
        await page.waitForURL(/\/u\/me/, { timeout: 30_000 });
      }
    });

    test("a deep link into a hidden test comp finds nothing, and names nothing", async ({
      page,
      context,
    }) => {
      const mapbox = await installMapbox(context);

      // A `test` comp is invisible to anyone but its admins: all four routes
      // the deep link uses answer a non-admin the same "Not found" they answer
      // for an id that never existed.
      const name = e2eCompName("hidden from the analysis deep link");
      const compRes = await admin.post("/api/comp", {
        data: { name, category: "hg", pilot_classes: ["open"], test: true },
      });
      expect(compRes.ok(), await compRes.text()).toBeTruthy();
      const { comp_id: hiddenComp } = (await compRes.json()) as { comp_id: string };
      try {
        const taskRes = await admin.post(`/api/comp/${hiddenComp}/task`, {
          data: { name: "Secret task", task_date: "2020-12-12", pilot_classes: ["open"] },
        });
        expect(taskRes.ok(), await taskRes.text()).toBeTruthy();
        const { task_id: hiddenTask } = (await taskRes.json()) as { task_id: string };

        await page.goto(`/analysis?compId=${hiddenComp}&taskId=${hiddenTask}`);

        // Not-found, said as an answer rather than as a failure.
        await expect(page.locator("#status-message")).toHaveText(
          "Competition task not found",
          { timeout: 60_000 }
        );

        // And nothing about the competition leaked on the way to saying so:
        // the breadcrumbs are built only after the task resolved, and the
        // title is the page's own.
        await expect(page.locator("#breadcrumbs")).toHaveText("GlideComp");
        expect(await page.locator("body").innerText()).not.toContain(name);
        expect(await page.title()).not.toContain(name);
        expect(await page.title()).not.toContain("Secret task");
      } finally {
        await admin.delete(`/api/comp/${hiddenComp}`);
      }

      mapbox.assertComplete();
    });
  });
});
