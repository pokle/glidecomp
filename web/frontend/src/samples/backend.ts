// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * A render backend hosts a FlightScene and owns the camera + ground.
 * Two implementations: the standalone abstract view (its own WebGL canvas +
 * OrbitControls) and the Mapbox terrain view (a custom 3D layer).
 *
 * The orchestrator (ReplayViewer) drives time/markers and asks the active
 * backend to draw, project markers for picking, follow a pilot, and report the
 * scale-bar / compass values.
 */

import type { MarkerSample } from './flight-scene';

export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

export interface Backend {
  /** Async because the terrain backend must wait for the map style to load. */
  mount(): Promise<void>;
  /** Draw the current scene state. */
  render(): void;
  /** Frame the whole task. */
  resetCamera(): void;
  /** Re-centre on a pilot (null = stop following). */
  followTo(sample: MarkerSample | null): void;
  /** Project a local ENU point (y already exaggerated) to container px. */
  projectToScreen(x: number, y: number, z: number): ScreenPoint;
  /** Metres per pixel at the view centre (for the scale bar). */
  getMetresPerPixel(): number;
  /** Map/camera bearing in degrees, for the compass. */
  getBearingDeg(): number;
  /** Keep vertical exaggeration in sync (terrain also drives map terrain). */
  setVScale(v: number): void;
  /** Change the basemap style (terrain only; no-op elsewhere). */
  setMapStyle?(url: string): void;
  resize(): void;
  dispose(): void;
}
