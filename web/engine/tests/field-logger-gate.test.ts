/**
 * The logger gate: metrics that read fine detail leave out a pilot whose
 * instrument records too seldom, and say so — a null with a note, plus one
 * field-summary line — rather than publish a value the logger, not the
 * pilot, decided (docs/2026-10-20-logger-interval-evidence.md).
 */
import { describe, expect, it } from 'bun:test';
import { ALL_METRICS } from '../src/analysis';
import {
  CIRCLE_DETAIL_MAX_INTERVAL_S,
  THERMAL_EDGE_MAX_INTERVAL_S,
  coarseLoggerGate,
} from '../src/analysis/metrics/util';
import { circlingFixes, makeTestField, straightFixes } from './field-test-helpers';

/** One climb and glide, every fix `every` seconds apart. */
const flight = (every: number) => [
  ...circlingFixes(0, 300, 0, 1000, 2, every),
  ...straightFixes(310, 600, 60, 1600, 12, -1, every),
];

function metric(id: string) {
  const m = ALL_METRICS.find((x) => x.id === id);
  if (!m) throw new Error(`unknown metric ${id}`);
  return m;
}

describe('coarseLoggerGate', () => {
  const field = makeTestField([
    { name: 'one', fixes: flight(1) },
    { name: 'two', fixes: flight(2) },
    { name: 'five', fixes: flight(5) },
    { name: 'ten', fixes: flight(10) },
  ]);

  it('reads each pilot’s logger interval from the airborne track', () => {
    const byName = new Map(field.pilots.map((p) => [p.trackFile, p.fixIntervalSeconds]));
    expect(byName.get('one.igc')).toBe(1);
    expect(byName.get('two.igc')).toBe(2);
    expect(byName.get('five.igc')).toBe(5);
    expect(byName.get('ten.igc')).toBe(10);
  });

  it('leaves out loggers slower than the limit, with the reason', () => {
    const gate = coarseLoggerGate(field, CIRCLE_DETAIL_MAX_INTERVAL_S);
    expect([...gate.excluded.keys()].sort()).toEqual(['five.igc', 'ten.igc']);
    expect(gate.excluded.get('ten.igc')).toEqual({
      trackFile: 'ten.igc',
      value: null,
      note: 'instrument records every 10 s; this measure needs every 2 s or faster',
    });
    expect(gate.summaryLine).toBe(
      '2 pilots left out: their instruments record a position only every 5–10 s, too seldom for this measure.',
    );
  });

  it('speaks of one pilot in the singular, and is silent when nobody is out', () => {
    const one = coarseLoggerGate(field, THERMAL_EDGE_MAX_INTERVAL_S);
    expect([...one.excluded.keys()].sort()).toEqual(['five.igc', 'ten.igc']);
    const single = coarseLoggerGate(field, 5);
    expect(single.summaryLine).toBe(
      '1 pilot left out: their instrument records a position only every 10 s, too seldom for this measure.',
    );
    expect(coarseLoggerGate(field, 10)).toEqual({ excluded: new Map(), summaryLine: null });
  });
});

describe('the four detail-hungry metrics', () => {
  // The same flight from a 1 s and a 10 s logger, both started.
  const started = {
    sssReaching: {
      taskIndex: 1,
      fixIndex: 0,
      time: flight(1)[0].time,
      latitude: -36.2,
      longitude: 147.9,
      altitude: 1000,
      selectionReason: 'first_after_previous' as const,
      candidateCount: 1,
    },
  };
  const field = makeTestField([
    { name: 'fine', fixes: flight(1), turnpointResult: started, score: { flownDistance: 30_000 } },
    { name: 'coarse', fixes: flight(10), turnpointResult: started, score: { flownDistance: 30_000 } },
  ]);

  for (const [id, limit] of [
    ['glide.dolphin_fraction', 2],
    ['climb.circle_smoothness', 2],
    ['climb.time_to_core', 4],
    ['decision.km_between_climbs', 4],
  ] as const) {
    it(`${id} leaves out the 10 s logger and says why`, () => {
      const out = metric(id).compute(field);
      const coarse = out.perPilot.find((v) => v.trackFile === 'coarse.igc')!;
      expect(coarse.value).toBeNull();
      expect(coarse.note).toBe(
        `instrument records every 10 s; this measure needs every ${limit} s or faster`,
      );
      expect(out.fieldSummary).toContain(
        '1 pilot left out: their instrument records a position only every 10 s, too seldom for this measure.',
      );
      const fine = out.perPilot.find((v) => v.trackFile === 'fine.igc')!;
      expect(fine.note ?? '').not.toContain('instrument records');
    });
  }
});
