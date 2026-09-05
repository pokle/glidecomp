// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The basis's airtime split grouped by goal (TASK_ANALYSIS_VERSION 29): the
 * field-wide mix divided between pilots who made goal and those who did not.
 *
 * Each side is that group's own airborne time, pooled by seconds — the same
 * pooling the field-wide split already uses. The pair is omitted when only
 * one group flew: a 0% or 100% goal day has nothing to compare.
 */
import { describe, it, expect } from 'bun:test';
import {
  evaluateField,
  renderTaskAnalysis,
  type FieldAirtimeSplit,
  type FieldContext,
} from '../src/analysis';
import { makeTestField, straightFixes, circlingFixes } from './field-test-helpers';

/** A long straight glide — reads as gliding. */
const GLIDE = () => straightFixes(0, 600, 0, 1500, 12, -0.5);

/**
 * Climb then a slow meander — more climbing/searching than the straight
 * glide, so the two groups' mixes actually differ.
 */
const HUNT = () => [
  ...circlingFixes(0, 400, 0, 1000, 2),
  ...straightFixes(410, 200, 60, 1800, 4, 0),
];

function mixedField(): FieldContext {
  return makeTestField([
    { name: 'goal-a', fixes: GLIDE(), score: { madeGoal: true } },
    { name: 'goal-b', fixes: GLIDE(), score: { madeGoal: true } },
    { name: 'out-a', fixes: HUNT(), score: { madeGoal: false } },
  ]);
}

function allGoal(): FieldContext {
  return makeTestField([
    { name: 'a', fixes: GLIDE(), score: { madeGoal: true } },
    { name: 'b', fixes: GLIDE(), score: { madeGoal: true } },
  ]);
}

function noneGoal(): FieldContext {
  return makeTestField([
    { name: 'a', fixes: GLIDE(), score: { madeGoal: false } },
    { name: 'b', fixes: HUNT(), score: { madeGoal: false } },
  ]);
}

function basisBlock(rendered: string): string {
  const lines = rendered.split('\n');
  const start = lines.findIndex((l) => l.startsWith('Basis:'));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => !l.startsWith('       '));
  return [lines[start], ...(end === -1 ? rest : rest.slice(0, end))].join('\n');
}

describe('analysis basis: airtime split by goal', () => {
  it('splits the field mix into the two groups, pooled by seconds', () => {
    const { basis } = evaluateField(mixedField());
    const by = basis.airtimeSplitByGoal;
    expect(by).toBeDefined();
    expect(basis.airtimeSplit).toBeDefined();

    const made = by!.madeGoal.airborneSeconds;
    const out = by!.didNotMakeGoal.airborneSeconds;
    expect(made + out).toBeCloseTo(basis.airtimeSplit!.airborneSeconds, 6);

    // Seconds-weighted mix of the two groups reconstructs the field.
    const weight = (group: FieldAirtimeSplit, phase: 'climbPct' | 'glidePct' | 'searchPct') =>
      (group[phase] / 100) * group.airborneSeconds;
    const total = made + out;
    for (const phase of ['climbPct', 'glidePct', 'searchPct'] as const) {
      const reconstructed =
        ((weight(by!.madeGoal, phase) + weight(by!.didNotMakeGoal, phase)) / total) * 100;
      expect(reconstructed).toBeCloseTo(basis.airtimeSplit![phase], 10);
    }
  });

  it('gives each group its own mix, not a copy of the field', () => {
    const { basis } = evaluateField(mixedField());
    const by = basis.airtimeSplitByGoal!;
    // Goal-makers flew the straight glide; the landout climbed and hunted.
    expect(by.madeGoal.glidePct).toBeGreaterThan(by.didNotMakeGoal.glidePct);
    expect(by.didNotMakeGoal.climbPct + by.didNotMakeGoal.searchPct).toBeGreaterThan(
      by.madeGoal.climbPct + by.madeGoal.searchPct,
    );
  });

  it('omits the pair when everyone made goal', () => {
    expect(evaluateField(allGoal()).basis.airtimeSplitByGoal).toBeUndefined();
    expect(evaluateField(allGoal()).basis.airtimeSplit).toBeDefined();
  });

  it('omits the pair when nobody made goal', () => {
    expect(evaluateField(noneGoal()).basis.airtimeSplitByGoal).toBeUndefined();
    expect(evaluateField(noneGoal()).basis.airtimeSplit).toBeDefined();
  });
});

describe('renderTaskAnalysis: airtime split by goal', () => {
  it('prints each group on its own line, in place of the field-wide mix', () => {
    const block = basisBlock(renderTaskAnalysis(evaluateField(mixedField())));
    expect(block).toContain('2 of 3 made goal');
    expect(block).toMatch(/made goal \(2, [\d.]+ h\):/);
    expect(block).toMatch(/didn't make goal \(1, [\d.]+ h\):/);
    // The field-wide gerunds lived on the day line; with both groups they
    // move onto the two lines below, so the day line itself must not still
    // carry a third copy of the mix.
    const dayLine = block.split('\n').find((l) => l.includes('airtime'));
    expect(dayLine).toBeDefined();
    expect(dayLine!).not.toContain('climbing');
  });

  it('keeps the single mix when only one group flew', () => {
    const block = basisBlock(renderTaskAnalysis(evaluateField(allGoal())));
    expect(block).toContain('climbing');
    expect(block).not.toContain("didn't make goal");
  });

  it('says nothing extra when a stale row has no pair', () => {
    const report = evaluateField(mixedField());
    delete report.basis.airtimeSplitByGoal;
    const block = basisBlock(renderTaskAnalysis(report));
    expect(block).not.toContain("didn't make goal");
    expect(block).toContain('climbing');
  });
});
