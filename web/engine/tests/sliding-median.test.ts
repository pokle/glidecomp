// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * SlidingMedian must be value-identical to the sort-and-index median it
 * replaces in altitude cleaning (issue #470, SEC-32): same multiset of live
 * values → same two middle order statistics. The fuzz cases below compare it
 * against exactly that naive oracle after every single operation.
 */

import { describe, expect, it } from 'bun:test';
import { SlidingMedian } from '../src/sliding-median';

/** Seeded PRNG (mulberry32) — the oracle fuzz must be reproducible, so no
 * bare Math.random here. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The exact median arithmetic from the old crossChannelClean loop. */
function oracleMedian(live: number[]): { low: number; high: number } {
  const window = [...live].sort((a, b) => a - b);
  const mid = window.length >> 1;
  return {
    low: window.length % 2 === 1 ? window[mid] : window[mid - 1],
    high: window[mid],
  };
}

function expectMatchesOracle(med: SlidingMedian, live: number[]) {
  expect(med.size()).toBe(live.length);
  if (live.length === 0) return;
  const { low, high } = oracleMedian(live);
  expect(Object.is(med.medianLow(), low)).toBe(true);
  expect(Object.is(med.medianHigh(), high)).toBe(true);
}

describe('SlidingMedian hand cases', () => {
  it('single element', () => {
    const med = new SlidingMedian([7]);
    med.add(7);
    expect(med.size()).toBe(1);
    expect(med.medianLow()).toBe(7);
    expect(med.medianHigh()).toBe(7);
  });

  it('odd and even sizes give the two middle order statistics', () => {
    const med = new SlidingMedian([1, 2, 3, 4]);
    med.add(3);
    med.add(1);
    med.add(4);
    // live [1,3,4]: odd — both middles are 3
    expect(med.medianLow()).toBe(3);
    expect(med.medianHigh()).toBe(3);
    med.add(2);
    // live [1,2,3,4]: even — middles are 2 and 3
    expect(med.medianLow()).toBe(2);
    expect(med.medianHigh()).toBe(3);
  });

  it('remove to empty and re-add', () => {
    const med = new SlidingMedian([5, 9]);
    med.add(5);
    med.add(9);
    med.remove(5);
    med.remove(9);
    expect(med.size()).toBe(0);
    med.add(9);
    expect(med.medianLow()).toBe(9);
    expect(med.medianHigh()).toBe(9);
  });

  it('duplicate-heavy multiset [5,5,5,5] under removals', () => {
    const med = new SlidingMedian([5]);
    const live: number[] = [];
    for (let i = 0; i < 4; i++) {
      med.add(5);
      live.push(5);
      expectMatchesOracle(med, live);
    }
    while (live.length > 0) {
      med.remove(5);
      live.pop();
      expectMatchesOracle(med, live);
    }
  });

  it('boundary duplicates [1,2,2,2,3] with 2 removed three times', () => {
    const med = new SlidingMedian([1, 2, 2, 2, 3]);
    const live = [1, 2, 2, 2, 3];
    for (const v of live) med.add(v);
    expectMatchesOracle(med, live);
    for (let i = 0; i < 3; i++) {
      med.remove(2);
      live.splice(live.indexOf(2), 1);
      expectMatchesOracle(med, live);
    }
  });

  it('conflates -0 with +0 (documented SameValueZero behaviour)', () => {
    const med = new SlidingMedian([-0, 1]);
    med.add(-0);
    med.add(0);
    expect(med.size()).toBe(2);
    // Both middles are the canonicalised +0.
    expect(Object.is(med.medianLow(), 0)).toBe(true);
    expect(Object.is(med.medianHigh(), 0)).toBe(true);
    med.remove(0);
    med.remove(-0);
    expect(med.size()).toBe(0);
  });

  it('NaN universe entries are ignored, and foreign values throw', () => {
    const med = new SlidingMedian([NaN, 3, NaN]);
    med.add(3);
    expect(med.medianLow()).toBe(3);
    expect(() => med.add(4)).toThrow();
    expect(() => med.remove(NaN)).toThrow();
  });
});

describe('SlidingMedian fuzz vs naive oracle', () => {
  function fuzz(rand: () => number, drawValue: () => number, ops: number) {
    const universe = Array.from({ length: 64 }, drawValue);
    const med = new SlidingMedian(universe);
    const live: number[] = [];
    for (let op = 0; op < ops; op++) {
      if (live.length > 0 && rand() < 0.4) {
        const idx = Math.floor(rand() * live.length);
        med.remove(live[idx]);
        live.splice(idx, 1);
      } else {
        const v = universe[Math.floor(rand() * universe.length)];
        med.add(v);
        live.push(v);
      }
      expectMatchesOracle(med, live);
    }
  }

  it('duplicate-dense small integers', () => {
    const rand = mulberry32(0x5eed1);
    fuzz(rand, () => Math.floor(rand() * 11) - 5, 2000);
  });

  it('random floats', () => {
    const rand = mulberry32(0x5ec32);
    fuzz(rand, () => (rand() - 0.5) * 1000, 2000);
  });

  it('sliding-window walk over a random array (the altitude-cleaning shape)', () => {
    const rand = mulberry32(0x471);
    const n = 500;
    const values = Array.from({ length: n }, () =>
      rand() < 0.15 ? NaN : Math.floor(rand() * 21) - 10,
    );
    const med = new SlidingMedian(values);
    let lo = 0;
    let hi = 0;
    while (hi < n) {
      // Random forward walk of both ends, hi leading.
      const advanceHi = Math.min(n, hi + 1 + Math.floor(rand() * 5));
      while (hi < advanceHi) {
        if (!Number.isNaN(values[hi])) med.add(values[hi]);
        hi++;
      }
      const advanceLo = Math.min(hi, lo + Math.floor(rand() * 4));
      while (lo < advanceLo) {
        if (!Number.isNaN(values[lo])) med.remove(values[lo]);
        lo++;
      }
      const live = values.slice(lo, hi).filter((v) => !Number.isNaN(v));
      expectMatchesOracle(med, live);
    }
  });
});
