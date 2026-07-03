// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Entry point for the standalone /replay flight-replay page.
 * Wires the Three.js ReplayViewer to the DOM chrome (timeline scrubber,
 * play/pause, colour modes, vertical exaggeration, pilot legend, scale bar,
 * compass, rank badges, metrics callout). No authentication, no framework —
 * just the viewer.
 */

import {
  METRIC_AVG_SECONDS,
  ReplayViewer,
  type ColorMode,
  type PilotScreenSample,
} from './replay-viewer';
import { config } from '../analysis/config';
import {
  formatAltitude,
  formatClimbRate,
  formatSpeed,
  onUnitsChanged,
  type UnitPreferences,
} from '../analysis/units-browser';
import { MAP_STYLES, DEFAULT_MAP_STYLE } from './map-styles';
import { VARIO_MAX } from './flight-scene';
import { GaggleUI } from './gaggle-ui';
import type { GaggleResult } from './gaggles';
import type { TrackManifest } from '@glidecomp/engine';

/**
 * The replay data now comes from the competition-api Worker as a single packed
 * bundle. By default we show the seeded public sample competition (resolved by
 * name server-side, so no environment-specific id is needed); `?comp=&task=`
 * points the same viewer at any competition task the user may view.
 */
function bundleUrl(): string {
  const q = new URLSearchParams(location.search);
  const comp = q.get('comp');
  const task = q.get('task');
  return comp && task
    ? `/api/comp/${encodeURIComponent(comp)}/task/${encodeURIComponent(task)}/3dvis`
    : '/api/comp/sample-3dvis';
}

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

/**
 * Wire the single control drawer.
 *
 * Every control — View, Pilots, Gaggles — lives in one scrolling panel
 * (#menuPanel) opened from the floating hamburger (#menuToggle), the same way
 * on desktop and mobile. The panel slides in from the right; the hamburger
 * toggles it, the ✕ header button and Escape close it, and a click on the map
 * outside the panel dismisses it too. Inputs inside the panel never close it.
 */
function setupPanels(): void {
  const toggle = document.getElementById('menuToggle');
  const panel = document.getElementById('menuPanel');
  const close = document.getElementById('menuClose');
  if (!toggle || !panel) return;

  const setOpen = (open: boolean): void => {
    panel.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    // Hide the floating hamburger while the drawer is open so it doesn't sit on
    // top of the panel's ✕ button; the ✕ / Escape / click-outside close it.
    toggle.classList.toggle('hidden', open);
  };

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!panel.classList.contains('open'));
  });
  close?.addEventListener('click', () => setOpen(false));

  // Click outside the drawer (and not on the toggle) closes it.
  document.addEventListener('click', (e) => {
    const t = e.target as Node;
    if (panel.classList.contains('open') && !panel.contains(t) && !toggle.contains(t)) {
      setOpen(false);
    }
  });
  // Esc closes the drawer.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
}

// colour-scale gradients for the trail colour legend (module scope — used by
// updateLegend, which runs during early wiring)
const ALT_GRADIENT =
  'linear-gradient(to right, rgb(33,102,217), rgb(26,191,204), rgb(77,204,77), rgb(242,204,51), rgb(235,64,51))';
