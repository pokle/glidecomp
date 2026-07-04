// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Gaggle macro UI (Phase 3): the timeline ribbon under the scrubber and the
 * collapsible gaggle panel. Together they let you see where gaggles form across
 * the whole task and jump to any one.
 *
 * - Ribbon: lane-packed bars over [0, duration], one per episode, positioned by
 *   tStart..tEnd, coloured per gaggle, opacity ∝ size, with a playhead that
 *   tracks the scrubber. Hover → tooltip + highlight; click → seek to its start.
 * - Panel: a row per episode (swatch · size · time · near-turnpoint · members).
 *   Hover → highlight that blob; click → seek and follow its centroid. A toggle
 *   shows "active now" vs all episodes.
 *
 * Pure DOM + the shared gaggleColor; no framework. The 3D side is reached only
 * through the supplied callbacks.
 */

import type { TrackManifest } from '@glidecomp/engine';
import { gaggleColor, type GaggleEpisode, type GaggleResult } from './gaggles';

export interface GaggleUIDeps {
  ribbon: HTMLElement;
  list: HTMLElement;
  tooltip: HTMLElement;
  result: GaggleResult;
  manifest: TrackManifest;
  duration: number;
  /** Format a tRel offset (seconds since t0) as a wall clock for display. */
  fmtTime: (tRel: number) => string;
  onSeek: (tRel: number) => void;
  onFollow: (id: number) => void;
  onHighlight: (id: number) => void;
}

const css = (rgb: [number, number, number]): string =>
  `rgb(${(rgb[0] * 255) | 0}, ${(rgb[1] * 255) | 0}, ${(rgb[2] * 255) | 0})`;

const LANE_H = 7; // px per ribbon lane (bar height)
const LANE_GAP = 2;

export class GaggleUI {
  private d: GaggleUIDeps;
  private playhead: HTMLElement;
  private bars = new Map<number, HTMLElement>();
  private rows = new Map<number, HTMLElement>();
  private activeOnly = false;
  private lastActiveKey = '';
  /** The one gaggle row the user has tapped/clicked (-1 = none). */
  private selectedId = -1;

  // A single, unmistakable "selected" treatment for the tapped row. Kept
  // distinct from the ribbon's active-now ring so the list reads as a
  // single-select, never a multi-select.
  private static readonly SELECTED = ['bg-lime-500/20', 'ring-1', 'ring-inset', 'ring-lime-500/50'];

  constructor(deps: GaggleUIDeps) {
    this.d = deps;
    this.playhead = document.createElement('div');
    this.buildRibbon();
    this.renderList(deps.result.episodes);
  }

  // --- ribbon --------------------------------------------------------------

  private buildRibbon(): void {
    const { ribbon, result, duration } = this.d;
    ribbon.innerHTML = '';
    ribbon.classList.add('relative');

    const lanes = packLanes(result.episodes);
    const nLanes = Math.max(1, ...lanes.values()) + 1;
    ribbon.style.height = `${nLanes * (LANE_H + LANE_GAP)}px`;

    const peaks = result.episodes.map((e) => e.peakSize);
    const maxPeak = Math.max(2, ...peaks);

    for (const ep of result.episodes) {
      const bar = document.createElement('div');
      const lane = lanes.get(ep.id) ?? 0;
      const left = (ep.tStart / duration) * 100;
      const width = Math.max(((ep.tEnd - ep.tStart) / duration) * 100, 0.5);
      bar.className = 'absolute rounded-sm cursor-pointer transition-[outline] outline outline-0';
      bar.style.left = `${left}%`;
      bar.style.width = `${width}%`;
      bar.style.top = `${lane * (LANE_H + LANE_GAP)}px`;
      bar.style.height = `${LANE_H}px`;
      bar.style.background = css(gaggleColor(ep.id));
      bar.style.opacity = String(0.45 + 0.5 * ((ep.peakSize - 2) / (maxPeak - 2 || 1)));
      bar.addEventListener('pointerenter', (e) => {
        this.d.onHighlight(ep.id);
        bar.style.outlineColor = '#f8fafc';
        bar.classList.replace('outline-0', 'outline-1');
        this.showTip(ep, e);
      });
      bar.addEventListener('pointermove', (e) => this.showTip(ep, e));
      bar.addEventListener('pointerleave', () => {
        this.d.onHighlight(-1);
        bar.classList.replace('outline-1', 'outline-0');
        this.d.tooltip.classList.add('hidden');
      });
      bar.addEventListener('click', () => {
        this.d.onSeek(ep.tStart);
        this.d.onHighlight(ep.id);
      });
      ribbon.appendChild(bar);
      this.bars.set(ep.id, bar);
    }

    this.playhead.className = 'absolute top-0 bottom-0 w-px bg-slate-100/80 pointer-events-none';
    this.playhead.style.left = '0%';
    ribbon.appendChild(this.playhead);
  }

