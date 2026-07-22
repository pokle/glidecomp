import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { scoreTask, resolveCompGapParams, type PilotFlight } from '../src/gap-scoring';
import type { TurnpointReaching } from '../src/turnpoint-sequence';
import {
  buildFieldContext,
  evaluateField,
  type FieldAnalysisReport,
  type FieldContext,
} from '../src/field-analysis';
import { GAGGLE_METRICS } from '../src/field-analysis/metrics/gaggle';
import {
  makeTestField,
  straightFixes,
  circlingFixes,
  BASE_TIME,
  TEST_ORIGIN,
} from './field-test-helpers';

/** A minimal valid TurnpointReaching at a BASE_TIME-relative second. */
function reachingAt(taskIndex: number, seconds: number): TurnpointReaching {
  return {
    taskIndex,
    fixIndex: 0,
    time: new Date(BASE_TIME.getTime() + seconds * 1000),
    latitude: TEST_ORIGIN.lat,
    longitude: TEST_ORIGIN.lon,
    altitude: 1500,
    selectionReason: 'first_after_previous',
    candidateCount: 1,
  };
}

/** The metric's aligned per-pilot value for a trackFile. */
function valueFor(report: FieldAnalysisReport, metricId: string, trackFile: string) {
  const metric = report.metrics.find((m) => m.id === metricId)!;
  expect(metric).toBeDefined();
  const idx = report.pilots.findIndex((p) => p.trackFile === trackFile);
  expect(idx).toBeGreaterThanOrEqual(0);
  return metric.perPilot[idx];
}

// ---------------------------------------------------------------------------
// gaggle.affinity
// ---------------------------------------------------------------------------

