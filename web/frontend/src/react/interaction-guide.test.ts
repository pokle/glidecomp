/**
 * Patterns of docs/interaction-guide.md that had no owner in code and no test
 * (its Part 9, item 4, until 2026-11): each depended on every page
 * remembering it, which is how the bar's back control drifted until #901.
 *
 * Each check below reads the source. Where a check carries a list (the words
 * on a commit button, what each icon means, the buttons a page draws), the
 * list is the record: a change that adds to it is a decision, made in the
 * diff where a reviewer sees it, and never an accident.
 *
 * Same shape as `no-overlays.test.ts` and `one-kit.test.ts`: tests, because
 * the repo has no ESLint.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// vitest runs with the workspace root as cwd (web/frontend).
const FRONTEND = process.cwd();
const REACT = join(FRONTEND, "src", "react");

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

const FILES = sourceFiles(REACT).map((path) => ({
  path: relative(REACT, path),
  src: readFileSync(path, "utf8"),
}));

/** Source with its comments blanked, so a rule quoted in a comment is not a hit. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
}

// ---------------------------------------------------------------------------
// 5.6 Button wording
// ---------------------------------------------------------------------------

/** The four words of the guide. A commit button's label starts with one. */
const COMMIT_WORDS = ["Save", "Create", "Add", "Done"];

/**
 * A commit that sends, imports or fetches is named for that act (the guide's
 * 5.6, owner's decision 2026-11-24). These are the four, and where each is.
 * A fifth is a new word for the owner to rule on: wording is the owner's call
 * (CLAUDE.md, "Propose UI wording before you change it").
 */
const OTHER_COMMIT_WORDS: Record<string, string> = {
  Submit: "Submit track: the track goes to the organiser; nothing of the reader's is saved",
  Import: "Roster import: brings in the rows read from a CSV",
  Fill: "Roster: fills pilots' details from the CIVL rankings, as the row that opens it says",
  Load: "Fetches a route from XContest into the draft, and can fail; its page saves it later",
};

/** Every commit button's label, as the source spells it. */
function commitLabels(): { file: string; label: string }[] {
  const found: { file: string; label: string }[] = [];
  for (const { path, src } of FILES) {
    if (path === "pages/KitFormFixture.tsx") continue; // the kit form's bench
    const text = code(src);
    // submitLabel="…" on a SettingsForm, and commit="…" on a roster page.
    for (const m of text.matchAll(/\b(?:submitLabel|commit)=(?:"([^"]+)"|\{[^}]*?[`"]([A-Z][a-z]+)[^}]*\})/g)) {
      found.push({ file: path, label: m[1] ?? m[2]! });
    }
    // A button drawn in the bar's commit slot: its text is its label.
    for (const m of text.matchAll(/<(?:SubmitButton|Button)\b[^>]*className=\{commitClass\}[^>]*>\s*(?:\{[^}]*\}\s*)?([A-Z][A-Za-z ]*?)\s*</g)) {
      found.push({ file: path, label: m[1]! });
    }
  }
  return found;
}

