/**
 * Task debrief — the day's genuinely interesting findings, defined
 * narrowly so the section only speaks when it has evidence:
 *
 * A metric qualifies ONLY when
 *  - its correlation on THIS task is informative (n ≥ MIN_CORRELATION_N and
 *    |ρ| ≥ this task's noise floor), AND
 *  - the comp's OTHER tasks form a consistent consensus the other way
 *    (≥ 2 informative other tasks, all one sign, opposite to today's).
 *
 * That is deliberately conservative: no prior-based guesses, no "strongest
 * metric today" (the ranking already says that), no sub-noise anecdotes.
 * When nothing qualifies the debrief renders nothing at all. Findings are
 * findings — a flip day is information about the day, not a warning.
 */
import { MIN_CORRELATION_N, type CompAggregateReport } from "./types";

export interface DebriefFinding {
  metricId: string;
  label: string;
  /** This task's ρ (rank 1 best: negative = larger values, better ranks). */
  rho: number;
  n: number;
  /** Informative OTHER tasks agreeing on the opposite sign. */
  otherCount: number;
  /** True when larger values went with better ranks TODAY. */
  higherBetterToday: boolean;
}

/** Findings for the task occupying `taskIndex` in the class aggregate. */
export function debriefFindings(
  aggregate: CompAggregateReport,
  taskIndex: number,
): DebriefFinding[] {
  const findings: DebriefFinding[] = [];
  for (const m of aggregate.metrics) {
    if (m.outcome) continue; // sanity checks, not behaviours
    const today = m.perTaskCorrelation[taskIndex];
    if (!today || today.n < MIN_CORRELATION_N) continue;
    if (Math.abs(today.rho) < today.noiseFloor || today.rho === 0) continue;

    let negative = 0;
    let positive = 0;
    for (let i = 0; i < m.perTaskCorrelation.length; i++) {
      if (i === taskIndex) continue;
      const c = m.perTaskCorrelation[i];
      if (!c || Math.abs(c.rho) < c.noiseFloor || c.rho === 0) continue;
      if (c.rho < 0) negative++;
      else positive++;
    }
    const othersConsensusSign =
      negative >= 2 && positive === 0 ? -1 : positive >= 2 && negative === 0 ? 1 : 0;
    if (othersConsensusSign === 0) continue;
    const todaySign = today.rho < 0 ? -1 : 1;
    if (todaySign === othersConsensusSign) continue;

    findings.push({
      metricId: m.id,
      label: m.label,
      rho: today.rho,
      n: today.n,
      otherCount: negative + positive,
      higherBetterToday: todaySign < 0,
    });
  }
  // Strongest anomalies first; keep the section short.
  return findings.sort((a, b) => Math.abs(b.rho) - Math.abs(a.rho)).slice(0, 3);
}

/** One finding as a sentence — generic across metrics and units. */
export function debriefSentence(f: DebriefFinding): string {
  const today = f.higherBetterToday
    ? "higher values went with better ranks today"
    : "higher values went with worse ranks today";
  const usually = f.higherBetterToday
    ? "they went with worse ranks"
    : "they went with better ranks";
  return (
    `${f.label}: ${today} (ρ = ${f.rho.toFixed(2)}, n = ${f.n}) — ` +
    `the opposite of this comp's other tasks, where ${usually} on all ` +
    `${f.otherCount} informative days.`
  );
}
