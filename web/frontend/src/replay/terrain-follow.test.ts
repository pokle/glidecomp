// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * followTo gesture-yield logic on the terrain backend (unit-level; mapbox-gl
 * is mocked — the real map can't run headless). Guards the phone bug where
 * per-frame setCenter — whose implicit stop() cancels Mapbox's gesture
 * handlers — made touch pan/orbit impossible while following a pilot.
 */

import { describe, expect, it, mock } from 'bun:test';
import type { MarkerSample } from './flight-scene';

mock.module('mapbox-gl', () => ({}));
mock.module('mapbox-gl/dist/mapbox-gl.css', () => ({}));

const { TerrainBackend } = await import('./terrain-backend');

const LAT0 = -30;
const LON0 = 10;
const M_PER_DEG = 100_000; // round numbers: 100 m of ENU = 0.001°

interface Hooks {
  onContainerPointerDown(): void;
  onWindowPointerUp(): void;
}

function makeBackend() {
  const calls: [number, number][] = [];
  const fakeMap = {
    easing: false,
    zooming: false,
    getCenter: () => ({ lng: LON0, lat: LAT0 }),
    setCenter: (c: [number, number]) => calls.push(c),
    isEasing: () => fakeMap.easing,
    isZooming: () => fakeMap.zooming,
  };
  const manifest = {
    origin: { lat0: LAT0, lon0: LON0, alt0: 0 },
    mPerDegLat: M_PER_DEG,
    mPerDegLon: M_PER_DEG,
  };
  const backend = new TerrainBackend({} as HTMLElement, {} as never, manifest as never, '', '');
  (backend as unknown as { map: unknown }).map = fakeMap;
  return { backend, hooks: backend as unknown as Hooks, fakeMap, calls };
}

const sample = (x: number, z: number, over: Partial<MarkerSample> = {}): MarkerSample => ({
  pilot: 0,
  active: true,
  landed: false,
  x,
  y: 500,
  z,
  altMsl: 500,
  climb: 0,
  speed: 0,
  climbInst: 0,
  name: 'T',
  ...over,
});

describe('TerrainBackend.followTo', () => {
  it('anchors on the first frame, then pans by the pilot delta', () => {
    const { backend, calls } = makeBackend();
    backend.followTo(sample(0, 0));
    expect(calls).toHaveLength(0); // anchor only — no jump on follow start
    backend.followTo(sample(100, -100)); // 100 m E, 100 m N
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeCloseTo(LON0 + 0.001, 9);
    expect(calls[0][1]).toBeCloseTo(LAT0 + 0.001, 9);
  });

  it('does not call setCenter at all when the pilot has not moved (paused)', () => {
    const { backend, calls } = makeBackend();
    backend.followTo(sample(0, 0));
    backend.followTo(sample(0, 0));
    backend.followTo(sample(0, 0));
    expect(calls).toHaveLength(0); // setCenter's stop() would cancel gestures
  });

  it('yields while a pointer gesture is active, then resumes without a jump', () => {
    const { backend, hooks, calls } = makeBackend();
    backend.followTo(sample(0, 0));
    hooks.onContainerPointerDown(); // finger down
    backend.followTo(sample(100, 0));
    backend.followTo(sample(300, 0));
    expect(calls).toHaveLength(0); // gesture untouched
    hooks.onWindowPointerUp(); // finger up
    backend.followTo(sample(400, 0));
    // only the post-gesture delta (100 m), not the accumulated 400 m
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBeCloseTo(LON0 + 0.001, 9);
    expect(calls[0][1]).toBeCloseTo(LAT0, 9);
  });

  it('yields while the map is easing (orientation presets)', () => {
    const { backend, fakeMap, calls } = makeBackend();
    backend.followTo(sample(0, 0));
    fakeMap.easing = true;
    backend.followTo(sample(100, 0));
    expect(calls).toHaveLength(0);
    fakeMap.easing = false;
    backend.followTo(sample(200, 0));
    expect(calls).toHaveLength(1); // resumed with just the new delta
    expect(calls[0][0]).toBeCloseTo(LON0 + 0.001, 9);
  });

  it('yields while a scroll/trackpad pinch-zoom is in progress (no pointerdown fires for wheel gestures)', () => {
    const { backend, fakeMap, calls } = makeBackend();
    backend.followTo(sample(0, 0));
    fakeMap.zooming = true;
    backend.followTo(sample(100, 0));
    expect(calls).toHaveLength(0); // zoom gesture untouched
    fakeMap.zooming = false;
    backend.followTo(sample(200, 0));
    expect(calls).toHaveLength(1); // resumed with just the new delta
    expect(calls[0][0]).toBeCloseTo(LON0 + 0.001, 9);
  });

  it('a second finger landing mid-gesture keeps the follow yielded until both lift', () => {
    const { backend, hooks, calls } = makeBackend();
    backend.followTo(sample(0, 0));
    hooks.onContainerPointerDown();
    hooks.onContainerPointerDown(); // two-finger orbit/pinch
    hooks.onWindowPointerUp();
    backend.followTo(sample(100, 0));
    expect(calls).toHaveLength(0); // one finger still down
    hooks.onWindowPointerUp();
    backend.followTo(sample(200, 0));
    expect(calls).toHaveLength(1);
  });

  it('re-anchors (no jump) after the followed pilot changes or follow stops', () => {
    const { backend, calls } = makeBackend();
    backend.followTo(sample(0, 0));
    backend.followTo(null); // stop
    backend.followTo(sample(500, 0)); // restart → anchor only
    expect(calls).toHaveLength(0);
    backend.followTo(sample(600, 0, { pilot: 1 })); // new pilot → anchor only
    expect(calls).toHaveLength(0);
    backend.followTo(sample(700, 0, { pilot: 1 }));
    expect(calls).toHaveLength(1);
  });
});