const VARIO_GRADIENT = 'linear-gradient(to right, rgb(51,115,242), rgb(217,217,224), rgb(242,64,51))';

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

  // Declared before the viewer so its callbacks (which fire from the rAF loop)
  // can never hit the temporal dead zone.
  let followIdx = -1;
  let hoverIdx = -1;

  let manifest: TrackManifest;
  const viewer = new ReplayViewer(
    container,
    {
      onTime: (t) => onTime(t),
      onPlayState: (p) => {
        $('playPause').textContent = p ? '❚❚' : '▶';
      },
      onHover: (info) => {
        // No tooltip window next to the pilot — hovering a cone routes that
        // pilot's metrics into the fixed callout bubble instead (see
        // onFrameTick); here we just track who's hovered and hint clickability.
        hoverIdx = info ? info.pilotIdx : -1;
        container.style.cursor = info ? 'pointer' : '';
      },
      onFrame: (samples) => onFrameTick(samples),
      onPick: (i) => onPickPilot(i),
      onScale: (mpp) => updateScaleBar(mpp),
      onCompass: (deg) => {
        $('compassRot').setAttribute('transform', `rotate(${-deg} 20 20)`);
      },
    },
    import.meta.env.VITE_MAPBOX_TOKEN,
  );

  try {
    const tracks = await viewer.loadBundle(bundleUrl());
    manifest = tracks.manifest;
  } catch (err) {
    overlayText.textContent = `Could not load tracks: ${(err as Error).message}`;
    console.error(err);
    return;
  }

  overlay.classList.add('hidden');

  // Dev-only debug handle so the gaggle overlay can be inspected/driven from the
  // console or automation (which gaggles are active at the current frame, etc.).
  if (import.meta.env.DEV) (window as unknown as { __viewer: unknown }).__viewer = viewer;

  // --- scrubber + clock ---
  const duration = manifest.t1 - manifest.t0;
  const scrubber = $<HTMLInputElement>('scrubber');
  let scrubbing = false;
  const tz = manifest.timezone; // comp IANA zone, or undefined → browser zone
  $('clockZone').textContent = zoneLabel(new Date(manifest.t0 * 1000), tz);

  let gaggleUI: GaggleUI | undefined;
  function onTime(t: number): void {
    $('clock').textContent = clockLocal(manifest.t0 + t, tz);
    if (!scrubbing) scrubber.value = String(Math.round((t / duration) * 1000));
    gaggleUI?.setTime(t);
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

  // --- panel chrome (desktop collapse / mobile bottom sheets) ---
  setupPanels();

  // --- playback controls ---
  $('playPause').addEventListener('click', () => viewer.togglePlay());
  $<HTMLSelectElement>('speed').addEventListener('change', (e) => {
    viewer.setSpeed(Number((e.target as HTMLSelectElement).value));
  });
  // Space toggles play/pause — unless a form control has focus (space there
  // means "activate that control", e.g. re-clicking a focused button).
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space') return;
    const t = e.target as HTMLElement;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement ||
      t instanceof HTMLButtonElement
    )
      return;
    e.preventDefault(); // don't scroll the page
    viewer.togglePlay();
  });

  // --- view controls ---
  $<HTMLSelectElement>('colorMode').addEventListener('change', (e) => {
    const mode = (e.target as HTMLSelectElement).value as ColorMode;
    viewer.setColorMode(mode);
    updateLegend(mode);
  });
  // default: colour trails by vertical speed (matches the viewer's initial mode)
  updateLegend('vario');

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
    try {
      await viewer.setBackdrop(mode);
      paintBackdrop(mode);
      mapStyleRow.classList.toggle('hidden', mode !== 'terrain');
    } catch (err) {
      console.error(err);
      paintBackdrop(viewer.currentBackdrop);
    } finally {
      bdAbstract.disabled = false;
      bdTerrain.disabled = !import.meta.env.VITE_MAPBOX_TOKEN;
    }
  }
  bdAbstract.addEventListener('click', () => switchBackdrop('abstract'));
  bdTerrain.addEventListener('click', () => switchBackdrop('terrain'));

  // --- pilot legend (ordered by GAP result) ---
  function pilotRgb(i: number): string {
    const c = manifest.colors[i] ?? [0.8, 0.8, 0.8];
    return `rgb(${(c[0] * 255) | 0}, ${(c[1] * 255) | 0}, ${(c[2] * 255) | 0})`;
  }
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
    const rgb = pilotRgb(i);
    const scoreLabel = p.score != null ? String(Math.round(p.score)) : '';
    const li = document.createElement('li');
    li.className =
      'flex items-center gap-2 px-3 py-1 hover:bg-slate-700/40 cursor-pointer select-none';
    li.dataset.search = `${p.rank != null ? `${p.rank}. ` : ''}${p.name}`.toLowerCase();
    // Ranked pilots get the same rank chip as their cone in the 3D scene (it
    // doubles as the visibility toggle); unranked pilots keep a plain swatch.
    const swatchHtml =
      p.rank != null
        ? `<button class="swatch shrink-0 grid place-items-center h-4 min-w-4 px-1 rounded-full text-[10px] font-bold text-slate-900 leading-none" style="background:${rgb}; box-shadow: 0 0 0 1px rgba(8,12,22,0.6)" title="Toggle visibility">${p.rank}</button>`
        : `<button class="swatch shrink-0 w-3 h-3 rounded-sm" style="background:${rgb}" title="Toggle visibility"></button>`;
    li.innerHTML = `
      ${swatchHtml}
      <span class="name flex-1 truncate" title="Click to follow">${escapeHtml(p.name)}</span>
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
    showCallout(i);
  }
  function clearFollow(): void {
    followIdx = -1;
    viewer.setFollow(-1);
    viewer.setHighlight(-1);
    rows.forEach((r) => r.classList.remove('bg-slate-700/60'));
    $('followBar').classList.add('hidden');
    hideCallout();
  }
  $('unfollow').addEventListener('click', clearFollow);

  /**
   * Canvas click: on a cone, follow that pilot (click the followed one again
   * to stop); away from every cone, toggle play/pause — unless the click is
   * dismissing the open control drawer, which shouldn't also start playback.
   */
  function onPickPilot(i: number): void {
    if (i < 0) {
      if (!$('menuPanel').classList.contains('open')) viewer.togglePlay();
      return;
    }
    if (i === followIdx) clearFollow();
    else setFollow(i);
  }

  let allHidden = false;
  $('toggleAll').addEventListener('click', (e) => {
    e.stopPropagation(); // don't collapse the panel
    allHidden = !allHidden;
    manifest.pilots.forEach((_, i) => viewer.setPilotVisible(i, !allHidden));
    rows.forEach((r) => r.classList.toggle('opacity-40', allHidden));
    $('toggleAll').textContent = allHidden ? 'show all' : 'hide all';
  });

  // --- gaggle ribbon + panel ---
  function showGaggleFollow(id: number): void {
    const ep = viewer.gaggleResult?.episodes.find((e) => e.id === id);
    followIdx = -1;
    hideCallout();
    rows.forEach((r) => r.classList.remove('bg-slate-700/60'));
    $('followName').textContent = ep ? `${ep.peakSize}-pilot gaggle` : 'gaggle';
    $('followBar').classList.remove('hidden');
  }
  function buildGaggleUI(result: GaggleResult): GaggleUI {
    return new GaggleUI({
      ribbon: $('gaggleRibbon'),
      list: $('gaggleList'),
      tooltip: $('tooltip'),
      result,
      manifest,
      duration,
      fmtTime: (tRel) => clockLocal(manifest.t0 + tRel, tz),
      onSeek: (t) => {
        viewer.setPlaying(false);
        viewer.setTime(t);
      },
      onFollow: (id) => {
        viewer.setFollowGaggle(id);
        showGaggleFollow(id);
      },
      onHighlight: (id) => viewer.setGaggleHighlight(id),
    });
  }
  if (viewer.gaggleResult) gaggleUI = buildGaggleUI(viewer.gaggleResult);
  gaggleUI?.setTime(0);

  // show/hide the in-scene overlay
  let gaggleShown = true;
  $('gaggleToggle').addEventListener('click', (e) => {
    e.stopPropagation();
    gaggleShown = !gaggleShown;
    viewer.setGaggleVisible(gaggleShown);
    $('gaggleToggle').textContent = gaggleShown ? 'hide' : 'show';
  });

  // "active now" filter for the panel list
  let activeOnly = false;
  $('gaggleActiveOnly').addEventListener('click', (e) => {
    e.stopPropagation();
    activeOnly = !activeOnly;
    gaggleUI?.setActiveOnly(activeOnly);
    const btn = $('gaggleActiveOnly');
    btn.classList.toggle('text-lime-400', activeOnly);
    btn.classList.toggle('text-slate-400', !activeOnly);
    gaggleUI?.setTime(viewer.currentTime);
  });

  // dev-only threshold sliders — re-run detection live
  if (import.meta.env.DEV) {
    $('gaggleDev').classList.remove('hidden');
    const ggR = $<HTMLInputElement>('ggRadius');
    const ggB = $<HTMLInputElement>('ggBand');
    const ggM = $<HTMLInputElement>('ggMin');
    const recompute = (): void => {
      const result = viewer.recomputeGaggles({
        horizontalRadius: Number(ggR.value),
        verticalBand: Number(ggB.value),
        minPilots: Number(ggM.value),
      });
      $('ggRadiusVal').textContent = `${ggR.value} m`;
      $('ggBandVal').textContent = `${ggB.value} m`;
      $('ggMinVal').textContent = ggM.value;
      gaggleUI?.destroy();
      gaggleUI = buildGaggleUI(result);
      gaggleUI.setActiveOnly(activeOnly);
      gaggleUI.setTime(viewer.currentTime);
    };
    for (const el of [ggR, ggB, ggM]) el.addEventListener('change', recompute);
  }

  // --- rank badges on the pilot cones ---
  // Small DOM chips repositioned every frame from the viewer's projected marker
  // positions — crisp text in both backends (in-scene sprites don't billboard
  // correctly under the Mapbox custom-layer projection).
  const badgesLayer = $('badges');
  let badgesOn = true;
  const badges: (HTMLDivElement | null)[] = manifest.pilots.map((p, i) => {
    if (p.rank == null) return null;
    const el = document.createElement('div');
    el.className =
      'absolute left-0 top-0 grid place-items-center h-4 min-w-4 px-1 rounded-full text-[10px] font-bold text-slate-900 leading-none';
    el.style.background = pilotRgb(i);
    el.style.boxShadow = '0 0 0 1px rgba(8,12,22,0.6)';
    el.style.display = 'none';
    el.textContent = String(p.rank);
    badgesLayer.appendChild(el);
    return el;
  });
  $<HTMLInputElement>('rankBadges').addEventListener('change', (e) => {
    badgesOn = (e.target as HTMLInputElement).checked;
  });

  // --- metrics callout (draggable, leader line to the followed pilot) ---
  const callout = $('callout');
  const calloutStatus = $('calloutStatus');
  const leader = $('leader');
  const leaderLine = $('leaderLine');
  const leaderDot = $('leaderDot');
  const coAlt = $('coAlt');
  const coClimb = $('coClimb');
  const coSpeed = $('coSpeed');
  const coGlide = $('coGlide');
  const calloutClose = $('calloutClose');
  const CALLOUT_POS_KEY = 'replay.calloutPos';
  /** Pilot whose identity the callout header is currently painted for. */
  let calloutPilot = -1;

  /**
   * Vario gauge in the callout: a static half-dial (−VARIO_MAX…+VARIO_MAX m/s)
   * plus a live needle showing near-instantaneous climb. The needle is allowed
   * to flicker — it's drawn over a phosphor trail of its last ~3 s of
   * positions, fading like traces on a radium dial, so the spread of the
   * flicker reads as a glowing variance band while the digits stay averaged.
   * The trail is a ring buffer redrawn from scratch each frame (no
   * destination-out decay, which leaves stuck ghost pixels at low alpha).
   */
  const gauge = (() => {
    const W = 168;
    const H = 72;
    const CX = W / 2;
    const CY = H - 16; // needle pivot (climb readout sits below)
    const R = 46;
    const HISTORY = 180; // ~3 s of needle positions at 60 fps
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const sctx = $<HTMLCanvasElement>('gaugeScale').getContext('2d')!;
    const tctx = $<HTMLCanvasElement>('gaugeTrail').getContext('2d')!;
    for (const ctx of [sctx, tctx]) {
      ctx.canvas.width = W * dpr;
      ctx.canvas.height = H * dpr;
      ctx.scale(dpr, dpr);
    }
    const angleOf = (v: number): number => {
      const c = Math.max(-VARIO_MAX, Math.min(VARIO_MAX, v));
      return Math.PI + ((c + VARIO_MAX) / (2 * VARIO_MAX)) * Math.PI;
    };
    const ray = (ctx: CanvasRenderingContext2D, a: number, r0: number, r1: number): void => {
      ctx.beginPath();
      ctx.moveTo(CX + Math.cos(a) * r0, CY + Math.sin(a) * r0);
      ctx.lineTo(CX + Math.cos(a) * r1, CY + Math.sin(a) * r1);
      ctx.stroke();
    };

    // static dial: arc, ticks each 1 m/s (major each 2), labels at −max/0/+max
    // in the user's climb-rate unit (the dial's physical range stays ±VARIO_MAX
    // m/s to match the vario colour ramp; only the labels convert).
    const dialLabel = (v: number): string => {
      const u = config.getUnits().climbRate;
      return formatClimbRate(v, { decimals: u === 'm/s' ? 0 : undefined }).formatted;
    };
    const drawScale = (): void => {
      sctx.clearRect(0, 0, W, H);
      sctx.strokeStyle = 'rgba(148,163,184,0.35)';
      sctx.lineWidth = 1;
      sctx.beginPath();
      sctx.arc(CX, CY, R, Math.PI, 2 * Math.PI);
      sctx.stroke();
      sctx.textAlign = 'center';
      sctx.textBaseline = 'middle';
      sctx.font = '8px system-ui, sans-serif';
      for (let v = -VARIO_MAX; v <= VARIO_MAX; v++) {
        const a = angleOf(v);
        sctx.strokeStyle = v === 0 ? 'rgba(226,232,240,0.9)' : 'rgba(148,163,184,0.55)';
        sctx.lineWidth = v === 0 ? 1.5 : 1;
        ray(sctx, a, R - (v % 2 === 0 ? 6 : 3.5), R);
        if (v === -VARIO_MAX || v === 0 || v === VARIO_MAX) {
          sctx.fillStyle = 'rgba(148,163,184,0.8)';
          sctx.fillText(dialLabel(v), CX + Math.cos(a) * (R - 13), CY + Math.sin(a) * (R - 13));
        }
      }
      sctx.fillStyle = 'rgba(226,232,240,0.6)';
      sctx.beginPath();
      sctx.arc(CX, CY, 2, 0, 2 * Math.PI);
      sctx.fill();
    };
    drawScale();

    // needle history ring buffer (NaN = no reading that frame)
    const hist = new Float32Array(HISTORY).fill(NaN);
    let head = 0;
    return {
      /** Repaint the static dial (climb-rate unit changed). */
      redrawScale: drawScale,
      /** Wipe the trail (switching pilots). */
      reset(): void {
        hist.fill(NaN);
        tctx.clearRect(0, 0, W, H);
      },
      /** Per-frame: record `v` (null = no reading) and repaint trail + needle. */
      tick(v: number | null): void {
        hist[head] = v == null ? NaN : v;
        head = (head + 1) % HISTORY;
        tctx.clearRect(0, 0, W, H);
        tctx.lineCap = 'round';
        // phosphor trail, oldest (faintest) first
        tctx.lineWidth = 1.4;
        for (let k = 1; k < HISTORY; k++) {
          const hv = hist[(head + k) % HISTORY];
          if (Number.isNaN(hv)) continue;
          tctx.globalAlpha = 0.16 * (k / HISTORY) ** 2;
          tctx.strokeStyle = hv >= 0 ? '#a3e635' : '#38bdf8';
          ray(tctx, angleOf(hv), 10, R - 8);
        }
        // the live needle, with a soft glow
        if (v != null) {
          const color = v >= 0 ? '#a3e635' : '#38bdf8';
          tctx.globalAlpha = 0.95;
          tctx.strokeStyle = color;
          tctx.shadowColor = color;
          tctx.shadowBlur = 7;
          tctx.lineWidth = 2;
          ray(tctx, angleOf(v), 6, R - 8);
          tctx.shadowBlur = 0;
        }
        tctx.globalAlpha = 1;
      },
    };
  })();

  /** Clamp the callout inside the viewport (viewport coords == #app coords). */
  function placeCallout(x: number, y: number): void {
    const app = $('app').getBoundingClientRect();
    const r = callout.getBoundingClientRect();
    callout.style.left = `${Math.max(4, Math.min(app.width - r.width - 4, x))}px`;
    callout.style.top = `${Math.max(4, Math.min(app.height - r.height - 4, y))}px`;
  }
  function showCallout(i: number): void {
    calloutPilot = i;
    const p = manifest.pilots[i];
    $('calloutName').textContent = p.name;
    const rank = $('calloutRank');
    rank.style.display = p.rank != null ? '' : 'none';
    rank.textContent = p.rank != null ? String(p.rank) : '';
    rank.style.background = pilotRgb(i);
    leaderLine.setAttribute('stroke', pilotRgb(i));
    leaderDot.setAttribute('fill', pilotRgb(i));
    gauge.reset(); // don't smear one pilot's needle history into the next
    callout.classList.remove('hidden');
    placeCallout(parseFloat(callout.style.left), parseFloat(callout.style.top));
  }
  function hideCallout(): void {
    calloutPilot = -1;
    callout.classList.add('hidden');
    leader.classList.add('hidden');
  }
  calloutClose.addEventListener('click', clearFollow);

  // drag anywhere on the bubble (except the ✕); position persists locally
  {
    let drag: { dx: number; dy: number } | null = null;
    callout.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement).closest('#calloutClose')) return;
      const r = callout.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      callout.setPointerCapture(e.pointerId);
      callout.classList.replace('cursor-grab', 'cursor-grabbing');
    });
    callout.addEventListener('pointermove', (e) => {
      if (drag) placeCallout(e.clientX - drag.dx, e.clientY - drag.dy);
    });
    const endDrag = (): void => {
      if (!drag) return;
      drag = null;
      callout.classList.replace('cursor-grabbing', 'cursor-grab');
      try {
        localStorage.setItem(
          CALLOUT_POS_KEY,
          JSON.stringify({ left: callout.style.left, top: callout.style.top }),
        );
      } catch {
        /* storage unavailable (private mode) — position just won't persist */
      }
    };
    callout.addEventListener('pointerup', endDrag);
    callout.addEventListener('pointercancel', endDrag);
    try {
      const saved = JSON.parse(localStorage.getItem(CALLOUT_POS_KEY) ?? 'null') as {
        left?: string;
        top?: string;
      } | null;
      if (saved?.left) callout.style.left = saved.left;
      if (saved?.top) callout.style.top = saved.top;
    } catch {
      /* corrupt saved state — keep the default position */
    }
  }

  /** Glide ratio for display: '—' when not gliding, '∞' when level/climbing. */
  function fmtGlide(speed: number, climb: number): string {
    if (speed < 1) return '—';
    if (climb > -0.05) return '∞';
    const r = speed / -climb;
    return r > 40 ? '∞' : r.toFixed(1);
  }
  // digit-repaint throttle state (see onFrameTick)
  let digitsPilot = -1;
  let digitsAt = 0;

  // the climb digit is a fixed-window average (the needle stays instantaneous)
  $('coClimbAvg').textContent = `(${METRIC_AVG_SECONDS}s avg)`;

  /** Per-frame overlay refresh: badge positions + callout values + leader line. */
  function onFrameTick(samples: readonly PilotScreenSample[]): void {
    const eff = hoverIdx >= 0 ? hoverIdx : followIdx;
    for (const s of samples) {
      const el = badges[s.pilot];
      if (!el) continue;
      const show = badgesOn && s.active && s.onScreen;
      el.style.display = show ? '' : 'none';
      if (!show) continue;
      // pinned just above the cone tip
      el.style.transform = `translate(${s.screenX.toFixed(1)}px, ${s.screenY.toFixed(1)}px) translate(-50%, -175%)`;
      el.style.opacity = eff >= 0 && s.pilot !== eff ? '0.15' : s.landed ? '0.45' : '1';
    }

    // The callout shows the hovered pilot (live preview), else the followed
    // one — there is no per-pilot tooltip window; this bubble is the single
    // metrics surface.
    const display = hoverIdx >= 0 ? hoverIdx : followIdx;
    if (display !== calloutPilot) {
      if (display >= 0) showCallout(display);
      else hideCallout();
    }
    if (display < 0) return;
    // ✕ (stop following) only makes sense when a pilot is pinned
    calloutClose.style.visibility = followIdx >= 0 ? '' : 'hidden';
    const s = samples[display];
    const flying = s.active && !s.landed;

    // Every frame: altitude (steady by nature), the gauge needle (flicker is
    // the point — the phosphor trail turns it into a variance band), leader.
    coAlt.textContent = s.active ? formatAltitude(s.altMsl).withUnit : '—';
    gauge.tick(flying ? s.climbInst : null);
    updateLeader(s);

    // Digits: already averaged over the playback-scaled window, and repainted
    // at most ~1×/s during playback so they're readable; live when paused or
    // when the displayed pilot changes.
    const now = performance.now();
    if (display === digitsPilot && viewer.isPlaying && now - digitsAt < 1000) return;
    digitsPilot = display;
    digitsAt = now;
    coClimb.textContent = flying ? formatClimbRate(s.climb).withUnit : '—';
    coClimb.classList.toggle('text-lime-400', flying && s.climb >= 0);
    coClimb.classList.toggle('text-sky-400', flying && s.climb < 0);
    coSpeed.textContent = flying ? formatSpeed(s.speed).withUnit : '—';
    coGlide.textContent = flying ? fmtGlide(s.speed, s.climb) : '—';
    const p = manifest.pilots[display];
    const status = [
      p.score != null ? `${Math.round(p.score)} pts` : '',
      !s.active ? 'not launched yet' : s.landed ? 'landed' : '',
    ]
      .filter(Boolean)
      .join(' · ');
    if (calloutStatus.textContent !== status) calloutStatus.textContent = status;
  }

  /**
   * Leader line from the callout's nearest edge to the pilot's cone. Hidden when
   * the cone is off-screen or sits under the bubble itself.
   */
  function updateLeader(s: PilotScreenSample): void {
    if (!s.active || !s.onScreen || callout.classList.contains('hidden')) {
      leader.classList.add('hidden');
      return;
    }
    const r = callout.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const dx = s.screenX - cx;
    const dy = s.screenY - cy;
    // scale factor from the bubble centre to where the ray exits the (padded) rect
    const kx = dx !== 0 ? (r.width / 2 + 6) / Math.abs(dx) : Infinity;
    const ky = dy !== 0 ? (r.height / 2 + 6) / Math.abs(dy) : Infinity;
    const k = Math.min(kx, ky);
    if (!isFinite(k) || k >= 1) {
      leader.classList.add('hidden');
      return;
    }
    leaderLine.setAttribute('x1', (cx + dx * k).toFixed(1));
    leaderLine.setAttribute('y1', (cy + dy * k).toFixed(1));
    leaderLine.setAttribute('x2', s.screenX.toFixed(1));
    leaderLine.setAttribute('y2', s.screenY.toFixed(1));
    leaderDot.setAttribute('cx', s.screenX.toFixed(1));
    leaderDot.setAttribute('cy', s.screenY.toFixed(1));
    leader.classList.remove('hidden');
  }

  // --- units (same glidecomp:preferences store the analysis page uses) ---
  const unitSelects: Record<keyof UnitPreferences, HTMLSelectElement> = {
    speed: $('unitSpeed'),
    altitude: $('unitAltitude'),
    climbRate: $('unitClimb'),
    distance: $('unitDistance'),
  };
  function syncUnitSelects(): void {
    const u = config.getUnits();
    for (const k of Object.keys(unitSelects) as (keyof UnitPreferences)[]) {
      unitSelects[k].value = u[k];
    }
  }
  syncUnitSelects();
  for (const k of Object.keys(unitSelects) as (keyof UnitPreferences)[]) {
    unitSelects[k].addEventListener('change', () => {
      config.setUnit(k, unitSelects[k].value as UnitPreferences[typeof k]);
    });
  }
  // Fires for our own edits and for changes made elsewhere (analysis page /
  // another tab): refresh every unit-bearing surface.
  onUnitsChanged(() => {
    syncUnitSelects();
    gauge.redrawScale();
    updateLegend($<HTMLSelectElement>('colorMode').value as ColorMode);
    digitsPilot = -1; // repaint the callout digits immediately, skip the 1 s throttle
  });

  // --- colour scale legend (altitude / vertical speed) ---
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
      $('legendLo').textContent = formatAltitude(alt0 + manifest.altMin).withUnit;
      $('legendMid').textContent = '';
      $('legendHi').textContent = formatAltitude(alt0 + manifest.altMax).withUnit;
    } else {
      $('legendBar').style.background = VARIO_GRADIENT;
      $('legendLo').textContent = formatClimbRate(-VARIO_MAX).withUnit;
      $('legendMid').textContent = '0';
      $('legendHi').textContent = formatClimbRate(VARIO_MAX).withUnit;
    }
  }

  // --- scale bar (in the user's distance unit, sub-unit for short bars) ---
  function updateScaleBar(mpp: number): void {
    if (!isFinite(mpp) || mpp <= 0) return;
    const targetM = mpp * 90;
    const unit = config.getUnits().distance;
    let meters: number;
    let label: string;
    if (unit === 'mi') {
      const ft = targetM * 3.28084;
      if (ft < 2640) {
        const nice = niceNumber(ft);
        meters = nice / 3.28084;
        label = `${nice} ft`;
      } else {
        const nice = niceNumber(targetM / 1609.344);
        meters = nice * 1609.344;
        label = `${nice} mi`;
      }
    } else if (unit === 'nmi') {
      const nice = niceNumber(targetM / 1852);
      meters = nice * 1852;
      label = `${nice} NM`;
    } else {
      const nice = niceNumber(targetM);
      meters = nice;
      label = nice >= 1000 ? `${(nice / 1000).toFixed(nice % 1000 === 0 ? 0 : 1)} km` : `${nice} m`;
    }
    $('scaleBar').style.width = `${meters / mpp}px`;
    $('scaleLabel').textContent = label;
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
