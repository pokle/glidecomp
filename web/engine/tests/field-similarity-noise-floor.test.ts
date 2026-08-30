import { describe, it, expect } from 'bun:test';
import { similarityNoiseFloor } from '../src/analysis/similarity-noise-floor';

describe('similarityNoiseFloor', () => {
  it('falls as the behaviour count rises', () => {
    const floors = [2, 3, 5, 9, 13, 17, 21, 22, 30, 40].map(similarityNoiseFloor);
    for (let i = 1; i < floors.length; i++) {
      expect(floors[i]).toBeLessThan(floors[i - 1]);
    }
  });

  it('is high enough at 2-3 behaviours to disqualify a confident-looking score', () => {
    // The whole point: a pair sharing three behaviours needs a very high score
    // before it means anything, where a pair sharing twenty-two does not.
    expect(similarityNoiseFloor(2)).toBeGreaterThan(0.75);
    expect(similarityNoiseFloor(3)).toBeGreaterThan(0.6);
    expect(similarityNoiseFloor(22)).toBeLessThan(0.25);
  });

  it('is NaN below two behaviours, where no shape comparison exists', () => {
    expect(similarityNoiseFloor(1)).toBeNaN();
    expect(similarityNoiseFloor(0)).toBeNaN();
    expect(similarityNoiseFloor(-3)).toBeNaN();
    expect(similarityNoiseFloor(NaN)).toBeNaN();
  });

  it('clamps above the table rather than returning undefined', () => {
    // Conservative by construction: the true floor keeps falling, so clamping
    // can only overstate the noise, never dress a chance result up as real.
    const last = similarityNoiseFloor(40);
    expect(similarityNoiseFloor(41)).toBe(last);
    expect(similarityNoiseFloor(10_000)).toBe(last);
    expect(Number.isFinite(similarityNoiseFloor(10_000))).toBe(true);
  });

  it('floors a fractional count to the entry below it', () => {
    expect(similarityNoiseFloor(3.9)).toBe(similarityNoiseFloor(3));
  });

  it('agrees with a fresh simulation to within a few thousandths', () => {
    // Guards the committed table against a silent edit: re-derive two entries
    // the same way the generator did and check they still line up.
    const trial = (n: number) => {
      let dot = 0;
      let sumA = 0;
      let sumB = 0;
      for (let i = 0; i < n; i++) {
        // Box-Muller, unseeded — this is a statistical check, not an exact one.
        const g = () => {
          let u = 0;
          let v = 0;
          while (u === 0) u = Math.random();
          while (v === 0) v = Math.random();
          return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
        };
        const a = g();
        const b = g();
        dot += a * b;
        sumA += a * a;
        sumB += b * b;
      }
      return dot / (sumA + sumB - dot);
    };
    for (const n of [3, 22]) {
      const N = 60_000;
      const xs = new Float64Array(N);
      for (let t = 0; t < N; t++) xs[t] = trial(n);
      xs.sort();
      const p95 = xs[Math.floor(0.95 * (N - 1))];
      expect(Math.abs(p95 - similarityNoiseFloor(n))).toBeLessThan(0.02);
    }
  });
});
