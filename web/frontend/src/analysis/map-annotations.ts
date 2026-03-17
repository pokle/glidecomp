/**
 * Map Annotation Layer
 *
 * Freehand drawing overlay for Mapbox GL maps.
 * Strokes are rendered as native Mapbox GeoJSON line layers so they sit
 * flat on the map surface (including terrain). Stored in IndexedDB.
 */

import type { Map as MapboxMap, GeoJSONSource } from 'mapbox-gl';
import { storage, type AnnotationStroke } from './storage';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AnnotationMode = 'draw' | 'erase';

export interface MapAnnotationLayer {
  setEnabled(enabled: boolean): void;
  setMode(mode: AnnotationMode): void;
  undo(): void;
  redo(): void;
  clearAll(): void;
  isEnabled(): boolean;
  getMode(): AnnotationMode;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STROKE_COLOR = '#e03131';
const STROKE_WIDTH = 3;
const ERASE_HIT_DISTANCE = 12; // px
const RDP_TOLERANCE = 2; // px — Ramer-Douglas-Peucker simplification

const SOURCE_STROKES = 'annotation-strokes';
const SOURCE_LIVE = 'annotation-live';
const LAYER_STROKES = 'annotation-strokes-layer';
const LAYER_LIVE = 'annotation-live-layer';

// ---------------------------------------------------------------------------
// Ramer-Douglas-Peucker line simplification
// ---------------------------------------------------------------------------

function perpendicularDistance(
  px: number, py: number,
  lx1: number, ly1: number,
  lx2: number, ly2: number,
): number {
  const dx = lx2 - lx1;
  const dy = ly2 - ly1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - lx1, py - ly1);
  const t = Math.max(0, Math.min(1, ((px - lx1) * dx + (py - ly1) * dy) / lenSq));
  return Math.hypot(px - (lx1 + t * dx), py - (ly1 + t * dy));
}

function simplifyRDP(points: [number, number][], tolerance: number): [number, number][] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(
      points[i][0], points[i][1],
      first[0], first[1],
      last[0], last[1],
    );
    if (d > maxDist) {
      maxDist = d;
      maxIdx = i;
    }
  }

  if (maxDist > tolerance) {
    const left = simplifyRDP(points.slice(0, maxIdx + 1), tolerance);
    const right = simplifyRDP(points.slice(maxIdx), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// ---------------------------------------------------------------------------
// Point-to-polyline distance (screen space, for eraser hit testing)
// ---------------------------------------------------------------------------

function distanceToPolyline(px: number, py: number, line: [number, number][]): number {
  let minDist = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const d = perpendicularDistance(
      px, py,
      line[i][0], line[i][1],
      line[i + 1][0], line[i + 1][1],
    );
    if (d < minDist) minDist = d;
  }
  return minDist;
}

// ---------------------------------------------------------------------------
// GeoJSON helpers
// ---------------------------------------------------------------------------

function strokesToGeoJSON(strokes: AnnotationStroke[]): GeoJSON.FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: strokes.map((s) => ({
      type: 'Feature' as const,
      properties: { id: s.id, color: s.color, width: s.width },
      geometry: {
        type: 'LineString' as const,
        coordinates: s.points, // [lng, lat]
      },
    })),
  };
}

