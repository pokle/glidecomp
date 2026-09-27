/**
 * The CSP is enforced, so two drifts would break the site rather than just
 * log (see security-headers.ts):
 *
 *  1. public/_headers is a literal copy of SECURITY_HEADERS (Pages reads that
 *     file itself and it can't import). A copy edited alone would give static
 *     pages one policy and the SSR'd /comp pages another.
 *  2. An inline script or `on*=` handler in a page source. The SSR e2e suite
 *     catches this too, in a browser — this is the fast, no-stack version.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { SECURITY_HEADERS } from "./security-headers";
import { findInlineScripts } from "./inline-script-scan";

const FRONTEND = join(__dirname, "..");

function headersBlock(path: string): Record<string, string> {
  const lines = readFileSync(join(FRONTEND, "public/_headers"), "utf8").split("\n");
  const start = lines.indexOf(path);
  expect(start, `no ${path} block in public/_headers`).toBeGreaterThanOrEqual(0);
  const out: Record<string, string> = {};
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    const i = line.indexOf(":");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function walk(dir: string, ext: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "dist" ? [] : walk(p, ext);
    return ext.test(e.name) ? [p] : [];
  });
}

describe("security headers", () => {
  test("public/_headers carries exactly SECURITY_HEADERS for /*", () => {
    const expected = Object.entries(SECURITY_HEADERS)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    expect(
      headersBlock("/*"),
      `public/_headers has drifted from src/security-headers.ts — replace the /* block with:\n${expected}`
    ).toEqual(SECURITY_HEADERS);
  });

  test("the CSP is enforced, not report-only", () => {
    expect(SECURITY_HEADERS["Content-Security-Policy"]).toMatch(/script-src 'self'/);
    expect(SECURITY_HEADERS).not.toHaveProperty("Content-Security-Policy-Report-Only");
  });
});

describe("page sources carry no inline script", () => {
  const sources = [
    ...walk(join(FRONTEND, "src"), /\.html$/),
    ...walk(join(FRONTEND, "static/src"), /\.astro$/),
  ];

  test("there are page sources to scan", () => {
    expect(sources.length).toBeGreaterThan(5);
  });

  test.each(sources.map((p) => [relative(FRONTEND, p), p]))("%s", (_name, path) => {
    let html = readFileSync(path, "utf8");
    // An Astro <script> without is:inline is bundled into a file (and
    // assetsInlineLimit stops it being inlined back), so only is:inline
    // scripts are what they look like.
    if (path.endsWith(".astro")) {
      html = html.replace(/<script(?![^>]*\bis:inline)(\b[^>]*)>[\s\S]*?<\/script>/g, "");
    }
    expect(
      findInlineScripts(html),
      "the enforced CSP (script-src 'self') refuses these — move the code to a " +
        "file, or wire a listener instead of an on*= attribute; see " +
        "src/security-headers.ts"
    ).toEqual([]);
  });
});

describe("findInlineScripts", () => {
  test("flags executable inline scripts and handlers, not files or data", () => {
    const found = findInlineScripts(`
      <script>alert(1)</script>
      <script type="module">go()</script>
      <script src="/a.js"></script>
      <script type="application/json" id="x">{"a":1}</script>
      <script type="application/ld+json">{}</script>
      <!-- <script>commented()</script> -->
      <button onclick="x()">x</button>
      <p data-onclick="y">Depends on= nothing</p>
    `);
    expect(found.map((f) => f.kind)).toEqual(["inline-script", "inline-script", "event-handler"]);
  });
});
