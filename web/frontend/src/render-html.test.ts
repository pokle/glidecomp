// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { html, nothing, renderElement, renderInto } from './render-html';

/**
 * The payloads that shipped as stored XSS when the analysis page and replay
 * built HTML strings: a comp pilot name in a text node (SEC-47) and in a
 * quoted attribute (SEC-22), a waypoint name in a list row (SEC-41). Each must
 * render as the characters it is, with no element or handler created.
 */
const TAG = '<img src=x onerror="window.__xss=1">';
const ATTR_BREAKOUT = '" onmouseover="window.__xss=1" x="';

function host(): HTMLDivElement {
  return document.createElement('div');
}

describe('renderInto', () => {
  it('renders an interpolated tag as text, not as an element (SEC-47)', () => {
    const el = host();
    renderInto(el, html`<strong class="pilot">${TAG}</strong>`);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('.pilot')!.textContent).toBe(TAG);
  });

  it('keeps an attribute value inside its attribute (SEC-22)', () => {
    const el = host();
    renderInto(el, html`<span title="Show scoring breakdown for ${ATTR_BREAKOUT}" data-pilot=${ATTR_BREAKOUT}>x</span>`);
    const span = el.querySelector('span')!;
    expect(span.getAttributeNames().sort()).toEqual(['data-pilot', 'title']);
    expect(span.title).toBe(`Show scoring breakdown for ${ATTR_BREAKOUT}`);
    expect(span.dataset.pilot).toBe(ATTR_BREAKOUT);
  });

  it('renders a list of rows with untrusted names as text (SEC-41)', () => {
    const el = host();
    const names = [TAG, 'A&B', "O'Brien"];
    renderInto(el, html`<ul>${names.map((n) => html`<li>${n}</li>`)}</ul>`);
    expect([...el.querySelectorAll('li')].map((li) => li.textContent)).toEqual(names);
    expect(el.querySelector('img')).toBeNull();
  });

  it('renders nested templates as markup and `nothing` as nothing', () => {
    const el = host();
    const icon = html`<svg viewBox="0 0 1 1"><circle r="1"></circle></svg>`;
    renderInto(el, html`<button>${icon}<span>Label</span>${nothing}</button>`);
    expect(el.querySelector('svg')!.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(el.querySelector('button')!.textContent).toBe('Label');
  });

  it('replaces whatever was there, and can render the same template twice', () => {
    const el = host();
    el.appendChild(document.createElement('hr'));
    el.appendChild(document.createTextNode('stale'));
    const tpl = html`<b>fresh</b>`;
    renderInto(el, tpl);
    renderInto(el, tpl);
    expect(el.innerHTML.replace(/<!--.*?-->/g, '')).toBe('<b>fresh</b>');
  });

  it('survives a container cleared by hand between renders', () => {
    const el = host();
    renderInto(el, html`<i>${'one'}</i>`);
    el.replaceChildren();
    renderInto(el, html`<i>${'two'}</i>`);
    expect(el.textContent).toBe('two');
  });

  it('renders a plain string as text', () => {
    const el = host();
    renderInto(el, TAG);
    expect(el.textContent).toBe(TAG);
    expect(el.children).toHaveLength(0);
  });

  it('sets boolean attributes from ?attr bindings', () => {
    const el = host();
    renderInto(el, html`<input type="checkbox" ?checked=${true}><input type="checkbox" ?checked=${false}>`);
    const [a, b] = el.querySelectorAll('input');
    expect(a.checked).toBe(true);
    expect(b.checked).toBe(false);
  });
});

describe('renderElement', () => {
  it('returns the first element, with listeners still attachable', () => {
    const li = renderElement<HTMLLIElement>(html`<li class="row"><span class="name">${TAG}</span></li>`);
    expect(li.tagName).toBe('LI');
    expect(li.querySelector('.name')!.textContent).toBe(TAG);
    expect(li.querySelector('img')).toBeNull();
  });
});
