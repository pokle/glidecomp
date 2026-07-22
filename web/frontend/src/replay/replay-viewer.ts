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

/**
 * Fixed flight-time window (seconds) for the averaged climb/speed metrics,
 * independent of playback speed — a "20 s average climb" means the same thing
 * at 1× and 240×, which is what you want for judging how a thermal is going.
 * The UI labels the readout with this value ("20s avg").
 */
export const METRIC_AVG_SECONDS = 20;

export interface HoverInfo {
  pilotIdx: number;
  name: string;
  altMsl: number;
  climb: number;
  speed: number;
  screenX: number;
  screenY: number;
}

/**
 * One pilot's state for this frame, projected to container px — the feed for
 * DOM overlays (rank badges on the cones, the metrics callout). The array is
 * reused across frames; consumers must not hold references between frames.
 */
export interface PilotScreenSample {
  pilot: number;
  /** Has a position now (launched) and is not hidden via the legend. */
  active: boolean;
  landed: boolean;
  /** Container-relative px of the marker cone. */
  screenX: number;
  screenY: number;
  /** False when the marker projects off-screen / behind the camera. */
  onScreen: boolean;
  altMsl: number;
  /** Climb averaged over the fixed METRIC_AVG_SECONDS window, m/s. */
  climb: number;
  /** Ground speed averaged over the same window, m/s. */
  speed: number;
  /** Near-instantaneous climb (±3-fix window), m/s — the gauge needle. */
  climbInst: number;
  /** ENU position (metres from the manifest origin; East = +X, North = -Z),
   * un-exaggerated — for geo lookups like the required-glide readout. */
  worldX: number;
  worldZ: number;
}

export interface ViewerCallbacks {
  onTime?(tRel: number): void;
  onPlayState?(playing: boolean): void;
  onHover?(info: HoverInfo | null): void;
  /** Fires every frame with all pilots' projected positions + live metrics. */
  onFrame?(samples: readonly PilotScreenSample[]): void;
  /**
   * Fires when the user clicks (not drags) the canvas: the picked pilot's
   * index, or -1 when the click landed away from every marker cone.
   */
  onPick?(pilotIdx: number): void;
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
  private colorMode: ColorMode = 'vario';
  private tailSeconds = 600; // 10 min comet tail by default
  private trailWidth = 3; // CSS px
  private mapStyle = DEFAULT_MAP_STYLE.url;
  private mapDesaturate = 0;
  private mapFadeWhite = 0;
  /** UI theme; the scene only follows it on the abstract backdrop (the
   * terrain backdrop's colours come from the map imagery, not the theme). */
  private lightTheme = false;
  private visibility!: boolean[];
  private follow = -1;
  /** Gaggle id being followed by its live centroid (-1 = none). */
  private followGaggleId = -1;
  private gaggleVisible = true;
  private gaggleHighlight = -1;

  // picking
  private pointer = { x: 0, y: 0, inside: false };
  private hover = -1;
  /** pointerdown position for click-vs-drag discrimination (null = no press). */
  private press: { x: number; y: number } | null = null;

  /** Reused per-frame screen-space samples (one per pilot) for DOM overlays. */
  private screenSamples: PilotScreenSample[] = [];

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
    this.screenSamples = this.tracks.manifest.pilots.map((_, i) => ({
      pilot: i,
      active: false,
      landed: false,
      screenX: 0,
      screenY: 0,
      onScreen: false,
      altMsl: 0,
      climb: 0,
      speed: 0,
      climbInst: 0,
      worldX: 0,
      worldZ: 0,
    }));

    this.scene = new FlightScene(this.tracks, this.gaggles, this.sceneLight('abstract'));
    this.applySceneState();
    this.backend = await this.makeBackend('abstract');
    this.backend.setVScale(this.vScale);
    await this.backend.mount();

