/**
 * URL slugs for the public competition pages.
 *
 * Canonical path segments are `${slug}-${id}` — a lowercased, dash-joined form
 * of the entity's name followed by its sqid id (e.g. `corryong-cup-2026-voqc`,
 * `task-3-open-zqfs`). The slug is decorative; the id is the identity.
 *
 * Parsing is unambiguous because a sqid id is `[a-z]+` (SQIDS_ALPHABET is the
 * 26 lowercase letters — no digits, no dashes), so the id is always the text
 * after the LAST dash. A hidden competition's id carries its share key after
 * an underscore (`vzuq_7hq2m9xk4rwd`, see `compUrlId` below); the key is
 * `[a-z0-9]` with no dash either, so it simply rides along as part of the id. That makes a bare `${id}` (the pre-slug URLs we still
 * support) and a slugged `${slug}-${id}` parse identically, and it makes the
 * whole canonical URL lowercase (the id already is).
 *
 * This module is PURE (no React, no DOM) so both the SSR Pages Function and the
 * SPA can import it. The client-side redirect that uses it lives in
 * lib/use-canonical-path.ts.
 */

// Combining diacritical marks (U+0300–U+036F), stripped after NFKD so accented
// names slugify to their ASCII base (e.g. "Épreuve" → "epreuve").
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Lowercase, ASCII, dash-joined slug of a name. Empty string when the name has
 * no slug-able characters. Length-capped so a pathological name can't blow out
 * the URL (the id after it keeps the URL unique regardless).
 */
export function slugify(name: string): string {
  return name
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // everything else becomes a separator
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, ""); // a slice mid-dash-run could leave a trailing dash
}

/**
 * A canonical path segment for an entity: `${slug}-${id}`, or just `${id}` when
 * the name is missing or slugifies to nothing. The id is used verbatim.
 */
export function slugSegment(id: string, name?: string | null): string {
  const slug = name ? slugify(name) : "";
  return slug ? `${slug}-${id}` : id;
}

/**
 * The id embedded in a `${slug}-${id}` (or bare `${id}`) path segment. Ids are
 * `[a-z]+` with no dash, so it is the text after the last dash — or the whole
 * segment when there is none. Tolerant of a percent-encoded segment.
 */
export function idFromSegment(segment: string): string {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding — fall back to the raw segment.
  }
  const i = s.lastIndexOf("-");
  return i === -1 ? s : s.slice(i + 1);
}

/**
 * The name half of a `${slug}-${id}` segment — the inverse of idFromSegment.
 * Empty for a bare `${id}` segment (there is no name in it to recover).
 *
 * Lossy on purpose: it is a slug, not the name. It exists so a dead URL can be
 * searched for by the words it still carries (see the 404 page's suggestions).
 */
export function nameSlugFromSegment(segment: string): string {
  let s = segment;
  try {
    s = decodeURIComponent(segment);
  } catch {
    // Malformed percent-encoding — fall back to the raw segment.
  }
  const i = s.lastIndexOf("-");
  return i === -1 ? "" : s.slice(0, i);
}

// ── Hidden competitions' links ───────────────────────────────────────────────
//
// A hidden comp opens for its admins and for anyone whose URL carries its
// share key after the comp's id: `/comp/corryong-cup-2027-vzuq_7hq2m9xk4rwd`
// (web/workers/competition-api/src/share-key.ts). Because the key is PART of
// the id, every path builder below and every `/api/comp/${compId}` fetch
// carries it without being told, so a visitor who arrived by the link keeps it
// as they click around — and the organiser's own address bar is the link to
// share.

/** Separates a comp's sqid from its share key. Never in a sqid or a key. */
export const SHARE_KEY_SEPARATOR = "_";

/**
 * The comp id a URL for this comp should carry, for this viewer.
 *
 * Public comp: the bare sqid, dropping any stale key (a draft link still works
 * after publishing, and settles on the clean URL). Hidden comp: the sqid plus
 * the key the API handed this viewer — its admins, or a visitor who arrived
 * with it. `fallback` (the id the URL already has) is kept when the comp has
 * not loaded, or the payload carries no key.
 */
export function compUrlId(
  comp:
    | { comp_id: string; test?: boolean; share_key?: string | null }
    | null
    | undefined,
  fallback: string
): string {
  if (!comp) return fallback;
  if (!comp.test) return comp.comp_id;
  return comp.share_key
    ? `${comp.comp_id}${SHARE_KEY_SEPARATOR}${comp.share_key}`
    : fallback;
}

/** A comp id without its share key — for comparing ids, never for a URL. */
export function bareCompId(id: string): string {
  const i = id.indexOf(SHARE_KEY_SEPARATOR);
  return i === -1 ? id : id.slice(0, i);
}

/**
 * Text with every share key in it masked: `vzuq_7hq2m9xk4rwd` → `vzuq_[key]`.
 * For anything that writes a URL somewhere other people can read it — a log
 * line above all — so the key to a hidden comp is not handed out with it.
 */
export function redactShareKeys(text: string): string {
  return text.replace(/([a-z]+)_[a-z0-9]{12}(?![a-z0-9])/g, "$1_[key]");
}

/**
 * Whether a `/comp/…` pathname's comp segment carries a share key. A page or
 * redirect for such a path is a hidden comp's, so it is never shared-cached
 * and never a permanent redirect (a reset key would keep resurfacing).
 */
export function pathCarriesShareKey(pathname: string): boolean {
  const segment = pathname.split("/")[2] ?? "";
  return idFromSegment(segment).includes(SHARE_KEY_SEPARATOR);
}

