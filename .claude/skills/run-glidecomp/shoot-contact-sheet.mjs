#!/usr/bin/env bun
// Contact sheet: screenshots every page of the app across theme x width and
// writes an HTML index you scroll through in one pass.
//
// This exists because a restyle is not reviewable as a diff. A token or kit
// change lands on thirty surfaces at once; the only honest way to judge it is
// to look at all of them side by side, in both themes, at both widths.
//
// Prereq: the dev stack is up (`bun run dev`) and comps are seeded
// (`bun run seed`). See SKILL.md.
//
// Usage:
//   LABEL=before bun .claude/skills/run-glidecomp/shoot-contact-sheet.mjs
//   git switch my-branch
//   LABEL=after  bun .claude/skills/run-glidecomp/shoot-contact-sheet.mjs
//   open .claude/skills/run-glidecomp/shots/sheet/index.html
//
// With two labels present the sheet pairs them before/after per shot; with one
// it just lists them. The HTML is regenerated on every run.
//
// Env:
//   LABEL     name for this pass (default "current")
//   BASE_URL  frontend origin (default http://localhost:3000)
//   ONLY      substring filter over route names, e.g. ONLY=settings
//   THEMES    comma list (default "light,dark")
//   WIDTHS    comma list (default "desktop,mobile")

import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const LABEL = process.env.LABEL ?? "current";
const ONLY = process.env.ONLY ?? "";
const SKILL_DIR = dirname(fileURLToPath(import.meta.url));
const SHEET = join(SKILL_DIR, "shots", "sheet");
const OUT = join(SHEET, LABEL);
mkdirSync(OUT, { recursive: true });

const SIZES = {
  desktop: { width: 1440, height: 1000 },
  mobile: { width: 390, height: 844 },
};
const THEMES = (process.env.THEMES ?? "light,dark").split(",");
const WIDTHS = (process.env.WIDTHS ?? "desktop,mobile").split(",");

const die = (m) => {
  console.error(`✗ ${m}`);
  process.exit(1);
};

// ── Resolve real ids. The comp sqid changes on every seed, so nothing here is
//    hardcoded; task and pilot are scraped from the pages that link to them.
const compsRes = await fetch(`${BASE}/api/comp`).catch((e) =>
  die(`GET /api/comp failed — is \`bun run dev\` up? ${e}`)
);
if (!compsRes.ok) die(`GET /api/comp → HTTP ${compsRes.status}`);
const { comps } = await compsRes.json();
const comp = comps?.find((c) => c.name.includes("Corryong")) ?? comps?.[0];
if (!comp) die("no comps — seed first: bun run seed");
const compId = comp.comp_id;
console.log(`→ comp ${comp.name} (${compId})`);

const browser = await chromium.launch();

// A signed-in super-admin sees the most surface: admin pages, the preview
// pill, comp management actions. Anonymous views are a separate concern and
// get their own pass below for the public pages that differ.
const auth = await browser.newContext();
const boot = await auth.newPage();
await boot.goto(`${BASE}/comp`, { waitUntil: "networkidle" });
await boot.evaluate(() =>
  fetch("/api/auth/dev-login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Tushar Pokle", email: "tushar.pokle@gmail.com" }),
    credentials: "include",
  })
);

// `domcontentloaded`, never `networkidle`: the comp/task pages keep a freshness
// poll in flight by design, so networkidle never settles on them.
await boot.goto(`${BASE}/comp/${compId}`, { waitUntil: "domcontentloaded" });
const taskHref = await boot
  .locator(`a[href*="/task/"]`)
  .first()
  .getAttribute("href", { timeout: 20_000 })
  .catch(() => null);
if (!taskHref) die("no task link on the comp page — is the comp seeded with tasks?");

await boot.goto(`${BASE}${taskHref}`, { waitUntil: "domcontentloaded" });
const pilotHref = await boot
  .locator(`a[href*="/pilot/"]`)
  .first()
  .getAttribute("href", { timeout: 20_000 })
  .catch(() => null);
await boot.close();
console.log(`→ task ${taskHref}`);
console.log(`→ pilot ${pilotHref ?? "(none found — report card will be skipped)"}`);

