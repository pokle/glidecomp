import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask } from '../src/xctsk-parser';
import { calculateOptimizedTaskDistance } from '../src/task-optimizer';
import { scoreTask, resolveCompGapParams, type PilotFlight } from '../src/gap-scoring';
import {
  buildFieldContext,
  evaluateField,
  renderFieldReport,
  spearman,
  ALL_METRICS,
  type FieldContext,
  type MetricComputer,
} from '../src/field-analysis';
import { makeTestField, straightFixes, circlingFixes } from './field-test-helpers';

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

// Built once — the integration suite shares it.
const field = buildKosciField();

describe('field analysis integration (kosci-loop-t1)', () => {
  it('builds a full FieldContext over the whole field', () => {
    expect(field.pilots.length).toBe(44);
    // Rank order and pilotIndex/grid alignment.
    for (let i = 0; i < field.pilots.length; i++) {
      expect(field.pilots[i].pilotIndex).toBe(i);
      if (i > 0) {
        expect(field.pilots[i].score.rank).toBeGreaterThanOrEqual(field.pilots[i - 1].score.rank);
      }
    }
    expect(field.grid.count).toBeGreaterThan(0);
    expect(field.grid.frames.length).toBe(field.grid.count);
    expect(field.sharedThermals.length).toBeGreaterThan(0);
    expect(field.workingBand.floorMeters).toBeLessThan(field.workingBand.ceilingMeters);
    expect(field.legs.length).toBe(field.task.turnpoints.length - 1);
    // Kosci T1 is a race with a start — most of the field should have started.
    expect(field.pilots.filter((p) => p.sssMs !== null).length).toBeGreaterThan(30);
  }, 120_000);

  it('partitions every pilot completely into phases', () => {
    for (const p of field.pilots) {
      if (p.phases.length === 0) continue;
      expect(p.phases[0].startIndex).toBe(p.takeoffIndex);
      expect(p.phases[p.phases.length - 1].endIndex).toBe(p.landingIndex);
      for (let i = 1; i < p.phases.length; i++) {
        expect(p.phases[i].startIndex).toBe(p.phases[i - 1].endIndex);
      }
    }
  }, 120_000);

  it('evaluates registered metrics and renders a report', () => {
    const report = evaluateField(field);
    expect(report.pilots.length).toBe(44);
    expect(report.metrics.length).toBe(ALL_METRICS.length);
    for (const m of report.metrics) {
      expect(m.perPilot.length).toBe(44);
      expect(m.error).toBeUndefined();
      if (m.correlation) {
        expect(isFinite(m.correlation.rho)).toBe(true);
        expect(m.correlation.n).toBeGreaterThanOrEqual(3);
      }
    }
    const rendered = renderFieldReport(report);
    expect(rendered).toContain('Field Analysis');
    expect(rendered).toContain('Basis: 44 scored pilots');
    expect(rendered).toContain('Metric separation ranking');
  }, 120_000);

  it('populates every non-exempt metric across the field (Stage 2 coverage gates)', () => {
    const report = evaluateField(field);
    const started = field.pilots.filter((p) => p.sssMs !== null).length;
    const byId = new Map(report.metrics.map((m) => [m.id, m]));
    const coverage = (id: string): number => {
      const m = byId.get(id);
      if (!m) throw new Error(`metric ${id} not registered`);
      return m.perPilot.filter((v) => v.value !== null).length;
    };

    // Broadly-applicable metrics: ≥ 80% of started pilots.
    for (const id of [
      'day.airtime_quality',
      'climb.shared_percentile',
      'climb.time_to_core',
      'climb.exit_decay',
      'climb.departure_band',
      'glide.speed',
      'glide.dolphin_fraction',
      'decision.altitude_floor',
      'decision.low_saves',
      'decision.search_fraction',
      'gaggle.affinity',
      'race.start_delay',
    ]) {
      expect(coverage(id)).toBeGreaterThanOrEqual(Math.floor(0.8 * started));
    }
    // Leg/marker-scoped metrics: only pilots completing speed-section legs
    // (or sharing marked thermals) qualify — ≥ 55% of started pilots here.
    for (const id of [
      'glide.ld_vs_field',
      'glide.track_efficiency',
      'race.leg_time_lost',
      'gaggle.marker_usage',
    ]) {
      expect(coverage(id)).toBeGreaterThanOrEqual(Math.floor(0.55 * started));
    }
    // ESS-scoped metrics: bounded by the 7 pilots who reach ESS on this task.
    expect(coverage('race.time_behind')).toBeGreaterThanOrEqual(5);
    expect(coverage('race.ess_margin')).toBeGreaterThanOrEqual(5);
    // Fixture-exempt on kosci (documented in the plan doc): the synthetic
    // triangle-wave tracks yield zero detected circles (selectivity,
    // circle_smoothness, day.wind samples), sub-20 km flights
    // (climbs_per_100km), uniform climbs (stf_proxy sparse), and no
    // qualifying gaggle departures or final-glide initiations. No coverage
    // gate for those — corryong is their exercise.

    // The day tables exist regardless.
    expect(byId.get('day.climb_by_hour')!.extraTables?.[0]?.rows.length).toBeGreaterThan(0);
    expect(byId.get('day.wind')!.extraTables?.length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('orders the goal field perfectly by time behind at ESS (horserace sanity)', () => {
    // Whole-field ρ is legitimately weak here (only 7/44 reach ESS and rank
    // separation is goal-completion, not speed) — the true sanity check is
    // that AMONG goal pilots, minutes-behind orders exactly with rank.
    const report = evaluateField(field);
    const tb = report.metrics.find((m) => m.id === 'race.time_behind')!;
    const valueByTrack = new Map(tb.perPilot.map((v) => [v.trackFile, v.value]));
    const values: number[] = [];
    const ranks: number[] = [];
    for (const p of field.pilots) {
      if (!p.score.madeGoal) continue;
      const v = valueByTrack.get(p.trackFile);
      if (v === null || v === undefined) continue;
      values.push(v);
      ranks.push(p.score.rank);
    }
    expect(values.length).toBeGreaterThanOrEqual(4); // kosci T1 has 4 goal-makers
    expect(spearman(values, ranks)).toBeGreaterThan(0.9);
  }, 120_000);

  it('leads the rendered report with the metric separation ranking', () => {
    const rendered = renderFieldReport(evaluateField(field));
    const separationAt = rendered.indexOf('Metric separation ranking');
    const firstFamilyAt = rendered.indexOf('--- Day profile');
    expect(separationAt).toBeGreaterThan(-1);
    expect(firstFamilyAt).toBeGreaterThan(-1);
    // Presentation principle: the separation ranking guides the reader to the
    // strategies that mattered today, so it prints before the family detail.
    expect(separationAt).toBeLessThan(firstFamilyAt);
  }, 120_000);

  it('correlates a known-good metric strongly against rank (eval template)', () => {
    // A trivial metric — flown distance — must correlate hard with GAP rank.
    // This is the authoring template for Stage 1 metric packages.
    const flownDistance: MetricComputer = {
      id: 'test.flown_distance',
      label: 'Flown distance',
      shortLabel: 'Dist',
      unit: 'm',
      family: 'racecraft',
      direction: 'higher',
      explanation: 'Scored flown distance straight from the GAP result (sanity check).',
      compute(f) {
        return {
          perPilot: f.pilots.map((p) => ({
            trackFile: p.trackFile,
            value: p.score.flownDistance,
          })),
        };
      },
    };
    const report = evaluateField(field, [flownDistance]);
    const c = report.metrics[0].correlation;
    expect(c).not.toBeNull();
    expect(c!.n).toBe(44);
    // Higher distance → better (numerically lower) rank → strongly negative ρ.
    expect(c!.rho).toBeLessThan(-0.8);
    expect(c!.verdict).toBe('strong');
    expect(renderFieldReport(report)).toContain('test.flown_distance');
  }, 120_000);

  it('surfaces a throwing metric as an error without killing the report', () => {
    const broken: MetricComputer = {
      id: 'test.broken',
      label: 'Broken',
      unit: 'pct',
      family: 'day',
      direction: 'neutral',
      explanation: 'Always throws.',
      compute() {
        throw new Error('boom');
      },
    };
    const report = evaluateField(field, [broken]);
    expect(report.metrics[0].error).toBe('boom');
    expect(report.metrics[0].perPilot.every((v) => v.value === null)).toBe(true);
    expect(renderFieldReport(report)).toContain('ERROR computing this metric: boom');
  }, 120_000);
});

describe('makeTestField (Stage 1 test factory)', () => {
  it('builds a synthetic field with real detectors', () => {
    // Two pilots: one climbs in a thermal then glides; one just glides.
    const climber = [
      ...circlingFixes(0, 300, 0, 1000, 2),
      ...straightFixes(310, 600, 60, 1600, 12, -1),
    ];
    const glider = straightFixes(0, 900, 0, 1600, 12, -1);
    const field = makeTestField([
      { name: 'climber', fixes: climber },
      { name: 'glider', fixes: glider },
    ]);
    expect(field.pilots.length).toBe(2);
    expect(field.pilots[0].score.rank).toBe(1);
    expect(field.pilots[0].thermals.length).toBeGreaterThan(0); // circling climb detected
    expect(field.pilots[1].phases.some((p) => p.phase === 'glide')).toBe(true);
    expect(field.grid.count).toBeGreaterThan(0);
  });
});
