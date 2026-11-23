// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The analysis panel's tab row, when the panel is narrower than its tabs
 * (issue #804).
 *
 * At the panel's default 320 px the six single-track tabs fit. The panel can
 * be dragged narrower, though, down to a third of the screen, so the row
 * scrolls sideways there, and a fade at whichever end still has tabs behind
 * it says so. This is the kit's tab strip (`react/rac/tabs.tsx`) in plain DOM:
 * the scrollbar is hidden, and the fades and the clipped tab are the cue.
 *
 * The fades are the host's `::before` and `::after` (`.tabs` in
 * analysis.css), switched by its `data-fade-start` and `data-fade-end`.
 */

/** What `overflowEnds` reads. A plain object stands in for an element in tests. */
export interface ScrollBox {
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

/**
 * Which ends of a row still have tabs behind them. 1 px of slack: a row that
 * cannot scroll can report a fraction of a pixel of overflow from sub-pixel
 * widths, which would show a fade for ever.
 */
export function overflowEnds(box: ScrollBox): { start: boolean; end: boolean } {
  return {
    start: box.scrollLeft > 1,
    end: box.scrollLeft < box.scrollWidth - box.clientWidth - 1,
  };
}

/**
 * Keep `host`'s fades in step with whichever of `rows` is shown. Measured on
 * scroll and on resize; a row that is shown or hidden resizes, so a mode
 * change (one track or the whole field) is a resize too, and so is the panel
 * opening. A resize also brings the selected tab back on screen: a tab chosen
 * while the panel was shut could not be scrolled to then.
 */
export function watchTabOverflow(host: HTMLElement, rows: HTMLElement[]): void {
  const measure = (): void => {
    // A hidden row measures 0 wide and has nothing behind it.
    const row = rows.find((r) => r.clientWidth > 0);
    const ends = row ? overflowEnds(row) : { start: false, end: false };
    host.toggleAttribute('data-fade-start', ends.start);
    host.toggleAttribute('data-fade-end', ends.end);
  };
  for (const row of rows) row.addEventListener('scroll', measure, { passive: true });
  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => {
      for (const row of rows) {
        const selected = row.querySelector<HTMLElement>('[aria-selected="true"]');
        if (selected) revealTab(selected);
      }
      measure();
    });
    for (const row of rows) observer.observe(row);
  }
  measure();
}

/**
 * Scroll a row so its selected tab is on screen. Focus already brings a tab
 * into view, but a selection restored from a past visit does not, and the
 * last tab chosen may be the one past the edge.
 */
export function revealTab(tab: HTMLElement): void {
  const row = tab.parentElement;
  if (!row || row.clientWidth === 0) return;
  const strip = row.getBoundingClientRect();
  const box = tab.getBoundingClientRect();
  // Clear the row's 3 px padding too, so a tab never ends under a fade.
  const gutter = 3;
  if (box.left < strip.left + gutter) {
    row.scrollLeft -= strip.left + gutter - box.left;
  } else if (box.right > strip.right - gutter) {
    row.scrollLeft += box.right - (strip.right - gutter);
  }
}
