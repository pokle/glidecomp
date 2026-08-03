// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PANEL_TAB,
  PANEL_TABS,
  isPanelTab,
  restorePanelTab,
} from './panel-tab';

describe('restorePanelTab', () => {
  it('restores every current tab', () => {
    for (const tab of PANEL_TABS) {
      expect(restorePanelTab(tab)).toBe(tab);
    }
  });

  it('falls back when nothing is stored', () => {
    expect(restorePanelTab(null)).toBe(DEFAULT_PANEL_TAB);
    expect(restorePanelTab('')).toBe(DEFAULT_PANEL_TAB);
  });

  // The bug this module exists for. 'gap-config' was a tab until GAP
  // parameters became a dialog; it stayed in the restore list, so a browser
  // that had stored it selected a tab with no button — the panel showed events
  // with nothing lit, and stayed that way until the visitor clicked a tab.
  it('does not restore a tab that has been retired', () => {
    expect(restorePanelTab('gap-config')).toBe(DEFAULT_PANEL_TAB);
  });

  it('ignores junk', () => {
    expect(restorePanelTab('Events')).toBe(DEFAULT_PANEL_TAB);
    expect(restorePanelTab('{"tab":"events"}')).toBe(DEFAULT_PANEL_TAB);
    expect(restorePanelTab('__proto__')).toBe(DEFAULT_PANEL_TAB);
  });

  it('always answers a tab that is in PANEL_TABS', () => {
    for (const stored of [null, '', 'gap-config', 'nonsense', 'task']) {
      expect(PANEL_TABS).toContain(restorePanelTab(stored));
    }
  });
});

describe('isPanelTab', () => {
  it('accepts current tabs and rejects everything else', () => {
    expect(isPanelTab('events')).toBe(true);
    expect(isPanelTab('gap-config')).toBe(false);
    expect(isPanelTab(null)).toBe(false);
  });
});

describe('PANEL_TABS', () => {
  it('includes the default', () => {
    expect(PANEL_TABS).toContain(DEFAULT_PANEL_TAB);
  });

  it('has no duplicates', () => {
    expect(new Set(PANEL_TABS).size).toBe(PANEL_TABS.length);
  });
});
