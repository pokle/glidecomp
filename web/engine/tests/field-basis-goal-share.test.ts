// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The basis's goal share (TASK_ANALYSIS_VERSION 26, issue #683): how many of
 * the analysed pilots made goal, which is the day's difficulty and the
 * context every correlation on the page has to be read against.
 *
 * The cases that matter are the edges — nobody in goal, everybody in goal,
 * and a stored report from before the field existed — because each of them is
 * a place a naive implementation quietly says the wrong thing: `0` is falsy,
 * `n/n` is a real day, and an absent field is not a hard day.
 */
import { describe, it, expect } from 'bun:test';
import { evaluateField, renderTaskAnalysis, type TaskAnalysisBasis } from '../src/analysis';
import { makeTestField, straightFixes } from './field-test-helpers';

/** Three pilots on identical straight glides; `goals` of them made goal. */
function basisWithGoals(goals: number): TaskAnalysisBasis {
  const field = makeTestField(
    [0, 1, 2].map((i) => ({
      name: `p${i}`,
      fixes: straightFixes(0, 600, 0, 1500, 12, -0.5),
      score: { madeGoal: i < goals },
    })),
  );
  return evaluateField(field).basis;
}

describe('analysis basis: goal share', () => {
  it('counts the analysed pilots who made goal', () => {
    expect(basisWithGoals(2)).toMatchObject({ pilotCount: 3, goalCount: 2 });
  });

  /**
   * Zero is the loudest reading the field has — a day nobody completed is the
   * hardest kind there is — and it is also falsy, so an implementation that
   * only emits a "truthy" count drops the finding on exactly the tasks that
   * have one.
   */
  it('states an emphatic zero rather than omitting the field', () => {
    const basis = basisWithGoals(0);
    expect(basis.goalCount).toBe(0);
    expect(basis.goalCount).not.toBeUndefined();
  });

  it('counts a whole field into goal', () => {
    expect(basisWithGoals(3).goalCount).toBe(3);
  });
});

describe('renderTaskAnalysis: goal share', () => {
  it('leads the day line with the share, in the words pilots use', () => {
    const field = makeTestField(
      [0, 1, 2, 3].map((i) => ({
        name: `p${i}`,
        fixes: straightFixes(0, 600, 0, 1500, 12, -0.5),
        score: { madeGoal: i < 1 },
      })),
    );
    expect(renderTaskAnalysis(evaluateField(field))).toContain('1 of 4 made goal (25%)');
  });

  it('prints the zero day', () => {
    const field = makeTestField(
      [0, 1].map((i) => ({ name: `p${i}`, fixes: straightFixes(0, 600, 0, 1500, 12, -0.5) })),
    );
    expect(renderTaskAnalysis(evaluateField(field))).toContain('0 of 2 made goal (0%)');
  });

  /**
   * A v25-or-earlier row is SERVED while it revalidates, so the renderer meets
   * a basis with no count and must drop the fact rather than print "undefined
   * of 37" or invent a 0% day.
   */
  it('says nothing at all when a stale row carries no count', () => {
    const report = evaluateField(
      makeTestField([{ name: 'p0', fixes: straightFixes(0, 600, 0, 1500, 12, -0.5) }]),
    );
    delete report.basis.goalCount;
    const rendered = renderTaskAnalysis(report);
    expect(rendered).not.toContain('made goal');
    expect(rendered).not.toContain('undefined');
  });
});

describe('renderTaskAnalysis: degenerate field', () => {
  /**
   * "0 of 0 made goal" is a report with no pilots in it, not a hard day —
   * the same exit the web's basis box takes, so the two surfaces stay silent
   * about the same tasks.
   */
  it('says nothing for a field of no pilots', () => {
    const report = evaluateField(
      makeTestField([{ name: 'p0', fixes: straightFixes(0, 600, 0, 1500, 12, -0.5) }]),
    );
    report.basis.pilotCount = 0;
    report.basis.goalCount = 0;
    expect(renderTaskAnalysis(report)).not.toContain('made goal');
  });
});
