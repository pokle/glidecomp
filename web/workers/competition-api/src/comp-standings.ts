import {
  ftvDiscardFactor,
  calculatedFtv,
  computeFtvForPilot,
  type FtvTaskStatus,
} from "@glidecomp/engine";
import { rankByTotalScore, type TaskScoreResponse } from "./scoring";

/**
 * A competition's official standings: the per-task scores summed per pilot
 * per class, or re-aggregated under FTV (S7F §16), then ranked with shared
 * ties. One implementation for the comp scores endpoint and for the comp
 * analysis, which correlates its metrics against this same ranking (engine
 * review 2026-10-20, finding 5.1) — two copies would let the analysis
 * measure against a ranking nobody publishes.
 *
 * Pure: no D1, no R2. The caller loads the stored task scores.
 */

export interface StandingsComp {
  category: string | null;
  scoring_format: string;
  series_scoring: string;
  ftv_factor: number | null;
}

export interface StandingsTask {
  task_id: string;
  task_date: string;
  classes: TaskScoreResponse["classes"];
}

/** Class day-winner's score on that task is kept for FTV (validity units). */
type TaskEntry = {
  task_id: string;
  task_date: string;
  score: number;
  rank: number;
  winner_score: number;
  ftv_status?: FtvTaskStatus;
  ftv_counted_score?: number;
  validity?: number;
};

type PilotTotals = {
  pilot_name: string;
  comp_pilot_id: string;
  team_name: string | null;
  total_score: number;
  tasks: TaskEntry[];
  calculated_ftv?: number;
};

export function buildCompStandings(
  comp: StandingsComp,
  taskScores: StandingsTask[],
  teamByPilot: Map<string, string | null> = new Map()
) {
  const classTotals: Record<string, Record<string, PilotTotals>> = {};
  // Per class, per task: the day-winner's score (max in the class).
  const classTaskWinner: Record<string, Record<string, number>> = {};

  for (const task of taskScores) {
    for (const cls of task.classes) {
      // S7F 2026 §16 (PG only): a stopped task with a task validity
      // under 0.05 (the winner has fewer than 50 points) is excluded
      // from the competition ranking. It stays on the task's own scores
      // page — only the comp aggregation skips it.
      if (
        comp.category === "pg" &&
        comp.scoring_format === "gap" &&
        cls.stopped &&
        cls.task_validity.task < 0.05
      ) {
        continue;
      }
      classTotals[cls.pilot_class] ??= {};
      classTaskWinner[cls.pilot_class] ??= {};
      const winnerScore = cls.pilots.reduce(
        (max, p) => Math.max(max, p.total_score),
        0
      );
      classTaskWinner[cls.pilot_class][task.task_id] = winnerScore;
      for (const pilot of cls.pilots) {
        if (!classTotals[cls.pilot_class][pilot.comp_pilot_id]) {
          classTotals[cls.pilot_class][pilot.comp_pilot_id] = {
            pilot_name: pilot.pilot_name,
            comp_pilot_id: pilot.comp_pilot_id,
            team_name: teamByPilot.get(pilot.comp_pilot_id) ?? null,
            total_score: 0,
            tasks: [],
          };
        }
        const entry = classTotals[cls.pilot_class][pilot.comp_pilot_id];
        // Default (sum-of-tasks) total; overwritten below under FTV.
        entry.total_score += pilot.total_score;
        entry.tasks.push({
          task_id: task.task_id,
          task_date: task.task_date,
          score: pilot.total_score,
          rank: pilot.rank,
          winner_score: winnerScore,
        });
      }
    }
  }

  // FTV (S7F §16): applies to GAP comps set to FTV with more than one task
  // (a single task can't discard anything). Pure re-aggregation over the
  // per-task scores — no task is re-scored.
  const ftvActive =
    comp.series_scoring === "ftv" &&
    comp.scoring_format === "gap" &&
    taskScores.length > 1;
  const ftvFactor = ftvActive
    ? comp.ftv_factor ?? ftvDiscardFactor(taskScores.length)
    : null;

  if (ftvActive && ftvFactor !== null) {
    for (const [clsKey, pilots] of Object.entries(classTotals)) {
      const target = calculatedFtv(
        Object.values(classTaskWinner[clsKey] ?? {}),
        ftvFactor
      );
      for (const entry of Object.values(pilots)) {
        const res = computeFtvForPilot(
          entry.tasks.map((t) => ({
            taskId: t.task_id,
            score: t.score,
            winnerScore: t.winner_score,
          })),
          target
        );
        entry.total_score = res.total;
        entry.calculated_ftv = target;
        const byId = new Map(res.tasks.map((t) => [t.taskId, t]));
        for (const t of entry.tasks) {
          const b = byId.get(t.task_id);
          if (!b) continue;
          t.ftv_status = b.status;
          t.ftv_counted_score = b.countedScore;
          t.validity = b.validity;
        }
      }
    }
  }

  // Build the ranked scores per class. rankByTotalScore applies S7A
  // §5.2.5.4 ties (equal published totals share a rank; no tie-break) to
  // whatever total_score holds — the sum, or the FTV total set above.
  const classScores = Object.entries(classTotals).map(
    ([pilotClass, pilots]) => ({
      pilot_class: pilotClass,
      pilots: rankByTotalScore(Object.values(pilots)).map((p) => ({
        pilot_name: p.pilot_name,
        comp_pilot_id: p.comp_pilot_id,
        team_name: p.team_name,
        rank: p.rank,
        total_score: p.total_score,
        ...(p.calculated_ftv !== undefined
          ? { calculated_ftv: p.calculated_ftv }
          : {}),
        // Drop the internal winner_score; surface FTV fields when present.
        tasks: p.tasks.map((t) => ({
          task_id: t.task_id,
          task_date: t.task_date,
          score: t.score,
          rank: t.rank,
          ...(t.ftv_status !== undefined
            ? {
                ftv_status: t.ftv_status,
                ftv_counted_score: t.ftv_counted_score,
                validity: t.validity,
              }
            : {}),
        })),
      })),
    })
  );

  return { classScores, ftvActive, ftvFactor };
}
