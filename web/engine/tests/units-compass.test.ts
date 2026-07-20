/**
 * Compass direction formatting — cardinal points and wind-travel arrows.
 * The arrow points where the wind BLOWS (source + 180), so a northerly
 * (FROM the north) reads "0° N ↓": top-to-bottom on the page.
 */

import { describe, it, expect } from 'bun:test';
import { bearingToCardinal, bearingToArrow, formatWindDirection } from '../src/units';

describe('bearingToCardinal', () => {
  it('maps the eight principal bearings', () => {
    expect(bearingToCardinal(0)).toBe('N');
    expect(bearingToCardinal(45)).toBe('NE');
    expect(bearingToCardinal(90)).toBe('E');
    expect(bearingToCardinal(135)).toBe('SE');
    expect(bearingToCardinal(180)).toBe('S');
    expect(bearingToCardinal(225)).toBe('SW');
    expect(bearingToCardinal(270)).toBe('W');
    expect(bearingToCardinal(315)).toBe('NW');
  });

  it('resolves the 16-point intercardinals', () => {
    expect(bearingToCardinal(22.5)).toBe('NNE');
    expect(bearingToCardinal(157.5)).toBe('SSE');
    expect(bearingToCardinal(337.5)).toBe('NNW');
  });

  it('wraps at 360 and normalises negatives', () => {
    expect(bearingToCardinal(360)).toBe('N');
    expect(bearingToCardinal(359)).toBe('N');
    expect(bearingToCardinal(-90)).toBe('W');
  });
});

describe('bearingToArrow', () => {
  it('points toward the given bearing (0 = up)', () => {
    expect(bearingToArrow(0)).toBe('↑');
    expect(bearingToArrow(90)).toBe('→');
    expect(bearingToArrow(180)).toBe('↓');
    expect(bearingToArrow(270)).toBe('←');
    expect(bearingToArrow(45)).toBe('↗');
    expect(bearingToArrow(315)).toBe('↖');
  });
});

describe('formatWindDirection', () => {
  it('shows source degrees, compass point, and a travel arrow', () => {
    // Wind FROM the north blows south → arrow points down.
    expect(formatWindDirection(0)).toBe('0° N ↓');
    // Wind FROM the west blows east → arrow points right.
    expect(formatWindDirection(270)).toBe('270° W →');
    // Wind FROM the NW blows SE → arrow points down-right.
    expect(formatWindDirection(315)).toBe('315° NW ↘');
  });

  it('rounds and normalises the source bearing', () => {
    expect(formatWindDirection(359.6)).toBe('0° N ↓');
    expect(formatWindDirection(-90)).toBe('270° W →');
  });
});
