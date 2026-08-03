// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Which panel tab a returning visitor lands on.
 *
 * Restoring lives here, apart from the panel, because the case that matters is
 * the stored value that is no longer a tab — and that case is invisible from
 * inside the happy path. `gap-config` was a tab until GAP parameters became a
 * dialog; browsers that stored it kept restoring it long afterwards, selecting
 * a tab with no button and leaving the panel showing events with nothing lit.
 *
 * The rule is that the list of tabs and the list of things that may be restored
 * are the SAME list. A tab that goes away must stop being restorable in the
 * same change, or it lingers in storage for as long as the browser does.
 */

export type PanelTabType =
  | 'task'
  | 'score'
  | 'events'
  | 'glides'
  | 'climbs'
  | 'sinks'
  | 'comp-score';

/** Every tab, in the order they appear in the panel. Each one has a button. */
export const PANEL_TABS: readonly PanelTabType[] = [
  'task',
  'score',
  'events',
  'glides',
  'climbs',
  'sinks',
  'comp-score',
];

/** Where the panel opens when nothing usable is stored. */
export const DEFAULT_PANEL_TAB: PanelTabType = 'events';

export function isPanelTab(value: string | null): value is PanelTabType {
  return value !== null && (PANEL_TABS as readonly string[]).includes(value);
}

/**
 * The tab to open, given whatever localStorage happens to hold.
 *
 * Anything that is not a current tab — absent, empty, a retired tab, junk
 * written by something else — falls back rather than being trusted.
 */
export function restorePanelTab(stored: string | null): PanelTabType {
  return isPanelTab(stored) ? stored : DEFAULT_PANEL_TAB;
}
