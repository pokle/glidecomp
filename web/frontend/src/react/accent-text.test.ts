/**
 * The accent is two colours: a FILL and a TEXT colour.
 *
 * Until 2026-11 it was one, iOS system blue, and it did both jobs badly. As a
 * fill it carried a white label at 4.02:1 in light and 3.65:1 in dark. As text
 * it was 3.60:1 on the grey ground and 3.04:1 on its own 20% wash. The
 * accessibility standard (docs/accessibility-standard.md §3.1) asks 4.5:1 of
 * text, and every Save, Create and Sign in button in the app was under it.
 *
 * One colour cannot do both: a blue light enough to fill a button is too light
 * to read as text on a light surface, and on dark it is the other way round.
 * So `--primary` is the fill, with `--primary-foreground` as its label, and
 * `--link` is the accent wherever it is TEXT (or a tick, which may as well
 * pass too). In classes: `bg-primary` and `text-link`.
 *
 * This is two guards. The first holds the numbers, so a new shade of blue
 * cannot quietly go back under the line. The second keeps the fill from being
 * used as text, which is the mistake the old single token invited.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// vitest runs with the workspace root as cwd (web/frontend).
const ROOT = process.cwd();
const CSS = readFileSync(join(ROOT, "src/react/globals.css"), "utf8");

type Rgb = [number, number, number];

/** The `#rrggbb` tokens declared in one block of globals.css. */
function tokens(selector: ":root" | ".dark"): Record<string, Rgb> {
  const start = CSS.indexOf(`\n${selector} {`);
  expect(start, `${selector} block in globals.css`).toBeGreaterThan(-1);
  const block = CSS.slice(start, CSS.indexOf("\n}", start));
  const out: Record<string, Rgb> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*#([0-9a-f]{6})\s*;/gi)) {
    const n = parseInt(m[2], 16);
    out[m[1]] = [n >> 16, (n >> 8) & 255, n & 255];
  }
  return out;
}

/** WCAG 2 relative luminance and contrast ratio. */
function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** `bg-primary/NN` over a surface: the fill at that opacity. */
function wash(fill: Rgb, alpha: number, under: Rgb): Rgb {
  return fill.map((c, i) => c * alpha + under[i] * (1 - alpha)) as Rgb;
}

const AA = 4.5;

describe.each([":root", ".dark"] as const)("accent contrast in %s", (selector) => {
  const t = tokens(selector);

  it("the fill holds its label", () => {
    expect(contrast(t["primary-foreground"], t.primary)).toBeGreaterThanOrEqual(AA);
  });

  it.each(["background", "card", "popover", "muted", "secondary", "accent"])(
    "accent text reads on --%s",
    (surface) => {
      expect(contrast(t.link, t[surface])).toBeGreaterThanOrEqual(AA);
    }
  );

  // A chip is accent text on a wash of the fill: `bg-primary/10 text-link`,
  // and `bg-primary/20` on the analysis page's active filter.
  it.each([
    ["10%", 0.1, "card"],
    ["10%", 0.1, "background"],
    ["20%", 0.2, "card"],
  ] as const)("accent text reads on a %s wash of the fill over --%s", (_label, alpha, surface) => {
    expect(contrast(t.link, wash(t.primary, alpha, t[surface]))).toBeGreaterThanOrEqual(AA);
  });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.(tsx?|css|html|astro)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("the fill is not used as text", () => {
  // `text-primary-foreground` is the label ON the fill, and is right.
  const AS_CLASS = /\btext-primary(?![-\w])/;
  // A stylesheet's own rule: the home page writes its styles by hand.
  const AS_PROPERTY = /(?<![-\w])color:\s*var\(--primary\)/;

  it("no `text-primary` class and no `color: var(--primary)`: use `text-link` / `var(--link)`", () => {
    const offenders = [join(ROOT, "src"), join(ROOT, "static", "src")]
      .flatMap(sourceFiles)
      .filter((f) => !f.endsWith("accent-text.test.ts"))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return AS_CLASS.test(text) || AS_PROPERTY.test(text);
      })
      .map((f) => f.slice(ROOT.length + 1));

    expect(offenders).toEqual([]);
  });
});
