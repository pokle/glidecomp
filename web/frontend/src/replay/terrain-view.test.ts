// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * ViewState handover math on the terrain backend (unit-level; mapbox-gl is
 * mocked). applyView must be the exact inverse of getViewState so switching
 * abstract ↔ map keeps the camera pose (look-at, bearing, pitch, scale).
 */

import { describe, expect, it, mock } from 'bun:test';
import type { ViewState } from './backend';

mock.module('mapbox-gl', () => ({}));
mock.module('mapbox-gl/dist/mapbox-gl.css', () => ({}));

const { TerrainBackend } = await import('./terrain-backend');

const LAT0 = -36.2;
const LON0 = 147.9;
const M_PER_DEG = 100_000;

interface JumpArgs {
  center: [number, number];
  bearing: number;
  pitch: number;
  zoom: number;
}

function makeBackend() {
  const state: JumpArgs = { center: [LON0, LAT0], bearing: 0, pitch: 0, zoom: 9 };
  const fakeMap = {
    jumpTo: (o: JumpArgs) => Object.assign(state, o),
    getCenter: () => ({ lng: state.center[0], lat: state.center[1] }),
    getZoom: () => state.zoom,
    getBearing: () => state.bearing,
    getPitch: () => state.pitch,
  };
  const manifest = {
    origin: { lat0: LAT0, lon0: LON0, alt0: 0 },
    mPerDegLat: M_PER_DEG,
    mPerDegLon: M_PER_DEG,
  };
  const backend = new TerrainBackend({} as HTMLElement, {} as never, manifest as never, '', '');
  (backend as unknown as { map: unknown }).map = fakeMap;
  return { backend, apply: (v: ViewState) => (backend as unknown as { applyView(v: ViewState): void }).applyView(v), state };
}

describe('TerrainBackend view handover', () => {
  it('applyView → getViewState round-trips the pose', () => {
    const { backend, apply } = makeBackend();
    const vIn: ViewState = { x: 5000, y: 0, z: -8000, bearingDeg: 42, pitchDeg: 60, mpp: 12 };
    apply(vIn);
    const out = backend.getViewState();
    expect(out.x).toBeCloseTo(vIn.x, 3);
    expect(out.z).toBeCloseTo(vIn.z, 3);
    expect(out.bearingDeg).toBeCloseTo(42, 6);
    expect(out.pitchDeg).toBeCloseTo(60, 6);
    expect(out.mpp).toBeCloseTo(12, 6); // zoom ↔ mpp are exact inverses
    expect(out.y).toBe(0);
  });

  it('clamps pitch to the Mapbox maximum (85°)', () => {
    const { apply, state } = makeBackend();
    apply({ x: 0, y: 0, z: 0, bearingDeg: 0, pitchDeg: 89, mpp: 10 });
    expect(state.pitch).toBe(85);
  });

  it('zoom accounts for latitude (mercator: same mpp → lower zoom number at higher latitude)', () => {
    const { apply, state } = makeBackend();
    apply({ x: 0, y: 0, z: 0, bearingDeg: 0, pitchDeg: 45, mpp: 10 });
    const zNearer = state.zoom;
    // 10° of ENU south = 10° further from the equator (LAT0 is already south)
    apply({ x: 0, y: 0, z: 10 * M_PER_DEG, bearingDeg: 0, pitchDeg: 45, mpp: 10 });
    expect(state.zoom).toBeLessThan(zNearer); // cos(lat) shrinks toward the poles
  });
});
