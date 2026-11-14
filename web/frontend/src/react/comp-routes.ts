/**
 * How the SSR Pages Function (functions/comp/[[path]].ts) answers each `/comp`
 * page — server-rendered, the noindex SPA shell, or a redirect — as ONE list.
 *
 * The router (routes.tsx) says which pages exist; this says what the Function
 * does with each. The two used to be joined by hand in four places — the
 * router, the Function's regexes, docs/ssr.md and e2e/ssr.spec.ts — and the
 * copies drifted. Now:
 *
 * - the Function builds its regexes from these tables (`compRouteRegExp`);
 * - comp-routes.test.ts reads routes.tsx and fails unless every `/comp` route
 *   in it is answered here exactly once, and every entry here answers a real
 *   route;
 * - e2e/ssr.spec.ts builds its shell URLs from `COMP_SHELL_ROUTES`.
 *
 * A page the router has and these tables do not works in dev (which serves the
 * shell for every path) and is a real 404 in production: the Function answers
 * an unmatched `/comp` path with a 404 and noindex, deliberately, so that junk
 * URLs stop looking valid. Converting a dialog to a page creates a URL, and the
 * Function has to have an answer for it.
 *
 * ORDER is the Function's: the redirects first, then the shell list, then the
 * SSR list, and the first match answers. So a shell entry may share an SSR
 * route's shape and win (`/comp/new` beside `/comp/:compId`).
 *
 * Patterns are in the router's own syntax (`/comp/:compId/task/:taskId/qr`),
 * plus two forms that stand for several router routes at once:
 *   `(a|b)`  — one of these segments, e.g. `/(settings|route|weather)`
 *   `(…)?`   — an optional tail, e.g. `/settings(/:group)?`
 *
 * PURE and light: the SSR Function bundles it. No `window`/`document`, and
 * nothing imported but the section list and the slug builders.
 */
import { TASK_ANALYSIS_SECTIONS, type TaskAnalysisSectionSlug } from "./analysis/sections";
import { newCompPath } from "./lib/slug";

export interface CompRoute {
  /** The pattern, in the router's syntax (see above). */
  path: string;
  /** Why the Function answers it this way, in a line. */
  why: string;
}

export interface CompShellRoute extends CompRoute {
  /** Only a signed-in admin of the comp has anything to see on it. */
  admin: boolean;
}

/** A section's slug, for a route that hangs off it. Typed against the list. */
const section = (slug: TaskAnalysisSectionSlug): string => slug;

/** Every section's slug, as one alternation: `(strategies|weather|…)`. */
const SECTION_SLUGS = `(${TASK_ANALYSIS_SECTIONS.map((s) => s.slug).join("|")})`;

/**
 * Served as the plain SPA shell, marked noindex. Each is a real page with
 * nothing to server-render — it fetches its own data, or edits a draft only
 * the browser has — and with nothing in it for a crawler. Most are admin-only,
 * and the API refuses their data to anyone else anyway.
 */
