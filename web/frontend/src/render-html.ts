/**
 * The ONE way the analysis page and the 3D replay put markup into the DOM.
 *
 * Both are vanilla TS, and both used to build HTML as strings and assign it
 * to `innerHTML`, with `escapeHtml()` at every interpolation that carried
 * outside data. That made escaping opt-in, and opt-in failed three times in
 * seven weeks: SEC-22 (2026-07-03), SEC-41 (2026-08-12, eight sites) and
 * SEC-47 (2026-08-17), each a pilot, waypoint or event name that reached a
 * sink unescaped. Security review proposal A4 (2026-10-01) retires the
 * pattern rather than auditing it again.
 *
 * `html` is lit-html's tagged template. Its static strings become a
 * `<template>` once; every `${value}` is then set as a TEXT NODE or an
 * ATTRIBUTE VALUE on the cloned DOM — never parsed as HTML — so a name
 * carrying `<img onerror=…>` or `" onmouseover="` renders as those
 * characters, in any position, with nothing to remember. A nested `html`
 * result renders as markup; an array of them renders as a list. Write text
 * plainly: `${pilot.name}`, never `${escapeHtml(pilot.name)}` (which would now
 * show `&amp;`).
 *
 * `renderInto()` renders into a FRESH fragment and swaps it in, instead of
 * lit's own diffing `render(template, el)`. Diffing keeps state on the
 * container (a marker comment plus `el._$litPart$`), and these pages mix
 * templates with imperative children and clear containers by hand; a stale
 * part silently renders into detached nodes. A fresh render each time has the
 * same cost profile as the `innerHTML` it replaces (lit caches the parsed
 * template per call site, so it is usually cheaper).
 *
 * lit-html creates its Trusted Types policy (`lit-html`) itself; see
 * src/trusted-types.ts for the page's other policy. `html-sinks.test.ts`
 * fails on any `innerHTML`-style sink, and on lit's `unsafeHTML`/`unsafeSVG`
 * escape hatches, anywhere in src/.
 */
import { render, type TemplateResult } from 'lit-html';

export { html, svg, nothing } from 'lit-html';
export type { TemplateResult } from 'lit-html';

/** Anything `renderInto` accepts: a template, a list of them, text, or `nothing`. */
export type Renderable = TemplateResult | string | number | symbol | null | undefined | readonly Renderable[];

/** Anything with children to replace — an element or a fragment. */
type Container = Pick<ParentNode, 'replaceChildren'>;

/** Replace `el`'s children with `content`. Plain strings render as text. */
export function renderInto(el: Container, content: Renderable): void {
  const frag = document.createDocumentFragment();
  render(content, frag);
  el.replaceChildren(frag);
}

/** Render `content` and return its first element (for code that builds and appends nodes). */
export function renderElement<E extends Element = HTMLElement>(content: TemplateResult): E {
  const frag = document.createDocumentFragment();
  render(content, frag);
  const el = frag.firstElementChild;
  if (!el) throw new Error('renderElement: the template produced no element');
  return el as E;
}
