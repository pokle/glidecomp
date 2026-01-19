/**
 * Leaflet Map Component
 *
 * React-leaflet based map for displaying flight tracks, tasks, and events.
 */

import { useEffect, useMemo, useCallback, useRef, useState } from 'react';
import {
  MapContainer,
  TileLayer,
  Polyline,
  Circle,
  Marker,
  Popup,
  useMap,
  useMapEvents,
  LayersControl,
  ScaleControl,
} from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

import { useAppContext, type MapBounds } from '../context/AppContext';
import { getEventStyle, type FlightEvent } from '../event-detector';
import { type IGCFix } from '../igc-parser';
import { calculateOptimizedTaskLine, getOptimizedSegmentDistances, type XCTask } from '../xctsk-parser';
import { haversineDistance, calculateBearing } from '../geo';

// Fix Leaflet default icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Map bounds change handler
function MapEventHandler({ onBoundsChange }: { onBoundsChange: (bounds: MapBounds) => void }) {
  const map = useMapEvents({
    moveend: () => {
      const bounds = map.getBounds();
      onBoundsChange({
        north: bounds.getNorth(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        west: bounds.getWest(),
      });
    },
  });

  return null;
}

// Fit bounds to track
function FitBounds({ fixes }: { fixes: IGCFix[] }) {
  const map = useMap();

  useEffect(() => {
    if (fixes.length > 0) {
      const bounds = L.latLngBounds(fixes.map(fix => [fix.latitude, fix.longitude]));
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [fixes, map]);

  return null;
}

// Pan to event
function PanToEvent({ event, fixes }: { event: FlightEvent | null; fixes: IGCFix[] }) {
  const map = useMap();
  const prevEventRef = useRef<FlightEvent | null>(null);

  useEffect(() => {
    if (event && event !== prevEventRef.current) {
      map.setView([event.latitude, event.longitude], map.getZoom(), { animate: true });
      prevEventRef.current = event;
    }
  }, [event, fixes, map]);

  return null;
}

// Track polyline with event-based coloring
function TrackLine({ fixes, events }: { fixes: IGCFix[]; events: FlightEvent[] }) {
  const segments = useMemo(() => {
    if (fixes.length === 0) return [];

    // Build a map of fix index -> event type for segments
    const fixEventType: (string | null)[] = new Array(fixes.length).fill(null);

    for (const event of events) {
      if (event.segment) {
        const eventType = event.type.includes('thermal') ? 'thermal' :
          event.type.includes('glide') ? 'glide' : null;
        if (eventType) {
          for (let i = event.segment.startIndex; i <= event.segment.endIndex; i++) {
            fixEventType[i] = eventType;
          }
        }
      }
    }

    // Create segments with consistent colors
    const result: { positions: [number, number][]; color: string }[] = [];
    let segmentStart = 0;
    let currentType = fixEventType[0];

    for (let i = 1; i <= fixes.length; i++) {
      const nextType = i < fixes.length ? fixEventType[i] : 'END';

      if (nextType !== currentType || i === fixes.length) {
        const segmentFixes = fixes.slice(segmentStart, i + 1);
        const positions = segmentFixes.map(fix => [fix.latitude, fix.longitude] as [number, number]);
        const color = currentType === 'thermal' ? '#f97316' :
          currentType === 'glide' ? '#3b82f6' : '#9ca3af';

        result.push({ positions, color });
        segmentStart = i;
        currentType = nextType as string | null;
      }
    }

    return result;
  }, [fixes, events]);

  return (
    <>
      {segments.map((segment, index) => (
        <Polyline
          key={index}
          positions={segment.positions}
          pathOptions={{ color: segment.color, weight: 3, opacity: 0.9 }}
        />
      ))}
    </>
  );
}

// Task overlay
function TaskOverlay({ task }: { task: XCTask | null }) {
  const [optimizedPath, setOptimizedPath] = useState<{ lat: number; lon: number }[]>([]);
  const [segmentDistances, setSegmentDistances] = useState<number[]>([]);

  useEffect(() => {
    if (task && task.turnpoints.length > 0) {
      const path = calculateOptimizedTaskLine(task);
      setOptimizedPath(path);
      setSegmentDistances(getOptimizedSegmentDistances(task));
    } else {
      setOptimizedPath([]);
      setSegmentDistances([]);
    }
  }, [task]);

  if (!task || task.turnpoints.length === 0) return null;

  const getTurnpointColor = (type?: string) => {
    switch (type) {
      case 'SSS': return '#22c55e';
      case 'ESS': return '#eab308';
      case 'TAKEOFF': return '#3b82f6';
      default: return '#a855f7';
    }
  };

  return (
    <>
      {/* Task line */}
      {optimizedPath.length > 1 && (
        <Polyline
          positions={optimizedPath.map(p => [p.lat, p.lon] as [number, number])}
          pathOptions={{ color: '#6366f1', weight: 2, opacity: 0.8, dashArray: '8, 8' }}
        />
      )}

      {/* Distance labels for each segment */}
      {optimizedPath.map((point, i) => {
        if (i >= optimizedPath.length - 1) return null;
        const p1 = optimizedPath[i];
        const p2 = optimizedPath[i + 1];
        const midLat = (p1.lat + p2.lat) / 2;
        const midLng = (p1.lon + p2.lon) / 2;
        const distance = segmentDistances[i];
        const distanceKm = (distance / 1000).toFixed(1);
        const legNumber = i + 1;

        return (
          <Marker
            key={`leg-${i}`}
            position={[midLat, midLng]}
            icon={L.divIcon({
              className: 'leaflet-distance-label',
              html: `<div style="
                background: white;
                padding: 2px 6px;
                border-radius: 4px;
                font-size: 11px;
                font-weight: 600;
                color: #6366f1;
                border: 1px solid #6366f1;
                box-shadow: 0 1px 3px rgba(0,0,0,0.2);
                white-space: nowrap;
              ">Leg ${legNumber}: ${distanceKm}km</div>`,
              iconSize: [100, 20],
              iconAnchor: [50, 10],
            })}
          />
        );
      })}

      {/* Turnpoint cylinders and markers */}
      {task.turnpoints.map((tp, idx) => {
        const color = getTurnpointColor(tp.type);
        const name = tp.waypoint.name || `TP${idx + 1}`;
        const radiusKm = (tp.radius / 1000).toFixed(tp.radius >= 1000 ? 0 : 1);
        const altitude = tp.waypoint.altSmoothed ? `A\u00A0${Math.round(tp.waypoint.altSmoothed)}m` : '';
        const role = tp.type || '';
        const labelParts = [name, `R\u00A0${radiusKm}km`];
        if (altitude) labelParts.push(altitude);
        if (role) labelParts.push(role);
        const label = labelParts.join(', ');

        return (
          <div key={idx}>
            <Circle
              center={[tp.waypoint.lat, tp.waypoint.lon]}
              radius={tp.radius}
              pathOptions={{
                color,
                weight: 2,
                opacity: 0.8,
                fillColor: color,
                fillOpacity: 0.15,
              }}
            />
            <Marker
              position={[tp.waypoint.lat, tp.waypoint.lon]}
              icon={L.divIcon({
                className: 'leaflet-task-marker',
                html: `<div style="
                  width: 12px;
                  height: 12px;
                  border-radius: 50%;
                  background: ${color};
                  border: 2px solid white;
                  box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                "></div>`,
                iconSize: [12, 12],
                iconAnchor: [6, 6],
              })}
            >
              <Popup>{label}</Popup>
            </Marker>
          </div>
        );
      })}
    </>
  );
}

// Event markers
function EventMarkers({ events, onEventClick }: { events: FlightEvent[]; onEventClick: (event: FlightEvent) => void }) {
  // Only show key event types
  const keyEventTypes = new Set([
    'takeoff', 'landing', 'start_crossing', 'goal_crossing',
    'max_altitude', 'turnpoint_entry',
  ]);

  const filteredEvents = useMemo(() =>
    events.filter(e => keyEventTypes.has(e.type)),
    [events]
  );

  return (
    <>
      {filteredEvents.map(event => {
        const style = getEventStyle(event.type);

        return (
          <Marker
            key={event.id}
            position={[event.latitude, event.longitude]}
            icon={L.divIcon({
              className: 'leaflet-event-marker',
              html: `<div style="
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: ${style.color};
                border: 2px solid white;
                box-shadow: 0 2px 4px rgba(0,0,0,0.3);
                cursor: pointer;
              "></div>`,
              iconSize: [20, 20],
              iconAnchor: [10, 10],
            })}
            eventHandlers={{
              click: () => onEventClick(event),
            }}
          >
            <Popup>
              <strong>{event.description}</strong><br />
              <span style={{ color: '#666' }}>{event.time.toLocaleTimeString()}</span>
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}

// Highlight segment
function HighlightSegment({ event, fixes }: { event: FlightEvent | null; fixes: IGCFix[] }) {
  if (!event?.segment || fixes.length === 0) return null;

  const segmentFixes = fixes.slice(event.segment.startIndex, event.segment.endIndex + 1);
  const positions = segmentFixes.map(fix => [fix.latitude, fix.longitude] as [number, number]);

  return (
    <Polyline
      positions={positions}
      pathOptions={{ color: '#00ffff', weight: 6, opacity: 0.9 }}
    />
  );
}

export function LeafletMap() {
  const {
    fixes,
    events,
    task,
    selectedEvent,
    setMapBounds,
    selectEvent,
  } = useAppContext();

  const handleEventClick = useCallback((event: FlightEvent) => {
    selectEvent(event);
  }, [selectEvent]);

  return (
    <MapContainer
      center={[45, 0]}
      zoom={5}
      className="map"
      style={{ height: '100%', width: '100%' }}
    >
      <LayersControl position="topright">
        <LayersControl.BaseLayer checked name="OpenTopoMap">
          <TileLayer
            url="https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png"
            attribution='Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)'
            maxZoom={17}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="OpenStreetMap">
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            maxZoom={19}
          />
        </LayersControl.BaseLayer>
        <LayersControl.BaseLayer name="Satellite (ESRI)">
          <TileLayer
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            attribution="Tiles &copy; Esri"
            maxZoom={19}
          />
        </LayersControl.BaseLayer>
      </LayersControl>

      <ScaleControl position="bottomleft" maxWidth={200} />

      <MapEventHandler onBoundsChange={setMapBounds} />
      <FitBounds fixes={fixes} />
      <PanToEvent event={selectedEvent} fixes={fixes} />

      <TaskOverlay task={task} />
      <TrackLine fixes={fixes} events={events} />
      <HighlightSegment event={selectedEvent} fixes={fixes} />
      <EventMarkers events={events} onEventClick={handleEventClick} />
    </MapContainer>
  );
}
