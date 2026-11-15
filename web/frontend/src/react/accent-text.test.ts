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
 * AMBER and GREEN were never tokens: the app wrote Tailwind's palette
 * straight into its classes, `text-amber-500` at 2.13:1 for every warning and
 * `text-green-600` at 3.22:1 across the analysis page. They are pairs now too:
 * `--warning` and `--success` are the fills, `--caution` and `--positive` the
 * text. In classes: `bg-warning/10 text-caution`, `bg-success/15 text-positive`.
 *
 * This is two guards for each colour. The first holds the numbers, so a new
 * shade cannot quietly go back under the line. The second keeps the fill from
 * being used as text, which is the mistake a single token invites. A third
 * guard keeps Tailwind's palette out, so a colour cannot arrive unmeasured.
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
/** `bg-primary/NN`, `bg-destructive/NN` and so on over a surface: the fill at that opacity. */
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
 * Red, amber and green: a fill, the text that goes with it, and every wash of
 * the fill the app draws under that text. Contrast only falls as a wash gets
 * stronger, so the strongest per theme is the one that decides.
 *
 * - Red. A destructive button is `bg-destructive/10`, and `/20` hovered; on
 *   dark it is `/20`, and `/30` hovered (rac/button.tsx). A badge and a chip
 *   are the resting washes. It sits on the ground, on a card and in a
 *   dialog's footer.
 * - Amber. A notice box is `bg-warning/5` or `/10`, a chip `/10` or `/15`. A
 *   chip sits in a list's row, and a row turns `--muted` when hovered.
 * - Green. The analysis page's Goal banner is `bg-success/15` and a climb's
 *   rank is 20% of the fill mixed with a card (analysis.css).
 */
type Theme = ":root" | ".dark";
const TONES = [
  {
    name: "red",
    fill: "destructive",
    text: "danger",
    washes: { ":root": [0.1, 0.2], ".dark": [0.1, 0.2, 0.3] },
    under: ["the ground", "a card", "a dialog's footer"],
  },
  {
    name: "amber",
    fill: "warning",
    text: "caution",
    washes: { ":root": [0.05, 0.1, 0.15], ".dark": [0.05, 0.1, 0.15] },
    under: ["the ground", "a card", "a hovered row"],
  },
  {
    name: "green",
    fill: "success",
    text: "positive",
    washes: { ":root": [0.15, 0.2], ".dark": [0.15, 0.2] },
    under: ["the ground", "a card", "a hovered row"],
  },
] as const;

describe.each(
  TONES.flatMap((tone) => ([":root", ".dark"] as const).map((selector) => [tone.name, selector, tone] as const))
)("%s contrast in %s", (_name, selector, tone) => {
  const t = tokens(selector);
  const surface: Record<string, Rgb> = {
    "the ground": t.background,
    "a card": t.card,
    // `bg-muted/50` on the popover (rac/dialog.tsx), where a confirm's
    // destructive button sits.
    "a dialog's footer": wash(t.muted, 0.5, t.popover),
    "a hovered row": t.muted,
  };
  const text = t[tone.text];
  const fill = t[tone.fill];

  it.each(["background", "card", "popover", "muted", "secondary", "accent"])(
    `${tone.name} text reads on --%s`,
    (name) => {
      expect(contrast(text, t[name])).toBeGreaterThanOrEqual(AA);
    }
  );

  it.each(
    tone.washes[selector].flatMap((alpha) =>
      tone.under.map((where) => [`${alpha * 100}%`, where, alpha] as const)
    )
  )(`${tone.name} text reads on a %s wash of the fill over %s`, (_label, where, alpha) => {
    expect(contrast(text, wash(fill, alpha, surface[where]))).toBeGreaterThanOrEqual(AA);
  });
});

describe.each([":root", ".dark"] as const)("red's own cases in %s", (selector) => {
  const t = tokens(selector);

  // rac/alert.tsx draws a destructive alert's description as `text-danger/90`.
  it("an alert's description, the text red at 90%, reads on a card", () => {
    expect(contrast(wash(t.danger, 0.9, t.card), t.card)).toBeGreaterThanOrEqual(AA);
  });

  // The fill stays what it was because a mark needs 3:1, not 4.5:1 (WCAG
  // 1.4.11). An invalid field's border is `border-destructive`, and so is the
  // focus border of a destructive button, which also sits in a dialog's footer.
  it.each([
    ["the ground", (x: Record<string, Rgb>) => x.background],
    ["a card", (x: Record<string, Rgb>) => x.card],
    ["a dialog's footer", (x: Record<string, Rgb>) => wash(x.muted, 0.5, x.popover)],
  ] as const)("the fill is a mark on %s", (_where, surface) => {
    expect(contrast(t.destructive, surface(t))).toBeGreaterThanOrEqual(3);
  });
});

