// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * ReplayViewer — orchestrator for the 3D flight replay.
 *
 * Owns the playback clock, the shared FlightScene, and exactly one active render
 * backend (abstract free-orbit view or Mapbox terrain view). It drives time and
 * marker updates, asks the backend to draw, handles pilot picking, and routes
 * scale-bar / compass / hover values back to the UI.
 *
 * Switching backdrops disposes the current scene + backend (they hold GL
 * resources bound to one context) and rebuilds them, re-applying all view state.
 */

import { loadTracks, loadTracksBundle, type LoadedTracks } from './track-data';
import { detectGaggles, gagglesAt, type GaggleParams, type GaggleResult } from './gaggles';
import { FlightScene, type ColorMode, type MarkerSample } from './flight-scene';
import { AbstractBackend } from './abstract-backend';
import { DEFAULT_MAP_STYLE } from './map-styles';
import type { Backend } from './backend';

export type { ColorMode } from './flight-scene';
export type Backdrop = 'abstract' | 'terrain';

export interface HoverInfo {
  pilotIdx: number;
  name: string;
  altMsl: number;
  climb: number;
  screenX: number;
  screenY: number;
}

export interface ViewerCallbacks {
  onTime?(tRel: number): void;
  onPlayState?(playing: boolean): void;
  onHover?(info: HoverInfo | null): void;
  onScale?(metresPerPixel: number): void;
  onCompass?(northAngleDeg: number): void;
}

export class ReplayViewer {
  private tracks!: LoadedTracks;
  private gaggles?: GaggleResult;
  private scene!: FlightScene;
  private backend!: Backend;
  private backdrop: Backdrop = 'abstract';
  private switching = false;

  private raf = 0;
  private lastFrame = 0;

  // playback / view state (preserved across backdrop switches)
  private duration = 0;
  private time = 0;
  private playing = false;
  private speed = 16;
  private vScale = 3;
  private colorMode: ColorMode = 'pilot';
  private tailSeconds = 600; // 10 min comet tail by default
  private trailWidth = 3; // CSS px
  private mapStyle = DEFAULT_MAP_STYLE.url;
  private visibility!: boolean[];
  private follow = -1;
  /** Gaggle id being followed by its live centroid (-1 = none). */
  private followGaggleId = -1;
  private gaggleVisible = true;
  private gaggleHighlight = -1;

  // picking
  private pointer = { x: 0, y: 0, inside: false };
  private hover = -1;

  constructor(
    private container: HTMLElement,
    private cb: ViewerCallbacks = {},
    private mapboxToken: string = '',
  ) {}

  /** Load from a two-file static asset (manifest JSON + gzipped binary). */
  async load(manifestUrl: string, binUrl: string): Promise<LoadedTracks> {
    return this.init(await loadTracks(manifestUrl, binUrl));
  }

  /** Load from a single Worker bundle (manifest + gzipped data in one fetch). */
  async loadBundle(url: string): Promise<LoadedTracks> {
    return this.init(await loadTracksBundle(url));
  }

  private async init(tracks: LoadedTracks): Promise<LoadedTracks> {
    this.tracks = tracks;
    this.duration = this.tracks.manifest.t1 - this.tracks.manifest.t0;
    this.visibility = new Array(this.tracks.manifest.pilots.length).fill(true);
    this.gaggles = detectGaggles(this.tracks);

    this.scene = new FlightScene(this.tracks, this.gaggles);
    this.applySceneState();
    this.backend = await this.makeBackend('abstract');
    this.backend.setVScale(this.vScale);
    await this.backend.mount();

    this.container.addEventListener('pointermove', this.onPointerMove);
    this.container.addEventListener('pointerleave', this.onPointerLeave);
    window.addEventListener('resize', this.onResize);

    this.startLoop();
    return this.tracks;
  }

  // --- backdrop switching --------------------------------------------------

  get currentBackdrop(): Backdrop {
    return this.backdrop;
  }

  async setBackdrop(mode: Backdrop): Promise<void> {
    if (mode === this.backdrop || this.switching) return;
    this.switching = true;
    try {
      this.backend.dispose();
      this.scene.dispose();

      this.scene = new FlightScene(this.tracks, this.gaggles);
      this.applySceneState();
      this.backend = await this.makeBackend(mode);
      this.backend.setVScale(this.vScale);
      await this.backend.mount();
      this.backdrop = mode;
    } finally {
      this.switching = false;
    }
  }

