/**
 * Mapbox Map Component
 *
 * react-map-gl based map for displaying flight tracks, tasks, and events.
 * Supports 3D terrain and altitude coloring.
 */

import { useEffect, useMemo, useCallback, useState, useRef } from 'react';
import Map, {
  Source,
  Layer,
  Marker,
  NavigationControl,
  ScaleControl,
  FullscreenControl,
  type MapRef,
  type ViewStateChangeEvent,
} from 'react-map-gl';
import 'mapbox-gl/dist/mapbox-gl.css';

import { useAppContext, type MapBounds } from '../context/AppContext';
import { getEventStyle, type FlightEvent } from '../event-detector';
import { type IGCFix, getBoundingBox } from '../igc-parser';
import { calculateOptimizedTaskLine, getOptimizedSegmentDistances, type XCTask } from '../xctsk-parser';
import { haversineDistance } from '../geo';

// Mapbox access token
const MAPBOX_TOKEN = 'pk.eyJ1IjoicG9rbGV0IiwiYSI6ImNta2NldzI2djAwM2szY3BudXYyd3Y2Ym4ifQ.cPKrPNe6ALnWnH03FlT6iA';

// Map styles
const MAPBOX_STYLES = [
  { id: 'outdoors', name: 'Outdoors', style: 'mapbox://styles/mapbox/outdoors-v12' },
  { id: 'satellite', name: 'Satellite', style: 'mapbox://styles/mapbox/satellite-streets-v12' },
  { id: 'streets', name: 'Streets', style: 'mapbox://styles/mapbox/streets-v12' },
  { id: 'light', name: 'Light', style: 'mapbox://styles/mapbox/light-v11' },
  { id: 'dark', name: 'Dark', style: 'mapbox://styles/mapbox/dark-v11' },
];

/**
 * Create a circle polygon (approximation) for cylinder rendering
 */
function createCirclePolygon(
  centerLon: number,
  centerLat: number,
  radiusMeters: number,
  numPoints = 64
): GeoJSON.Polygon {
  const coords: [number, number][] = [];

  for (let i = 0; i <= numPoints; i++) {
    const angle = (i / numPoints) * 2 * Math.PI;
    const latOffset = (radiusMeters / 111320) * Math.cos(angle);
    const lonOffset = (radiusMeters / (111320 * Math.cos((centerLat * Math.PI) / 180))) * Math.sin(angle);
    coords.push([centerLon + lonOffset, centerLat + latOffset]);
  }

  return {
    type: 'Polygon',
    coordinates: [coords],
  };
}

/**
 * Get color based on normalized altitude (0-1 range)
 */
