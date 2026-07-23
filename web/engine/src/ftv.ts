/**
 * FTV — Fixed Total Validity (FAI S7F §15, S7A §5.2.5.1).
 *
 * FTV scores a pilot's competition total on their *best* task performances
 * rather than all of them: a fixed fraction of the total available validity is
 * discarded, so every pilot's counted validity is capped at the same value.
 *
 * The procedure (S7F §15), matching the CIVL reference scorer AirScore:
 *   1. For each task, performance = pilot's day score ÷ the class day-winner's
 *      score. Each task's "validity" in FTV units is WinnerScore ÷ 1000
 *      (AirScore's `validity_ref = max_score`; a task's winning score is the
 *      operative measure of how much that day is worth).
 *   2. CalculatedFTV = (1 − FTVfactor) × Σ_task (WinnerScore ÷ 1000), i.e. the
 *      total validity minus the discarded fraction. FTVfactor is the *discard*
 *      fraction: 0.2 for comps with ≤6 planned tasks, 0.25 for ≥7. (AirScore
 *      stores the kept fraction 1 − FTVfactor = 0.8/0.75 — the "factor 0.75" in
 *      the GAP explainer.)
 *   3. Walk the pilot's flights in descending performance order, adding each
 *      task's raw score and consuming its validity, until the consumed validity
 *      reaches CalculatedFTV. A task that fits entirely counts in full; the task
 *      that tips over the line counts a *fraction* of its score, scaled so the
 *      consumed validity lands exactly on CalculatedFTV; the rest are discarded.
 *
 * A pilot who flew too few tasks to consume CalculatedFTV simply counts all of
 * them (no discard). Values are kept full-precision here; callers round for
 * display and for tie comparison (S7A §5.2.5.4), as elsewhere in the engine.
 *
 * This module is pure data-in/data-out so it is unit-testable and can drive
 * both the competition API's standings and the CLI.
 */

import type { ScoreExplanationItem } from './score-explanation-types';

/** How a task counted toward a pilot's FTV total. */
export type FtvTaskStatus = 'full' | 'partial' | 'discarded';

/** One of a pilot's tasks, as fed into the FTV calculation. */
export interface FtvTaskInput {
  taskId: string;
  /** The pilot's published score on this task. */
  score: number;
  /** The class day-winner's score on this task (max published score). */
  winnerScore: number;
}

/** How one task resolved for a pilot under FTV. */
export interface FtvTaskBreakdown {
  taskId: string;
  /** The pilot's raw task score. */
  score: number;
  /** The class day-winner's score on this task. */
  winnerScore: number;
  /** This task's FTV validity = winnerScore ÷ 1000. */
  validity: number;
  /** performance = score ÷ winnerScore, in [0,1] (0 when winnerScore is 0). */
  performance: number;
  status: FtvTaskStatus;
  /** 1 for a fully-counted task, (0,1) for the partial task, 0 for discarded. */
  fraction: number;
  /** The score that actually counted = score × fraction. */
  countedScore: number;
}

/** A pilot's FTV outcome across the competition (one pilot class). */
export interface FtvPilotResult {
  /** The FTV competition total = Σ countedScore (full precision). */
  total: number;
  /** The class-wide CalculatedFTV target, in validity units. */
  calculatedFtv: number;
  /** Per-task breakdown, in the input order (not performance order). */
  tasks: FtvTaskBreakdown[];
}

/**
 * The FTV discard factor per S7A §5.2.5.1: 0.2 for competitions with ≤6
 * planned tasks, 0.25 for ≥7. `plannedTasks` is the number of tasks the
 * competition ran (the caller supplies the scoreable-task count as a proxy,
 * since a separate "planned" count isn't tracked).
 */
export function ftvDiscardFactor(plannedTasks: number): number {
  return plannedTasks >= 7 ? 0.25 : 0.2;
}

/**
 * CalculatedFTV for a class: (1 − discardFactor) × Σ (winnerScore ÷ 1000) over
 * every task in the class. This is the same target for every pilot in the class.
 */
export function calculatedFtv(
  winnerScores: number[],
  discardFactor: number,
): number {
  const totalValidity = winnerScores.reduce((sum, w) => sum + w / 1000, 0);
  return (1 - discardFactor) * totalValidity;
}

/**
 * Compute a pilot's FTV total and per-task breakdown. `pilotTasks` are the
 * pilot's own flights (each carrying that task's day-winner score); `target` is
 * the class-wide CalculatedFTV. See the module header for the algorithm.
 */
