// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Entry point for the standalone /samples/3dvis flight-replay page.
 * Wires the Three.js ReplayViewer to the DOM chrome (timeline scrubber,
 * play/pause, colour modes, vertical exaggeration, pilot legend, scale bar,
 * compass, hover tooltip). No authentication, no framework — just the viewer.
 */

import { ReplayViewer, type ColorMode, type HoverInfo } from './replay-viewer';
import type { TrackManifest } from '@glidecomp/engine';

const DATA_BASE = '/samples/3dvis';

const $ = <T = HTMLElement>(id: string): T =>
  document.getElementById(id) as unknown as T;

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** Format absolute UTC seconds as HH:MM:SS. */
function clockUTC(utcSeconds: number): string {
  const d = new Date(utcSeconds * 1000);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
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
  const viewer = new ReplayViewer(container, {
    onTime: (t) => onTime(t),
    onPlayState: (p) => {
      $('playPause').textContent = p ? '❚❚' : '▶';
    },
    onHover: (info) => showTooltip(info),
    onScale: (mpp) => updateScaleBar(mpp),
    onCompass: (deg) => {
      $('compassRot').setAttribute('transform', `rotate(${-deg} 20 20)`);
    },
  });

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
    `${manifest.pilots.length} pilots · ${(manifest.vertexCount / 1000).toFixed(0)}k fixes · ${durMin} min · drag to orbit`;

  // --- scrubber + clock ---
  const duration = manifest.t1 - manifest.t0;
  const scrubber = $<HTMLInputElement>('scrubber');
  let scrubbing = false;

  function onTime(t: number): void {
    $('clock').textContent = clockUTC(manifest.t0 + t);
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

  // --- playback controls ---
  $('playPause').addEventListener('click', () => viewer.togglePlay());
  $<HTMLSelectElement>('speed').addEventListener('change', (e) => {
    viewer.setSpeed(Number((e.target as HTMLSelectElement).value));
  });

  // --- view controls ---
  $<HTMLSelectElement>('colorMode').addEventListener('change', (e) => {
    viewer.setColorMode((e.target as HTMLSelectElement).value as ColorMode);
  });

  const vscale = $<HTMLInputElement>('vscale');
  vscale.addEventListener('input', () => {
    const v = Number(vscale.value);
    viewer.setVScale(v);
    $('vscaleVal').textContent = `${v.toFixed(1)}×`;
  });

  const tail = $<HTMLInputElement>('tail');
  tail.addEventListener('input', () => {
    const v = Number(tail.value);
    if (v >= 100) {
      viewer.setTailSeconds(1e9);
      $('tailVal').textContent = 'Full';
    } else {
      const secs = Math.max(15, Math.pow(v / 100, 2) * duration);
      viewer.setTailSeconds(secs);
      $('tailVal').textContent = secs >= 90 ? `${Math.round(secs / 60)} min` : `${Math.round(secs)} s`;
    }
  });

  $('resetView').addEventListener('click', () => {
    viewer.resetCamera();
    clearFollow();
  });

  $('fullscreen').addEventListener('click', () => {
    const app = $('app');
    if (document.fullscreenElement) document.exitFullscreen();
    else app.requestFullscreen?.();
  });

  // --- pilot legend ---
  let followIdx = -1;
  const rows: HTMLLIElement[] = [];
  const legend = $('legend');
  manifest.pilots.forEach((p, i) => {
    const c = manifest.colors[i] ?? [0.8, 0.8, 0.8];
    const rgb = `rgb(${(c[0] * 255) | 0}, ${(c[1] * 255) | 0}, ${(c[2] * 255) | 0})`;
    const li = document.createElement('li');
    li.className =
      'flex items-center gap-2 px-3 py-1 hover:bg-slate-700/40 cursor-pointer select-none';
    li.innerHTML = `
      <button class="swatch shrink-0 w-3 h-3 rounded-sm" style="background:${rgb}" title="Toggle visibility"></button>
      <span class="name flex-1 truncate" title="Click to follow">${escapeHtml(p.name)}</span>`;
    legend.appendChild(li);
    rows.push(li);

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
  $('toggleAll').addEventListener('click', () => {
    allHidden = !allHidden;
    manifest.pilots.forEach((_, i) => viewer.setPilotVisible(i, !allHidden));
    rows.forEach((r) => r.classList.toggle('opacity-40', allHidden));
    $('toggleAll').textContent = allHidden ? 'show all' : 'hide all';
  });

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