describe('gaggle.affinity', () => {
  // Two pilots side-by-side (50 m apart, 20 m vertical) flying east from
  // 8 km — outside the 2 km SSS cylinder centred 5 km east — for 600 s.
  // A third started pilot flies the same line 1500 m higher (never linked),
  // and a fourth never started.
  const field = makeTestField([
    {
      name: 'lead',
      fixes: straightFixes(0, 600, 8_000, 1500, 10, -0.3),
      turnpointResult: { sssReaching: reachingAt(1, 0) },
    },
    {
      name: 'wing',
      fixes: straightFixes(0, 600, 8_050, 1520, 10, -0.3),
      turnpointResult: { sssReaching: reachingAt(1, 0) },
    },
    {
      name: 'high',
      fixes: straightFixes(0, 600, 8_000, 3000, 10, -0.3),
      turnpointResult: { sssReaching: reachingAt(1, 0) },
    },
    {
      name: 'nostart',
      fixes: straightFixes(0, 600, 8_050, 1480, 10, -0.3),
    },
  ]);
  const report = evaluateField(field, GAGGLE_METRICS);

  it('detects the pair as a gaggle for most of their post-SSS steps', () => {
    expect(field.gaggles.episodes.length).toBeGreaterThan(0);
    expect(valueFor(report, 'gaggle.affinity', 'lead.igc').value).toBeGreaterThan(80);
    expect(valueFor(report, 'gaggle.affinity', 'wing.igc').value).toBeGreaterThan(80);
  });

  it('gives a started pilot who never gaggled 0 (not null)', () => {
    expect(valueFor(report, 'gaggle.affinity', 'high.igc').value).toBe(0);
  });

  it('is null for a pilot who never started', () => {
    expect(valueFor(report, 'gaggle.affinity', 'nostart.igc').value).toBeNull();
  });

  it('summarizes the detected episodes', () => {
    const metric = report.metrics.find((m) => m.id === 'gaggle.affinity')!;
    expect(metric.fieldSummary?.length).toBe(1);
    expect(metric.fieldSummary![0]).toContain('gaggle episode');
  });

  it('finds no departures in a gaggle that flies together to the end', () => {
    const metric = report.metrics.find((m) => m.id === 'gaggle.departure_winrate')!;
    expect(metric.error).toBeUndefined();
    expect(metric.perPilot.every((v) => v.value === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// gaggle.marker_usage
// ---------------------------------------------------------------------------

describe('gaggle.marker_usage', () => {
  // A marker pilot climbs three well-separated (2 km apart) thermals; a
  // follower flies the same route 60 s behind, joining each climb while the
  // marker is still in it. A loner circles once, 7 km away, on their own.
  function route(delaySeconds: number) {
    const d = delaySeconds;
    return [
      ...circlingFixes(d + 0, 400, 9_000, 1000, 2.0),
      ...straightFixes(d + 405, 90, 9_060, 1800, 21, -2),
      ...circlingFixes(d + 500, 400, 11_000, 1620, 2.0),
      ...straightFixes(d + 905, 90, 11_060, 2420, 21, -2),
      ...circlingFixes(d + 1000, 400, 13_000, 2240, 1.5),
    ];
  }
  const field = makeTestField([
    {
      name: 'marker',
      fixes: route(0),
      turnpointResult: { sssReaching: reachingAt(1, 0) },
    },
    {
      name: 'follower',
      fixes: route(60),
      turnpointResult: { sssReaching: reachingAt(1, 0) },
    },
    {
      name: 'loner',
      fixes: [
        ...circlingFixes(0, 400, 20_000, 1000, 2.0),
        ...straightFixes(405, 200, 20_060, 1800, 15, -1),
      ],
      turnpointResult: { sssReaching: reachingAt(1, 0) },
    },
  ]);
  const report = evaluateField(field, GAGGLE_METRICS);

  it('clusters the route into three multi-pilot shared thermals', () => {
    expect(field.sharedThermals.filter((s) => s.pilotCount >= 2).length).toBe(3);
  });

  it('scores the follower 100% marked and the marker 0%', () => {
    const follower = valueFor(report, 'gaggle.marker_usage', 'follower.igc');
    expect(follower.value).toBe(100);
    expect(follower.note).toBe('3/3 climbs marked');
    const marker = valueFor(report, 'gaggle.marker_usage', 'marker.igc');
    expect(marker.value).toBe(0);
    expect(marker.note).toBe('0/3 climbs marked');
  });

  it('is null below 3 post-SSS uses', () => {
    expect(valueFor(report, 'gaggle.marker_usage', 'loner.igc').value).toBeNull();
  });

  it('is null for a pilot who never started (all uses pre-SSS)', () => {
    const noStart = makeTestField([
      { name: 'a', fixes: route(0), turnpointResult: { sssReaching: reachingAt(1, 0) } },
      { name: 'b', fixes: route(60) }, // never started — same climbs, none count
    ]);
    const r = evaluateField(noStart, GAGGLE_METRICS);
    expect(valueFor(r, 'gaggle.marker_usage', 'b.igc').value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// gaggle.departure_winrate
// ---------------------------------------------------------------------------

describe('gaggle.departure_winrate', () => {
  // Four pilots fly together from 8 km east; at t=300 the leaver accelerates
  // away (10 m/s separation) while three stayers continue together to t=900 —
  // a departure with ≥ 2 remaining members and ≥ 120 s of continuation. All
  // reaching times are faked on turnpointResult; the leaver's next turnpoint
  // (ESS, taskIndex 2) is compared against the stayers' median (t=1050).
  function makeDepartureField(leaverReachSeconds: number): FieldContext {
    const stayer = (name: string, offset: number, reachSeconds: number) => ({
      name,
      fixes: straightFixes(0, 900, 8_000 + offset, 1500 + offset, 8, -0.3),
      turnpointResult: {
        sssReaching: reachingAt(1, 0),
        sequence: [reachingAt(1, 0), reachingAt(2, reachSeconds)],
      },
    });
    return makeTestField([
      {
        name: 'leaver',
        fixes: [
          ...straightFixes(0, 300, 8_000, 1500, 8, -0.3),
          ...straightFixes(310, 590, 10_580, 1407, 18, -0.3),
        ],
        turnpointResult: {
          sssReaching: reachingAt(1, 0),
          sequence: [reachingAt(1, 0), reachingAt(2, leaverReachSeconds)],
        },
      },
      stayer('s1', 30, 1000),
      stayer('s2', 60, 1050),
      stayer('s3', 90, 1100),
    ]);
  }

  it('scores a departure that beat the stayers as a win', () => {
    const report = evaluateField(makeDepartureField(800), GAGGLE_METRICS);
    const leaver = valueFor(report, 'gaggle.departure_winrate', 'leaver.igc');
    expect(leaver.value).toBe(100);
    expect(leaver.note).toBe('1W–0L (1 departure)');
  });

  it('scores a departure slower than the stayers\' median as a loss', () => {
    const report = evaluateField(makeDepartureField(1200), GAGGLE_METRICS);
    const leaver = valueFor(report, 'gaggle.departure_winrate', 'leaver.igc');
    expect(leaver.value).toBe(0);
    expect(leaver.note).toBe('0W–1L (1 departure)');
  });

  it('is null for the pilots who stayed', () => {
    const report = evaluateField(makeDepartureField(800), GAGGLE_METRICS);
    for (const name of ['s1', 's2', 's3']) {
      expect(valueFor(report, 'gaggle.departure_winrate', `${name}.igc`).value).toBeNull();
    }
  });

  it('prints the mandated self-explanatory method text verbatim', () => {
    const metric = GAGGLE_METRICS.find((m) => m.id === 'gaggle.departure_winrate')!;
    expect(metric.explanation).toBe(
      'When a pilot leaves a gaggle that keeps flying, did leaving pay off? We compare the ' +
        "leaver's arrival at the next turnpoint against the median arrival of the pilots who " +
        'stayed. Win rate > 50% means their departures beat the gaggle. Only pilots still in ' +
        'the gaggle after the split who reached that turnpoint after it count as stayers.',
    );
  });

  // --- Comparator validity (exit-turnpoint / out-and-return regressions) ---
  //
  // These inject a hand-built episode timeline so snapshot membership is
  // exact; the real detector is exercised by the geometric fixtures above.

  /** Replace the detected gaggles with one episode over the given timeline. */
  function injectEpisode(
    field: FieldContext,
    timeline: { t: number; members: number[] }[],
  ): void {
    field.gaggles = {
      params: field.gaggles.params,
      episodes: [
        {
          id: 1,
          tStart: timeline[0].t,
          tEnd: timeline[timeline.length - 1].t,
          members: [...new Set(timeline.flatMap((s) => s.members))].sort((a, b) => a - b),
          timeline,
          peakSize: Math.max(...timeline.map((s) => s.members.length)),
        },
      ],
    };
  }

  const plainPilot = (
    name: string,
    offset: number,
    reachSeconds: number,
  ) => ({
    name,
    fixes: straightFixes(0, 900, 8_000 + offset, 1500, 8, -0.3),
    turnpointResult: {
      sssReaching: reachingAt(1, 0),
      sequence: [reachingAt(1, 0), reachingAt(2, reachSeconds)],
    },
  });

  it('ignores "stayers" who reached the turnpoint before the split (out-and-return)', () => {
    // s1 and s2 tagged the leaver's next turnpoint BEFORE the departure —
    // returning pilots sharing a thermal with outbound ones. Their times are
    // decided by course position, not by the departure, so they must not be
    // comparators; s3 alone is below MIN_COMPARATORS, so no departure counts.
    const field = makeTestField([
      plainPilot('leaver', 0, 800),
      plainPilot('s1', 30, 50),
      plainPilot('s2', 60, 60),
      plainPilot('s3', 90, 1000),
    ]);
    injectEpisode(field, [
      { t: 0, members: [0, 1, 2, 3] },
      { t: 60, members: [0, 1, 2, 3] },
      { t: 120, members: [0, 1, 2, 3] },
      { t: 180, members: [1, 2, 3] },
      { t: 240, members: [1, 2, 3] },
      { t: 300, members: [1, 2, 3] },
      { t: 360, members: [1, 2, 3] },
    ]);
    const report = evaluateField(field, GAGGLE_METRICS);
    expect(valueFor(report, 'gaggle.departure_winrate', 'leaver.igc').value).toBeNull();
  });

  it('does not count a same-split co-leaver as a stayer', () => {
    // Pilots 0 and 1 leave in the same split. The co-leaver's (fast) arrival
    // must not enter the stayers' median: with it the median is 1025 and the
    // leaver's 1040 reads as a loss; the true stayers' median is 1050 and
    // the departure is a win.
    const field = makeTestField([
      plainPilot('leaver', 0, 1040),
      plainPilot('co', 30, 900),
      plainPilot('s2', 60, 1000),
      plainPilot('s3', 90, 1050),
      plainPilot('s4', 120, 1100),
    ]);
    injectEpisode(field, [
      { t: 0, members: [0, 1, 2, 3, 4] },
      { t: 60, members: [0, 1, 2, 3, 4] },
      { t: 120, members: [0, 1, 2, 3, 4] },
      { t: 180, members: [2, 3, 4] },
      { t: 240, members: [2, 3, 4] },
      { t: 300, members: [2, 3, 4] },
      { t: 360, members: [2, 3, 4] },
    ]);
    const report = evaluateField(field, GAGGLE_METRICS);
    const leaver = valueFor(report, 'gaggle.departure_winrate', 'leaver.igc');
    expect(leaver.value).toBe(100);
    expect(leaver.note).toBe('1W–0L (1 departure)');
  });
});

// ---------------------------------------------------------------------------
// Smoke test over the real kosci-loop-t1 field
// ---------------------------------------------------------------------------

const KOSCI_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../samples/comps/kosci-loop-t1',
);

/** Score kosci-loop-t1 (deterministic synthetic PG race) and build the field. */
function buildKosciField(): FieldContext {
  const entries = readdirSync(KOSCI_DIR);
  const taskFile = entries.find((f) => f.endsWith('.xctsk'))!;
  const task = parseXCTask(readFileSync(join(KOSCI_DIR, taskFile), 'utf-8'));

  const pilots: PilotFlight[] = entries
    .filter((f) => f.endsWith('.igc'))
    .sort()
    .map((f) => {
      const igc = parseIGC(readFileSync(join(KOSCI_DIR, f), 'utf-8'));
      return { pilotName: igc.header.pilot || f, trackFile: join(KOSCI_DIR, f), fixes: igc.fixes };
    });

  const gapParams = resolveCompGapParams('pg', { scoring: 'PG' });
  gapParams.nominalDistance = 0.7 * calculateOptimizedTaskDistance(task);
  const result = scoreTask(task, pilots, gapParams);
  return buildFieldContext(task, pilots, result, 'pg');
}

describe('gaggle metrics smoke test (kosci-loop-t1)', () => {
  it('computes all three metrics over the real field without error', () => {
    const field = buildKosciField();
    const report = evaluateField(field, GAGGLE_METRICS);
    expect(report.metrics.length).toBe(3);
    for (const m of report.metrics) {
      expect(m.error).toBeUndefined();
      expect(m.perPilot.length).toBe(field.pilots.length);
    }

    // Kosci tracks are dense route-followers: most started pilots should get
    // an affinity value, and plenty of them should actually be in a gaggle.
    const affinity = report.metrics.find((m) => m.id === 'gaggle.affinity')!;
    const started = report.pilots.filter(
      (_, i) => field.pilots[i].sssMs !== null,
    ).length;
    expect(started).toBeGreaterThan(0);
    const affinityValues = affinity.perPilot.filter((v) => v.value !== null);
    expect(affinityValues.length).toBeGreaterThan(started * 0.5);
    expect(affinityValues.some((v) => v.value! > 0)).toBe(true);
  }, 120_000);
});
