// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * TerrainBackend — hosts the shared FlightScene over a Mapbox GL terrain map
 * via a raw custom 3D layer (no Threebox, so our uTime ShaderMaterial is reused
 * verbatim). Lazy-loaded so mapbox-gl is only fetched when the user picks the
 * terrain backdrop.
 *
 * Coordinate bridge: the FlightScene works in local ENU metres (X=East, Y=Up,
 * Z=South — North = -Z). The custom layer's render gives us Mapbox's mercator
 * view-projection matrix; we left-multiply a model matrix that maps local → mercator:
 *
 *   mercator.x = originMerc.x + xE * s
 *   mercator.y = originMerc.y + zS * s        (local +Z is south; mercator Y is south)
 *   mercator.z = alt0*vScale*s + yUp * s      (yUp already ×vScale in the scene)
 *
 * where s = metres→mercator at the origin. Because the scene already applies the
 * vertical exaggeration (shader/markers/walls), the model matrix uses a uniform
 * s (cones stay undistorted); the only exaggeration baked here is the constant
 * alt0 offset, and `map.setTerrain({exaggeration})` is kept equal to vScale so
 * tracks and terrain share one vertical scale.
 */

import * as mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import * as THREE from 'three';
import type { TrackManifest } from '@glidecomp/engine';
import type { Backend, ScreenPoint } from './backend';
import type { FlightScene, MarkerSample } from './flight-scene';

export class TerrainBackend implements Backend {
  private map!: mapboxgl.Map;
  private renderer3?: THREE.WebGLRenderer;
  private camera3 = new THREE.Camera();
  private scene3 = new THREE.Scene();

  private originMerc!: mapboxgl.MercatorCoordinate;
  private s = 1;
  private vScale = 3;
  private firstLoad = true;
  // follow: shift the map by the pilot's movement so the user can still drag/rotate/zoom.
  private followPilot = -1;
  private followLngLat: [number, number] | null = null;
  private readonly combined = new THREE.Matrix4();
  private readonly model = new THREE.Matrix4(); // local→mercator; rebuilt only on vScale change

  constructor(
    private container: HTMLElement,
    private flight: FlightScene,
    private manifest: TrackManifest,
    private token: string,
    private style: string,
  ) {}

  mount(): Promise<void> {
    const { lat0, lon0 } = this.manifest.origin;
    this.originMerc = mapboxgl.MercatorCoordinate.fromLngLat([lon0, lat0], 0);
    this.s = this.originMerc.meterInMercatorCoordinateUnits();
    this.rebuildModel();

    return new Promise((resolve, reject) => {
      try {
        this.map = new mapboxgl.Map({
          container: this.container,
          accessToken: this.token,
          style: this.style,
          center: [lon0, lat0],
          zoom: 9.5,
          pitch: 60,
          bearing: 0,
          maxPitch: 85,
          antialias: true,
        });

        // Fires on initial load AND after every setStyle(); re-add terrain + the
        // custom layer each time (setStyle removes all sources/layers).
        this.map.on('style.load', () => {
          this.addTerrainAndLayers();
          if (this.firstLoad) {
            this.firstLoad = false;
            this.resetCamera();
            // Dev-only handle so headless tests can force a synchronous render
            // (the preview tab suspends rAF, so Mapbox never auto-paints).
            if (import.meta.env.DEV) {
              (window as unknown as { __terrainMap?: mapboxgl.Map }).__terrainMap = this.map;
            }
            resolve();
          }
        });
        this.map.on('error', (e) => console.warn('[terrain] map error', e?.error ?? e));
      } catch (err) {
        reject(err as Error);
      }
    });
  }

  /** (Re)add DEM terrain, sky, and the custom 3D track layer for the current style. */
  private addTerrainAndLayers(): void {
    if (!this.map.getSource('mapbox-dem')) {
      this.map.addSource('mapbox-dem', {
        type: 'raster-dem',
        url: 'mapbox://mapbox.mapbox-terrain-dem-v1',
        tileSize: 512,
        maxzoom: 14,
      });
    }
    this.map.setTerrain({ source: 'mapbox-dem', exaggeration: this.vScale });
    if (!this.map.getLayer('sky')) {
      this.map.addLayer({
        id: 'sky',
        type: 'sky',
        paint: {
          'sky-type': 'atmosphere',
          'sky-atmosphere-sun': [0, 90],
          'sky-atmosphere-sun-intensity': 15,
        },
      });
    }
    if (!this.map.getLayer('tracks-3d')) this.map.addLayer(this.customLayer());
  }

  setMapStyle(url: string): void {
    if (url === this.style || !this.map) return;
    this.style = url;
    // setStyle wipes sources/layers; the style.load handler re-adds them. The
    // shared GL context (and renderer3) survive, so the camera/scene persist.
    this.map.setStyle(url);
  }

