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
 * RED has the same split, for the same reason. `--destructive` (iOS system
 * red) is the fill and the mark: an invalid field's border, the wash behind a
 * destructive button. As text it was 3.55:1 on a card in light, which is what
 * every field's error message was, and the label of a destructive button sat
 * on a wash of its own colour at 2.80:1 (3.60:1 in a dark confirm dialog).
 * `--danger` is red wherever it is TEXT. In classes: `bg-destructive/10` and
 * `text-danger`.
 *
 * This is two guards for each colour. The first holds the numbers, so a new
 * shade cannot quietly go back under the line. The second keeps the fill from
 * being used as text, which is the mistake a single token invites.
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
/** `bg-primary/NN` or `bg-destructive/NN` over a surface: the fill at that opacity. */
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

/**
 * The washes of the red fill that carry red text, as the kit writes them. A
 * destructive button is `bg-destructive/10`, and `/20` hovered; on dark it is
 * `/20`, and `/30` hovered (rac/button.tsx). A badge and a chip are the
 * resting washes (rac/badge.tsx). Contrast only falls as a wash gets
 * stronger, so the strongest per theme is the one that decides.
 */
const RED_WASH = { ":root": [0.1, 0.2], ".dark": [0.1, 0.2, 0.3] } as const;

describe.each([":root", ".dark"] as const)("red contrast in %s", (selector) => {
  const t = tokens(selector);
  // A dialog's footer, where a confirm's destructive button sits:
  // `bg-muted/50` on the popover (rac/dialog.tsx).
  const under: Record<string, Rgb> = {
    "the ground": t.background,
    "a card": t.card,
    "a dialog's footer": wash(t.muted, 0.5, t.popover),
  };

  it.each(["background", "card", "popover", "muted", "secondary", "accent"])(
    "red text reads on --%s",
    (surface) => {
      expect(contrast(t.danger, t[surface])).toBeGreaterThanOrEqual(AA);
    }
  );

  it.each(
    RED_WASH[selector].flatMap((alpha) =>
      Object.keys(under).map((where) => [`${alpha * 100}%`, where, alpha] as const)
    )
  )("red text reads on a %s wash of the fill over %s", (_label, where, alpha) => {
    expect(
      contrast(t.danger, wash(t.destructive, alpha, under[where]))
    ).toBeGreaterThanOrEqual(AA);
  });

  // rac/alert.tsx draws a destructive alert's description as `text-danger/90`.
  it("an alert's description, the text red at 90%, reads on a card", () => {
    expect(contrast(wash(t.danger, 0.9, t.card), t.card)).toBeGreaterThanOrEqual(AA);
  });

  // The fill stays what it was because a mark needs 3:1, not 4.5:1 (WCAG
  // 1.4.11): an invalid field's border is `border-destructive`.
  it.each(["background", "card"])("the fill is still a mark on --%s", (surface) => {
    expect(contrast(t.destructive, t[surface])).toBeGreaterThanOrEqual(3);
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

const SOURCES = [join(ROOT, "src"), join(ROOT, "static", "src")]
  .flatMap(sourceFiles)
  .filter((f) => !f.endsWith("accent-text.test.ts"));

describe("a fill is not used as text", () => {
  it.each([
    ["primary", "link"],
    ["destructive", "danger"],
  ])("no `text-%s` class and no `color: var(--…)` of it: use `text-%s`", (fill, text) => {
    // `text-primary-foreground` is the label ON the fill, and is right.
    const asClass = new RegExp(`\\btext-${fill}(?![-\\w])`);
    // A stylesheet's own rule: the home page writes its styles by hand.
    const asProperty = new RegExp(`(?<![-\\w])color:\\s*var\\(--${fill}\\)`);

    const offenders = SOURCES.filter((f) => {
      const source = readFileSync(f, "utf8");
      return asClass.test(source) || asProperty.test(source);
    }).map((f) => f.slice(ROOT.length + 1));

    expect(offenders, `use text-${text} / var(--${text})`).toEqual([]);
  });
});

describe("no wash of the red fill is stronger than the ones held above", () => {
  // Red text on a stronger wash than these has not been measured. Raise the
  // list in RED_WASH with the class, and the tests above say if it still reads.
  it("every `bg-destructive/NN` is one of the washes red text is held on", () => {
    const strongest = { light: Math.max(...RED_WASH[":root"]), dark: Math.max(...RED_WASH[".dark"]) };
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const source = readFileSync(f, "utf8");
      for (const m of source.matchAll(/((?:[\w-]+:)*)bg-destructive\/(\d+)/g)) {
        // A `dark:` wash is drawn on dark only; any other is drawn on both.
        const limit = m[1].includes("dark:") ? strongest.dark : strongest.light;
        if (Number(m[2]) / 100 > limit) offenders.push(`${f.slice(ROOT.length + 1)}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