  /** Build a backend for the given backdrop (terrain is lazy-loaded). */
  private async makeBackend(mode: Backdrop): Promise<Backend> {
    if (mode === 'terrain') {
      if (!this.mapboxToken) throw new Error('Mapbox token not configured (VITE_MAPBOX_TOKEN)');
      const { TerrainBackend } = await import('./terrain-backend');
      return new TerrainBackend(this.container, this.scene, this.tracks.manifest, this.mapboxToken, this.mapStyle);
    }
    return new AbstractBackend(this.container, this.scene);
  }

  /** Re-push every scene-level setting onto a freshly built FlightScene. */
  private applySceneState(): void {
    this.scene.setVScale(this.vScale);
    this.scene.setColorMode(this.colorMode);
    this.scene.setTailSeconds(this.tailSeconds);
    this.scene.setWidth(this.trailWidth);
    this.visibility.forEach((v, i) => this.scene.setVisible(i, v));
    this.scene.setGaggleVisible(this.gaggleVisible);
    this.scene.setGaggleHighlight(this.gaggleHighlight);
    this.scene.setTime(this.time);
  }

  // --- render loop ---------------------------------------------------------

  private startLoop(): void {
    this.lastFrame = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;
    if (this.switching) return;

    if (this.playing) {
      this.time += dt * this.speed;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.setPlaying(false);
      }
      this.cb.onTime?.(this.time);
    }

    this.scene.setTime(this.time);
    const samples = this.scene.updateMarkers(this.time);

    if (this.followGaggleId >= 0) this.backend.followTo(this.gaggleCentroid(samples));
    else if (this.follow >= 0) this.backend.followTo(samples[this.follow]);
    this.backend.render();

