// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { describe, expect, it } from 'vitest';
import { parseThermalParam } from './thermal-link';

describe('parseThermalParam', () => {
  it('reads an absent param as no deep link, not as thermal 0', () => {
    // The regression: Number(null) is 0, so every plain replay load used to
    // open as a deep link into thermal 0 — highlighted, clock jumped, paused,
    // camera flown into the column.
    expect(parseThermalParam('')).toBeNull();
    expect(parseThermalParam('?comp=wugh&task=lubd')).toBeNull();
  });

  it('reads a real id, including 0', () => {
    expect(parseThermalParam('?thermal=0')).toBe(0);
    expect(parseThermalParam('?thermal=165')).toBe(165);
    expect(parseThermalParam('?comp=wugh&task=lubd&thermal=165')).toBe(165);
  });

  it('rejects anything that is not an integer id', () => {
    expect(parseThermalParam('?thermal=')).toBeNull();
    expect(parseThermalParam('?thermal=  ')).toBeNull();
    expect(parseThermalParam('?thermal=abc')).toBeNull();
    expect(parseThermalParam('?thermal=1.5')).toBeNull();
    expect(parseThermalParam('?thermal=Infinity')).toBeNull();
  });

  it('keeps a negative id parseable so the caller decides (-1 clears)', () => {
    expect(parseThermalParam('?thermal=-1')).toBe(-1);
  });
});