  private showTip(ep: GaggleEpisode, e: PointerEvent): void {
    const tip = this.d.tooltip;
    tip.innerHTML = `<div class="font-medium" style="color:${css(gaggleColor(ep.id))}">${ep.peakSize} pilots</div>
      <div class="text-slate-400">${this.d.fmtTime(ep.tStart)}–${this.d.fmtTime(ep.tEnd)}${esc(this.tpLabel(ep))}</div>
      <div class="text-slate-500 max-w-[14rem] truncate">${this.memberNames(ep)}</div>`;
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY - 8}px`;
    tip.classList.remove('hidden');
  }

  // --- panel ---------------------------------------------------------------

  setActiveOnly(on: boolean): void {
    this.activeOnly = on;
    this.lastActiveKey = ''; // force a refresh
    this.refreshList();
  }

  /** Update the playhead and (in active-only mode) the visible rows. */
  setTime(t: number): void {
    this.playhead.style.left = `${(t / this.d.duration) * 100}%`;
    this.markActive(t);
    if (this.activeOnly) this.refreshList(t);
  }

  private activeIds(t: number): Set<number> {
    const tol = this.d.result.params.stepSeconds;
    const ids = new Set<number>();
    for (const ep of this.d.result.episodes) {
      if (t >= ep.tStart - tol && t <= ep.tEnd + tol) ids.add(ep.id);
    }
    return ids;
  }

  /**
   * Ring the ribbon bars whose episode is live at `t`. The panel rows are
   * deliberately NOT marked here — only the explicitly selected row is
   * highlighted (see applySelection), so the list always reads as a single
   * selection rather than "every gaggle active right now".
   */
  private markActive(t: number): void {
    const ids = this.activeIds(t);
    for (const [id, bar] of this.bars) {
      bar.style.boxShadow = ids.has(id) ? '0 0 0 1px rgba(248,250,252,0.9)' : 'none';
    }
  }

  /** Paint the selected-row treatment on exactly the selected episode's row. */
  private applySelection(): void {
    for (const [id, row] of this.rows) {
      const on = id === this.selectedId;
      for (const c of GaggleUI.SELECTED) row.classList.toggle(c, on);
    }
  }

  private refreshList(t?: number): void {
    if (!this.activeOnly) {
      this.renderList(this.d.result.episodes);
      return;
    }
    const time = t ?? 0;
    const ids = this.activeIds(time);
    const key = [...ids].sort((a, b) => a - b).join(',');
    if (key === this.lastActiveKey) return; // no change → skip rebuild
    this.lastActiveKey = key;
    this.renderList(this.d.result.episodes.filter((e) => ids.has(e.id)));
  }

  private renderList(episodes: GaggleEpisode[]): void {
    const list = this.d.list;
    list.innerHTML = '';
    this.rows.clear();
    if (episodes.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'px-3 py-2 text-[11px] text-slate-500';
      empty.textContent = this.activeOnly ? 'No gaggle right now.' : 'No gaggles.';
      list.appendChild(empty);
      return;
    }
    for (const ep of episodes) {
      const li = document.createElement('li');
      li.className =
        'flex items-start gap-2 px-3 py-1.5 hover:bg-slate-700/40 cursor-pointer select-none border-b border-slate-800/60';
      li.innerHTML = `
        <span class="shrink-0 mt-0.5 w-3 h-3 rounded-sm" style="background:${css(gaggleColor(ep.id))}"></span>
        <span class="flex-1 min-w-0">
          <span class="flex justify-between gap-2">
            <span class="font-medium">${ep.peakSize} pilots</span>
            <span class="text-[10px] text-slate-500 tabular-nums">${this.d.fmtTime(ep.tStart)}</span>
          </span>
          <span class="block text-[10px] text-slate-500 truncate">${esc(this.tpLabel(ep, true))}${this.memberNames(ep)}</span>
        </span>`;
      li.addEventListener('pointerenter', () => this.d.onHighlight(ep.id));
      li.addEventListener('pointerleave', () => this.d.onHighlight(-1));
      li.addEventListener('click', () => {
        this.selectedId = ep.id; // single-select: this row only
        this.applySelection();
        this.d.onSeek(ep.tStart); // jump the timeline to the gaggle's start
        this.d.onFollow(ep.id);
        this.d.onHighlight(ep.id);
      });
      list.appendChild(li);
      this.rows.set(ep.id, li);
    }
    this.applySelection(); // keep the selection painted across list rebuilds
  }

  // --- helpers -------------------------------------------------------------

  private tpLabel(ep: GaggleEpisode, trailing = false): string {
    const tps = this.d.manifest.task?.turnpoints;
    if (ep.nearTurnpoint == null || !tps?.[ep.nearTurnpoint]) return '';
    const name = tps[ep.nearTurnpoint].name;
    if (!name) return '';
    return trailing ? `near ${name} · ` : ` · near ${name}`;
  }

  private memberNames(ep: GaggleEpisode): string {
    const names = ep.members.map((m) => this.d.manifest.pilots[m]?.name ?? `#${m}`);
    return esc(names.join(', '));
  }

  destroy(): void {
    this.d.ribbon.innerHTML = '';
    this.d.list.innerHTML = '';
    this.bars.clear();
    this.rows.clear();
  }
}

/** Greedy lane packing: assign each episode the lowest lane free at its tStart. */
function packLanes(episodes: GaggleEpisode[]): Map<number, number> {
  const lanes: number[] = []; // lane index → end time of its last bar
  const out = new Map<number, number>();
  for (const ep of [...episodes].sort((a, b) => a.tStart - b.tStart)) {
    let lane = lanes.findIndex((end) => end <= ep.tStart);
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(ep.tEnd);
    } else {
      lanes[lane] = ep.tEnd;
    }
    out.set(ep.id, lane);
  }
  return out;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}