    this.updatePicking(samples);
    this.cb.onScale?.(this.backend.getMetresPerPixel());
    this.cb.onCompass?.(this.backend.getBearingDeg());
  }

  private updatePicking(samples: MarkerSample[]): void {
    let hover = -1;
    let hoverX = 0;
    let hoverY = 0;
    if (this.pointer.inside) {
      let bestD = 20;
      for (const s of samples) {
        if (!s.active) continue;
        const p = this.backend.projectToScreen(s.x, s.y, s.z);
        if (!p.visible) continue;
        const d = Math.hypot(p.x - this.pointer.x, p.y - this.pointer.y);
        if (d < bestD) {
          bestD = d;
          hover = s.pilot;
          hoverX = p.x;
          hoverY = p.y;
        }
      }
    }
    this.hover = hover;

    // effective highlight: hovered pilot wins, else the followed pilot
    const eff = hover >= 0 ? hover : this.follow;
    this.scene.setHighlight(eff);

    if (eff >= 0 && samples[eff]?.active) {
      const s = samples[eff];
      // reuse the projection from the picking loop when the hovered pilot won
      const p = eff === hover ? { x: hoverX, y: hoverY } : this.backend.projectToScreen(s.x, s.y, s.z);
      this.cb.onHover?.({
        pilotIdx: eff,
        name: s.name,
        altMsl: s.altMsl,
        climb: s.climb,
        screenX: p.x,
        screenY: p.y,
      });
    } else {
      this.cb.onHover?.(null);
    }
  }

  // --- input ---------------------------------------------------------------

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.container.getBoundingClientRect();
    this.pointer.x = e.clientX - rect.left;
    this.pointer.y = e.clientY - rect.top;
    this.pointer.inside = true;
  };
  private onPointerLeave = (): void => {
    this.pointer.inside = false;
  };
  private onResize = (): void => this.backend.resize();

  // --- public controls -----------------------------------------------------

  setTime(t: number): void {
    this.time = Math.max(0, Math.min(this.duration, t));
    this.scene?.setTime(this.time);
    this.cb.onTime?.(this.time);
  }
  get currentTime(): number {
    return this.time;
  }
  /** Number of gaggle episodes detected across the task. */
  get gaggleCount(): number {
    return this.gaggles?.episodes.length ?? 0;
  }
  /** The full gaggle detection result (episodes + params), if any. */
  get gaggleResult(): GaggleResult | undefined {
    return this.gaggles;
  }
  get totalDuration(): number {
    return this.duration;
  }
  get isPlaying(): boolean {
    return this.playing;
  }

  setPlaying(p: boolean): void {
    if (p && this.time >= this.duration) this.time = 0;
    this.playing = p;
    this.lastFrame = performance.now();
    this.cb.onPlayState?.(p);
  }
  togglePlay(): void {
    this.setPlaying(!this.playing);
  }
  setSpeed(x: number): void {
    this.speed = x;
  }

  setVScale(v: number): void {
    this.vScale = v;
    this.scene.setVScale(v);
    this.backend.setVScale(v);
  }
  setColorMode(mode: ColorMode): void {
    this.colorMode = mode;
    this.scene.setColorMode(mode);
  }
  /** Basemap style for the terrain backdrop; remembered across backdrop switches. */
  setMapStyle(url: string): void {
    this.mapStyle = url;
    this.backend.setMapStyle?.(url);
  }
  get currentMapStyle(): string {
    return this.mapStyle;
  }
  setTailSeconds(s: number): void {
    this.tailSeconds = s;
    this.scene.setTailSeconds(s);
  }
  setTrailWidth(px: number): void {
    this.trailWidth = px;
    this.scene.setWidth(px);
  }
  setPilotVisible(idx: number, visible: boolean): void {
    this.visibility[idx] = visible;
    this.scene.setVisible(idx, visible);
  }
  setHighlight(idx: number): void {
    this.scene.setHighlight(idx);
  }
  setFollow(idx: number): void {
    this.follow = idx;
    this.followGaggleId = -1;
    if (idx < 0) this.backend.followTo(null);
  }

  /** Follow a gaggle by its live centroid (-1 = stop). Overrides pilot follow. */
  setFollowGaggle(id: number): void {
    this.followGaggleId = id;
    this.follow = -1;
    if (id < 0) this.backend.followTo(null);
  }

  /** Show/hide the in-scene gaggle blobs. */
  setGaggleVisible(visible: boolean): void {
    this.gaggleVisible = visible;
    this.scene.setGaggleVisible(visible);
  }

  /** Emphasise one gaggle (others dimmed); -1 clears. */
  setGaggleHighlight(id: number): void {
    this.gaggleHighlight = id;
    this.scene.setGaggleHighlight(id);
  }

  /** Re-run detection with new params (dev tuning) and rebuild the blob layer. */
  recomputeGaggles(params: Partial<GaggleParams>): GaggleResult {
    const base = this.gaggles?.params ?? undefined;
    this.gaggles = detectGaggles(this.tracks, { ...(base as GaggleParams), ...params });
    this.scene.setGaggles(this.gaggles);
    this.applySceneState();
    return this.gaggles;
  }

  /** Synthetic marker sample at the followed gaggle's live centroid, or null. */
  private gaggleCentroid(samples: MarkerSample[]): MarkerSample | null {
    if (!this.gaggles) return null;
    const active = gagglesAt(this.gaggles, this.time);
    const g = active.find((a) => a.id === this.followGaggleId);
    if (!g) return null;
    let x = 0;
    let y = 0;
    let z = 0;
    let n = 0;
    for (const m of g.members) {
      const s = samples[m];
      if (!s?.active || s.landed) continue;
      x += s.x;
      y += s.y;
      z += s.z;
      n++;
    }
    if (n === 0) return null;
    return {
      pilot: -1,
      active: true,
      landed: false,
      x: x / n,
      y: y / n,
      z: z / n,
      altMsl: 0,
      climb: 0,
      name: '',
    };
  }

  resetCamera(): void {
    this.follow = -1;
    this.followGaggleId = -1;
    this.backend.resetCamera();
  }
  /** Orientation presets — keep any active follow, just change the view angle. */
  faceNorth(): void {
    this.backend.faceNorth();
  }
  topView(): void {
    this.backend.topView();
  }
  sideView(): void {
    this.backend.sideView();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.container.removeEventListener('pointermove', this.onPointerMove);
    this.container.removeEventListener('pointerleave', this.onPointerLeave);
    window.removeEventListener('resize', this.onResize);
    this.backend?.dispose();
    this.scene?.dispose();
  }
}