// The analysis page (/analysis.html) never sets `.dark`, so it is drawn with
// the light tokens only. Two of its surfaces are washes of the ACCENT fill
// with coloured text of another tone on them.
describe("the analysis page's own surfaces", () => {
  const t = tokens(":root");

  // A turnpoint's number is `bg-primary/10` with its type's colour: blue for
  // a turnpoint, green for the start, amber for the end of the speed section.
  it.each(["link", "positive", "caution"])("--%s reads on a turnpoint's number", (text) => {
    expect(contrast(t[text], wash(t.primary, 0.1, t.card))).toBeGreaterThanOrEqual(AA);
  });

  // A selected climb or sink is `bg-primary/20`, with its gain or drop written
  // on it. Its rank is not: a rank's bubble is its fill mixed with a card, so
  // it is the wash over a card that the tests above hold, in every state.
  it.each(["positive", "danger"])("--%s reads on a selected item", (text) => {
    expect(contrast(t[text], wash(t.primary, 0.2, t.card))).toBeGreaterThanOrEqual(AA);
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
const relative = (f: string) => f.slice(ROOT.length + 1);

describe("a fill is not used as text", () => {
  it.each([
    ["primary", "link"],
    ["destructive", "danger"],
    ["warning", "caution"],
    ["success", "positive"],
  ])("no `text-%s` class and no `color: var(--…)` of it: use `text-%s`", (fill, text) => {
    // `text-primary-foreground` is the label ON the fill, and is right.
    const asClass = new RegExp(`\\btext-${fill}(?![-\\w])`);
    // A stylesheet's own rule: the home page writes its styles by hand.
    const asProperty = new RegExp(`(?<![-\\w])color:\\s*var\\(--${fill}\\)`);

    const offenders = SOURCES.filter((f) => {
      const source = readFileSync(f, "utf8");
      return asClass.test(source) || asProperty.test(source);
    }).map(relative);

    expect(offenders, `use text-${text} / var(--${text})`).toEqual([]);
  });
});

describe("no wash of a fill is stronger than the ones held above", () => {
  // Text on a stronger wash than these has not been measured. Raise the list
  // in TONES with the class, and the tests above say if it still reads.
  it.each(TONES.map((tone) => [tone.fill, tone] as const))(
    "every wash of --%s is one its text is held on",
    (fill, tone) => {
      const strongest: Record<Theme, number> = {
        ":root": Math.max(...tone.washes[":root"]),
        ".dark": Math.max(...tone.washes[".dark"]),
      };
      // `bg-destructive/20`, and a rule's own `color-mix(…, var(--destructive) 20%, …)`.
      const asClass = new RegExp(`((?:[\\w-]+:)*)bg-${fill}\\/(\\d+)`, "g");
      const asMix = new RegExp(`()var\\(--${fill}\\)\\s+(\\d+)%`, "g");
      const offenders: string[] = [];
      for (const f of SOURCES) {
        const source = readFileSync(f, "utf8");
        for (const m of [...source.matchAll(asClass), ...source.matchAll(asMix)]) {
          // A `dark:` wash is drawn on dark only; any other is drawn on both.
          const limit = strongest[m[1].includes("dark:") ? ".dark" : ":root"];
          if (Number(m[2]) / 100 > limit) offenders.push(`${relative(f)}: ${m[0]}`);
        }
      }
      expect(offenders).toEqual([]);
    }
  );
});

describe("a destructive button's focus ring", () => {
  // Its border was `border-destructive/40` and its ring `/20`: 1.68:1 against
  // the page, where a focus indicator needs 3:1. The border is the fill at
  // full strength now, which "the fill is a mark" above holds at 3:1.
  it("no focus border is a translucent red", () => {
    const offenders = SOURCES.filter((f) =>
      /focus(?:-visible|ed)?:border-destructive\/\d/.test(readFileSync(f, "utf8"))
    ).map(relative);
    expect(offenders).toEqual([]);
  });
});

describe("no colour arrives unmeasured", () => {
  // Tailwind's palette (`text-amber-500`, `bg-green-500/20`) and the chart
  // tones as text (`text-chart-2`) are how amber and green came to be under
  // 4.5:1 with nothing to say so. A colour that carries text is a token in
  // globals.css, where the tests above can see it.
  const HUES =
    "red|rose|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink";
  const PALETTE = new RegExp(`\\b(?:text|bg|border|ring)-(?:${HUES})-\\d{2,3}\\b|\\btext-chart-\\d`, "g");
  // The 3D replay (/replay) is its own surface with its own theme, in
  // replay.css and inline; accessibility-standard.md §2 says so.
  const OWN_THEME = /^src\/replay[./]/;
  // The "Last used" pill on the sign-in page is near-black on a solid
  // highlighter yellow, the same in both themes, and well past 4.5:1.
  const ALLOWED: Record<string, string[]> = {
    "src/react/pages/SignIn.tsx": ["border-yellow-400", "bg-yellow-300", "text-yellow-950"],
  };

  it("no Tailwind palette colour, and no chart tone as text", () => {
    const offenders: string[] = [];
    for (const f of SOURCES) {
      const file = relative(f);
      if (OWN_THEME.test(file)) continue;
      for (const m of readFileSync(f, "utf8").matchAll(PALETTE)) {
        if (!ALLOWED[file]?.includes(m[0])) offenders.push(`${file}: ${m[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * Text dimmed by opacity: `text-foreground/60`, `text-muted-foreground/80`.
 *
 * A token can hold 4.5:1 at full strength and lose it at a reduced opacity,
 * and nothing above looks at that. An unselected tab's label was
 * `text-foreground/60` on the strip's `--muted`: 4.16:1 in light, on every
 * tab strip in the app, while every token in it passed. Lower a token's
 * opacity and this measures it, on every surface in both themes.
 *
 * Text that marks something INACTIVE is exempt (WCAG 1.4.3 says so), and so
 * is an icon, which is not text. Each one is listed below with its reason.
 * Text on a ground of its own (the analysis map's HUD is `text-white/60` on a
 * translucent card over the map) has no token to measure against, so a class
 * that is not a token is left alone here.
 */
describe("text is not dimmed below 4.5:1", () => {
  const SURFACES = ["background", "card", "popover", "muted", "secondary", "accent"];
  const EXEMPT: Record<string, Record<string, string>> = {
    "src/react/rac/date-picker.impl.tsx": {
      // react-aria disables a day outside the month (useCalendarCell), so
      // the calendar draws it dimmed as an inactive control.
      "text-muted-foreground/40": "a day outside the month, which cannot be chosen",
    },
    "src/analysis/task-editor.ts": {
      "text-muted-foreground/50": "the drag grip, an icon beside a turnpoint's name",
    },
  };
  // A class drawn on fewer surfaces than all six names them, and the tests
  // above hold it there.
  const DRAWN_ON: Record<string, string[]> = {
    // rac/alert.tsx: a destructive alert's description, on its card.
    "text-danger/90": ["card"],
  };
  const DIMMED = /((?:[\w-]+:)*)text-([a-z][a-z-]*)\/(\d+)\b/g;

  it("every dimmed text colour holds 4.5:1 on every surface it can sit on", () => {
    const themes = { ":root": tokens(":root"), ".dark": tokens(".dark") };
    const offenders: string[] = [];
    let measured = 0;
    for (const f of SOURCES) {
      const file = relative(f);
      for (const m of readFileSync(f, "utf8").matchAll(DIMMED)) {
        const [, variants, token] = m;
        const cls = `text-${token}/${m[3]}`;
        if (!(token in themes[":root"])) continue; // not a token: see above
        if (EXEMPT[file]?.[cls]) continue;
        measured++;
        const alpha = Number(m[3]) / 100;
        // A `dark:` class is drawn on dark only; any other is drawn on both.
        const selectors = variants.includes("dark:") ? [".dark"] : [":root", ".dark"];
        for (const selector of selectors as Theme[]) {
          const t = themes[selector];
          for (const surface of DRAWN_ON[cls] ?? SURFACES) {
            const ratio = contrast(wash(t[token], alpha, t[surface]), t[surface]);
            if (ratio < AA) {
              offenders.push(`${file}: ${cls} is ${ratio.toFixed(2)}:1 on --${surface} in ${selector}`);
            }
          }
        }
      }
    }
    expect(measured, "the scan found the dimmed text it is meant to measure").toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });

  it("every exemption still names a class the file uses", () => {
    const stale = Object.entries(EXEMPT).flatMap(([file, classes]) => {
      const source = readFileSync(join(ROOT, file), "utf8");
      return Object.keys(classes)
        .filter((cls) => !source.includes(cls))
        .map((cls) => `${file}: ${cls}`);
    });
    expect(stale).toEqual([]);
  });
});