  private customLayer(): mapboxgl.CustomLayerInterface {
    return {
      id: 'tracks-3d',
      type: 'custom',
      renderingMode: '3d',
      onAdd: (_map, gl) => {
        // Reuse the renderer across style switches (context persists); creating
        // it once avoids leaking a GL renderer per setStyle.
        if (!this.renderer3) {
          this.renderer3 = new THREE.WebGLRenderer({
            canvas: this.map.getCanvas(),
            context: gl,
            antialias: true,
          });
          this.renderer3.autoClear = false;
        }
        this.scene3.add(this.flight.group);
        this.scene3.add(this.flight.markers);
      },
      render: (_gl, matrix) => {
        if (!this.renderer3) return;
        this.combined.fromArray(matrix).multiply(this.model);
        this.camera3.projectionMatrix.copy(this.combined);
        this.renderer3.resetState();
        this.renderer3.render(this.scene3, this.camera3);
      },
    };
  }

  /** Recompute the cached local→mercator matrix (only origin/scale/vScale change it). */
  private rebuildModel(): void {
    if (!this.originMerc) return;
    const o = this.originMerc;
    const s = this.s;
    // row-major. Local frame is X=East, Y=Up, Z=South (North = -Z), so local +Z
    // maps to mercator +Y (south). This makes the model matrix a reflection
    // (det < 0) — positions stay correct, only chirality flips (the mercator
    // flip cancels it, so the labels look the same in both backends).
    this.model.set(
      s, 0, 0, o.x,
      0, 0, s, o.y,
      0, s, 0, this.manifest.origin.alt0 * this.vScale * s,
      0, 0, 0, 1,
    );
  }

  render(): void {
    this.map.triggerRepaint();
  }

  resetCamera(): void {
    this.followPilot = -1;
    this.followLngLat = null;
    const { minX, maxX, minZ, maxZ } = this.flight.bbox;
    const { lat0, lon0, mPerDegLat, mPerDegLon } = this.toGeoParams();
    // lat = lat0 - z/mPerDegLat (North = -Z): minZ is the northern edge, maxZ the southern.
    const bounds = new mapboxgl.LngLatBounds(
      [lon0 + minX / mPerDegLon, lat0 - maxZ / mPerDegLat],
      [lon0 + maxX / mPerDegLon, lat0 - minZ / mPerDegLat],
    );
    this.map.fitBounds(bounds, { padding: 80, bearing: 0, duration: 0 });
    this.map.easeTo({ pitch: 60, duration: 500 });
  }

  private toGeoParams() {
    return {
      lat0: this.manifest.origin.lat0,
      lon0: this.manifest.origin.lon0,
      mPerDegLat: this.manifest.mPerDegLat,
      mPerDegLon: this.manifest.mPerDegLon,
    };
  }

  faceNorth(): void { this.map.easeTo({ bearing: 0, duration: 500 }); }
  topView(): void { this.map.easeTo({ pitch: 0, bearing: 0, duration: 500 }); }
  sideView(): void { this.map.easeTo({ pitch: 85, duration: 500 }); }

  followTo(sample: MarkerSample | null): void {
    if (!sample) {
      this.followPilot = -1;
      this.followLngLat = null;
      return;
    }
    if (!sample.active) {
      this.followLngLat = null; // re-anchor (no jump) when the pilot resumes
      return;
    }
    const { lat0, lon0, mPerDegLat, mPerDegLon } = this.toGeoParams();
    const lng = lon0 + sample.x / mPerDegLon;
    const lat = lat0 - sample.z / mPerDegLat;
    if (sample.pilot !== this.followPilot || !this.followLngLat) {
      // anchor without moving the map: the pilot stays where it is on screen
      this.followPilot = sample.pilot;
      this.followLngLat = [lng, lat];
      return;
    }
    // pan the map by the pilot's movement since last frame; reading the live
    // centre first means any user drag/rotate/zoom is preserved.
    const c = this.map.getCenter();
    this.map.setCenter([c.lng + (lng - this.followLngLat[0]), c.lat + (lat - this.followLngLat[1])]);
    this.followLngLat = [lng, lat];
  }

  projectToScreen(x: number, y: number, z: number): ScreenPoint {
    const e = this.combined.elements;
    const cx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const cy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (cw <= 0) return { x: 0, y: 0, visible: false };
    return {
      x: (cx / cw * 0.5 + 0.5) * w,
      y: (-cy / cw * 0.5 + 0.5) * h,
      visible: true,
    };
  }

  getMetresPerPixel(): number {
    const lat = this.map.getCenter().lat;
    return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, this.map.getZoom() + 9);
  }

  getBearingDeg(): number {
    return this.map.getBearing();
  }

  setVScale(v: number): void {
    this.vScale = v;
    this.rebuildModel();
    if (this.map?.getTerrain()) {
      this.map.setTerrain({ source: 'mapbox-dem', exaggeration: v });
    }
  }

  resize(): void {
    this.map?.resize();
  }

  dispose(): void {
    // Detach shared objects before tearing down the map (which destroys the GL
    // context the renderer3 borrowed). Do NOT renderer3.dispose() afterwards —
    // the context is already gone (mirrors the Threebox-on-style-change rule).
    this.scene3.remove(this.flight.group);
    this.scene3.remove(this.flight.markers);
    this.map?.remove();
  }
}