describe("5.6: the words on a commit button", () => {
  const labels = commitLabels();

  it("finds the commit buttons", () => {
    // If the patterns above stop matching, this check would pass on nothing.
    expect(labels.length).toBeGreaterThan(12);
  });

  it("each says Save, Create, Add or Done, or is a listed exception", () => {
    const allowed = [...COMMIT_WORDS, ...Object.keys(OTHER_COMMIT_WORDS)];
    const wrong = labels.filter(
      ({ label }) => !allowed.some((word) => label === word || label.startsWith(`${word} `))
    );
    expect(wrong).toEqual([]);
  });

  it("every listed exception is still in use", () => {
    const unused = Object.keys(OTHER_COMMIT_WORDS).filter(
      (word) => !labels.some(({ label }) => label === word || label.startsWith(`${word} `))
    );
    expect(unused).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5.5 One icon, one meaning
// ---------------------------------------------------------------------------

/**
 * What each icon means on a ⋯ row, a nav row or a section box, and the labels
 * that carry it. This is the full list; the table in the guide's 5.5 is the
 * part of it a reader needs.
 *
 * A label is written as the source writes it: a string, or the name of the
 * constant or the expression that holds it.
 *
 * To use an icon for a new row, add the row's label under the icon whose
 * meaning it shares. If no meaning fits, the row needs an icon of its own.
 */
const ICON_MEANINGS: Record<string, { means: string; labels: string[] }> = {};

/** Each `icon: SomeIcon` beside a `label:` in the same object literal. */
function iconUses(): { icon: string; label: string; file: string }[] {
  const uses: { icon: string; label: string; file: string }[] = [];
  for (const { path, src } of FILES) {
    const lines = code(src).split("\n");
    lines.forEach((line, i) => {
      const icon = /\bicon: ([A-Z]\w*Icon)\b/.exec(line)?.[1];
      if (!icon || icon === "LucideIcon") return;
      // The label is a property of the same object: look a few lines either
      // side, nearest first, and stop at the object's own braces.
      let label: string | undefined;
      for (let d = 0; d <= 8 && !label; d++) {
        for (const j of [i - d, i + d]) {
          // A string, a template, or an expression up to the property's end.
          const m = /\blabel: (?:"([^"]*)"|(`[^`]*`)|([^,{}]+?))\s*(?:,|\}|$)/.exec(lines[j] ?? "");
          if (m) {
            label = (m[1] ?? m[2] ?? m[3])!.trim();
            break;
          }
        }
      }
      uses.push({ icon, label: label ?? "(no label found)", file: path });
    });
  }
  return uses;
}

// Filled in below, so the meanings read as one table.
Object.assign(ICON_MEANINGS, {
  MapIcon: {
    means: "Opens tracks on a map, the 3D replay included",
    labels: ["Climbs and glides", "All tracks", "Replay the task in 3D"],
  },
  ChartColumnIcon: {
    means: "Task analysis and comp analysis, and nothing else",
    labels: ["COMP_ANALYSIS_LABEL", "TASK_ANALYSIS_LABEL"],
  },
  ShareIcon: { means: "Sharing", labels: ["Share task"] },
  QrCodeIcon: { means: "Sharing, as a QR code", labels: ["QR code", 'showQR ? "Hide QR" : "QR code"'] },
  CloudUploadIcon: { means: "Submit your track", labels: ["Submit your track"] },
  PlusIcon: { means: "Make a new one", labels: ["New task", "Add waypoint"] },
  CopyIcon: {
    means: "Copy between competitions",
    labels: ["Copy from another competition…", "Copy to a new competition…"],
  },
  SettingsIcon: { means: "Settings", labels: ["Settings", "Task settings"] },
  ImportIcon: {
    means: "Bring a file in",
    labels: ["Import CSV…", "Import .xctsk…", "Upload file"],
  },
  DownloadIcon: { means: "Take a file out", labels: ["Export .xctsk"] },
  FileSpreadsheetIcon: {
    means: "Take a CSV out",
    labels: ["Export CSV", "Export .csv", "CSV spreadsheet"],
  },
  FileTextIcon: {
    means: "The results record",
    labels: ["Results record (PDF)", "Download the results record (PDF)"],
  },
  FileArchiveIcon: { means: "The results data, as a ZIP", labels: ["Results data (ZIP)"] },
  SheetIcon: { means: "Google Sheets", labels: ["Open in Google Sheets…"] },
  MountainIcon: {
    means: "Anything about altitudes",
    labels: ["Check altitudes", "fillingAlts", "`Use the map’s altitude for all ${acceptable.length}`"],
  },
  MapPinPlusIcon: { means: "Start placing on the map", labels: ["New waypoint from the map"] },
  FlaskConicalIcon: { means: "Test data", labels: ["Add test pilots", "Create test IGC"] },
  RefreshCwIcon: {
    means: "Recompute or rebuild",
    labels: ["Recompute", "Recompute scores", "Rebuild search index"],
  },
  Trash2Icon: { means: "Clear", labels: ["Clear turnpoints", "Clear entire cache"] },
  Undo2Icon: { means: "Discard changes", labels: ["Discard changes"] },
  RotateCcwIcon: { means: "Reset to defaults", labels: ["Reset to defaults"] },
  // One row each. They were not in the guide's table before 2026-11-24.
  RouteIcon: { means: "The task's route", labels: ['hasRoute ? "Edit route" : "Create route"'] },
  NotebookPenIcon: {
    means: "The task's weather notes",
    labels: ['task.weather_notes.trim().length > 0 ? "Edit notes" : "Add notes"'],
  },
  ClipboardPenIcon: { means: "A manual flight", labels: ["Record a manual flight"] },
  KeyboardIcon: { means: "Type the route as one line", labels: ["Quick entry"] },
  ArrowUpDownIcon: { means: "Reorder a list", labels: ["Reorder turnpoints"] },
  FilesIcon: { means: "The import and export rows, behind one row", labels: ["Import or export"] },
  ArrowLeftRightIcon: {
    means: "Swap two fields of a waypoint file",
    labels: ['`Swap code & name: ${swap ? "on" : "off"}`'],
  },
  GlobeIcon: { means: "Load from another site", labels: ["Load from XContest"] },
  IdCardIcon: { means: "Fill pilots' details from the CIVL rankings", labels: ["Fill from CIVL…"] },
  ListFilterIcon: { means: "Show all rows, or only the ones that need a look", labels: ["showAll"] },
});

describe("5.5: one icon means one thing", () => {
  const uses = iconUses();

  it("finds the icons", () => {
    expect(uses.length).toBeGreaterThan(30);
  });

  it("every icon on a row is in the table, with that row's label", () => {
    const unlisted = uses
      .filter(({ icon, label }) => !ICON_MEANINGS[icon]?.labels.includes(label))
      .map(({ icon, label, file }) => `${icon} for ${label} (${file})`);
    expect(unlisted).toEqual([]);
  });

  it("the table lists nothing that is gone", () => {
    const gone: string[] = [];
    for (const [icon, { labels }] of Object.entries(ICON_MEANINGS)) {
      for (const label of labels) {
        if (!uses.some((u) => u.icon === icon && u.label === label)) gone.push(`${icon} for ${label}`);
      }
    }
    expect(gone).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5.3 The trail
// ---------------------------------------------------------------------------

describe("5.3: a trail is built by lib/crumbs.ts", () => {
  it("no page writes a trail out by hand", () => {
    // A literal may add to a helper's trail (a crumb that carries the page's
    // own query, say). It may not start one: the helper is what keeps one
    // label for one destination.
    const inline = FILES.filter(({ path }) => path !== "lib/crumbs.ts").flatMap(({ path, src }) =>
      [...code(src).matchAll(/\b(?:trail|crumbs)=\{\[\s*([^\]\s][^\n]*)/g)]
        .filter((m) => !/^\.\.\.(under\w+|compCrumbs)\(/.test(m[1]!))
        .map((m) => `${path}: ${m[1]}`)
    );
    expect(inline).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5.7 Lists
// ---------------------------------------------------------------------------

describe("5.7: lists", () => {
  it("a list of rows draws each row's body with RowContent", () => {
    // `comp/TaskScoresAdmin.tsx` draws a pilot's facts with `PilotFacts`
    // (comp/task-pilots.tsx), which the organiser's list and the pilot's page
    // share (#900).
    const OWN_BODY = new Set(["comp/TaskScoresAdmin.tsx"]);
    const without = FILES.filter(
      ({ path, src }) =>
        path !== "rac/grid-list.tsx" &&
        !OWN_BODY.has(path) &&
        /variant="rows"/.test(code(src)) &&
        !/\bRowContent\b/.test(code(src))
    ).map(({ path }) => path);
    expect(without).toEqual([]);
  });

  it("no grid library is installed or imported", () => {
    const GRID = /tabulator|ag-grid|handsontable|data-grid|react-table|@tanstack\/[\w-]*table|revogrid|react-virtualized|jspreadsheet/i;
    const pkg = JSON.parse(readFileSync(join(FRONTEND, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const installed = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((name) =>
      GRID.test(name)
    );
    expect(installed).toEqual([]);
    const imported = FILES.filter(({ src }) =>
      [...code(src).matchAll(/from\s+["']([^"']+)["']/g)].some((m) => !m[1]!.startsWith(".") && GRID.test(m[1]!))
    ).map(({ path }) => path);
    expect(imported).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5.4 Actions go in ⋯
// ---------------------------------------------------------------------------

/**
 * The buttons each page draws for itself, outside the bar's commit slot. A
 * page's actions go in ⋯; a button stays on the page only where its place
 * says something, or where the page has no bar. A new button on a page, or a
 * page that gains its first, changes this list, and the diff says why.
 */
const PAGE_BUTTONS: Record<string, { count: number; why: string }> = {};

Object.assign(PAGE_BUTTONS, {
  "pages/CompAltitudeReviewPage.tsx": { count: 1, why: "Check altitudes, where the review has not been run: the page's one act" },
  "pages/CompWaypointPage.tsx": { count: 2, why: "The radius chips, and the destructive action at the foot of the form" },
  "pages/CompWaypoints.tsx": { count: 1, why: "Stop, beside the map, while placing a waypoint on it (the list and the full-size map are this one page)" },
  "pages/Dashboard.tsx": { count: 4, why: "Download and Remove on each stored flight and task: actions on a row" },
  "pages/NewCompPage.tsx": { count: 1, why: "Sign in to start a competition, for a signed-out reader" },
  "pages/OAuthConsent.tsx": { count: 2, why: "No bar: Allow and Deny" },
  "pages/Onboarding.tsx": { count: 1, why: "No bar: Continue" },
  "pages/Settings.tsx": { count: 4, why: "Revoke and Disconnect on a row, and Copy beside a key and the MCP address" },
  "pages/SignIn.tsx": { count: 5, why: "No bar: the ways to sign in" },
  "pages/TaskPilotSimilarity.tsx": { count: 3, why: "Select all and Clear on the behaviour picker, and Show all pilots under the list" },
  "pages/TaskRouteTurnpointPage.tsx": { count: 1, why: "The destructive action at the foot of the form" },
});

describe("5.4: a page's actions go in the bar", () => {
  it("a page draws only the buttons the list records", () => {
    const drawn: Record<string, number> = {};
    for (const { path, src } of FILES) {
      if (!path.startsWith("pages/") || path === "pages/KitFormFixture.tsx") continue;
      const count = [...code(src).matchAll(/<Button\b(?![^>]*className=\{commitClass\})/g)].length;
      if (count > 0) drawn[path] = count;
    }
    const recorded = Object.fromEntries(
      Object.entries(PAGE_BUTTONS).map(([path, { count }]) => [path, count])
    );
    expect(drawn).toEqual(recorded);
  });
});
