import { describe, it, expect } from 'bun:test';
import {
  ftvDiscardFactor,
  calculatedFtv,
  computeFtvForPilot,
  explainFtv,
  type FtvTaskInput,
} from '../src/ftv';

describe('ftvDiscardFactor (S7A §5.2.5.1)', () => {
  it('is 0.2 for ≤6 planned tasks and 0.25 for ≥7', () => {
    expect(ftvDiscardFactor(1)).toBe(0.2);
    expect(ftvDiscardFactor(6)).toBe(0.2);
    expect(ftvDiscardFactor(7)).toBe(0.25);
    expect(ftvDiscardFactor(12)).toBe(0.25);
  });
});

describe('calculatedFtv', () => {
  it('keeps (1 − factor) of the total validity (WinnerScore/1000 per task)', () => {
    expect(calculatedFtv([1000, 1000, 1000], 0.25)).toBeCloseTo(2.25, 10);
    expect(calculatedFtv([1000, 1000, 1000], 0.2)).toBeCloseTo(2.4, 10);
    // Uneven winners: 0.8 + 1.0 + 0.9 = 2.7 total → ×0.8 = 2.16
    expect(calculatedFtv([800, 1000, 900], 0.2)).toBeCloseTo(2.16, 10);
  });
});

describe('computeFtvForPilot', () => {
  it('counts best tasks in full, the tipping task in part, and the total', () => {
    // 3 tasks, all winner 1000 (validity 1.0 each); target 1.5.
    // Sorted by performance: 0.9 (full, rem 0.5), 0.6 (partial 0.5 → 300),
    // 0.3 (discarded).
    const tasks: FtvTaskInput[] = [
      { taskId: 't1', score: 900, winnerScore: 1000 },
      { taskId: 't2', score: 600, winnerScore: 1000 },
      { taskId: 't3', score: 300, winnerScore: 1000 },
    ];
    const r = computeFtvForPilot(tasks, 1.5);

    expect(r.total).toBeCloseTo(1200, 6); // 900 + 300
    const byId = Object.fromEntries(r.tasks.map((t) => [t.taskId, t]));
    expect(byId.t1.status).toBe('full');
    expect(byId.t1.countedScore).toBeCloseTo(900, 6);
    expect(byId.t2.status).toBe('partial');
    expect(byId.t2.fraction).toBeCloseTo(0.5, 6);
    expect(byId.t2.countedScore).toBeCloseTo(300, 6);
    expect(byId.t3.status).toBe('discarded');
    expect(byId.t3.fraction).toBe(0);
    expect(byId.t3.countedScore).toBe(0);
  });

  it('preserves input order in the breakdown while discarding by performance', () => {
    const tasks: FtvTaskInput[] = [
      { taskId: 't1', score: 800, winnerScore: 1000 },
      { taskId: 't2', score: 600, winnerScore: 1000 },
      { taskId: 't3', score: 400, winnerScore: 1000 },
    ];
    const r = computeFtvForPilot(tasks, 2.0); // exactly two tasks' worth
    expect(r.tasks.map((t) => t.taskId)).toEqual(['t1', 't2', 't3']);
    expect(r.total).toBeCloseTo(1400, 6); // 800 + 600, t3 dropped
    expect(r.tasks[2].status).toBe('discarded');
  });

  it('weights the discard by each task validity (uneven winners)', () => {
    // t3 has a low-validity day (winner 900 → validity 0.9) but the pilot won
    // it (performance 1.0), so it is counted first.
    const tasks: FtvTaskInput[] = [
      { taskId: 't1', score: 800, winnerScore: 1000 }, // val 1.0, perf 0.8
      { taskId: 't2', score: 500, winnerScore: 1000 }, // val 1.0, perf 0.5
      { taskId: 't3', score: 900, winnerScore: 900 }, // val 0.9, perf 1.0
    ];
    // target = 0.8 × (1.0 + 1.0 + 0.9) = 2.32
    const target = calculatedFtv([1000, 1000, 900], ftvDiscardFactor(3));
    const r = computeFtvForPilot(tasks, target);
    const byId = Object.fromEntries(r.tasks.map((t) => [t.taskId, t]));
    // t3 full (rem 1.42), t1 full (rem 0.42), t2 partial 0.42 → 210
    expect(byId.t3.status).toBe('full');
    expect(byId.t1.status).toBe('full');
    expect(byId.t2.status).toBe('partial');
    expect(byId.t2.fraction).toBeCloseTo(0.42, 6);
    expect(r.total).toBeCloseTo(1910, 4); // 900 + 800 + 210
  });

  it('counts everything when a pilot flew too few tasks to reach the cap', () => {
    const tasks: FtvTaskInput[] = [
      { taskId: 't1', score: 700, winnerScore: 1000 },
      { taskId: 't2', score: 400, winnerScore: 1000 },
    ];
    const r = computeFtvForPilot(tasks, 5.0); // cap far above their 2.0 validity
    expect(r.total).toBeCloseTo(1100, 6);
    expect(r.tasks.every((t) => t.status === 'full')).toBe(true);
  });

  it('handles a fully-invalid task (winner score 0) without dividing by zero', () => {
    const tasks: FtvTaskInput[] = [
      { taskId: 't1', score: 500, winnerScore: 1000 },
      { taskId: 't2', score: 0, winnerScore: 0 },
    ];
    const r = computeFtvForPilot(tasks, 3.0);
    const t2 = r.tasks.find((t) => t.taskId === 't2')!;
    expect(t2.performance).toBe(0);
    expect(t2.validity).toBe(0);
    expect(Number.isFinite(r.total)).toBe(true);
    expect(r.total).toBeCloseTo(500, 6);
  });
});

describe('explainFtv', () => {
  it('lists counted and discarded tasks and the total arithmetic', () => {
    const tasks: FtvTaskInput[] = [
      { taskId: 't1', score: 900, winnerScore: 1000 },
      { taskId: 't2', score: 600, winnerScore: 1000 },
      { taskId: 't3', score: 300, winnerScore: 1000 },
    ];
    const r = computeFtvForPilot(tasks, 1.5);
    const ex = explainFtv(r, (id) => id.toUpperCase(), 0.25);

    expect(ex.headline).toContain('2 of 3 tasks counted');
    const ids = ex.sections.map((s) => s.id);
    expect(ids).toEqual(['ftv-counted', 'ftv-discarded', 'ftv-total']);
    const total = ex.sections.find((s) => s.id === 'ftv-total')!;
    expect(total.points).toBe(1200);
    const discarded = ex.sections.find((s) => s.id === 'ftv-discarded')!;
    expect(discarded.items[0].text).toContain('T3');
  });

  it('omits the discarded section when every task counted', () => {
    const tasks: FtvTaskInput[] = [
      { taskId: 't1', score: 700, winnerScore: 1000 },
      { taskId: 't2', score: 400, winnerScore: 1000 },
    ];
    const r = computeFtvForPilot(tasks, 5.0);
    const ex = explainFtv(r, (id) => id, 0.2);
    expect(ex.sections.map((s) => s.id)).toEqual(['ftv-counted', 'ftv-total']);
  });
});
