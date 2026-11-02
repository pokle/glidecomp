/**
 * Team names on the roster: which team a typed name means, and which it
 * nearly means.
 *
 * Teams are scored by their exact name — the public Teams tab and the
 * results record group pilots with `aggregateTeams()` — so "Alpha Gliders"
 * and "Alpha Gilders" are published as two teams with two totals. A team
 * field that took any text made that a typo away. The pilot sheet's Team
 * field (comp/TeamField.tsx) offers the roster's teams instead, makes a new
 * one a deliberate choice, and catches the near misses worked out here.
 *
 * Two kinds of "the same team":
 *
 *   - **Same key** — equal once case, spacing and accents are ignored
 *     ("alpha  gliders", "ALPHA GLIDERS"). Unambiguously the same team; it
 *     takes the spelling the roster already uses, here and on the server
 *     (competition-api's team canonicalisation does the same, so a CSV import
 *     or an assistant cannot split a team either).
 *   - **Near miss** — a letter or two off ("Alpha Gilders"). Possibly a
 *     different team, so it is only ever offered ("Did you mean …?"), never
 *     applied: names may propose, never dispose.
 */
import { fold } from "./pilot-search";

/** A team on the roster, under its most-used spelling. */
export interface RosterTeam {
  name: string;
  /** How many pilots carry it. */
  count: number;
}

/** What two spellings of one team share: case, spacing and accents ignored. */
export function teamKey(name: string): string {
  return fold(name).replace(/\s+/g, " ").trim();
}

/**
 * The roster's teams, most pilots first. Spellings that share a key are one
 * team, under whichever spelling more of its pilots use.
 */
export function rosterTeams(pilots: Array<{ team_name: string | null }>): RosterTeam[] {
  const byKey = new Map<string, Map<string, number>>();
  for (const p of pilots) {
    const name = p.team_name?.trim();
    if (!name) continue;
    const spellings = byKey.get(teamKey(name)) ?? new Map<string, number>();
    spellings.set(name, (spellings.get(name) ?? 0) + 1);
    byKey.set(teamKey(name), spellings);
  }
  const teams: RosterTeam[] = [];
  for (const spellings of byKey.values()) {
    const [name] = [...spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    const count = [...spellings.values()].reduce((a, b) => a + b, 0);
    teams.push({ name, count });
  }
  return teams.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * Edit distance with adjacent transpositions (optimal string alignment), so
 * "Alpah" is one slip from "Alpha", not two. Stops counting past `limit`.
 */
function distance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * How many slips still count as a near miss. None for a name too short to
 * tell a slip from a different name ("A" and "B" are both teams), one for a
 * short name, two for a longer one.
 */
function slipsAllowed(key: string): number {
  if (key.length < 4) return 0;
  return key.length < 8 ? 1 : 2;
}

export interface TeamMatch {
  /** The roster team this name IS (same key), if any. */
  exact: RosterTeam | null;
  /** Teams this name is a slip away from — offered, never applied. */
  near: RosterTeam[];
}

/** What a typed team name means against the roster's teams. */
export function matchTeam(input: string, teams: RosterTeam[]): TeamMatch {
  const key = teamKey(input);
  if (!key) return { exact: null, near: [] };
  const exact = teams.find((t) => teamKey(t.name) === key) ?? null;
  if (exact) return { exact, near: [] };
  const allowed = slipsAllowed(key);
  const near =
    allowed === 0
      ? []
      : teams.filter((t) => distance(teamKey(t.name), key, allowed) <= allowed);
  return { exact: null, near };
}

/** One choice in the Team field's list. */
export type TeamOption =
  | { id: string; kind: "team"; name: string; count: number }
  | { id: string; kind: "near"; name: string; count: number }
  | { id: string; kind: "new"; name: string };

/**
 * The Team field's list for what has been typed: the roster's teams that
 * contain it (all of them, for an empty field), then — when it matches no
 * team — "Did you mean …?" for each near miss, and last "New team: …".
 */
export function teamOptions(input: string, teams: RosterTeam[]): TeamOption[] {
  const key = teamKey(input);
  const listed = key ? teams.filter((t) => teamKey(t.name).includes(key)) : teams;
  const options: TeamOption[] = listed.map((t) => ({
    id: `team:${t.name}`,
    kind: "team",
    name: t.name,
    count: t.count,
  }));
  if (!key) return options;
  const { exact, near } = matchTeam(input, teams);
  if (exact) return options;
  for (const t of near) {
    if (!listed.includes(t)) {
      options.push({ id: `near:${t.name}`, kind: "near", name: t.name, count: t.count });
    }
  }
  options.push({ id: `new:${input.trim()}`, kind: "new", name: input.trim() });
  return options;
}

/** One heading in the pilot list's team view, and the pilots under it. */
export interface TeamGroup<P> {
  /** The team, or null for the pilots in none. */
  team: string | null;
  /** How many pilots the WHOLE roster has in it, whatever a search shows. */
  size: number;
  pilots: P[];
}

/**
 * The pilot list's "Sort: Team": a group per team, teams in name order, the
 * pilots in each by name, and the teamless last.
 *
 * A team here is what SCORING calls one — the trimmed name, exactly as
 * `aggregateTeams()` groups the Teams tab — and not `teamKey()`'s folding.
 * Two spellings of a team left over from before the server spelled every
 * write the roster's way (competition-api/src/team-name.ts) are two teams
 * with two totals on the scores page, so they are two headings here, side by
 * side, which is how an organiser finds them.
 *
 * `size` counts `roster`, not `shown`: a search narrows the rows under a
 * heading, but the heading says how big the team IS.
 */
export function groupByTeam<P extends { name: string; team_name: string | null }>(
  shown: P[],
  roster: P[]
): TeamGroup<P>[] {
  const teamOf = (p: P) => p.team_name?.trim() || null;
  const sizes = new Map<string | null, number>();
  for (const p of roster) sizes.set(teamOf(p), (sizes.get(teamOf(p)) ?? 0) + 1);
  const groups = new Map<string | null, P[]>();
  for (const p of shown) groups.set(teamOf(p), [...(groups.get(teamOf(p)) ?? []), p]);
  return [...groups.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([team, pilots]) => ({
      team,
      size: sizes.get(team) ?? pilots.length,
      pilots: [...pilots].sort((a, b) => a.name.localeCompare(b.name)),
    }));
}
