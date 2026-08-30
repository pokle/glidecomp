/**
 * URL slugs for the public competition pages.
 *
 * Canonical path segments are `${slug}-${id}` — a lowercased, dash-joined form
 * of the entity's name followed by its sqid id (e.g. `corryong-cup-2026-voqc`,
 * `task-3-open-zqfs`). The slug is decorative; the id is the identity.
 *
 * Parsing is unambiguous because a sqid id is `[a-z]+` (SQIDS_ALPHABET is the
 * 26 lowercase letters — no digits, no dashes), so the id is always the text
 * after the LAST dash. That makes a bare `${id}` (the pre-slug URLs we still
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