export const COMP_SHELL_ROUTES: readonly CompShellRoute[] = [
  {
    path: newCompPath(),
    admin: false,
    why:
      "Starting a competition: signed-in only (a signed-out reader is offered sign-in). " +
      "Caught ahead of `/comp/:compId`, whose loader would read `new` as an id it cannot " +
      "parse (a comp id is at least four letters).",
  },
  {
    path: "/comp/:compId/pilots",
    admin: true,
    why: "The roster editor.",
  },
  {
    path: "/comp/:compId/pilots/:pilotId",
    admin: true,
    why:
      "One pilot's editor, and the pages beside it: a blank one (`/new`), " +
      "the roster's CSV import (`/import`) and its CIVL fill (`/civl-fill`, #810), " +
      "and copying another competition's pilots in (`/copy`).",
  },
  {
    path: "/comp/:compId/waypoints/:page(/:rowId)?",
    admin: true,
    why:
      "The waypoints editor's pages (#811): one waypoint (`/:n`), Add waypoint (`/new`), " +
      "the map at full size (`/map`) and the altitude review (`/altitudes`, `/altitudes/:n`), " +
      "all editing a draft only the browser has. Only BELOW the list: the list itself is SSR'd.",
  },
  {
    path: "/comp/:compId/copy",
    admin: true,
    why:
      "Copying the competition into a new one: its settings and, at the organiser's " +
      "choice, its waypoints, pilots and other organisers. Reached from the settings index.",
  },
  {
    path: "/comp/:compId/task/new",
    admin: true,
    why:
      "Creating a task (#819). Caught ahead of the public task page, whose shape it shares: " +
      "`new` is no task's id (a sqid is at least four letters), so the task's loader would only 404 it.",
  },
  {
    path: "/comp/:compId/settings(/:group)?",
    admin: true,
    why: "The competition's settings: the index, and a page per group.",
  },
  {
    path: "/comp/:compId/task/:taskId/(settings|route|weather)",
    admin: true,
    why:
      "The task's three editors — settings, route and weather notes. " +
      "The route editor has a second reason never to be server-rendered: it pulls Mapbox.",
  },
  {
    path: "/comp/:compId/task/:taskId/route/:page",
    admin: true,
    why:
      "The route editor's other pages (#812): one turnpoint (`/:n`), Quick entry (`/quick`), " +
      "Load from XContest (`/xcontest`), Copy from another competition (`/copy`) and " +
      "Add waypoint (`/add-waypoint`), all editing a draft only the browser has.",
  },
  {
    path: "/comp/:compId/task/:taskId/test-igc",
    admin: true,
    why: "Create a test IGC (#822): a form whose result is a file made in the browser.",
  },
  {
    path: "/comp/:compId/task/:taskId/qr",
    admin: false,
    why:
      "The task's QR code (#813). PUBLIC, but a picture for a camera: " +
      "the SSR'd task page already gives a crawler the same route as text.",
  },
  {
    path: "/comp/:compId/task/:taskId/pilot/:pilotId/manual-flight",
    admin: true,
    why: "Recording a manual flight for one pilot (FAI S7F §9.2.2).",
  },
  {
    path: "/comp/:compId/task/:taskId/analysis/similar",
    admin: false,
    why:
      "The pilot-similarity page. PUBLIC, but everything on it is derived client-side " +
      "from the report the page fetches anyway, and it is a tool rather than a document.",
  },
  {
    path: `/comp/:compId/task/:taskId/analysis/${section("thermals")}/map`,
    admin: false,
    why:
      "One thermal's rose and map at the size of the screen (#816). PUBLIC, but there to show " +
      "a browser-only map; all it says about the thermal is server-rendered on the thermals section.",
  },
];

/**
 * Server-rendered: each has a loader in the Function's `ROUTE_RUNS`, keyed by
 * `name` — a `Record` over these names, so a route here without a loader (or a
 * loader without a route) does not compile. Public, and indexable unless the
 * `why` says otherwise; a hidden `test` comp's pages are always noindex.
 */
export const COMP_SSR_ROUTES = [
  {
    name: "comps",
    path: "/comp",
    why: "The competitions list. A search (`/comp?q=…`) is the shell instead: its results are fetched client-side.",
  },
  {
    name: "comp",
    path: "/comp/:compId",
    why: "The competition's hub: its tasks, and a summary of the scores.",
  },
  {
    name: "scores",
    path: "/comp/:compId/scores",
    why: "The full scores; `?task=` opens the scores by task.",
  },
  {
    name: "waypoints",
    path: "/comp/:compId/waypoints",
    why: "The waypoint list. The editor's pages under it are shells.",
  },
  {
    name: "task",
    path: "/comp/:compId/task/:taskId",
    why: "The route and the public results; the admin's tools on it are client-only.",
  },
  {
    name: "taskDiagram",
    path: "/comp/:compId/task/:taskId/diagram",
    why: "The route diagram at full size (#814). Always noindex: the task page is the indexable form.",
  },
  {
    name: "pilot",
    path: "/comp/:compId/task/:taskId/pilot/:pilotId",
    why: "The report card: how one pilot's score was worked out.",
  },
  {
    name: "compAnalysis",
    path: "/comp/:compId/analysis",
    why: "The comp analysis. Noindex per request while nothing is aggregated yet.",
  },
  {
    name: "taskAnalysis",
    path: "/comp/:compId/task/:taskId/analysis",
    why: "The task analysis: a contents list of its sections. Noindex per request while pending.",
  },
  {
    name: "taskAnalysisSection",
    path: `/comp/:compId/task/:taskId/analysis/${SECTION_SLUGS}`,
    why:
      "One section of the task analysis. Built from analysis/sections.ts, so a section added " +
      "there cannot 404 here; any other slug falls through to the 404.",
  },
  {
    name: "taskAnalysisMetric",
    path: `/comp/:compId/task/:taskId/analysis/${section("metrics")}/:metric`,
    why:
      "One metric's chart at full size (#815). Always noindex: a bigger copy of a chart " +
      "the strategies page shows. An unknown metric is a 404.",
  },
] as const satisfies readonly (CompRoute & { name: string })[];