// ── Canonical path builders ──────────────────────────────────────────────────
// Each takes the bare id(s) plus the name(s) and returns the canonical path.
// A missing name degrades to a bare-id segment (still a working URL).

export function compPath(id: string, name?: string | null): string {
  return `/comp/${slugSegment(id, name)}`;
}

export function compScoresPath(id: string, name?: string | null): string {
  return `${compPath(id, name)}/scores`;
}

/**
 * The scores page's CSV twin (served by the SSR Pages Function, not the SPA).
 * A real, shareable URL rather than a blob: a spreadsheet can pull from it —
 * see the "Open in Google Sheets" flow — and it works with JS off.
 */
export function compScoresCsvPath(id: string, name?: string | null): string {
  return `${compScoresPath(id, name)}.csv`;
}

/**
 * The results record: the whole comp's scores as one PDF with the data
 * attached (src/results-record/), served by the same Pages Function as the
 * CSV.
 */
export function compScoresPdfPath(id: string, name?: string | null): string {
  return `${compScoresPath(id, name)}.pdf`;
}

/** The results record's attached data on its own, as a ZIP — for a reader
 * whose PDF viewer shows no attachments (macOS Preview). */
export function compScoresZipPath(id: string, name?: string | null): string {
  return `${compScoresPath(id, name)}.zip`;
}

export function compWaypointsPath(id: string, name?: string | null): string {
  return `${compPath(id, name)}/waypoints`;
}

export function compAnalysisPath(id: string, name?: string | null): string {
  return `${compPath(id, name)}/analysis`;
}

/** The roster. Where a matched pilot who has not flown a task yet is found. */
export function compPilotsPath(id: string, name?: string | null): string {
  return `${compPath(id, name)}/pilots`;
}

/**
 * One pilot's editor on the roster, or `"new"` for the blank one. A page and
 * not a sheet over the list: see the overlays rule in CLAUDE.md.
 */
export function compPilotPath(
  id: string,
  name: string | null | undefined,
  pilotId: string | "new",
  pilotName?: string | null
): string {
  return `${compPilotsPath(id, name)}/${pilotId === "new" ? "new" : slugSegment(pilotId, pilotName)}`;
}

/**
 * The admin-only competition settings pages. Without `group`, the index of
 * grouped rows; with one (e.g. "scoring"), that group's sub-page.
 */
export function compSettingsPath(
  id: string,
  name?: string | null,
  group?: string
): string {
  return `${compPath(id, name)}/settings${group ? `/${group}` : ""}`;
}

export function taskPath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined
): string {
  return `${compPath(compId, compName)}/task/${slugSegment(taskId, taskName)}`;
}

/**
 * The admin-only page that creates a task. A page and not a dialog over the
 * comp: see the overlays rule in CLAUDE.md. `new` can never be a task's id
 * (a sqid is at least four letters), so it cannot shadow a real task.
 */
export function compNewTaskPath(id: string, name?: string | null): string {
  return `${compPath(id, name)}/task/new`;
}

/*
 * The task's three admin-only editors, all siblings under the task: each is
 * reached from the part of the task page it edits, so none is nested under
 * another. Flat where the competition's settings are an index — a task has
 * five settings, which is a form and not a hierarchy.
 */

export function taskSettingsPath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined
): string {
  return `${taskPath(compId, compName, taskId, taskName)}/settings`;
}

/** Turnpoints, start gates and goal. */
export function taskRoutePath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined
): string {
  return `${taskPath(compId, compName, taskId, taskName)}/route`;
}

/** The organiser's account of what the day did. */
export function taskWeatherPath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined
): string {
  return `${taskPath(compId, compName, taskId, taskName)}/weather`;
}

/**
 * Create a test IGC for this task — an organiser's tool, not an editor: it
 * makes a file to download and changes nothing.
 */
export function taskTestIgcPath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined
): string {
  return `${taskPath(compId, compName, taskId, taskName)}/test-igc`;
}

/**
 * The per-task analysis. A child of the TASK: it is the one task's
 * report, it is where a reader arrives from, and the breadcrumbs say the same
 * (lib/crumbs.ts). The whole-comp report at {@link compAnalysisPath} collects
 * these chapters but does not own their URLs.
 */
export function taskAnalysisPath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined
): string {
  return `${taskPath(compId, compName, taskId, taskName)}/analysis`;
}

/**
 * One section of the task's analysis, on its own page. The chapter page
 * is a summary of these — see analysis/sections.ts for the set.
 */
export function taskAnalysisSectionPath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined,
  section: string
): string {
  return `${taskAnalysisPath(compId, compName, taskId, taskName)}/${section}`;
}

/** The pilot-similarity sheet, hung off the task's analysis. */
export function taskSimilarityPath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined
): string {
  return `${taskAnalysisPath(compId, compName, taskId, taskName)}/similar`;
}

export function pilotPath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined,
  pilotId: string,
  pilotName?: string | null
): string {
  return `${taskPath(compId, compName, taskId, taskName)}/pilot/${slugSegment(pilotId, pilotName)}`;
}

/**
 * Recording a flight for a pilot who has no track (FAI S7F §9.2.2). A child of
 * the pilot's report card because that is the page it is about — and the page
 * the recorded flight then explains.
 */
export function manualFlightPath(
  compId: string,
  compName: string | null | undefined,
  taskId: string,
  taskName: string | null | undefined,
  pilotId: string,
  pilotName?: string | null
): string {
  return `${pilotPath(compId, compName, taskId, taskName, pilotId, pilotName)}/manual-flight`;
}
