/**
 * Map Style Selector Control for MapLibre GL JS
 *
 * Provides a UI widget to switch between different map styles:
 * - OpenStreetMap
 * - Satellite (Esri)
 * - Terrain (OpenTopoMap)
 * - Dark (CartoDB Dark Matter)
 */

import maplibregl from 'maplibre-gl';

export interface MapStyle {
  id: string;
  name: string;
  icon: string;
  style: maplibregl.StyleSpecification;
}

/**
 * Base terrain/hillshade sources that get added to all styles
 */
const terrainSources = {
  'terrain-dem': {
    type: 'raster-dem' as const,
    url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
    tileSize: 256,
  },
  'hillshade-dem': {
    type: 'raster-dem' as const,
    url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json',
    tileSize: 256,
  },
};

/**
 * Hillshade layer configuration
 */
const hillshadeLayer: maplibregl.LayerSpecification = {
  id: 'hillshade',
  type: 'hillshade',
  source: 'hillshade-dem',
  paint: {
    'hillshade-illumination-direction': 315,
    'hillshade-exaggeration': 0.5,
    'hillshade-shadow-color': '#473B24',
    'hillshade-highlight-color': '#FFFFFF',
    'hillshade-accent-color': '#5a5a5a',
  },
};

/**
 * Available map styles
 */
export const MAP_STYLES: MapStyle[] = [
  {
    id: 'osm',
    name: 'Streets',
    icon: '🗺️',
    style: {
      version: 8,
      sources: {
        'osm-tiles': {
          type: 'raster',
          tiles: [
            'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://b.tile.openstreetmap.org/{z}/{x}/{y}.png',
            'https://c.tile.openstreetmap.org/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        },
        ...terrainSources,
      },
      layers: [
        {
          id: 'osm-layer',
          type: 'raster',
          source: 'osm-tiles',
          minzoom: 0,
          maxzoom: 19,
        },
        hillshadeLayer,
      ],
      terrain: {
        source: 'terrain-dem',
        exaggeration: 1,
      },
      sky: {},
    },
  },
  {
    id: 'satellite',
    name: 'Satellite',
    icon: '🛰️',
    style: {
      version: 8,
      sources: {
        'satellite-tiles': {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          attribution: '&copy; Esri, Maxar, Earthstar Geographics',
        },
        ...terrainSources,
      },
      layers: [
        {
          id: 'satellite-layer',
          type: 'raster',
          source: 'satellite-tiles',
          minzoom: 0,
          maxzoom: 19,
        },
        hillshadeLayer,
      ],
      terrain: {
        source: 'terrain-dem',
        exaggeration: 1,
      },
      sky: {},
    },
  },
  {
    id: 'topo',
    name: 'Topo',
    icon: '⛰️',
    style: {
      version: 8,
      sources: {
        'topo-tiles': {
          type: 'raster',
          tiles: [
            'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
            'https://b.tile.opentopomap.org/{z}/{x}/{y}.png',
            'https://c.tile.opentopomap.org/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
        },
        ...terrainSources,
      },
      layers: [
        {
          id: 'topo-layer',
          type: 'raster',
          source: 'topo-tiles',
          minzoom: 0,
          maxzoom: 17,
        },
        hillshadeLayer,
      ],
      terrain: {
        source: 'terrain-dem',
        exaggeration: 1,
      },
      sky: {},
    },
  },
  {
    id: 'dark',
    name: 'Dark',
    icon: '🌙',
    style: {
      version: 8,
      sources: {
        'dark-tiles': {
          type: 'raster',
          tiles: [
            'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
            'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png',
          ],
          tileSize: 256,
          attribution: '&copy; <a href="https://carto.com/">CARTO</a>',
        },
        ...terrainSources,
      },
      layers: [
        {
          id: 'dark-layer',
          type: 'raster',
          source: 'dark-tiles',
          minzoom: 0,
          maxzoom: 19,
        },
        {
          ...hillshadeLayer,
          paint: {
            ...hillshadeLayer.paint,
            'hillshade-shadow-color': '#000000',
            'hillshade-highlight-color': '#333333',
            'hillshade-accent-color': '#222222',
          },
        } as maplibregl.LayerSpecification,
      ],
      terrain: {
        source: 'terrain-dem',
        exaggeration: 1,
      },
      sky: {},
    },
  },
];

/**
 * Custom MapLibre control for style selection
 */
export class StyleSelectorControl implements maplibregl.IControl {
  private container: HTMLElement | null = null;
  private map: maplibregl.Map | null = null;
  private currentStyleId: string = 'osm';
  private onStyleChange: ((styleId: string) => void) | null = null;

  constructor(onStyleChange?: (styleId: string) => void) {
    this.onStyleChange = onStyleChange || null;
  }

  onAdd(map: maplibregl.Map): HTMLElement {
    this.map = map;

    this.container = document.createElement('div');
    this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group style-selector';

    // Create button for each style
    for (const style of MAP_STYLES) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'style-selector-btn';
      button.dataset.styleId = style.id;
      button.title = style.name;
      button.innerHTML = `<span class="style-icon">${style.icon}</span>`;

      if (style.id === this.currentStyleId) {
        button.classList.add('active');
      }

      button.addEventListener('click', () => {
        this.selectStyle(style.id);
      });

      this.container.appendChild(button);
    }

    return this.container;
  }

  onRemove(): void {
    this.container?.parentNode?.removeChild(this.container);
    this.map = null;
  }

  selectStyle(styleId: string): void {
    const style = MAP_STYLES.find(s => s.id === styleId);
    if (!style || !this.map) return;

    this.currentStyleId = styleId;

    // Update button states
    this.container?.querySelectorAll('.style-selector-btn').forEach(btn => {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.styleId === styleId);
    });

    // Notify callback
    if (this.onStyleChange) {
      this.onStyleChange(styleId);
    }
  }

  getCurrentStyleId(): string {
    return this.currentStyleId;
  }
}

/**
 * Get a style specification by ID
 */
export function getStyleById(styleId: string): maplibregl.StyleSpecification | null {
  const style = MAP_STYLES.find(s => s.id === styleId);
  return style?.style || null;
}
