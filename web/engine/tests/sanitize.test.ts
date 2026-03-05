import { describe, it, expect } from 'bun:test';
import { sanitizeText } from '../src/sanitize';

describe('sanitizeText', () => {
  it('should pass through clean text unchanged', () => {
    expect(sanitizeText('John Doe')).toBe('John Doe');
    expect(sanitizeText('TP1 Grubigstein')).toBe('TP1 Grubigstein');
  });

  it('should strip HTML tags', () => {
    expect(sanitizeText('<script>alert(1)</script>')).toBe('alert(1)');
    expect(sanitizeText('<img src=x onerror=alert(1)>')).toBe('');
    expect(sanitizeText('Hello <b>World</b>')).toBe('Hello World');
  });

  it('should escape HTML entities', () => {
    expect(sanitizeText('A & B')).toBe('A &amp; B');
    expect(sanitizeText('x < y')).toBe('x &lt; y');
    expect(sanitizeText('x > y')).toBe('x &gt; y');
    expect(sanitizeText('say "hello"')).toBe('say &quot;hello&quot;');
    expect(sanitizeText("it's")).toBe('it&#39;s');
  });

  it('should strip tags then escape remaining entities', () => {
    expect(sanitizeText('<img src="x" onerror="alert(1)">Click & run')).toBe('Click &amp; run');
  });

  it('should handle empty string', () => {
    expect(sanitizeText('')).toBe('');
  });

  it('should handle strings with only tags', () => {
    expect(sanitizeText('<div><span></span></div>')).toBe('');
  });

  it('should handle nested and malformed tags', () => {
    expect(sanitizeText('<<script>>alert(1)<</script>>')).toBe('&gt;alert(1)&gt;');
  });
});
