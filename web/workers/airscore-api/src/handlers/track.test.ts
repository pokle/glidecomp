import { describe, expect, test } from 'bun:test';
import { isValidIgcContent } from './track';

describe('isValidIgcContent', () => {
  test('accepts valid IGC content', () => {
    const content = 'AFLA001\r\nHFDTE150726\r\nB1101355206343N00006198WA0058700558';
    expect(isValidIgcContent(content)).toBe(true);
  });

  test('rejects HTML error page starting with <A', () => {
    const content = '<A href="error">Page not found</A>';
    expect(isValidIgcContent(content)).toBe(false);
  });

  test('rejects content with HFDTE but not starting with A', () => {
    const content = 'Some random text\nHFDTE150726\n';
    expect(isValidIgcContent(content)).toBe(false);
  });

  test('rejects content starting with A but missing HFDTE', () => {
    const content = 'AFLA001\r\nB1101355206343N00006198WA0058700558';
    expect(isValidIgcContent(content)).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidIgcContent('')).toBe(false);
  });
});
