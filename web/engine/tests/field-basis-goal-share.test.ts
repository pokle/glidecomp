// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The basis's goal share (TASK_ANALYSIS_VERSION 28, issue #683): how many
 * pilots made goal, which is the day's difficulty and the variable v27 tells
 * the reader to read glide.extra_distance against.
 *
 * The cases that matter are the edges — nobody in goal, everybody in goal, a
 * pilot in the scores the analysis could not measure, and a stored report from
 * before the field existed — because each is a place a naive implementation
 * quietly says the wrong thing: `0` is falsy, `n/n` is a real day, a scored
 * pilot the analysis never saw is not in the denominator, and an absent field
 * is not a hard day.
 */
import { describe, it, expect } from 'bun:test';
import { evaluateField, renderTaskAnalysis, type FieldContext } from '../src/analysis';
import type { TaskAnalysisBasis } from '../src/analysis';
import { makeTestField, straightFixes } from './field-test-helpers';

const GLIDE = () => straightFixes(0, 600, 0, 1500, 12, -0.5);

/**
 * The basis block alone — the "Basis:" line and the indented day line under
 * it. Scoped deliberately: since v27 glide.extra_distance's own explanation
 * tells the reader to read it "against how many pilots made goal", so a
 * whole-report search for that phrase matches the glossary and proves
 * nothing about the basis.
 */
function basisBlock(rendered: string): string {
  const lines = rendered.split('\n');
  const start = lines.findIndex((l) => l.startsWith('Basis:'));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => !l.startsWith('       '));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

/** `n` pilots on identical straight glides; `goals` of them made goal. */
function field(n: number, goals: number): FieldContext {
  return makeTestField(
    Array.from({ length: n }, (_, i) => ({
      name: `p${i}`,
      fixes: GLIDE(),
      score: { madeGoal: i < goals },
    })),
  );
}

function basisOf(n: number, goals: number): TaskAnalysisBasis {
  return evaluateField(field(n, goals)).basis;
}

describe('analysis basis: goal share', () => {
  it('counts the pilots who made goal, out of the analysed field', () => {
    expect(basisOf(3, 2)).toMatchObject({ goalCount: 2, pilotCount: 3 });
  });

  /**
   * Zero is the loudest reading the field has — a day nobody completed is the
   * hardest kind there is — and it is also falsy, so an implementation that
   * only emits a "truthy" count drops the finding on exactly the tasks that
   * have one.
   */
  it('states an emphatic zero rather than omitting the field', () => {
    expect(basisOf(3, 0).goalCount).toBe(0);
    expect(basisOf(3, 0).goalCount).not.toBeUndefined();
  });

  it('counts a whole field into goal', () => {
    expect(basisOf(3, 3)).toMatchObject({ goalCount: 3, pilotCount: 3 });
  });

  /**
   * The denominator is the ANALYSED field, not `scoreResult.pilotScores`,
   * which can carry a pilot buildFieldContext dropped for having no usable
   * fixes. Printing that larger number would put a denominator on the report
   * that its own per-pilot tables cannot account for — and the CLI has no
   * exclusion note to explain the gap.
   *
   * The trade is documented on TaskAnalysisBasis.goalCount: it parts company
   * with the sweep's `goal / scores.length` by a few points on tasks with
   * unanalysable tracks. Nothing in the BACKEND sees it, because
   * task-analysis.ts filters pilotScores to the analysed set first.
   */
  it('ignores a scored pilot who never entered the analysed field', () => {
    const f = field(3, 1);
    const [seed] = f.scoreResult.pilotScores;
    f.scoreResult.pilotScores.push(
      { ...seed, pilotName: 'unanalysed', trackFile: 'unanalysed.igc', madeGoal: true, rank: 4 },
    );

    const basis = evaluateField(f).basis;
    expect(basis.pilotCount).toBe(3);
    expect(basis.goalCount).toBe(1);
  });
});

describe('renderTaskAnalysis: goal share', () => {
  it('leads the day line with the share, in the words pilots use', () => {
    const block = basisBlock(renderTaskAnalysis(evaluateField(field(4, 1))));
    expect(block).toContain('1 of 4 made goal (25%)');
    // Ahead of the airtime it shares the line with.
    expect(block.indexOf('made goal')).toBeLessThan(block.indexOf('airtime'));
  });

  it('prints the zero day', () => {
    expect(basisBlock(renderTaskAnalysis(evaluateField(field(2, 0))))).toContain(
      '0 of 2 made goal (0%)',
    );
  });

  /**
   * A v27-or-earlier row is SERVED while it revalidates, so the renderer meets
   * a basis with no counts and must drop the fact rather than print "undefined
   * of 37" or invent a 0% day.
   */
  it('says nothing at all when a stale row carries no counts', () => {
    const report = evaluateField(field(1, 0));
    delete report.basis.goalCount;
    const block = basisBlock(renderTaskAnalysis(report));
    expect(block).not.toContain('made goal');
    expect(block).not.toContain('undefined');
  });

  /**
   * "0 of 0 made goal" is a report with no pilots in it, not a hard day — the
   * same exit the web's basis box takes, so the two surfaces stay silent about
   * the same tasks.
   */
  it('says nothing for a field of no pilots', () => {
    const report = evaluateField(field(1, 0));
    report.basis.pilotCount = 0;
    report.basis.goalCount = 0;
    expect(basisBlock(renderTaskAnalysis(report))).not.toContain('made goal');
  });
});