    this.container.addEventListener('pointermove', this.onPointerMove);
    this.container.addEventListener('pointerleave', this.onPointerLeave);
    this.container.addEventListener('pointerdown', this.onPointerDown);
    this.container.addEventListener('pointerup', this.onPointerUp);
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
    await this.rebuild(mode);
  }

  /**
   * Set the UI theme. The in-scene furniture (background, grid, ground labels,
   * vario-ramp zero) follows it only on the abstract backdrop, which is
   * rebuilt in place; on terrain nothing in-scene changes.
   */
  async setLightTheme(light: boolean): Promise<void> {
    if (light === this.lightTheme) return;
    this.lightTheme = light;
    // Before load (no scene yet) init() picks the flag up; mid-switch skip.
    if (!this.scene || this.switching) return;
    if (this.backdrop === 'abstract') await this.rebuild('abstract');
  }

  /** Whether the in-scene furniture should be light-themed for `mode`. */
  private sceneLight(mode: Backdrop): boolean {
    return this.lightTheme && mode === 'abstract';
  }

  /**
   * Re-bake the map's baked-text labels (turnpoint name + altitude planes) —
   * call when the altitude unit changes, so the ground text follows it.
   */
  refreshMapLabels(): void {
    if (!this.scene || this.switching) return;
    this.scene.refreshTurnpointLabels();
  }

  /** Dispose and rebuild the scene + backend for `mode`, re-applying view state. */
  private async rebuild(mode: Backdrop): Promise<void> {
    this.switching = true;
    try {
      // Hand the camera pose over so switching backdrop (or theme) keeps
      // visual continuity instead of snapping to each backend's default frame.
      const view = this.backend.getViewState();
      this.backend.dispose();
      this.scene.dispose();

      this.scene = new FlightScene(this.tracks, this.gaggles, this.sceneLight(mode));
      this.applySceneState();
      this.backend = await this.makeBackend(mode);
      this.backend.setInitialView(view);
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
      return new TerrainBackend(
        this.container,
        this.scene,
        this.tracks.manifest,
        this.mapboxToken,
        this.mapStyle,
        this.mapDesaturate,
        this.mapFadeWhite,
      );
    }
    return new AbstractBackend(this.container, this.scene, this.sceneLight(mode));
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
    const samples = this.scene.updateMarkers(this.time, METRIC_AVG_SECONDS);

    if (this.followGaggleId >= 0) this.backend.followTo(this.gaggleCentroid(samples));
    else if (this.follow >= 0) this.backend.followTo(samples[this.follow]);
    this.backend.render();

    this.projectSamples(samples);
    this.updatePicking(samples);
    this.cb.onFrame?.(this.screenSamples);
    this.cb.onScale?.(this.backend.getMetresPerPixel());
    this.cb.onCompass?.(this.backend.getBearingDeg());
  }

  /** Project every pilot's marker into the reused screen-sample array. */
  private projectSamples(samples: MarkerSample[]): void {
    for (const s of samples) {
      const out = this.screenSamples[s.pilot];
      out.active = s.active && this.visibility[s.pilot];
      out.landed = s.landed;
      out.altMsl = s.altMsl;
      out.climb = s.climb;
      out.speed = s.speed;
      out.climbInst = s.climbInst;
      out.worldX = s.x;
      out.worldZ = s.z;
      if (!out.active) {
        out.onScreen = false;
        continue;
      }
      const p = this.backend.projectToScreen(s.x, s.y, s.z);
      out.screenX = p.x;
      out.screenY = p.y;
      out.onScreen = p.visible;
    }
  }

  /** Nearest on-screen marker within `radius` px of (px, py), or -1. */
  private pickAt(px: number, py: number, radius: number): number {
    let best = -1;
    let bestD = radius;
    for (const s of this.screenSamples) {
      if (!s.active || !s.onScreen) continue;
      const d = Math.hypot(s.screenX - px, s.screenY - py);
      if (d < bestD) {
        bestD = d;
        best = s.pilot;
      }
    }
    return best;
  }

  private updatePicking(samples: MarkerSample[]): void {
    const hover = this.pointer.inside ? this.pickAt(this.pointer.x, this.pointer.y, 20) : -1;
    this.hover = hover;

    // effective highlight: hovered pilot wins, else the followed pilot
    const eff = hover >= 0 ? hover : this.follow;
    this.scene.setHighlight(eff);

    if (eff >= 0 && samples[eff]?.active && this.screenSamples[eff].active) {
      const s = samples[eff];
      const p = this.screenSamples[eff];
      this.cb.onHover?.({
        pilotIdx: eff,
        name: s.name,
        altMsl: s.altMsl,
        climb: s.climb,
        speed: s.speed,
        screenX: p.screenX,
        screenY: p.screenY,
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
  /**
   * Click detection: a primary-pointer press that releases within a few px
   * (i.e. not a camera pan/orbit drag, not a multi-touch gesture) reports the
   * nearest marker cone under the cursor — or -1 for a background click.
   */
  private onPointerDown = (e: PointerEvent): void => {
    if (!e.isPrimary) {
      this.press = null; // a second finger landed — this is a gesture, not a click
      return;
    }
    const rect = this.container.getBoundingClientRect();
    this.press = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  private onPointerUp = (e: PointerEvent): void => {
    const press = this.press;
    this.press = null;
    if (!press || !e.isPrimary) return;
    const rect = this.container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    if (Math.hypot(x - press.x, y - press.y) > 5) return; // it was a drag
    this.cb.onPick?.(this.pickAt(x, y, 20));
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
  /** Basemap desaturation for the terrain backdrop; remembered across backdrop switches. */
  setMapDesaturate(v: number): void {
    this.mapDesaturate = v;
    this.backend.setMapDesaturate?.(v);
  }
  get currentMapDesaturate(): number {
    return this.mapDesaturate;
  }
  /** Basemap fade-to-white for the terrain backdrop; remembered across backdrop switches. */
  setMapFadeWhite(v: number): void {
    this.mapFadeWhite = v;
    this.backend.setMapFadeWhite?.(v);
  }
  get currentMapFadeWhite(): number {
    return this.mapFadeWhite;
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
      speed: 0,
      climbInst: 0,
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
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('resize', this.onResize);
    this.backend?.dispose();
    this.scene?.dispose();
  }
}
