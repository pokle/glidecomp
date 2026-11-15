/**
 * The analysis page's bar (#869): the app's three slots
 * (react/rac/page-bar.tsx) in plain markup, analysis.html `#page-bar`.
 *
 *   leading   Back to the page above: a pilot's report card, a task, or
 *             My Flights
 *   centre    the page's name over a menu of where this page is: "Climbs
 *             and glides" for one track, "All tracks" for several (setPageMode)
 *   trailing  Analysis (the side panel), then ⋯ for the page's actions
 *
 * Both menus are native `<details>`, so they open with no script and every
 * link in them is in the markup. This adds what a disclosure does not do by
 * itself, as the content pages' bar does in public/site-header.js: Escape
 * closes it and gives focus back to its control; a click elsewhere or focus
 * going elsewhere closes it; one is open at a time. A row of ⋯ closes ⋯ when
 * it is used.
 */
import { html, renderElement, renderInto } from '../render-html';
import { compPath, pilotPath, taskPath } from '../react/lib/slug';

/** A page above this one: its name in the bar and the menu, and its link. */
export type BarCrumb = { label: string; href: string };

export const MY_FLIGHTS: BarCrumb = { label: 'My Flights', href: '/u/me' };

/**
 * The trail of a competition task's map: Competitions › comp › task, and the
 * pilot when the page shows one pilot's track (the report card's link).
 * Names arrive late, so each takes a generic fallback; the links work either
 * way, and a fallback names nothing a hidden competition would want kept.
 */
export function compTrail(
  compId: string,
  compName: string | null,
  taskId: string,
  taskName: string | null,
  pilot?: { id: string; name: string | null },
): BarCrumb[] {
  const trail: BarCrumb[] = [
    { label: 'Competitions', href: '/comp' },
    { label: compName || 'Competition', href: compPath(compId, compName) },
    { label: taskName || 'Task', href: taskPath(compId, compName, taskId, taskName) },
  ];
  if (pilot) {
    trail.push({
      label: pilot.name || 'Pilot',
      href: pilotPath(compId, compName, taskId, taskName, pilot.id, pilot.name),
    });
  }
  return trail;
}

const byId = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

/** The title menu's indent: 12 px, and 14 px more for each level down (the app's bar). */
const indent = (depth: number): string => `padding-left:${12 + depth * 14}px`;

/**
 * What the page is called, by what it shows (owner decision, #869). One
 * track: its climbs, glides and sinks, and the panel button opens those lists.
 * Several (a task's whole field): the tracks on one map, and the panel button
 * opens the score table. The ⋯ rows that open the page use the same names
 * (TaskDetail.tsx, PilotScoreDetail.tsx), so the row tapped and the title
 * landed on agree.
 */
export type PageMode = 'one' | 'field';
const PAGE_NAMES: Record<PageMode, { title: string; panel: string }> = {
  one: { title: 'Climbs and glides', panel: 'Lists' },
  field: { title: 'All tracks', panel: 'Scores' },
};
let pageName = PAGE_NAMES.one.title;
/** The trail last drawn, so a change of name can redraw it. */
let lastTrail: BarCrumb[] = [];

/** Name the page for what it shows: the title, its <h1>, the tab, the panel button. */
export function setPageMode(mode: PageMode): void {
  const { title, panel } = PAGE_NAMES[mode];
  pageName = title;
  for (const el of document.querySelectorAll<HTMLElement>('[data-page-name]')) el.textContent = title;
  // The hidden breadcrumb and the title menu are drawn with the trail.
  if (lastTrail.length > 0) setTrail(lastTrail);
  byId('bar-title')?.setAttribute('aria-label', `${title}: go to another page`);
  const panelLabel = byId('analysis-toggle-label');
  if (panelLabel) panelLabel.textContent = panel;
  for (const icon of document.querySelectorAll<SVGElement>('[data-panel-icon]')) {
    icon.toggleAttribute('hidden', icon.dataset.panelIcon !== mode);
  }
  document.title = `GlideComp - ${title}`;
}