// ── The routes. Name → path. Ordered so the sheet reads as a tour of the app.
const ROUTES = [
  ["home", "/"],
  ["about", "/about"],
  ["scoring", "/scoring"],
  ["scoring-gap", "/scoring/gap"],
  ["competitions", "/comp"],
  ["comp-detail", `/comp/${compId}`],
  ["comp-scores", `/comp/${compId}/scores`],
  ["comp-pilots", `/comp/${compId}/pilots`],
  ["comp-waypoints", `/comp/${compId}/waypoints`],
  ["comp-analysis", `/comp/${compId}/analysis`],
  ["task-detail", taskHref],
  ["task-analysis", `/comp/${compId}/analysis/task/${taskHref.split("/task/")[1]}`],
  ...(pilotHref ? [["report-card", pilotHref]] : []),
  ["dashboard", "/u/me"],
  ["submit", "/submit"],
  ["settings", "/settings"],
  ["admin-users", "/admin/users"],
  ["admin-cache", "/admin/cache"],
  ["not-found", "/comp/definitely-not-a-real-comp"],
].filter(([name]) => !ONLY || name.includes(ONLY));

const shots = [];
const problems = [];

for (const width of WIDTHS) {
  for (const theme of THEMES) {
    const ctx = await browser.newContext({
      viewport: SIZES[width],
      deviceScaleFactor: 2,
      storageState: await auth.storageState(),
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(String(e)));

    // Theme is a device-local localStorage preference shared with the static
    // pages; set it on the origin before any navigation so nothing flashes.
    await page.goto(`${BASE}/comp`, { waitUntil: "domcontentloaded" });
    await page.evaluate((t) => localStorage.setItem("glidecomp-theme", t), theme);

    for (const [name, path] of ROUTES) {
      const file = `${name}-${width}-${theme}.png`;
      try {
        await page.goto(`${BASE}${path}`, {
          // networkidle never settles on pages with a freshness poller.
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });
        // Give client-rendered content (scores, analysis) a chance to land.
        await page.waitForTimeout(2500);
        await page.screenshot({ path: join(OUT, file), fullPage: true });
        shots.push({ name, width, theme, file, path });
        process.stdout.write(".");
      } catch (e) {
        problems.push(`${name} ${width}/${theme}: ${String(e).split("\n")[0]}`);
        process.stdout.write("!");
      }
    }
    if (errors.length) {
      // Console noise is per-context, not per-shot, so report it as a set.
      problems.push(
        `console (${width}/${theme}): ${[...new Set(errors)].slice(0, 5).join(" | ")}`
      );
    }
    await ctx.close();
  }
}
await auth.close();
await browser.close();
console.log();

// ── Build the index over every label present, so before/after pair up.
const labels = readdirSync(SHEET, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort((a, b) => (a === "before" ? -1 : b === "before" ? 1 : a.localeCompare(b)));

const names = [...new Set(shots.map((s) => s.name))];
const rows = [];
for (const name of names) {
  for (const width of WIDTHS) {
    for (const theme of THEMES) {
      const file = `${name}-${width}-${theme}.png`;
      const cells = labels
        .filter((l) => existsSync(join(SHEET, l, file)))
        .map(
          (l) =>
            `<figure><figcaption>${l}</figcaption><a href="${l}/${file}" target="_blank"><img loading="lazy" src="${l}/${file}"></a></figure>`
        )
        .join("");
      if (cells) rows.push(`<section><h2>${name} · ${width} · ${theme}</h2><div class="pair">${cells}</div></section>`);
    }
  }
}

writeFileSync(
  join(SHEET, "index.html"),
  `<!doctype html><meta charset=utf8><title>GlideComp contact sheet</title>
<style>
 :root{color-scheme:light dark}
 body{margin:0;padding:24px;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;background:#f2f2f7;color:#1d1d1f}
 @media(prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}}
 h1{font-size:20px;margin:0 0 4px}
 .meta{opacity:.6;margin-bottom:24px}
 section{margin:0 0 32px}
 h2{font:600 11px/1 ui-monospace,monospace;letter-spacing:.08em;text-transform:uppercase;opacity:.6;margin:0 0 8px}
 .pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr));gap:16px;align-items:start}
 figure{margin:0}
 figcaption{font:600 11px/1 ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;opacity:.5;margin-bottom:6px}
 img{width:100%;border-radius:10px;border:1px solid rgba(128,128,128,.35);background:#fff}
 @media(prefers-color-scheme:dark){img{background:#111}}
</style>
<h1>GlideComp contact sheet</h1>
<div class=meta>labels: ${labels.join(" · ")} — ${names.length} pages x ${WIDTHS.length} widths x ${THEMES.length} themes</div>
${rows.join("\n")}`
);

console.log(`→ ${shots.length} shots into shots/sheet/${LABEL}/`);
console.log(`→ sheet: ${join(SHEET, "index.html")}`);
if (problems.length) {
  console.log(`\n⚠ ${problems.length} problem(s):`);
  for (const p of problems) console.log("  ", p);
}
