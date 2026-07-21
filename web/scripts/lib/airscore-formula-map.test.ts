import { describe, it, expect } from 'bun:test';
import {
  mapAirscoreFormula,
  parseFormulaName,
  sharedGapParams,
  taskGapParamOverrides,
  type AirscoreFormulaBlock,
} from './airscore-formula-map';

// Real published blocks from web/samples/comps/*/airscore-result-raw.json —
// the mapping domain this module was designed against.
const CORRYONG_2021_OPEN: AirscoreFormulaBlock = {
  formula: 'gap-2018', goal_penalty: '1', nominal_goal: '30%',
  minimum_distance: '5 km', nominal_distance: '35 km', nominal_time: '90 mins',
  arrival_scoring: 'place', departure: 'off', stop_glide_bonus: '0',
  start_weight: '0.125', arrival_weight: '0.175', speed_weight: '0.7',
  scale_to_validity: '0', error_margin: 0.0005, arrival: 'off', height_bonus: 'off',
};

const CORRYONG_2026_OPEN: AirscoreFormulaBlock = {
  ...CORRYONG_2021_OPEN, formula: 'gap-2021', arrival_scoring: 'timed',
  start_weight: '0.175', arrival_weight: '0.125',
};

const CORRYONG_2017_OPEN: AirscoreFormulaBlock = {
  formula: 'gap-hg2013', goal_penalty: '0.2', nominal_goal: '20%',
  minimum_distance: '5 km', nominal_distance: '50 km', nominal_time: '90 mins',
  arrival_scoring: 'place', departure: 'Dpt', stop_glide_bonus: '0',
  start_weight: '0.125', arrival_weight: '0.175', speed_weight: '0.7',
  scale_to_validity: '0', error_margin: 0.0005, arrival: 'on', height_bonus: 'on',
};

const CORRYONG_2024_OPEN_T2: AirscoreFormulaBlock = {
  ...CORRYONG_2026_OPEN, departure: 'Ldo', arrival: 'on', height_bonus: 'on',
};

const UNUNGRA_2020: AirscoreFormulaBlock = {
  formula: 'ggap-2018', goal_penalty: '1', nominal_goal: '30%',
  minimum_distance: '5 km', nominal_distance: '40 km', nominal_time: '115 mins',
  arrival_scoring: 'timed', departure: 'Lkm', stop_glide_bonus: '5',
  start_weight: '0.15', arrival_weight: '0.175', speed_weight: '0.7',
  scale_to_validity: '0', error_margin: 0.0005, arrival: 'off', height_bonus: 'off',
};

describe('parseFormulaName', () => {
  it('splits class and year, including the hg2013 form', () => {
    expect(parseFormulaName('gap-2018')).toEqual({ cls: 'gap', year: 2018 });
    expect(parseFormulaName('ggap-2018')).toEqual({ cls: 'ggap', year: 2018 });
    expect(parseFormulaName('gap-hg2013')).toEqual({ cls: 'gap', year: 2013 });
    expect(parseFormulaName(undefined)).toEqual({ cls: '', year: null });
  });
});

