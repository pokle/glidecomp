import { describe, it, expect } from 'bun:test';
import {
  percentile,
  median,
  mean,
  rankWithTies,
  spearman,
  circularMeanWind,
} from '../src/field-analysis';

describe('percentile', () => {
  it('interpolates linearly on a sorted array', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4], 100)).toBe(4);
    expect(percentile([1, 2, 3, 4], 10)).toBeCloseTo(1.3, 10);
  });

  it('handles empty and single-element arrays', () => {
    expect(percentile([], 50)).toBeNaN();
    expect(percentile([7], 90)).toBe(7);
  });
});

describe('median / mean', () => {
  it('median of unsorted input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('mean', () => {
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeNaN();
  });
});

describe('rankWithTies', () => {
  it('assigns average ranks to ties', () => {
    expect(rankWithTies([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it('ranks a strictly increasing series 1..n', () => {
    expect(rankWithTies([5, 10, 15])).toEqual([1, 2, 3]);
  });

  it('all-equal series gets the shared average rank', () => {
    expect(rankWithTies([7, 7, 7])).toEqual([2, 2, 2]);
  });
});

describe('spearman', () => {
  it('is 1 for a monotonic increasing relation', () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 10);
  });

  it('is -1 for a monotonic decreasing relation', () => {
    expect(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('matches a hand-computed non-monotonic case', () => {
    // ranks a: [1,2,3,4], ranks b: [2,1,4,3] → d = [-1,1,-1,1], Σd² = 4
    // ρ = 1 − 6·4 / (4·15) = 0.6
    expect(spearman([10, 20, 30, 40], [5, 3, 9, 7])).toBeCloseTo(0.6, 10);
  });

  it('handles ties via average ranks', () => {
    const rho = spearman([1, 2, 2, 3], [1, 2, 3, 4]);
    expect(isFinite(rho)).toBe(true);
    expect(rho).toBeGreaterThan(0.8);
  });

  it('is NaN for n < 3', () => {
    expect(spearman([1, 2], [3, 4])).toBeNaN();
  });

  it('is NaN when a series is constant', () => {
    expect(spearman([5, 5, 5, 5], [1, 2, 3, 4])).toBeNaN();
  });
});

describe('circularMeanWind', () => {
  it('averages across the 0°/360° wrap', () => {
    const w = circularMeanWind([
      { speed: 5, direction: 350 },
      { speed: 5, direction: 10 },
    ]);
    expect(w).not.toBeNull();
    expect(w!.n).toBe(2);
    // Symmetric about north: direction 0, speed 5·cos(10°).
    expect(Math.min(w!.direction, 360 - w!.direction)).toBeCloseTo(0, 6);
    expect(w!.speed).toBeCloseTo(5 * Math.cos((10 * Math.PI) / 180), 6);
  });

  it('lets opposing estimates cancel', () => {
    const w = circularMeanWind([
      { speed: 5, direction: 0 },
      { speed: 5, direction: 180 },
    ]);
    expect(w!.speed).toBeCloseTo(0, 6);
  });

  it('returns null for no samples', () => {
    expect(circularMeanWind([])).toBeNull();
  });
});
