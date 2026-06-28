// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Mapbox style options for the terrain backdrop. Kept in its own module (no
 * mapbox-gl import) so the UI can list styles without pulling the heavy
 * mapbox-gl chunk into the initial bundle — only terrain-backend.ts does that,
 * lazily.
 *
 * Ordered cleanest-first: plain Satellite (no road/label clutter) is the default
 * because satellite-streets reads as very noisy under colourful trails.
 */

export interface MapStyleOption {
  id: string;
  name: string;
  url: string;
}

export const MAP_STYLES: MapStyleOption[] = [
  { id: 'satellite', name: 'Satellite', url: 'mapbox://styles/mapbox/satellite-v9' },
  { id: 'outdoors', name: 'Outdoors', url: 'mapbox://styles/mapbox/outdoors-v12' },
  { id: 'dark', name: 'Dark', url: 'mapbox://styles/mapbox/dark-v11' },
  { id: 'light', name: 'Light', url: 'mapbox://styles/mapbox/light-v11' },
  { id: 'satellite-streets', name: 'Satellite + labels', url: 'mapbox://styles/mapbox/satellite-streets-v12' },
];

export const DEFAULT_MAP_STYLE = MAP_STYLES[0];