describe('mapAirscoreFormula — HG generations', () => {
  it('gap-2018 HG (Corryong 2021): 2/3 exponent, leading+arrival off, keep 0% at ESS-not-goal — no warnings', () => {
    const { gapParams: p, cylinderTolerance, warnings } =
      mapAirscoreFormula(CORRYONG_2021_OPEN, 'hg');
    expect(p.timePointsExponent).toBe('2/3');
    expect(p.leadingFormula).toBe('classic');
    expect(p.useLeading).toBe(false);
    expect(p.useArrival).toBe(false);
    expect(p.essNotGoalFactor).toBe(0);
    expect(p.nominalDistance).toBe(35000);
    expect(p.nominalTime).toBe(5400);
    expect(p.nominalGoal).toBeCloseTo(0.3, 10);
    expect(p.minimumDistance).toBe(5000);
    expect(cylinderTolerance).toBe(0.0005);
    expect(warnings).toEqual([]);
  });

  it('gap-2021 HG (Corryong 2026): 5/6 exponent; timed arrival_scoring is harmless while arrival is off', () => {
    const { gapParams: p, warnings } = mapAirscoreFormula(CORRYONG_2026_OPEN, 'hg');
    expect(p.timePointsExponent).toBe('5/6');
    expect(p.useArrival).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('gap-hg2013 HG (Corryong 2017 open): 2/3 exponent, keep 80%, Dpt departure warns and disables leading', () => {
    const { gapParams: p, warnings } = mapAirscoreFormula(CORRYONG_2017_OPEN, 'hg');
    expect(p.timePointsExponent).toBe('2/3');
    expect(p.essNotGoalFactor).toBeCloseTo(0.8, 10);
    expect(p.useLeading).toBe(false);
    expect(p.useArrival).toBe(true);
    expect(p.nominalGoal).toBeCloseTo(0.2, 10);
    expect(warnings.some((w) => w.includes('Dpt'))).toBe(true);
  });

  it('gap-2021 HG with Ldo + timed arrival (Corryong 2024 t2–4): leading on with the linear-LC warning, timed-arrival warning', () => {
    const { gapParams: p, warnings } = mapAirscoreFormula(CORRYONG_2024_OPEN_T2, 'hg');
    expect(p.useLeading).toBe(true);
    expect(p.useArrival).toBe(true);
    expect(warnings.some((w) => w.includes('linear-area'))).toBe(true);
    expect(warnings.some((w) => w.includes('timed'))).toBe(true);
  });

  it('warns about an ESS height bonus flagged on the task', () => {
    const { warnings } = mapAirscoreFormula(CORRYONG_2024_OPEN_T2, 'hg', { hbess: 'on' });
    expect(warnings.some((w) => w.includes('hbess'))).toBe(true);
  });
});

describe('mapAirscoreFormula — PG generations', () => {
  it('ggap-2018 PG (Unungra 2020): loud GGap warning, Lkm warning, PG glide-bonus warning', () => {
    const { gapParams: p, warnings } = mapAirscoreFormula(UNUNGRA_2020, 'pg');
    expect(p.timePointsExponent).toBe('2/3');
    expect(p.useLeading).toBe(false);
    expect(p.useArrival).toBe(false);
    expect(p.nominalDistance).toBe(40000);
    expect(p.nominalTime).toBe(115 * 60);
    expect(warnings.some((w) => w.includes('GGap'))).toBe(true);
    expect(warnings.some((w) => w.includes('Lkm'))).toBe(true);
    expect(warnings.some((w) => w.includes('glide bonus 5:1'))).toBe(true);
  });

  it('gap-2021 PG maps to the s7f2020 generation (with the legacy knob-weights caveat)', () => {
    const { gapParams: p, warnings } =
      mapAirscoreFormula({ ...CORRYONG_2026_OPEN, arrival_scoring: 'place' }, 'pg');
    expect(p.leadingWeightFormula).toBe('s7f2020');
    expect(p.leadingFormula).toBe('weighted');
    expect(p.timePointsExponent).toBe('5/6');
    expect(warnings.some((w) => w.includes('verify parity'))).toBe(true);
  });

  it('gap-2023 PG maps to s7f2024', () => {
    const { gapParams: p } =
      mapAirscoreFormula({ ...CORRYONG_2026_OPEN, formula: 'gap-2023', arrival_scoring: 'place' }, 'pg');
    expect(p.leadingWeightFormula).toBe('s7f2024');
  });

  it('gap-2018 PG maps to the gap2020 (GAP2016/2018) weights', () => {
    const { gapParams: p } = mapAirscoreFormula({ ...CORRYONG_2021_OPEN }, 'pg');
    expect(p.leadingWeightFormula).toBe('gap2020');
    expect(p.leadingFormula).toBe('classic');
  });
});

describe('mapAirscoreFormula — loud failure on unknown vocabulary', () => {
  it('unknown formula class warns and still maps nominals', () => {
    const { gapParams: p, warnings } =
      mapAirscoreFormula({ ...CORRYONG_2021_OPEN, formula: 'ozgap-2005' }, 'hg');
    expect(warnings.some((w) => w.includes('ozgap-2005'))).toBe(true);
    expect(p.nominalDistance).toBe(35000);
  });

  it('unknown departure/arrival values warn', () => {
    const { warnings } = mapAirscoreFormula(
      { ...CORRYONG_2021_OPEN, departure: 'wat', arrival: 'maybe' }, 'hg');
    expect(warnings.some((w) => w.includes('unknown departure mode "wat"'))).toBe(true);
    expect(warnings.some((w) => w.includes('unknown arrival mode "maybe"'))).toBe(true);
  });

  it('unparsable nominals warn instead of silently defaulting', () => {
    const { gapParams: p, warnings } = mapAirscoreFormula(
      { ...CORRYONG_2021_OPEN, nominal_distance: '35 miles', goal_penalty: 'x' }, 'hg');
    expect(p.nominalDistance).toBeUndefined();
    expect(p.essNotGoalFactor).toBeUndefined();
    expect(warnings.some((w) => w.includes('nominal_distance'))).toBe(true);
    expect(warnings.some((w) => w.includes('goal_penalty'))).toBe(true);
  });
});

describe('sharedGapParams / taskGapParamOverrides', () => {
  it('splits a comp into the shared base and per-task diffs', () => {
    const a = mapAirscoreFormula(CORRYONG_2026_OPEN, 'hg').gapParams;
    const b = mapAirscoreFormula(CORRYONG_2024_OPEN_T2, 'hg').gapParams;
    const shared = sharedGapParams([a, b]);
    expect(shared.timePointsExponent).toBe('5/6');
    expect(shared.nominalDistance).toBe(35000);
    expect(shared.useLeading).toBeUndefined(); // diverges between the tasks
    expect(taskGapParamOverrides(a, shared)).toEqual({ useLeading: false, useArrival: false });
    expect(taskGapParamOverrides(b, shared)).toEqual({ useLeading: true, useArrival: true });
  });

  it('returns null when a task matches the shared base exactly', () => {
    const a = mapAirscoreFormula(CORRYONG_2021_OPEN, 'hg').gapParams;
    const shared = sharedGapParams([a, { ...a }]);
    expect(taskGapParamOverrides(a, shared)).toBeNull();
  });
});
