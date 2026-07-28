/**
 * Turning a dead URL back into a live one — the data half of the 404 page.
 *
 * A public GlideComp URL is built from `${slug}-${id}` segments, where the id is
 * the identity and the slug is a readable copy of the name. When an id stops
 * resolving, the slug is still a description of what the visitor wanted, so the
 * 404 page reads the words out of the dead path, asks /api/comp/lookup which
 * comps / tasks / pilots carry those words today, and rebuilds the deepest URL
 * that exists — "did you mean …".
 *
 * Everything here is pure (no React, no DOM, no fetch) so the parsing and the
 * ranking can be unit-tested against the URL shapes they exist to repair. The
 * path builders are the same ones the app links with, which is why the search
 * runs on this side: the server never has to know a URL shape.
 */
import {
  compAnalysisPath,
  compPath,
  compScoresPath,
  idFromSegment,
  nameSlugFromSegment,
  pilotPath,
  slugify,
  taskPath,
} from "./slug";

/** One `${slug}-${id}` segment, split into the two things it carries. */
export interface Segment {
  id: string;
  slug: string;
}

/** What a dead /comp URL still tells us about what the visitor wanted. */
export interface PathIdentity {
  comp?: Segment;
  task?: Segment;
  pilot?: Segment;
}

const SEGMENT = "([^/]+)";
/**
 * The public URL shapes, deepest first. Only the ones with an id in them are
 * listed: a path with no id (say /comp) can't 404 for a missing entity, and a
 * path we don't recognise contributes no search terms — the page then falls
 * back to its plain "here are the main sections" list.
 */
const SHAPES: Array<{ re: RegExp; parts: Array<keyof PathIdentity> }> = [
  { re: new RegExp(`^/comp/${SEGMENT}/task/${SEGMENT}/pilot/${SEGMENT}/?$`), parts: ["comp", "task", "pilot"] },
  { re: new RegExp(`^/comp/${SEGMENT}/analysis/task/${SEGMENT}/?$`), parts: ["comp", "task"] },
  { re: new RegExp(`^/comp/${SEGMENT}/task/${SEGMENT}/analysis/?$`), parts: ["comp", "task"] },
  { re: new RegExp(`^/comp/${SEGMENT}/task/${SEGMENT}/?$`), parts: ["comp", "task"] },
  { re: new RegExp(`^/comp/${SEGMENT}/(?:scores|waypoints|analysis|pilots)/?$`), parts: ["comp"] },
  { re: new RegExp(`^/comp/${SEGMENT}/?$`), parts: ["comp"] },
];

/** Read the comp / task / pilot segments out of a public competition path. */
export function parsePathIdentity(pathname: string): PathIdentity {
  for (const shape of SHAPES) {
    const m = pathname.match(shape.re);
    if (!m) continue;
    const out: PathIdentity = {};
    shape.parts.forEach((part, i) => {
      const raw = m[i + 1];
      out[part] = { id: idFromSegment(raw), slug: nameSlugFromSegment(raw) };
    });
    return out;
  }
  return {};
}

/**
 * The lookup query for a dead path. The comp id goes over as an anchor — if it
 * still resolves, the comp half of the URL was right and only the deeper
 * segments need repairing — and each segment's slug goes over as search words
 * for its own entity type.
 *
 * A segment with no slug (a bare-id URL) contributes nothing, which is correct:
 * there is no name in it to search for.
 */
export function lookupParams(identity: PathIdentity): URLSearchParams | null {
  const params = new URLSearchParams();
  if (identity.comp?.id) params.set("comp", identity.comp.id);
  if (identity.comp?.slug) params.set("comp_q", identity.comp.slug);
  if (identity.task?.slug) params.set("task_q", identity.task.slug);
  if (identity.pilot?.slug) params.set("pilot_q", identity.pilot.slug);
  // An anchor alone is worth asking about (the comp may still exist), but a
  // path that carries neither an anchor nor a single word is not.
  return [...params.keys()].length > 0 ? params : null;
}

/** A free-text query searches all three kinds at once. */
export function freeTextParams(query: string): URLSearchParams | null {
  const q = query.trim();
  if (q.length < 2) return null;
  return new URLSearchParams({ comp_q: q, task_q: q, pilot_q: q });
}