export function computeFtvForPilot(
  pilotTasks: FtvTaskInput[],
  target: number,
): FtvPilotResult {
  const enriched = pilotTasks.map((t) => ({
    taskId: t.taskId,
    score: t.score,
    winnerScore: t.winnerScore,
    validity: t.winnerScore / 1000,
    performance: t.winnerScore > 0 ? t.score / t.winnerScore : 0,
  }));

  // Best performances first; ties broken by raw score (matches AirScore's
  // (perf, score) descending sort). Stable so equal keys keep input order.
  const order = enriched
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      if (b.t.performance !== a.t.performance)
        return b.t.performance - a.t.performance;
      return b.t.score - a.t.score;
    });

  const status = new Map<number, { status: FtvTaskStatus; fraction: number }>();
  let remaining = target;
  for (const { t, i } of order) {
    if (remaining <= 0) {
      status.set(i, { status: 'discarded', fraction: 0 });
    } else if (remaining >= t.validity) {
      // The whole task fits — count it in full.
      remaining -= t.validity;
      status.set(i, { status: 'full', fraction: 1 });
    } else {
      // This task tips over CalculatedFTV — count the fraction that fits.
      // A zero-validity task can't tip the line, so it always counts in full
      // above; here validity > remaining > 0, so the divide is safe.
      const fraction = remaining / t.validity;
      status.set(i, { status: 'partial', fraction });
      remaining = 0;
    }
  }

  const tasks: FtvTaskBreakdown[] = enriched.map((t, i) => {
    const s = status.get(i)!;
    return {
      taskId: t.taskId,
      score: t.score,
      winnerScore: t.winnerScore,
      validity: t.validity,
      performance: t.performance,
      status: s.status,
      fraction: s.fraction,
      countedScore: t.score * s.fraction,
    };
  });

  const total = tasks.reduce((sum, t) => sum + t.countedScore, 0);
  return { total, calculatedFtv: target, tasks };
}

// ---------------------------------------------------------------------------
// Explanation
// ---------------------------------------------------------------------------

/** A human-readable FTV explanation for one pilot (structurally compatible
 *  with the score-explanation renderer's section/item shape). */
export interface FtvExplanation {
  headline: string;
  sections: Array<{
    id: 'ftv-counted' | 'ftv-discarded' | 'ftv-total';
    title: string;
    summary?: string;
    points?: number;
    items: ScoreExplanationItem[];
  }>;
}

/** Round to whole points for display sentences (comp totals show whole points). */
function whole(n: number): number {
  return Math.round(n);
}

/**
 * Turn an FTV result into a structured explanation: which tasks counted (in
 * full or in part), which were discarded, and the arithmetic that produced the
 * total. `taskName` maps a taskId to its display name.
 */
export function explainFtv(
  result: FtvPilotResult,
  taskName: (taskId: string) => string,
  discardFactor: number,
): FtvExplanation {
  const counted = result.tasks.filter((t) => t.status !== 'discarded');
  const discarded = result.tasks.filter((t) => t.status === 'discarded');

  // Present counted tasks best-performance first, as the discard was decided.
  const countedByPerf = [...counted].sort(
    (a, b) => b.performance - a.performance || b.score - a.score,
  );

  const countedItems: ScoreExplanationItem[] = countedByPerf.map((t) => ({
    id: `counted-${t.taskId}`,
    text:
      t.status === 'partial'
        ? `${taskName(t.taskId)} — counted in part (${Math.round(t.fraction * 100)}% of the score fit under the validity cap)`
        : `${taskName(t.taskId)} — counted in full`,
    value: `${whole(t.countedScore)} pts`,
    detail:
      t.status === 'partial'
        ? `${whole(t.score)} × ${t.fraction.toFixed(3)} = ${whole(t.countedScore)} (validity ${t.validity.toFixed(3)})`
        : `validity ${t.validity.toFixed(3)}, performance ${Math.round(t.performance * 100)}%`,
    emphasis: t.status === 'partial' ? 'warning' : 'normal',
  }));

  const discardedItems: ScoreExplanationItem[] = discarded
    .sort((a, b) => b.performance - a.performance || b.score - a.score)
    .map((t) => ({
      id: `discarded-${t.taskId}`,
      text: `${taskName(t.taskId)} — discarded (validity cap already reached)`,
      value: `${whole(t.score)} pts dropped`,
      emphasis: 'muted',
    }));

  const sections: FtvExplanation['sections'] = [
    {
      id: 'ftv-counted',
      title: 'Tasks counted',
      summary: `Best results kept until the fixed validity cap (CalculatedFTV = ${result.calculatedFtv.toFixed(3)}) is reached.`,
      items: countedItems,
    },
  ];
  if (discardedItems.length > 0) {
    sections.push({
      id: 'ftv-discarded',
      title: 'Tasks discarded',
      summary: `${Math.round(discardFactor * 100)}% of total validity is discarded — the weakest tasks drop out.`,
      items: discardedItems,
    });
  }
  sections.push({
    id: 'ftv-total',
    title: 'FTV total',
    points: whole(result.total),
    items: [
      {
        id: 'ftv-total-sum',
        text: 'The competition total is the sum of the counted (full and partial) task scores.',
        value: `${whole(result.total)} pts`,
        detail: countedByPerf
          .map((t) => whole(t.countedScore))
          .join(' + ') + ` = ${whole(result.total)}`,
      },
    ],
  });

  return {
    headline: `FTV total ${whole(result.total)} points — ${counted.length} of ${result.tasks.length} tasks counted`,
    sections,
  };
}
