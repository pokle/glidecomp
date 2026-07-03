import { describe, it, expect } from 'vitest';
import { escapeHtml } from './escape-html';

describe('escapeHtml', () => {
  it('neutralises tag injection in text context', () => {
    expect(escapeHtml('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;'
    );
  });

  it('escapes the double quote so a value cannot break out of a quoted attribute', () => {
    // A comp pilot name like this would otherwise close `title="..."` and
    // inject an event handler (the SEC-22 stored-XSS vector).
    const payload = '" onmouseover="alert(1)';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&quot; onmouseover=&quot;alert(1)');

    // Prove it stays inert once placed in a real attribute: the parsed element
    // has only the intended attribute, not an injected `onmouseover`.
    const el = document.createElement('div');
    el.innerHTML = `<span title="${escaped}">x</span>`;
    const span = el.querySelector('span')!;
    expect(span.getAttribute('title')).toBe(payload);
    expect(span.hasAttribute('onmouseover')).toBe(false);
  });

  it('escapes the single quote for single-quoted attribute contexts', () => {
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes ampersand first so existing entities are not double-interpreted', () => {
    expect(escapeHtml('Tom & Jerry <3')).toBe('Tom &amp; Jerry &lt;3');
  });

  it('leaves ordinary names untouched', () => {
    expect(escapeHtml('María O’Brien-Smith')).toBe('María O’Brien-Smith');
  });
});
