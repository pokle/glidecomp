/**
 * Pure data transforms for the scores page views: class-hierarchy rollups
 * ("Top 3 per task & class") and team aggregation. No DOM dependencies so the
 * logic is unit-testable.
 */

// ── Types (mirror the /api/comp/:comp_id/scores response) ────────────────────

export interface TaskInfo {
  task_id: string;
  task_name: string;
  task_date: string;
  classes: string[];
}

/** How a task counted toward a pilot's FTV total (present in FTV comps). */
export type FtvTaskStatus = "full" | "partial" | "discarded";

export interface PilotTaskEntry {
  task_id: string;
  task_date: string;
  /** The pilot's task score (the full task result, before any FTV discard). */
  score: number;
  rank: number;
  /** FTV comps only: how this task counted toward the pilot's series total. */
  ftv_status?: FtvTaskStatus;
  /** FTV comps only: the score that actually counted (score × fraction). */
  ftv_counted_score?: number;
  /** FTV comps only: this task's validity (day-winner score ÷ 1000). */
  validity?: number;
}

export interface CompPilotScore {
  pilot_name: string;
  comp_pilot_id: string;
  team_name?: string | null;
  rank: number;
  /** The pilot's competition total — sum of task scores, or the FTV total. */
  total_score: number;
  tasks: PilotTaskEntry[];
  /** FTV comps only: the class-wide CalculatedFTV cap (validity units). */
  calculated_ftv?: number;
}

export interface CompClassScore {
  pilot_class: string;
  pilots: CompPilotScore[];
}

// ── Class hierarchy rollups ───────────────────────────────────────────────────

export const OVERALL_LABEL = "Overall";

/** A pilot class, a rolled-up ancestor of slash-delimited classes, or the
 * synthetic root ("Overall") that spans the whole field. */
export interface ClassGroup {
  label: string;
  /** The pilot classes aggregated into this group. */
  classes: string[];
  /** Merged pilots from every member class, re-ranked by total score. */
  pilots: CompPilotScore[];
}

