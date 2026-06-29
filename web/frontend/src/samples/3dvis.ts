// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Entry point for the standalone /samples/3dvis flight-replay page.
 * Wires the Three.js ReplayViewer to the DOM chrome (timeline scrubber,
 * play/pause, colour modes, vertical exaggeration, pilot legend, scale bar,
 * compass, hover tooltip). No authentication, no framework — just the viewer.
 */

import { ReplayViewer, type ColorMode, type HoverInfo } from './replay-viewer';
import { MAP_STYLES, DEFAULT_MAP_STYLE } from './map-styles';
import { VARIO_MAX } from './flight-scene';
import type { TrackManifest } from '@glidecomp/engine';

const DATA_BASE = '/samples/3dvis';

const $ = <T = HTMLElement>(id: string): T =>
  document.getElementById(id) as unknown as T;

/**
 * Format absolute UTC seconds as HH:MM:SS in `timeZone` (the comp's IANA zone
 * from the manifest); falls back to the browser's zone when undefined. Intl
 * applies the correct DST offset for each fix's date.
 */
function clockLocal(utcSeconds: number, timeZone?: string): string {
  return new Date(utcSeconds * 1000).toLocaleTimeString(undefined, {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone,
  });
}

/**
 * Short timezone label (e.g. "AEDT", "GMT+11") for `timeZone` (or the browser's
 * zone), computed at `refDate` so the DST offset matches the comp date.
 */
function zoneLabel(refDate: Date, timeZone?: string): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZoneName: 'short',
      timeZone,
    }).formatToParts(refDate);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? 'local';
  } catch {
    return 'local';
  }
}

/** Clicking anywhere on a panel header toggles its body and flips the chevron. */
function makeCollapsible(headerId: string, bodyId: string, chevronId: string): void {
  const header = document.getElementById(headerId);
  const body = document.getElementById(bodyId);
  const chevron = document.getElementById(chevronId);
  if (!header || !body || !chevron) return;
  header.addEventListener('click', () => {
    const collapsed = body.classList.toggle('hidden');
    chevron.textContent = collapsed ? '▶' : '▼';
    header.setAttribute('title', collapsed ? 'Expand panel' : 'Collapse panel');
  });
}

/** Round n down to a "nice" 1/2/5×10^k value for the scale bar. */
function niceNumber(n: number): number {
  const exp = Math.floor(Math.log10(n));
  const base = Math.pow(10, exp);
  const f = n / base;
  const nice = f >= 5 ? 5 : f >= 2 ? 2 : 1;
  return nice * base;
}