export type CompSsrRouteName = (typeof COMP_SSR_ROUTES)[number]["name"];

/**
 * The per-task analysis's July–August 2026 URL (and `/similar` below it),
 * 301'd to its place under the task. A redirect and not a shell entry: that
 * URL was public and server-rendered, so a crawler must be told where the
 * page went rather than handed a noindex shell.
 */
export const LEGACY_TASK_ANALYSIS: CompRoute = {
  path: "/comp/:compId/analysis/task/:taskId(/similar)?",
  why: "The per-task analysis while it hung off the comp report; 301s to /comp/:c/task/:t/analysis.",
};

/** Every redirect the Function answers itself, ahead of both tables above. */
export const COMP_REDIRECT_ROUTES: readonly CompRoute[] = [LEGACY_TASK_ANALYSIS];

// ── The pattern syntax ───────────────────────────────────────────────────────

type Node =
  | { kind: "text"; text: string }
  | { kind: "param"; name: string }
  | { kind: "group"; alternatives: Node[][]; optional: boolean };

/** Parse a pattern. Throws on anything outside the syntax described above. */
function parse(pattern: string): Node[] {
  let i = 0;
  const sequence = (): Node[] => {
    const nodes: Node[] = [];
    while (i < pattern.length) {
      const c = pattern[i];
      if (c === ")" || c === "|") break;
      if (c === "(") {
        i++;
        const alternatives = [sequence()];
        while (pattern[i] === "|") {
          i++;
          alternatives.push(sequence());
        }
        if (pattern[i] !== ")") throw new Error(`unclosed group in ${pattern}`);
        i++;
        const optional = pattern[i] === "?";
        if (optional) i++;
        nodes.push({ kind: "group", alternatives, optional });
      } else if (c === ":") {
        const name = /^:([A-Za-z][A-Za-z0-9]*)/.exec(pattern.slice(i))?.[1];
        if (!name) throw new Error(`bad parameter at ${i} in ${pattern}`);
        nodes.push({ kind: "param", name });
        i += name.length + 1;
      } else if (/[a-z0-9/-]/.test(c)) {
        nodes.push({ kind: "text", text: c });
        i++;
      } else {
        throw new Error(`unexpected "${c}" at ${i} in ${pattern}`);
      }
    }
    return nodes;
  };
  const nodes = sequence();
  if (i !== pattern.length) throw new Error(`unbalanced "${pattern[i]}" in ${pattern}`);
  return nodes;
}

function toSource(nodes: Node[]): string {
  return nodes
    .map((n) => {
      // Only [a-z0-9/-] gets this far, and none of it is special in a regex.
      if (n.kind === "text") return n.text;
      if (n.kind === "param") return "([^/]+)";
      return `(${n.alternatives.map(toSource).join("|")})${n.optional ? "?" : ""}`;
    })
    .join("");
}

/**
 * The regex the Function matches a pathname with: anchored, a trailing slash
 * allowed. Every `:param` and every `(…)` captures, numbered left to right as
 * they open — the order a route's loader reads them in (`m[1]` the comp's
 * segment, `m[2]` the task's, …).
 */
export function compRouteRegExp(pattern: string): RegExp {
  return new RegExp(`^${toSource(parse(pattern))}/?$`);
}

function variants(nodes: Node[]): string[] {
  let out = [""];
  for (const n of nodes) {
    const options =
      n.kind === "text"
        ? [n.text]
        : n.kind === "param"
          ? [`:${n.name}`]
          : [...n.alternatives.flatMap(variants), ...(n.optional ? [""] : [])];
    out = out.flatMap((head) => options.map((tail) => head + tail));
  }
  return out;
}

/**
 * The plain router paths a pattern stands for, every `(a|b)` and `(…)?`
 * spelt out: `/comp/:compId/settings(/:group)?` →
 * `/comp/:compId/settings`, `/comp/:compId/settings/:group`.
 */
export function compRouteVariants(pattern: string): string[] {
  return variants(parse(pattern));
}

/** A router path with each `:param` replaced, for an example URL. */
export function fillCompRoute(path: string, value: (param: string) => string): string {
  return path.replace(/:([A-Za-z][A-Za-z0-9]*)/g, (_m, name: string) => value(name));
}