function liveStrokeGeoJSON(points: [number, number][]): GeoJSON.FeatureCollection {
  if (points.length < 2) {
    return { type: 'FeatureCollection', features: [] };
  }
  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: points },
    }],
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMapAnnotationLayer(
  map: MapboxMap,
  container: HTMLElement,
): MapAnnotationLayer {
  // --- State ---
  let enabled = false;
  let mode: AnnotationMode = 'draw';
  let strokes: AnnotationStroke[] = [];
  let redoStack: AnnotationStroke[] = [];
  let drawing = false;
  let currentScreenPoints: [number, number][] = [];
  let currentGeoPoints: [number, number][] = [];
  let sourcesAdded = false;

  // --- Transparent input overlay (captures pointer events without blocking map visuals) ---
  const inputOverlay = document.createElement('div');
  inputOverlay.style.position = 'absolute';
  inputOverlay.style.top = '0';
  inputOverlay.style.left = '0';
  inputOverlay.style.width = '100%';
  inputOverlay.style.height = '100%';
  inputOverlay.style.pointerEvents = 'none';
  inputOverlay.style.zIndex = '10';
  container.appendChild(inputOverlay);

  // --- Mapbox sources & layers ---
  function ensureSourcesAndLayers() {
    if (sourcesAdded) return;

    if (!map.getSource(SOURCE_STROKES)) {
      map.addSource(SOURCE_STROKES, {
        type: 'geojson',
        data: strokesToGeoJSON(strokes),
      });
    }
    if (!map.getSource(SOURCE_LIVE)) {
      map.addSource(SOURCE_LIVE, {
        type: 'geojson',
        data: liveStrokeGeoJSON([]),
      });
    }

    if (!map.getLayer(LAYER_STROKES)) {
      map.addLayer({
        id: LAYER_STROKES,
        type: 'line',
        source: SOURCE_STROKES,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['get', 'width'],
          'line-opacity': 0.85,
        },
      });
    }

    if (!map.getLayer(LAYER_LIVE)) {
      map.addLayer({
        id: LAYER_LIVE,
        type: 'line',
        source: SOURCE_LIVE,
        layout: {
          'line-cap': 'round',
          'line-join': 'round',
        },
        paint: {
          'line-color': STROKE_COLOR,
          'line-width': STROKE_WIDTH,
          'line-opacity': 0.6,
        },
      });
    }

    sourcesAdded = true;
  }

  function updateStrokesSource() {
    const src = map.getSource(SOURCE_STROKES) as GeoJSONSource | undefined;
    if (src) src.setData(strokesToGeoJSON(strokes));
  }

  function updateLiveSource() {
    const src = map.getSource(SOURCE_LIVE) as GeoJSONSource | undefined;
    if (src) src.setData(liveStrokeGeoJSON(currentGeoPoints));
  }

  // Re-add sources/layers after style changes
  function onStyleLoad() {
    sourcesAdded = false;
    ensureSourcesAndLayers();
    updateStrokesSource();
  }
  map.on('style.load', onStyleLoad);

  // Add sources once map is ready
  if (map.isStyleLoaded()) {
    ensureSourcesAndLayers();
  } else {
    map.once('style.load', () => ensureSourcesAndLayers());
  }

  // --- Toolbar ---
  const toolbar = document.createElement('div');
  toolbar.style.cssText = `
    position: absolute; bottom: 36px; left: 10px; z-index: 11;
    display: none; align-items: center; gap: 2px;
    background: rgba(255,255,255,0.92); border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18); padding: 4px 6px;
    font-family: system-ui, sans-serif; font-size: 13px;
    user-select: none;
  `;
  toolbar.innerHTML = `
    <button data-ann-tool="draw" title="Draw (P)" style="cursor:pointer;border:none;background:none;padding:4px 8px;border-radius:6px;font-size:13px;">&#9998; Draw</button>
    <button data-ann-tool="erase" title="Erase (E)" style="cursor:pointer;border:none;background:none;padding:4px 8px;border-radius:6px;font-size:13px;">&#9003; Erase</button>
    <span style="width:1px;height:20px;background:#ccc;margin:0 4px;"></span>
    <button data-ann-tool="undo" title="Undo (Ctrl+Z)" style="cursor:pointer;border:none;background:none;padding:4px 8px;border-radius:6px;font-size:13px;">&#8630;</button>
    <button data-ann-tool="redo" title="Redo (Ctrl+Shift+Z)" style="cursor:pointer;border:none;background:none;padding:4px 8px;border-radius:6px;font-size:13px;">&#8631;</button>
    <span style="width:1px;height:20px;background:#ccc;margin:0 4px;"></span>
    <button data-ann-tool="clear" title="Clear all" style="cursor:pointer;border:none;background:none;padding:4px 8px;border-radius:6px;font-size:13px;color:#e03131;">&#128465;</button>
  `;
  container.appendChild(toolbar);

  // Toolbar click handling
  toolbar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-ann-tool]');
    if (!btn) return;
    const tool = btn.dataset.annTool;
    if (tool === 'draw') setMode('draw');
    else if (tool === 'erase') setMode('erase');
    else if (tool === 'undo') undo();
    else if (tool === 'redo') redo();
    else if (tool === 'clear') clearAll();
  });

  function updateToolbarHighlight() {
    toolbar.querySelectorAll<HTMLElement>('[data-ann-tool]').forEach((btn) => {
      const tool = btn.dataset.annTool;
      if (tool === 'draw' || tool === 'erase') {
        btn.style.background = tool === mode ? '#e8e8e8' : 'none';
        btn.style.fontWeight = tool === mode ? '600' : '400';
      }
    });
  }

  // --- Map interaction management ---
  const mapInteractions = ['dragPan', 'scrollZoom', 'doubleClickZoom', 'dragRotate', 'touchZoomRotate', 'keyboard'] as const;

  function disableMapInteractions() {
    for (const name of mapInteractions) {
      (map[name] as { disable(): void }).disable();
    }
  }

  function enableMapInteractions() {
    for (const name of mapInteractions) {
      (map[name] as { enable(): void }).enable();
    }
  }

  // --- Projection helpers ---
  function geoToScreen(lngLat: [number, number]): [number, number] {
    const p = map.project({ lng: lngLat[0], lat: lngLat[1] });
    return [p.x, p.y];
  }

  function screenToGeo(xy: [number, number]): [number, number] {
    const ll = map.unproject(xy);
    return [ll.lng, ll.lat];
  }

  // --- Pointer event handlers ---
  function onPointerDown(e: PointerEvent) {
    if (!enabled) return;
    if (e.button !== 0) return;

    drawing = true;
    currentScreenPoints = [[e.offsetX, e.offsetY]];
    currentGeoPoints = [screenToGeo([e.offsetX, e.offsetY])];

    if (mode === 'erase') {
      eraseAtPoint(e.offsetX, e.offsetY);
    }

    inputOverlay.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!enabled || !drawing) return;

    const x = e.offsetX;
    const y = e.offsetY;

    if (mode === 'draw') {
      currentScreenPoints.push([x, y]);
      currentGeoPoints.push(screenToGeo([x, y]));
      updateLiveSource();
    } else {
      eraseAtPoint(x, y);
    }
  }

  function onPointerUp(_e: PointerEvent) {
    if (!enabled || !drawing) return;
    drawing = false;

    if (mode === 'draw' && currentScreenPoints.length >= 2) {
      // Simplify in screen space then convert to geo
      const simplified = simplifyRDP(currentScreenPoints, RDP_TOLERANCE);
      if (simplified.length >= 2) {
        const geoPoints = simplified.map(screenToGeo);
        const stroke: AnnotationStroke = {
          id: crypto.randomUUID(),
          points: geoPoints,
          timestamp: Date.now(),
          color: STROKE_COLOR,
          width: STROKE_WIDTH,
        };
        strokes.push(stroke);
        redoStack = [];
        updateStrokesSource();
        storage.storeAnnotation(stroke);
      }
    }

    currentScreenPoints = [];
    currentGeoPoints = [];
    updateLiveSource();
  }

  inputOverlay.addEventListener('pointerdown', onPointerDown);
  inputOverlay.addEventListener('pointermove', onPointerMove);
  inputOverlay.addEventListener('pointerup', onPointerUp);

  // --- Eraser ---
  function eraseAtPoint(x: number, y: number) {
    const toRemove: string[] = [];
    for (const stroke of strokes) {
      const screenPts = stroke.points.map(geoToScreen);
      if (distanceToPolyline(x, y, screenPts) < ERASE_HIT_DISTANCE) {
        toRemove.push(stroke.id);
      }
    }
    if (toRemove.length > 0) {
      for (const id of toRemove) {
        const idx = strokes.findIndex((s) => s.id === id);
        if (idx !== -1) {
          strokes.splice(idx, 1);
          storage.deleteAnnotation(id);
        }
      }
      redoStack = [];
      updateStrokesSource();
    }
  }

  // --- Undo / Redo ---
  function undo() {
    if (strokes.length === 0) return;
    const stroke = strokes.pop()!;
    redoStack.push(stroke);
    storage.deleteAnnotation(stroke.id);
    updateStrokesSource();
  }

  function redo() {
    if (redoStack.length === 0) return;
    const stroke = redoStack.pop()!;
    strokes.push(stroke);
    storage.storeAnnotation(stroke);
    updateStrokesSource();
  }

  function clearAll() {
    if (strokes.length === 0) return;
    strokes = [];
    redoStack = [];
    storage.clearAnnotations();
    updateStrokesSource();
  }

  // --- Mode management ---
  function setMode(newMode: AnnotationMode) {
    mode = newMode;
    updateCursor();
    updateToolbarHighlight();
  }

  function updateCursor() {
    if (!enabled) {
      inputOverlay.style.cursor = 'default';
      return;
    }
    inputOverlay.style.cursor = mode === 'draw' ? 'crosshair' : 'pointer';
  }

  // --- Enable / Disable ---
  function setEnabled(value: boolean) {
    enabled = value;
    inputOverlay.style.pointerEvents = value ? 'auto' : 'none';
    toolbar.style.display = value ? 'flex' : 'none';

    if (value) {
      ensureSourcesAndLayers();
      disableMapInteractions();
      mode = 'draw';
      updateCursor();
      updateToolbarHighlight();
    } else {
      enableMapInteractions();
      drawing = false;
      currentScreenPoints = [];
      currentGeoPoints = [];
      inputOverlay.style.cursor = 'default';
      updateLiveSource();
    }
  }

  // --- Load persisted annotations on init ---
  storage.listAnnotations().then((stored) => {
    if (stored.length > 0) {
      strokes = stored;
      updateStrokesSource();
    }
  });

  // --- Public API ---
  return {
    setEnabled,
    setMode,
    undo,
    redo,
    clearAll,
    isEnabled: () => enabled,
    getMode: () => mode,
    destroy() {
      map.off('style.load', onStyleLoad);
      inputOverlay.removeEventListener('pointerdown', onPointerDown);
      inputOverlay.removeEventListener('pointermove', onPointerMove);
      inputOverlay.removeEventListener('pointerup', onPointerUp);
      inputOverlay.remove();
      toolbar.remove();
      if (map.getLayer(LAYER_LIVE)) map.removeLayer(LAYER_LIVE);
      if (map.getLayer(LAYER_STROKES)) map.removeLayer(LAYER_STROKES);
      if (map.getSource(SOURCE_LIVE)) map.removeSource(SOURCE_LIVE);
      if (map.getSource(SOURCE_STROKES)) map.removeSource(SOURCE_STROKES);
      if (enabled) enableMapInteractions();
    },
  };
}
