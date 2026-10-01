/**
 * No string reaches a DOM XSS sink anywhere in the frontend.
 *
 * The analysis page and the 3D replay are vanilla TS, and until 2026-10 they
 * rendered by assigning HTML strings to `innerHTML`, with `escapeHtml()` at
 * each interpolation that carried outside data. That discipline failed three
 * times in seven weeks — SEC-22 (2026-07-03), SEC-41 (2026-08-12, eight sites
 * that had shipped across three review rounds) and SEC-47 (2026-08-17, a ninth
 * the SEC-41 sweep itself missed) — and this test used to pin a per-file
 * COUNT of the 73 sinks so a new one would at least be noticed.
 *
 * Security review proposal A4 (2026-10-01) retired the pattern instead: those
 * pages render through lit-html templates (src/render-html.ts), whose bindings
 * set text and attribute values on DOM nodes rather than parsing them. So the
 * baseline is now ZERO, everywhere in src/:
 *
 *  1. no `dangerouslySetInnerHTML` under src/react/ (JSX text auto-escapes);
 *  2. no string HTML sink — `innerHTML`/`outerHTML` assignment,
 *     `insertAdjacentHTML`, `setHTML` (Mapbox's popup), `document.write`,
 *     `DOMParser`, `createContextualFragment`, `srcdoc`;
 *  3. none of lit's escape hatches (`unsafeHTML`, `unsafeSVG`, `unsafeMathML`,
 *     `unsafeStatic`), which would hand a string straight back to the parser;
 *  4. `lit-html` itself is imported only by src/render-html.ts, so nothing
 *     reaches lit's diffing `render()` (see that file for why);
 *  5. exactly one Trusted Types policy is created by our code, in
 *     src/trusted-types.ts.
 *
 * If this fails because you need markup: build it with `html\`…\`` and
 * `renderInto()` from src/render-html.ts, and interpolate values plainly.
 * Third-party code that needs a sink (Mapbox's attribution, threebox's
 * tooltips) is covered at runtime by the default policy in trusted-types.ts,
 * and `e2e/trusted-types.spec.ts` loads the pages with Trusted Types enforced.
 *
 * The repo has no ESLint, so like one-kit.test.ts this is a test instead.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

// vitest runs with the workspace root as cwd (web/frontend); import.meta.url
// is a vite-virtual path here, so it can't be used to find the source tree.
const SRC = join(process.cwd(), "src");

/** Each forbidden construct, written so a comment that merely names it can't match. */
const SINKS: ReadonlyArray<readonly [string, RegExp]> = [
  // Assignments (including +=); `(?!=)` keeps comparisons (`===`) out.
  ["innerHTML/outerHTML assignment", /\.(?:innerHTML|outerHTML)\s*\+?=(?!=)/g],
  ["insertAdjacentHTML", /\.insertAdjacentHTML\s*\(/g],
  ["setHTML", /\.setHTML\s*\(/g],
  ["document.write", /\bdocument\.write(?:ln)?\s*\(/g],
  ["DOMParser", /\bnew\s+DOMParser\b|\.parseFromString\s*\(/g],
  ["createContextualFragment", /\.createContextualFragment\s*\(/g],
  ["srcdoc", /\.srcdoc\s*=(?!=)|\bsrcDoc\s*=\s*\{/g],
  ["lit unsafe directive", /\bunsafe(?:HTML|SVG|MathML|Static)\s*\(|lit-html\/(?:directives\/unsafe-|static)/g],
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const rel = (f: string) => f.slice(SRC.length + 1).split(sep).join("/");

describe("no string reaches a DOM XSS sink (security review A4)", () => {
  const files = sourceFiles(SRC);
  const source = new Map(files.map((f) => [rel(f), readFileSync(f, "utf8")]));

  it("finds the source tree", () => {
    expect(source.has("render-html.ts")).toBe(true);
    expect(source.size).toBeGreaterThan(50);
  });

  it("src/react/ has no dangerouslySetInnerHTML", () => {
    const offenders = [...source]
      .filter(([f, text]) => f.startsWith("react/") && text.includes("dangerouslySetInnerHTML"))
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it.each(SINKS.map(([name, re]) => [name, re] as const))("no %s anywhere in src/", (_name, re) => {
    const offenders: string[] = [];
    for (const [f, text] of source) {
      text.split("\n").forEach((line, i) => {
        if (line.match(re)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders, "render markup with html`…` + renderInto() from src/render-html.ts").toEqual([]);
  });

  it("only src/render-html.ts imports lit-html itself", () => {
    const importers = [...source]
      .filter(([, text]) => /from\s+['"]lit-html['"]/.test(text))
      .map(([f]) => f);
    expect(importers).toEqual(["render-html.ts"]);
  });

  it("only src/trusted-types.ts creates a Trusted Types policy", () => {
    const creators = [...source]
      .filter(([, text]) => /\.createPolicy\s*\(/.test(text))
      .map(([f]) => f);
    expect(creators).toEqual(["trusted-types.ts"]);
  });

  // The patterns above must still catch what they are for, or every test in
  // this block passes vacuously.
  it.each([
    ["el.innerHTML = `<b>${name}</b>`;", "innerHTML/outerHTML assignment"],
    ["el.outerHTML += s;", "innerHTML/outerHTML assignment"],
    ["el.insertAdjacentHTML('beforeend', s);", "insertAdjacentHTML"],
    ["new mapboxgl.Popup().setHTML(s);", "setHTML"],
    ["document.write(s);", "document.write"],
    ["new DOMParser().parseFromString(s, 'text/html');", "DOMParser"],
    ["range.createContextualFragment(s);", "createContextualFragment"],
    ["frame.srcdoc = s;", "srcdoc"],
    ["html`${unsafeHTML(s)}`", "lit unsafe directive"],
  ])("detects %s", (snippet, name) => {
    const re = SINKS.find(([n]) => n === name)![1];
    expect(snippet).toMatch(new RegExp(re.source));
  });

  it("does not flag a comparison or a read", () => {
    const re = SINKS[0][1];
    expect("if (el.innerHTML === '') {}").not.toMatch(new RegExp(re.source));
    expect("const s = el.innerHTML;").not.toMatch(new RegExp(re.source));
  });
});
