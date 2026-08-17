/**
 * The prerendered content pages — `/`, `/about`, `/legal` and the four scoring
 * guides — which no spec loaded at all before this one. `ssr.spec.ts` mentions
 * some of their paths, but only as strings it expects the sitemap to list.
 *
 * The rule for these pages (CLAUDE.md) is SEO, not a JS ban: every word and
 * image a visitor or a crawler needs is in the prerendered HTML, and the page
 * stays useful with JavaScript off — with hand-written vanilla enhancement on
 * top where it genuinely helps. So this file asserts both halves:
 *
 *   1. fetched as a crawler fetches them (`request`, no browser at all), the
 *      HTML already carries the words — including the answers behind the FAQ
 *      accordion, all six chart panels behind the tabs, and the GAP page's
 *      formulas, which are KaTeX-rendered at BUILD and must never arrive as a
 *      client-side script;
 *   2. with `javaScriptEnabled: false`, the page still reads;
 *   3. with JS on, the enhancements actually work.
 *
 * Scope, deliberately: this runs against the dev stack, where Astro serves the
 * same components it prerenders (`astro dev`, proxied onto :3000 by
 * vite.config.ts). It therefore guards the CONTENT of these pages, not the
 * production build step that freezes them — `bun run build` runs the Astro
 * build, and web/scripts/smoke-test.sh checks the deployed `/` afterwards.
 */
import { test, expect, type APIRequestContext } from "./fixtures/test";

/** Every content page, with a phrase only that page carries. */
const PAGES = [
  { path: "/", heading: "See where the race was really won." },
  { path: "/about", heading: "About GlideComp" },
  { path: "/legal", heading: "Privacy Policy &amp; Terms" },
  { path: "/scoring", heading: "Scoring" },
  { path: "/scoring/gap", heading: "How GAP Scoring Works" },
  { path: "/scoring/open-distance", heading: "How Open Distance Scoring Works" },
  { path: "/scoring/data-cleaning", heading: "How Track Data Cleaning Works" },
  { path: "/scoring/track-validity", heading: "How Track Validity Checks Work" },
] as const;

async function html(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.get(path);
  expect(res.status(), `${path} must serve 200`).toBe(200);
  return res.text();
}

test.describe("prerendered content (no browser)", () => {
  for (const page of PAGES) {
    test(`${page.path} carries its heading, title and description in the HTML`, async ({
      request,
    }) => {
      const body = await html(request, page.path);
      expect(body, "the page's own words, not a JS placeholder").toContain(page.heading);
      // A crawler reads these two before anything else.
      expect(body).toMatch(/<title>[^<]*GlideComp[^<]*<\/title>/);
      expect(body).toMatch(/<meta name="description" content="[^"]{40,}"/);
    });
  }

  test("the GAP page's formulas are prerendered, not rendered in the browser", async ({
    request,
  }) => {
    const body = await html(request, "/scoring/gap");
    // katex.renderToString output: the markup is already here, with the fonts
    // and spans a reader needs.
    expect(body, "KaTeX markup in the served HTML").toContain('class="katex"');
    // …and no KaTeX ENGINE shipped to the browser to produce it. Pulling katex
    // in client-side would mean the formulas are invisible to a crawler and to
    // anybody with JS off, which is the whole reason they are prerendered.
    //
    // Matched on the library, not on any `<script …katex…>`: in dev, Vite
    // serves katex's stylesheet as a module script, so the broader pattern
    // fails here while passing against the built output — a difference in the
    // dev server, not in the page.
    expect(body).not.toMatch(/katex(\.min)?\.js/i);
  });

  test("the scoring index links to every guide and to the published changelog", async ({
    request,
  }) => {
    const body = await html(request, "/scoring");
    for (const guide of [
      "/scoring/gap",
      "/scoring/open-distance",
      "/scoring/data-cleaning",
      "/scoring/track-validity",
    ]) {
      expect(body, `a link to ${guide}`).toContain(`href="${guide}"`);
    }
    // A pilot whose points moved is entitled to read why: the scoring-changes
    // directory is published, and this page is one of the two that link it.
    expect(body).toContain("web/engine/scoring-changes");
  });

  test("the homepage's tabbed charts are ALL in the HTML, not fetched per tab", async ({
    request,
  }) => {
    const body = await html(request, "/");
    // By id rather than by counting `role="tabpanel"`: the page carries more
    // than one tablist, so a total would quietly pass while the charts lost a
    // panel and something else gained one.
    for (let i = 0; i < 6; i++) {
      expect(body, `chart panel cp-${i} prerendered`).toContain(`id="cp-${i}"`);
      expect(body, `its tab ct-${i}`).toContain(`id="ct-${i}"`);
    }
    // The screenshots are content here, not decoration — a crawler that
    // followed the tabs would find nothing without them.
    expect(body).toMatch(/<img[^>]+alt="[^"]{10,}"/);
  });

  test("the FAQ answers are in the HTML, not behind the accordion's JS", async ({
    request,
  }) => {
    const body = await html(request, "/");
    expect(body).toContain("What do I need to run a comp with GlideComp?");
    // The answer text itself, which the accordion only reveals.
    expect(body).toContain("There is no software to install");
  });
});

test.describe("with JavaScript off", () => {
  test.use({ javaScriptEnabled: false });

  test("the homepage still reads: hero, charts and FAQ answers", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { level: 1, name: /See where the race was really won/ })
    ).toBeVisible();
    // `.fade-in` is hidden only under `html.js`, which the enhancement script
    // adds. With no script there is no class, so nothing is invisible — the
    // reveal is an enhancement, never a gate.
    await expect(page.getByText("There is no software to install")).toBeVisible();
    await expect(page.getByRole("tabpanel").first()).toBeVisible();
  });

  test("the GAP guide still shows its formulas", async ({ page }) => {
    await page.goto("/scoring/gap");
    await expect(
      page.getByRole("heading", { level: 1, name: "How GAP Scoring Works" })
    ).toBeVisible();
    await expect(page.locator(".katex").first()).toBeVisible();
  });
});

test.describe("the homepage's vanilla enhancements", () => {
  test("the FAQ accordion opens an answer and says so", async ({ page }) => {
    await page.goto("/");
    const question = page.getByRole("button", {
      name: /What do I need to run a comp with GlideComp\?/,
    });
    await expect(question).toHaveAttribute("aria-expanded", "false");
    await question.click();
    await expect(question).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByText("There is no software to install")).toBeVisible();
  });

  test("the chart tabs move selection to the tab that was pressed", async ({ page }) => {
    await page.goto("/");
    const tabs = page.getByRole("tablist", { name: "Field analysis charts" });
    const first = tabs.getByRole("tab").first();
    const wind = tabs.getByRole("tab", { name: "Wind, leg by leg" });
    await expect(first).toHaveAttribute("aria-selected", "true");

    await wind.click();
    await expect(wind).toHaveAttribute("aria-selected", "true");
    await expect(first).toHaveAttribute("aria-selected", "false");
    // The panel it controls is the one on screen — the tablist sits over a
    // native scroll-snap track, so selection has to move the track too.
    await expect(page.locator("#cp-5")).toBeInViewport();
  });

  test("reveal-on-scroll reveals rather than withholding", async ({ page }) => {
    await page.goto("/");
    // With JS on, `.fade-in` starts hidden and the IntersectionObserver adds
    // `.in`. Anything above the fold must therefore be revealed immediately —
    // a reveal that never fires is a blank homepage.
    const hero = page.locator("h1.fade-in");
    await expect(hero).toHaveClass(/\bin\b/, { timeout: 10_000 });
    await expect(hero).toBeVisible();
  });
});