async function main(): Promise<void> {
  const overlay = $('overlay');
  const overlayText = $('overlayText');
  const container = $('viewer');

  let manifest: TrackManifest;
  const viewer = new ReplayViewer(
    container,
    {
      onTime: (t) => onTime(t),
      onPlayState: (p) => {
        $('playPause').textContent = p ? '❚❚' : '▶';
      },
      onHover: (info) => showTooltip(info),
      onScale: (mpp) => updateScaleBar(mpp),
      onCompass: (deg) => {
        $('compassRot').setAttribute('transform', `rotate(${-deg} 20 20)`);
      },
    },
    import.meta.env.VITE_MAPBOX_TOKEN,
  );

  try {
    const tracks = await viewer.load(`${DATA_BASE}/manifest.json`, `${DATA_BASE}/tracks.bin.gz`);
    manifest = tracks.manifest;
  } catch (err) {
    overlayText.textContent = `Could not load tracks: ${(err as Error).message}`;
    console.error(err);
    return;
  }

  overlay.classList.add('hidden');

  // --- stats line ---
  const durMin = ((manifest.t1 - manifest.t0) / 60).toFixed(0);
  $('stats').textContent =
    `${manifest.pilots.length} pilots · ${(manifest.vertexCount / 1000).toFixed(0)}k fixes · ${durMin} min · ${viewer.gaggleCount} gaggles · drag to orbit`;

  // --- scrubber + clock ---
  const duration = manifest.t1 - manifest.t0;
  const scrubber = $<HTMLInputElement>('scrubber');
  let scrubbing = false;
  const tz = manifest.timezone; // comp IANA zone, or undefined → browser zone
  $('clockZone').textContent = zoneLabel(new Date(manifest.t0 * 1000), tz);

  function onTime(t: number): void {
    $('clock').textContent = clockLocal(manifest.t0 + t, tz);
    if (!scrubbing) scrubber.value = String(Math.round((t / duration) * 1000));
  }
  scrubber.addEventListener('pointerdown', () => {
    scrubbing = true;
    viewer.setPlaying(false);
  });
  const stopScrub = () => (scrubbing = false);
  scrubber.addEventListener('pointerup', stopScrub);
  scrubber.addEventListener('pointercancel', stopScrub);
  scrubber.addEventListener('input', () => {
    viewer.setTime((Number(scrubber.value) / 1000) * duration);
  });
  onTime(0);

  // --- collapsible panels ---
  makeCollapsible('viewHeader', 'viewBody', 'viewChevron');
  makeCollapsible('pilotsHeader', 'pilotsBody', 'pilotsChevron');

  // --- playback controls ---
  $('playPause').addEventListener('click', () => viewer.togglePlay());
  $<HTMLSelectElement>('speed').addEventListener('change', (e) => {
    viewer.setSpeed(Number((e.target as HTMLSelectElement).value));
  });

  // --- view controls ---
  $<HTMLSelectElement>('colorMode').addEventListener('change', (e) => {
    const mode = (e.target as HTMLSelectElement).value as ColorMode;
    viewer.setColorMode(mode);
    updateLegend(mode);
  });
  updateLegend('pilot');

  const vscale = $<HTMLInputElement>('vscale');
  vscale.addEventListener('input', () => {
    const v = Number(vscale.value);
    viewer.setVScale(v);
    $('vscaleVal').textContent = `${v.toFixed(1)}×`;
  });

  // Trail = how many of the most-recent minutes are drawn (1–30 min, or Full).
  const tail = $<HTMLInputElement>('tail');
  tail.addEventListener('input', () => {
    const v = Number(tail.value);
    if (v >= 31) {
      viewer.setTailSeconds(1e9);
      $('tailVal').textContent = 'Full';
    } else {
      viewer.setTailSeconds(v * 60);
      $('tailVal').textContent = `${v} min`;
    }
  });

  const width = $<HTMLInputElement>('width');
  width.addEventListener('input', () => {
    const v = Number(width.value);
    viewer.setTrailWidth(v);
    $('widthVal').textContent = `${v} px`;
  });

  $('resetView').addEventListener('click', () => {
    viewer.resetCamera();
    clearFollow();
  });
  // Orientation presets keep any active follow — just change the view angle.
  $('topView').addEventListener('click', () => viewer.topView());
  $('sideView').addEventListener('click', () => viewer.sideView());
  // Clicking the compass spins the view back to north-up.
  $('compassBtn').addEventListener('click', () => viewer.faceNorth());

  $('fullscreen').addEventListener('click', () => {
    const app = $('app');
    if (document.fullscreenElement) document.exitFullscreen();
    else app.requestFullscreen?.();
  });

  // --- backdrop (abstract / terrain) ---
  const bdAbstract = $<HTMLButtonElement>('bdAbstract');
  const bdTerrain = $<HTMLButtonElement>('bdTerrain');
  const setActive = (btn: HTMLButtonElement, on: boolean): void => {
    btn.classList.toggle('bg-lime-500', on);
    btn.classList.toggle('text-slate-900', on);
    btn.classList.toggle('bg-slate-800', !on);
    btn.classList.toggle('text-slate-300', !on);
    btn.classList.toggle('hover:bg-slate-700', !on);
  };
  function paintBackdrop(active: 'abstract' | 'terrain'): void {
    setActive(bdAbstract, active === 'abstract');
    setActive(bdTerrain, active === 'terrain');
  }
  if (!import.meta.env.VITE_MAPBOX_TOKEN) {
    bdTerrain.disabled = true;
    bdTerrain.classList.add('opacity-40', 'cursor-not-allowed');
    bdTerrain.title = 'Set VITE_MAPBOX_TOKEN to enable the map backdrop';
  }
  // map style picker (terrain only)
  const mapStyleRow = $('mapStyleRow');
  const mapStyleSel = $<HTMLSelectElement>('mapStyle');
  mapStyleSel.innerHTML = MAP_STYLES.map(
    (s) => `<option value="${s.url}">${s.name}</option>`,
  ).join('');
  mapStyleSel.value = DEFAULT_MAP_STYLE.url;
  mapStyleSel.addEventListener('change', () => viewer.setMapStyle(mapStyleSel.value));

  async function switchBackdrop(mode: 'abstract' | 'terrain'): Promise<void> {
    if (mode === viewer.currentBackdrop) return;
    bdAbstract.disabled = bdTerrain.disabled = true;
    const prevStats = $('stats').textContent;
    if (mode === 'terrain') $('stats').textContent = 'Loading map…';
    try {
      await viewer.setBackdrop(mode);
      paintBackdrop(mode);
      mapStyleRow.classList.toggle('hidden', mode !== 'terrain');
      $('stats').textContent = prevStats;
    } catch (err) {
      console.error(err);
      $('stats').textContent = `Map unavailable: ${(err as Error).message}`;
      paintBackdrop(viewer.currentBackdrop);
    } finally {
      bdAbstract.disabled = false;
      bdTerrain.disabled = !import.meta.env.VITE_MAPBOX_TOKEN;
    }
  }
  bdAbstract.addEventListener('click', () => switchBackdrop('abstract'));
  bdTerrain.addEventListener('click', () => switchBackdrop('terrain'));

  // --- pilot legend (ordered by GAP result) ---
  let followIdx = -1;
  const rows: HTMLLIElement[] = new Array(manifest.pilots.length);
  const legend = $('legend');
  // rank ascending; pilots without a rank fall to the bottom, name-sorted
  const order = manifest.pilots
    .map((_, i) => i)
    .sort((a, b) => {
      const ra = manifest.pilots[a].rank;
      const rb = manifest.pilots[b].rank;
      if (ra != null && rb != null) return ra - rb;
      if (ra != null) return -1;
      if (rb != null) return 1;
      return manifest.pilots[a].name.localeCompare(manifest.pilots[b].name);
    });

  for (const i of order) {
    const p = manifest.pilots[i];
    const c = manifest.colors[i] ?? [0.8, 0.8, 0.8];
    const rgb = `rgb(${(c[0] * 255) | 0}, ${(c[1] * 255) | 0}, ${(c[2] * 255) | 0})`;
    const rankLabel = p.rank != null ? `${p.rank}. ` : '';
    const scoreLabel = p.score != null ? String(Math.round(p.score)) : '';
    const li = document.createElement('li');
    li.className =
      'flex items-center gap-2 px-3 py-1 hover:bg-slate-700/40 cursor-pointer select-none';
    li.dataset.search = `${rankLabel}${p.name}`.toLowerCase();
    li.innerHTML = `
      <button class="swatch shrink-0 w-3 h-3 rounded-sm" style="background:${rgb}" title="Toggle visibility"></button>
      <span class="name flex-1 truncate" title="Click to follow">${escapeHtml(rankLabel + p.name)}</span>
      <span class="shrink-0 text-[10px] text-slate-500 tabular-nums">${scoreLabel}</span>`;
    legend.appendChild(li);
    rows[i] = li;

    let visible = true;
    const swatch = li.querySelector<HTMLButtonElement>('.swatch')!;
    const nameEl = li.querySelector<HTMLSpanElement>('.name')!;

    li.addEventListener('pointerenter', () => {
      if (followIdx < 0) viewer.setHighlight(i);
    });
    li.addEventListener('pointerleave', () => {
      if (followIdx < 0) viewer.setHighlight(-1);
    });
    swatch.addEventListener('click', (e) => {
      e.stopPropagation();
      visible = !visible;
      viewer.setPilotVisible(i, visible);
      li.classList.toggle('opacity-40', !visible);
    });
    nameEl.addEventListener('click', () => setFollow(i));
  }

  // --- pilot search filter ---
  const pilotSearch = $<HTMLInputElement>('pilotSearch');
  pilotSearch.addEventListener('input', () => {
    const q = pilotSearch.value.trim().toLowerCase();
    for (const li of rows) {
      const match = !q || (li.dataset.search ?? '').includes(q);
      li.classList.toggle('hidden', !match);
    }
  });

  function setFollow(i: number): void {
    followIdx = i;
    viewer.setFollow(i);
    viewer.setHighlight(i);
    rows.forEach((r, k) => r.classList.toggle('bg-slate-700/60', k === i));
    $('followName').textContent = manifest.pilots[i].name;
    $('followBar').classList.remove('hidden');
  }
  function clearFollow(): void {
    followIdx = -1;
    viewer.setFollow(-1);
    viewer.setHighlight(-1);
    rows.forEach((r) => r.classList.remove('bg-slate-700/60'));
    $('followBar').classList.add('hidden');
  }
  $('unfollow').addEventListener('click', clearFollow);

  let allHidden = false;
  $('toggleAll').addEventListener('click', (e) => {
    e.stopPropagation(); // don't collapse the panel
    allHidden = !allHidden;
    manifest.pilots.forEach((_, i) => viewer.setPilotVisible(i, !allHidden));
    rows.forEach((r) => r.classList.toggle('opacity-40', allHidden));
    $('toggleAll').textContent = allHidden ? 'show all' : 'hide all';
  });

  // --- colour scale legend (altitude / vertical speed) ---
  const ALT_GRADIENT =
    'linear-gradient(to right, rgb(33,102,217), rgb(26,191,204), rgb(77,204,77), rgb(242,204,51), rgb(235,64,51))';
  const VARIO_GRADIENT = 'linear-gradient(to right, rgb(51,115,242), rgb(217,217,224), rgb(242,64,51))';
  function updateLegend(mode: ColorMode): void {
    const box = $('colorLegend');
    if (mode === 'pilot') {
      box.classList.add('hidden');
      return;
    }
    box.classList.remove('hidden');
    if (mode === 'altitude') {
      const alt0 = manifest.origin.alt0;
      $('legendBar').style.background = ALT_GRADIENT;
      $('legendLo').textContent = `${Math.round(alt0 + manifest.altMin)} m`;
      $('legendMid').textContent = '';
      $('legendHi').textContent = `${Math.round(alt0 + manifest.altMax)} m`;
    } else {
      $('legendBar').style.background = VARIO_GRADIENT;
      $('legendLo').textContent = `−${VARIO_MAX} m/s`;
      $('legendMid').textContent = '0';
      $('legendHi').textContent = `+${VARIO_MAX} m/s`;
    }
  }

  // --- tooltip ---
  function showTooltip(info: HoverInfo | null): void {
    const el = $('tooltip');
    if (!info) {
      el.classList.add('hidden');
      return;
    }
    const climb = info.climb >= 0 ? `+${info.climb.toFixed(1)}` : info.climb.toFixed(1);
    el.innerHTML = `<div class="font-medium">${escapeHtml(info.name)}</div>
      <div class="text-slate-400">${info.altMsl.toFixed(0)} m · <span class="${info.climb >= 0 ? 'text-lime-400' : 'text-sky-400'}">${climb} m/s</span></div>`;
    el.style.left = `${info.screenX + 14}px`;
    el.style.top = `${info.screenY - 8}px`;
    el.classList.remove('hidden');
  }

  // --- scale bar ---
  function updateScaleBar(mpp: number): void {
    if (!isFinite(mpp) || mpp <= 0) return;
    const meters = niceNumber(mpp * 90);
    const px = meters / mpp;
    $('scaleBar').style.width = `${px}px`;
    $('scaleLabel').textContent = meters >= 1000 ? `${(meters / 1000).toFixed(meters % 1000 === 0 ? 0 : 1)} km` : `${meters} m`;
  }

  // start paused at t=0; user presses play
  viewer.setTime(0);

  window.addEventListener('beforeunload', () => viewer.dispose());
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

main();