function getAltitudeColorNormalized(normalizedAlt: number): string {
  const t = Math.max(0, Math.min(1, normalizedAlt));

  const colors = [
    { pos: 0.0, r: 141, g: 110, b: 99 },   // Brown
    { pos: 0.25, r: 102, g: 187, b: 106 }, // Green
    { pos: 0.5, r: 41, g: 182, b: 246 },   // Light Blue
    { pos: 0.75, r: 129, g: 212, b: 250 }, // Sky Blue
    { pos: 1.0, r: 227, g: 242, b: 253 },  // Pale Sky
  ];

  let lower = colors[0];
  let upper = colors[colors.length - 1];
  for (let i = 0; i < colors.length - 1; i++) {
    if (t >= colors[i].pos && t <= colors[i + 1].pos) {
      lower = colors[i];
      upper = colors[i + 1];
      break;
    }
  }

  const range = upper.pos - lower.pos;
  const localT = range > 0 ? (t - lower.pos) / range : 0;
  const r = Math.round(lower.r + (upper.r - lower.r) * localT);
  const g = Math.round(lower.g + (upper.g - lower.g) * localT);
  const b = Math.round(lower.b + (upper.b - lower.b) * localT);

  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * Calculate altitude gradient stops based on line progress
 */
function calculateAltitudeGradient(fixes: IGCFix[]): [number, string][] {
  if (fixes.length < 2) return [[0, '#3b82f6'], [1, '#3b82f6']];

  let minAlt = Infinity;
  let maxAlt = -Infinity;
  for (const fix of fixes) {
    if (fix.gnssAltitude < minAlt) minAlt = fix.gnssAltitude;
    if (fix.gnssAltitude > maxAlt) maxAlt = fix.gnssAltitude;
  }
  const altRange = maxAlt - minAlt;

  const distances: number[] = [0];
  let totalDistance = 0;
  for (let i = 1; i < fixes.length; i++) {
    const dist = haversineDistance(
      fixes[i - 1].latitude, fixes[i - 1].longitude,
      fixes[i].latitude, fixes[i].longitude
    );
    totalDistance += dist;
    distances.push(totalDistance);
  }

  if (totalDistance === 0) return [[0, '#3b82f6'], [1, '#3b82f6']];

  const stops: [number, string][] = [];
  const sampleInterval = Math.max(1, Math.floor(fixes.length / 100));

  for (let i = 0; i < fixes.length; i += sampleInterval) {
    const progress = distances[i] / totalDistance;
    const normalizedAlt = altRange > 0 ? (fixes[i].gnssAltitude - minAlt) / altRange : 0;
    const color = getAltitudeColorNormalized(normalizedAlt);
    stops.push([progress, color]);
  }

  if (stops[stops.length - 1][0] < 1) {
    const lastFix = fixes[fixes.length - 1];
    const normalizedAlt = altRange > 0 ? (lastFix.gnssAltitude - minAlt) / altRange : 0;
    stops.push([1, getAltitudeColorNormalized(normalizedAlt)]);
  }

  return stops;
}

export function MapboxMap() {
  const {
    fixes,
    events,
    task,
    selectedEvent,
    setMapBounds,
    selectEvent,
    altitudeColorsEnabled,
    is3DMode,
  } = useAppContext();

  const mapRef = useRef<any>(null);
  const [mapStyle, setMapStyle] = useState(MAPBOX_STYLES[0].style);
  const [viewState, setViewState] = useState({
    longitude: 0,
    latitude: 45,
    zoom: 5,
    pitch: 45,
    bearing: 0,
  });

  // Track GeoJSON data
  const trackGeoJSON = useMemo(() => {
    if (fixes.length === 0) {
      return { type: 'FeatureCollection' as const, features: [] };
    }

    const coordinates = fixes.map(fix => [fix.longitude, fix.latitude, fix.gnssAltitude]);
    return {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        properties: {},
        geometry: {
          type: 'LineString' as const,
          coordinates,
        },
      }],
    };
  }, [fixes]);

  // Altitude gradient
  const altitudeGradient = useMemo(() => {
    return calculateAltitudeGradient(fixes);
  }, [fixes]);

  // Task data
  const taskData = useMemo(() => {
    if (!task || task.turnpoints.length === 0) {
      return {
        line: { type: 'FeatureCollection' as const, features: [] },
        points: { type: 'FeatureCollection' as const, features: [] },
        cylinders: { type: 'FeatureCollection' as const, features: [] },
        labels: { type: 'FeatureCollection' as const, features: [] },
      };
    }

    const optimizedPath = calculateOptimizedTaskLine(task);
    const segmentDistances = getOptimizedSegmentDistances(task);

    // Task line
    const lineFeature = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: optimizedPath.map(p => [p.lon, p.lat]),
      },
    };

    // Segment labels
    const labelFeatures = optimizedPath.slice(0, -1).map((p1, i) => {
      const p2 = optimizedPath[i + 1];
      const midLon = (p1.lon + p2.lon) / 2;
      const midLat = (p1.lat + p2.lat) / 2;
      const distance = segmentDistances[i];
      const distanceKm = (distance / 1000).toFixed(1);

      return {
        type: 'Feature' as const,
        properties: { distance: `Leg ${i + 1}: ${distanceKm}km` },
        geometry: { type: 'Point' as const, coordinates: [midLon, midLat] },
      };
    });

    // Turnpoint markers
    const pointFeatures = task.turnpoints.map((tp, idx) => {
      const name = tp.waypoint.name || `TP${idx + 1}`;
      const radiusKm = (tp.radius / 1000).toFixed(tp.radius >= 1000 ? 0 : 1);
      const altitude = tp.waypoint.altSmoothed ? `A\u00A0${Math.round(tp.waypoint.altSmoothed)}m` : '';
      const role = tp.type || '';
      const labelParts = [name, `R\u00A0${radiusKm}km`];
      if (altitude) labelParts.push(altitude);
      if (role) labelParts.push(role);

      return {
        type: 'Feature' as const,
        properties: { name: labelParts.join(', '), type: tp.type || '', radius: tp.radius },
        geometry: { type: 'Point' as const, coordinates: [tp.waypoint.lon, tp.waypoint.lat] },
      };
    });

    // Cylinder polygons
    const cylinderFeatures = task.turnpoints.map((tp, idx) => ({
      type: 'Feature' as const,
      properties: { name: tp.waypoint.name || `TP${idx + 1}`, type: tp.type || '', radius: tp.radius },
      geometry: createCirclePolygon(tp.waypoint.lon, tp.waypoint.lat, tp.radius),
    }));

    return {
      line: { type: 'FeatureCollection' as const, features: [lineFeature] },
      points: { type: 'FeatureCollection' as const, features: pointFeatures },
      cylinders: { type: 'FeatureCollection' as const, features: cylinderFeatures },
      labels: { type: 'FeatureCollection' as const, features: labelFeatures },
    };
  }, [task]);

  // Highlight segment GeoJSON
  const highlightGeoJSON = useMemo(() => {
    if (!selectedEvent?.segment || fixes.length === 0) {
      return { type: 'FeatureCollection' as const, features: [] };
    }

    const { startIndex, endIndex } = selectedEvent.segment;
    const segmentFixes = fixes.slice(startIndex, endIndex + 1);
    const coordinates = segmentFixes.map(fix => [fix.longitude, fix.latitude, fix.gnssAltitude]);

    return {
      type: 'FeatureCollection' as const,
      features: [{
        type: 'Feature' as const,
        properties: {},
        geometry: { type: 'LineString' as const, coordinates },
      }],
    };
  }, [selectedEvent, fixes]);

  // Key events for markers
  const keyEvents = useMemo(() => {
    const keyEventTypes = new Set([
      'takeoff', 'landing', 'start_crossing', 'goal_crossing',
      'max_altitude', 'turnpoint_entry',
    ]);
    return events.filter(e => keyEventTypes.has(e.type));
  }, [events]);

  // Fit bounds when fixes change
  useEffect(() => {
    if (fixes.length > 0 && mapRef.current) {
      const bounds = getBoundingBox(fixes);
      mapRef.current.fitBounds(
        [[bounds.minLon, bounds.minLat], [bounds.maxLon, bounds.maxLat]],
        { padding: 50, duration: 1000 }
      );
    }
  }, [fixes]);

  // Pan to selected event
  useEffect(() => {
    if (selectedEvent && mapRef.current) {
      mapRef.current.flyTo({
        center: [selectedEvent.longitude, selectedEvent.latitude],
        duration: 1000,
      });
    }
  }, [selectedEvent]);

  // Handle bounds change
  const handleMoveEnd = useCallback(() => {
    if (mapRef.current) {
      const bounds = mapRef.current.getBounds();
      setMapBounds({
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      });
    }
  }, [setMapBounds]);

  // Build gradient expression
  const gradientExpression = useMemo(() => {
    if (altitudeGradient.length < 2) {
      return ['interpolate', ['linear'], ['line-progress'], 0, '#3b82f6', 1, '#3b82f6'];
    }
    const expr: any[] = ['interpolate', ['linear'], ['line-progress']];
    for (const [progress, color] of altitudeGradient) {
      expr.push(progress, color);
    }
    return expr;
  }, [altitudeGradient]);

  return (
    <Map
      ref={mapRef}
      {...viewState}
      onMove={(evt: ViewStateChangeEvent) => setViewState(evt.viewState)}
      onMoveEnd={handleMoveEnd}
      mapStyle={mapStyle}
      mapboxAccessToken={MAPBOX_TOKEN}
      style={{ width: '100%', height: '100%' }}
      terrain={is3DMode ? { source: 'mapbox-dem', exaggeration: 1.5 } : undefined}
      maxPitch={85}
    >
      <NavigationControl position="top-right" visualizePitch />
      <ScaleControl position="bottom-left" maxWidth={200} />
      <FullscreenControl position="top-right" />

      {/* Style selector */}
      <div style={{
        position: 'absolute',
        top: 10,
        left: 10,
        zIndex: 1,
        background: 'white',
        borderRadius: 4,
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      }}>
        <select
          value={mapStyle}
          onChange={(e) => setMapStyle(e.target.value)}
          style={{
            padding: '6px 8px',
            border: 'none',
            background: 'white',
            cursor: 'pointer',
            fontSize: 12,
          }}
        >
          {MAPBOX_STYLES.map(s => (
            <option key={s.id} value={s.style}>{s.name}</option>
          ))}
        </select>
      </div>

      {/* Terrain source for 3D */}
      {is3DMode && (
        <Source
          id="mapbox-dem"
          type="raster-dem"
          url="mapbox://mapbox.mapbox-terrain-dem-v1"
          tileSize={512}
          maxzoom={14}
        />
      )}

      {/* Task line */}
      <Source id="task-line" type="geojson" data={taskData.line}>
        <Layer
          id="task-line"
          type="line"
          paint={{
            'line-color': '#6366f1',
            'line-width': 2,
            'line-dasharray': [4, 4],
            'line-opacity': 0.8,
          }}
        />
      </Source>

      {/* Task cylinders */}
      <Source id="task-cylinders" type="geojson" data={taskData.cylinders}>
        <Layer
          id="task-cylinders-fill"
          type="fill"
          paint={{
            'fill-color': [
              'case',
              ['==', ['get', 'type'], 'SSS'], '#22c55e',
              ['==', ['get', 'type'], 'ESS'], '#eab308',
              ['==', ['get', 'type'], 'TAKEOFF'], '#3b82f6',
              '#a855f7',
            ],
            'fill-opacity': 0.15,
          }}
        />
        <Layer
          id="task-cylinders-stroke"
          type="line"
          paint={{
            'line-color': [
              'case',
              ['==', ['get', 'type'], 'SSS'], '#22c55e',
              ['==', ['get', 'type'], 'ESS'], '#eab308',
              ['==', ['get', 'type'], 'TAKEOFF'], '#3b82f6',
              '#a855f7',
            ],
            'line-width': 2,
            'line-opacity': 0.8,
          }}
        />
      </Source>

      {/* Task points */}
      <Source id="task-points" type="geojson" data={taskData.points}>
        <Layer
          id="task-points"
          type="circle"
          paint={{
            'circle-radius': 6,
            'circle-color': [
              'case',
              ['==', ['get', 'type'], 'SSS'], '#22c55e',
              ['==', ['get', 'type'], 'ESS'], '#eab308',
              ['==', ['get', 'type'], 'TAKEOFF'], '#3b82f6',
              '#a855f7',
            ],
            'circle-stroke-width': 2,
            'circle-stroke-color': '#ffffff',
          }}
        />
        <Layer
          id="task-labels"
          type="symbol"
          layout={{
            'text-field': ['get', 'name'],
            'text-size': 12,
            'text-offset': [0, 1.5],
            'text-anchor': 'top',
          }}
          paint={{
            'text-color': '#1e293b',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
          }}
        />
      </Source>

      {/* Task segment labels */}
      <Source id="task-segment-labels" type="geojson" data={taskData.labels}>
        <Layer
          id="task-segment-labels"
          type="symbol"
          layout={{
            'text-field': ['get', 'distance'],
            'text-size': 11,
            'text-anchor': 'center',
          }}
          paint={{
            'text-color': '#6366f1',
            'text-halo-color': '#ffffff',
            'text-halo-width': 2,
          }}
        />
      </Source>

      {/* Track line (solid orange) */}
      <Source id="track" type="geojson" data={trackGeoJSON}>
        <Layer
          id="track-line-outline"
          type="line"
          layout={{ visibility: altitudeColorsEnabled ? 'visible' : 'visible' }}
          paint={{
            'line-color': '#000000',
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 4, 8, 6, 12, 5],
            'line-opacity': 0.4,
          }}
        />
        <Layer
          id="track-line"
          type="line"
          layout={{ visibility: altitudeColorsEnabled ? 'none' : 'visible' }}
          paint={{
            'line-color': '#f97316',
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2, 8, 3, 12, 3],
            'line-opacity': 0.95,
          }}
        />
      </Source>

      {/* Track line with altitude gradient */}
      <Source id="track-gradient" type="geojson" data={trackGeoJSON} lineMetrics>
        <Layer
          id="track-line-gradient"
          type="line"
          layout={{ visibility: altitudeColorsEnabled ? 'visible' : 'none' }}
          paint={{
            'line-gradient': gradientExpression as any,
            'line-width': ['interpolate', ['linear'], ['zoom'], 3, 2, 8, 3, 12, 3],
            'line-opacity': 0.95,
          }}
        />
      </Source>

      {/* Highlight segment */}
      <Source id="highlight-segment" type="geojson" data={highlightGeoJSON}>
        <Layer
          id="highlight-segment"
          type="line"
          paint={{
            'line-color': '#00ffff',
            'line-width': 6,
            'line-opacity': 0.9,
          }}
        />
      </Source>

      {/* Event markers */}
      {keyEvents.map(event => {
        const style = getEventStyle(event.type);
        return (
          <Marker
            key={event.id}
            longitude={event.longitude}
            latitude={event.latitude}
            onClick={() => {
              selectEvent(event);
            }}
          >
            <div
              style={{
                width: 20,
                height: 20,
                borderRadius: '50%',
                backgroundColor: style.color,
                border: '2px solid white',
                boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                cursor: 'pointer',
              }}
            />
          </Marker>
        );
      })}
    </Map>
  );
}