// ── The lookup response ─────────────────────────────────────────────────────

export interface LookupComp {
  comp_id: string;
  name: string;
  category: string;
}

export interface LookupTask {
  comp_id: string;
  comp_name: string;
  task_id: string;
  name: string;
  task_date: string;
}

export interface LookupPilot {
  comp_id: string;
  comp_name: string;
  task_id: string;
  task_name: string;
  task_date: string;
  comp_pilot_id: string;
  name: string;
}

export interface LookupResults {
  comps: LookupComp[];
  tasks: LookupTask[];
  pilots: LookupPilot[];
}

export interface Suggestion {
  /** Where to go. Always a currently-resolvable URL. */
  path: string;
  /** The thing itself — a pilot's name, a task's name, a comp's name. */
  label: string;
  /** Where it lives, e.g. "Task 1 (Open) · Corryong Cup 2026". */
  context?: string;
  kind: "comp" | "task" | "pilot" | "scores" | "analysis";
}

/** How many links the page offers. More than this is a list, not a suggestion. */
export const MAX_SUGGESTIONS = 8;
/** Per kind, so a deep match can never crowd out the comp link above it. */
const MAX_PER_KIND = 3;

/**
 * How well a candidate name matches the words a dead slug carried: the share of
 * the slug's words the name contains, with an exact slug match scoring 1.
 *
 * Deliberately blunt. The server already did the filtering (a hit contains every
 * searched word), so this only has to order a handful of survivors, and the
 * thing it must get right is preferring "Task 1 (Open)" over "Task 1 (Floater)"
 * for a `task-1-open` slug — which counting shared words does.
 */
export function matchScore(slug: string, name: string): number {
  const wanted = slugify(slug).split("-").filter(Boolean);
  if (wanted.length === 0) return 0;
  const candidate = slugify(name);
  if (candidate === slugify(slug)) return 1;
  const have = new Set(candidate.split("-").filter(Boolean));
  const hits = wanted.filter((w) => have.has(w)).length;
  // Never quite 1: an exact match above must always win.
  return (hits / wanted.length) * 0.99;
}

/**
 * Rebuild the deepest URL that exists, then the shallower ones around it.
 *
 * Order is deepest-first because that is the answer to "where was I going": a
 * visitor whose pilot-score link died wants that pilot's page, not a list of
 * competitions. Each kind is capped, so the shallower levels always get a link
 * too — they are the fallback when the deepest guess is the wrong one.
 */
export function buildSuggestions(
  identity: PathIdentity,
  results: LookupResults
): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  const add = (s: Suggestion) => {
    if (seen.has(s.path)) return;
    seen.add(s.path);
    out.push(s);
  };

  const best = <T>(items: T[], slug: string | undefined, name: (x: T) => string) =>
    (slug
      ? [...items].sort((a, b) => matchScore(slug, name(b)) - matchScore(slug, name(a)))
      : items
    ).slice(0, MAX_PER_KIND);

  for (const p of best(results.pilots, identity.pilot?.slug, (x) => x.name)) {
    add({
      kind: "pilot",
      path: pilotPath(p.comp_id, p.comp_name, p.task_id, p.task_name, p.comp_pilot_id, p.name),
      label: p.name,
      context: `${p.task_name} · ${p.comp_name}`,
    });
  }

  for (const t of best(results.tasks, identity.task?.slug, (x) => x.name)) {
    add({
      kind: "task",
      path: taskPath(t.comp_id, t.comp_name, t.task_id, t.name),
      label: t.name,
      context: t.comp_name,
    });
  }

  for (const c of best(results.comps, identity.comp?.slug, (x) => x.name)) {
    add({ kind: "comp", path: compPath(c.comp_id, c.name), label: c.name });
    // A single confidently-identified comp is worth expanding: its scores and
    // its field analysis are the two pages most links into a comp are after,
    // and they are one hop from wherever the dead link was pointing.
    if (results.comps.length === 1) {
      add({
        kind: "scores",
        path: compScoresPath(c.comp_id, c.name),
        label: "Scores",
        context: c.name,
      });
      add({
        kind: "analysis",
        path: compAnalysisPath(c.comp_id, c.name),
        label: "Field analysis",
        context: c.name,
      });
    }
  }

  return out.slice(0, MAX_SUGGESTIONS);
}
