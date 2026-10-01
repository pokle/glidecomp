// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { allowScriptUrl, installDefaultTrustedTypesPolicy, sanitizeHtml } from './trusted-types';
import { TRUSTED_TYPES_POLICY_NAMES, TRUSTED_TYPES_REPORT_ONLY_POLICY } from './security-headers';

const ORIGIN = 'https://glidecomp.com';

describe('sanitizeHtml (the default policy for third-party HTML)', () => {
  it("keeps Mapbox's attribution markup, link target included", () => {
    const attribution =
      '<a href="https://www.mapbox.com/about/maps/" target="_blank" title="Mapbox" aria-label="Mapbox">© Mapbox</a> ' +
      '<a href="https://www.openstreetmap.org/about/" target="_blank">© OpenStreetMap</a>';
    const out = document.createElement('div');
    out.innerHTML = sanitizeHtml(attribution);
    const links = out.querySelectorAll('a');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('https://www.mapbox.com/about/maps/');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('aria-label')).toBe('Mapbox');
    expect(out.textContent).toContain('© OpenStreetMap');
  });

  it("keeps the popup's close-button markup", () => {
    expect(sanitizeHtml('<span aria-hidden="true">&#215;</span>')).toBe('<span aria-hidden="true">×</span>');
  });

  it('strips script, handlers and javascript: URLs', () => {
    const out = sanitizeHtml(
      '<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a><svg onload="alert(4)"></svg>'
    );
    expect(out).not.toMatch(/onerror|onload|<script|javascript:/i);
  });

  it('passes plain text (the scale bar) through', () => {
    expect(sanitizeHtml('500 km')).toBe('500 km');
  });
});

describe('allowScriptUrl', () => {
  it("allows this origin's files and the blob: workers it mints", () => {
    expect(allowScriptUrl('/assets/worker-abc.js', ORIGIN)).toBe('/assets/worker-abc.js');
    expect(allowScriptUrl(`${ORIGIN}/assets/x.js`, ORIGIN)).toBe(`${ORIGIN}/assets/x.js`);
    const blob = `blob:${ORIGIN}/3f2f86d3-89af-4183-b641-07cd2dd20e0f`;
    expect(allowScriptUrl(blob, ORIGIN)).toBe(blob);
  });

  it('refuses another origin, its blobs, and non-http schemes', () => {
    expect(allowScriptUrl('https://evil.example/x.js', ORIGIN)).toBeNull();
    expect(allowScriptUrl('//evil.example/x.js', ORIGIN)).toBeNull();
    expect(allowScriptUrl('blob:https://evil.example/uuid', ORIGIN)).toBeNull();
    expect(allowScriptUrl('data:text/javascript,alert(1)', ORIGIN)).toBeNull();
    expect(allowScriptUrl('javascript:alert(1)', ORIGIN)).toBeNull();
  });
});

describe('installDefaultTrustedTypesPolicy', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a no-op without Trusted Types', () => {
    expect(() => installDefaultTrustedTypesPolicy()).not.toThrow();
  });

  it('creates exactly one `default` policy wired to the sanitiser and URL check', () => {
    const createPolicy = vi.fn();
    vi.stubGlobal('trustedTypes', { createPolicy, defaultPolicy: null });
    installDefaultTrustedTypesPolicy();
    expect(createPolicy).toHaveBeenCalledTimes(1);
    const [name, rules] = createPolicy.mock.calls[0];
    expect(name).toBe('default');
    expect(rules.createHTML('<img src=x onerror=alert(1)>')).not.toMatch(/onerror/);
    expect(rules.createScriptURL('https://evil.example/x.js')).toBeNull();
    expect(rules.createScript('alert(1)')).toBeNull();
  });

  it('leaves an existing default policy alone', () => {
    const createPolicy = vi.fn();
    vi.stubGlobal('trustedTypes', { createPolicy, defaultPolicy: {} });
    installDefaultTrustedTypesPolicy();
    expect(createPolicy).not.toHaveBeenCalled();
  });

  it("the header allows lit's, DOMPurify's and this file's policy", () => {
    expect([...TRUSTED_TYPES_POLICY_NAMES].sort()).toEqual(['default', 'dompurify', 'lit-html']);
    expect(TRUSTED_TYPES_REPORT_ONLY_POLICY).toContain(
      "require-trusted-types-for 'script'; trusted-types default lit-html dompurify;"
    );
  });
});