/** Proper prefixes of a slash-delimited class name: "a/b/c" → ["a", "a/b"]. */
function ancestorsOf(pilotClass: string): string[] {
  const parts = pilotClass.split("/").map((p) => p.trim()).filter(Boolean);
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/**
 * Assign 1-based ranks to an already best-first-sorted list, sharing a rank on
 * ties. S7A §5.2.4/§5.2.5: pilots (and nations/teams) "with the same score are
 * ranked in the same position" — no tie-break. Equality is on the published
 * one-decimal total (S7F §15; the value shown via formatRankedScore), so rows
 * displaying the same total share a rank and the next rank skips (1, 2, 2, 4).
 */
const oneDecimal = (x: number) => Math.round(x * 10) / 10;

function assignSharedRanks<T extends { total_score: number; rank: number }>(
  sorted: T[]
): T[] {
  const ranked = sorted.map((r) => ({ ...r }));
  for (let i = 0; i < ranked.length; i++) {
    ranked[i].rank =
      i > 0 &&
      oneDecimal(ranked[i].total_score) === oneDecimal(ranked[i - 1].total_score)
        ? ranked[i - 1].rank
        : i + 1;
  }
  return ranked;
}

function rankByTotal(pilots: CompPilotScore[]): CompPilotScore[] {
  return assignSharedRanks(
    [...pilots].sort((a, b) => b.total_score - a.total_score)
  );
}

/**
 * Expand class classScores into the groups shown by the "Top 3" view: every
 * class, plus a rollup for each slash-hierarchy ancestor (e.g. `open/a-grade`
 * and `open/b-grade` roll up into `open`), plus an "Overall" root spanning all
 * classes. Rollups that would exactly duplicate another group are dropped.
 */
export function buildClassGroups(classScores: CompClassScore[]): ClassGroup[] {
  // label → member leaf classes, in insertion order
  const members = new Map<string, string[]>();
  const add = (label: string, cls: string) => {
    const list = members.get(label) ?? [];
    if (!list.includes(cls)) list.push(cls);
    members.set(label, list);
  };

  for (const cls of classScores) add(cls.pilot_class, cls.pilot_class);
  for (const cls of classScores) {
    for (const ancestor of ancestorsOf(cls.pilot_class)) {
      add(ancestor, cls.pilot_class);
    }
  }

  if (classScores.length > 1) {
    for (const cls of classScores) add(OVERALL_LABEL, cls.pilot_class);
  }

  const byClass = new Map(classScores.map((s) => [s.pilot_class, s.pilots]));
  const seenSets = new Set<string>();
  const groups: ClassGroup[] = [];
  for (const [label, classes] of members) {
    // A rollup with the same members as an earlier group adds nothing —
    // e.g. an ancestor with a single child, or "Overall" when every class
    // already shares one top-level prefix.
    const setKey = [...classes].sort().join("§");
    const isRollup = !byClass.has(label) || classes.length > 1;
    if (isRollup && seenSets.has(setKey)) continue;
    seenSets.add(setKey);

    const pilots = classes.flatMap((c) => byClass.get(c) ?? []);
    groups.push({ label, classes, pilots: rankByTotal(pilots) });
  }
  return groups;
}

// ── Top 3 per task & class ────────────────────────────────────────────────────

export interface Top3Entry {
  pilot_name: string;
  comp_pilot_id: string;
  score: number;
}

export interface Top3Row {
  label: string;
  /** null for the aggregate "Total" row */
  task_id: string | null;
  task_date: string | null;
  entries: Top3Entry[];
}

/** Tasks flown by at least one of the group's member classes. */
export function tasksForGroup(group: ClassGroup, tasks: TaskInfo[]): TaskInfo[] {
  return tasks.filter((t) => t.classes.some((c) => group.classes.includes(c)));
}

/**
 * One row per task the group flew (top 3 scores on that task), plus a final
 * "Total" row with the top 3 by competition total.
 */
export function computeTop3Rows(group: ClassGroup, tasks: TaskInfo[]): Top3Row[] {
  const rows: Top3Row[] = tasksForGroup(group, tasks).map((task) => {
    const entries = group.pilots
      .flatMap((p) => {
        const entry = p.tasks.find((t) => t.task_id === task.task_id);
        return entry
          ? [{ pilot_name: p.pilot_name, comp_pilot_id: p.comp_pilot_id, score: entry.score }]
          : [];
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return { label: task.task_name, task_id: task.task_id, task_date: task.task_date, entries };
  });

  rows.push({
    label: "Total",
    task_id: null,
    task_date: null,
    entries: group.pilots.slice(0, 3).map((p) => ({
      pilot_name: p.pilot_name,
      comp_pilot_id: p.comp_pilot_id,
      score: p.total_score,
    })),
  });

  return rows;
}

// ── Teams ─────────────────────────────────────────────────────────────────────

export interface CompTeamScore {
  team_name: string;
  rank: number;
  /** Member names, highest contributor first (deduped across classes). */
  pilots: string[];
  /** task_id → summed score of the team's pilots on that task */
  task_scores: Record<string, number>;
  total_score: number;
}

/**
 * Sum every team's pilot scores per task and overall, ranked by total.
 * Pilots with no team are left out; an empty result means the comp has no
 * teams. A pilot entered in several classes contributes each entry.
 */
export function aggregateTeams(classScores: CompClassScore[]): CompTeamScore[] {
  const teams = new Map<string, CompTeamScore>();
  // team → pilot name → that pilot's summed contribution, for member ordering
  const contributions = new Map<string, Map<string, number>>();

  for (const cls of classScores) {
    for (const pilot of cls.pilots) {
      const teamName = pilot.team_name?.trim();
      if (!teamName) continue;

      let team = teams.get(teamName);
      if (!team) {
        team = { team_name: teamName, rank: 0, pilots: [], task_scores: {}, total_score: 0 };
        teams.set(teamName, team);
        contributions.set(teamName, new Map());
      }
      const contrib = contributions.get(teamName)!;
      contrib.set(pilot.pilot_name, (contrib.get(pilot.pilot_name) ?? 0) + pilot.total_score);
      team.total_score += pilot.total_score;
      for (const entry of pilot.tasks) {
        team.task_scores[entry.task_id] = (team.task_scores[entry.task_id] ?? 0) + entry.score;
      }
    }
  }

  const sorted = [...teams.values()].sort(
    (a, b) => b.total_score - a.total_score
  );
  return assignSharedRanks(sorted).map((t) => ({
    ...t,
    pilots: [...contributions.get(t.team_name)!.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name),
  }));
}