/** Draw the bar's links for the pages above this one. */
export function setTrail(trail: BarCrumb[]): void {
  if (trail.length === 0) return;
  lastTrail = trail;
  const parent = trail[trail.length - 1];
  const back = byId<HTMLAnchorElement>('bar-back');
  if (back) {
    back.href = parent.href;
    back.setAttribute('aria-label', `Back to ${parent.label}`);
  }

  // A phone has room for the parent; a wider screen for the whole trail.
  const more = trail.length > 1 ? ` +${trail.length - 1} more` : '';
  const trailEl = byId('bar-trail');
  if (trailEl) {
    renderInto(
      trailEl,
      html`<span class="sm:hidden">${parent.label}${more}</span><span class="max-sm:hidden">${trail
        .map((c) => c.label)
        .join(' › ')}</span>`,
    );
  }

  // "You are here": the trail, then this page, one level further in.
  const here = byId('bar-here');
  const current = byId('bar-current');
  if (here && current) {
    for (const li of Array.from(here.children)) if (li !== current) li.remove();
    for (const [i, c] of trail.entries()) {
      here.insertBefore(
        renderElement(html`<li><a href=${c.href} class="bar-row" style=${indent(i)}>${c.label}</a></li>`),
        current,
      );
    }
    current.querySelector<HTMLElement>('.bar-row')?.setAttribute('style', indent(trail.length));
  }

  // "Elsewhere" holds what the trail does not.
  for (const li of document.querySelectorAll<HTMLElement>('[data-bar-elsewhere]')) {
    li.hidden = trail.some((c) => c.href === li.dataset.barElsewhere);
  }

  // The same trail as real links with the menus closed.
  const crumbs = byId('breadcrumbs');
  if (crumbs) {
    renderInto(
      crumbs,
      html`${trail.map((c) => html`<li><a href=${c.href} tabindex="-1">${c.label}</a></li>`)}
        <li><span aria-current="page" data-page-name>${pageName}</span></li>`,
    );
  }
}

/** A toggle row of ⋯: its tick shows while the thing it names is on. */
export function setPressed(el: HTMLElement | null, on: boolean): void {
  el?.setAttribute('aria-pressed', String(on));
}

/** Throb a control once, to say something arrived behind it. */
export function pulse(el: HTMLElement | null): void {
  if (!el) return;
  el.classList.remove('pulse-attention');
  void el.offsetWidth; // restart the animation
  el.classList.add('pulse-attention');
  el.addEventListener('animationend', () => el.classList.remove('pulse-attention'), { once: true });
}

/**
 * Keep the bar clear of the side panel. On a wide screen the panel sits
 * beside the map, so the bar's right edge follows the panel's left edge and
 * ⋯ is never under it. On a phone the open panel covers the map, the bar
 * with it, and has its own close button.
 */
export function followPanel(panelWidth: string, open: boolean): void {
  const bar = byId('page-bar');
  if (bar) bar.style.right = open && window.innerWidth >= 768 ? panelWidth : '0px';
  byId('analysis-toggle')?.setAttribute('aria-expanded', String(open));
}

export interface BarMenus {
  /** Open ⋯ and put focus on its first row. */
  openMore(): void;
  /** ⌘K: open ⋯, or close it if it is open. */
  toggleMore(): void;
  closeAll(): void;
}

export function setupBarMenus(): BarMenus {
  const menus = Array.from(document.querySelectorAll<HTMLDetailsElement>('[data-bar-menu]'));
  const more = byId<HTMLDetailsElement>('bar-more');

  const close = (menu: HTMLDetailsElement, refocus = false): void => {
    if (!menu.open) return;
    menu.open = false;
    if (refocus) menu.querySelector<HTMLElement>(':scope > summary')?.focus();
  };

  for (const menu of menus) {
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !menu.open) return;
      e.preventDefault();
      e.stopPropagation(); // the map's own Escape (leaving draw mode) is not for this key
      close(menu, true);
    });
    // focusout fires before the new element takes focus: look on the next tick.
    // A press on the panel's own padding moves focus to nothing, and must not
    // close the menu under the finger: only focus gone to another element counts.
    menu.addEventListener('focusout', () => {
      setTimeout(() => {
        const active = document.activeElement;
        if (active && active !== document.body && !menu.contains(active)) close(menu);
      }, 0);
    });
    // One menu at a time.
    menu.addEventListener('toggle', () => {
      if (menu.open) for (const other of menus) if (other !== menu) close(other);
    });
  }

  // A click elsewhere closes a menu. A click, not a pointerdown, so a tap on
  // the map that closes the menu is not also read as the start of a drag.
  document.addEventListener('click', (e) => {
    for (const menu of menus) if (!menu.contains(e.target as Node)) close(menu);
  });

  // A row of ⋯ that does something closes ⋯; "Samples…" only opens in place.
  more?.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest('button, a');
    if (row && more.contains(row)) close(more);
  });

  // Back to a page the browser kept whole: its menus must not still be open.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) for (const menu of menus) close(menu);
  });

  const openMore = (): void => {
    if (!more) return;
    more.open = true;
    // Focusable at once because the bar's menus do not animate open
    // (analysis.css, `details:not([data-bar-menu])`).
    more.querySelector<HTMLElement>('#bar-more-panel button:not([hidden]), #bar-more-panel a')?.focus();
  };

  return {
    openMore,
    toggleMore() {
      if (more?.open) close(more, true);
      else openMore();
    },
    closeAll() {
      for (const menu of menus) close(menu);
    },
  };
}
