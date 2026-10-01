import { describe, it, expect } from 'bun:test';
import { toText } from '../src/text';

describe('toText', () => {
  it('returns strings exactly as given — no HTML encoding, no tag stripping', () => {
    for (const s of ['John Doe', "O'Brien", 'A & B', 'x < y > z', 'say "hi"', '<b>bold</b>', '&amp;', '']) {
      expect(toText(s)).toBe(s);
    }
  });

  // The IGC/XCTask/AirScore parsers type their inputs as `string` but read
  // them out of attacker-controlled JSON, where a `name`/`description` can be
  // a number, an object or null. The boundary must coerce, not throw.
  it('coerces non-strings instead of throwing', () => {
    expect(toText(null)).toBe('');
    expect(toText(undefined)).toBe('');
    expect(toText(42)).toBe('42');
    expect(toText(true)).toBe('true');
    expect(toText([1, 2, 3])).toBe('1,2,3');
    expect(toText({ toString: () => 'x' })).toBe('x');
    expect(() => toText({ name: 'x' })).not.toThrow();
  });
});
