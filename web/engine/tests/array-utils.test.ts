import { describe, it, expect } from 'bun:test';
import { maxBy, minBy } from '../src/array-utils';

describe('maxBy', () => {
  it('returns the maximum value for a normal array', () => {
    const items = [{ v: 3 }, { v: 7 }, { v: 1 }, { v: 5 }];
    expect(maxBy(items, i => i.v)).toBe(7);
  });

  it('returns -Infinity for an empty array', () => {
    expect(maxBy([], () => 0)).toBe(-Infinity);
  });

  it('handles a single element', () => {
    expect(maxBy([{ v: 42 }], i => i.v)).toBe(42);
  });

  it('handles negative values', () => {
    const items = [{ v: -10 }, { v: -3 }, { v: -7 }];
    expect(maxBy(items, i => i.v)).toBe(-3);
  });

  it('handles large arrays without stack overflow', () => {
    const items = Array.from({ length: 100_000 }, (_, i) => ({ v: i }));
    expect(maxBy(items, i => i.v)).toBe(99_999);
  });
});

describe('minBy', () => {
  it('returns the minimum value for a normal array', () => {
    const items = [{ v: 3 }, { v: 7 }, { v: 1 }, { v: 5 }];
    expect(minBy(items, i => i.v)).toBe(1);
  });

  it('returns Infinity for an empty array', () => {
    expect(minBy([], () => 0)).toBe(Infinity);
  });

  it('handles large arrays without stack overflow', () => {
    const items = Array.from({ length: 100_000 }, (_, i) => ({ v: i }));
    expect(minBy(items, i => i.v)).toBe(0);
  });
});
