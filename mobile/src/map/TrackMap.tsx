/**
 * The report card's evidence map: the task, the pilot's flight, and where each
 * step of the explanation happened — natively, with @rnmapbox/maps.
 *
 * The visuals are docs/mapbox-interactions-spec.md's, and the features are the
 * website's own (`@glidecomp/client/map-geometry`), so a cylinder, a leg label
 * or a track colour here is the one the website draws. Layers are declared in
 * the spec's bottom-to-top order.
 *
 * Isolated behind this one component (plan §7: the map library may lag an
 * Expo SDK), so a screen never touches Mapbox directly.
 */
import {
  HIGHLIGHT_COLOR,
  KEY_EVENT_TYPES,
  TASK_COLOR,
  calculateAltitudeRange,
  nearestFixIndexByTime,
  taskMapFeatures,
  trackLineFeatures,
} from '@glidecomp/client/map-geometry';
import type { BestProgressRoute, OpenDistanceLine } from '@glidecomp/client/report-card';
import { formatTimeInZone } from '@glidecomp/client/time';
import { formatDistance, getEventStyle, type FlightEvent, type IGCFix, type XCTask } from '@glidecomp/engine';
import Mapbox, {
  Camera,
  CircleLayer,
  FillLayer,
  Images,
  LineLayer,
  MapView,
  MarkerView,
  RasterDemSource,
  ShapeSource,
  SkyLayer,
  SymbolLayer,
  Terrain,
} from '@rnmapbox/maps';
import Constants from 'expo-constants';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { useUnits } from '@/settings/units';

const TOKEN = (Constants.expoConfig?.extra as { mapboxPublicToken?: string } | undefined)?.mapboxPublicToken;
if (TOKEN) void Mapbox.setAccessToken(TOKEN);

/** The website's default style (mapbox-provider.ts, "Outdoors"). */
const STYLE_URL = 'mapbox://styles/poklet/cmkceyuoc00ha01svg6lb767k';
const TERRAIN_EXAGGERATION = 1.5;
const WIDTH_MUL = 0.7;
const TYPE_COLOUR = ['case', ['==', ['get', 'type'], 'SSS'], '#22c55e', ['==', ['get', 'type'], 'ESS'], '#eab308', ['==', ['get', 'type'], 'TAKEOFF'], '#3b82f6', '#a855f7'];
const ALT_WIDTH = (lo: number, hi: number) => ['interpolate', ['linear'], ['get', 'normalizedAlt'], 0, lo * WIDTH_MUL, 1, hi * WIDTH_MUL];

export interface TrackMapProps {
  task: XCTask;
  fixes: IGCFix[] | null;
  /** Every event an explanation line is anchored to. */
  events: FlightEvent[];
  /** The event to fly to and pick out, if the map was opened from a line. */
  focus: FlightEvent | null;
  openDistanceLine: OpenDistanceLine | null;
  bestProgressRoute: BestProgressRoute | null;
  timeZone: string | null;
}

export function TrackMap(props: TrackMapProps) {
  if (!TOKEN) {
    return (
      <View style={styles.missing}>
        <Text style={styles.missingText}>
          This build has no Mapbox token, so it can’t draw the map. See mobile/CLAUDE.md, “The track map”.
        </Text>
      </View>
    );
  }
  return <MapBody {...props} />;
}

const line = (coords: { lat: number; lon: number }[]) => ({
  type: 'Feature' as const,
  properties: {},
  geometry: { type: 'LineString' as const, coordinates: coords.map((c) => [c.lon, c.lat]) },
});

function MapBody({ task, fixes, events, focus, openDistanceLine, bestProgressRoute, timeZone }: TrackMapProps) {
  const prefs = useUnits();
  const camera = useRef<Camera>(null);
  const [selected, setSelected] = useState<FlightEvent | null>(focus);
  // Opened from a line with a real time: show the flight only up to that
  // moment, as the website does — where a pilot crossed the same cylinder
  // again and again, the clipped track is what makes the sequence readable.
  const [clipToFocus, setClipToFocus] = useState(focus != null && focus.time.getTime() > 0);

  const taskFeatures = useMemo(() => taskMapFeatures(task, prefs), [task, prefs]);
  const range = useMemo(() => (fixes ? calculateAltitudeRange(fixes) : null), [fixes]);
  const scrubIndex = useMemo(() => {
    if (!clipToFocus || !focus || !fixes || fixes.length < 2) return null;
    return nearestFixIndexByTime(fixes, focus.time.getTime());
  }, [clipToFocus, focus, fixes]);
  const track = useMemo(() => {
    if (!fixes || !range) return null;
    const shown = scrubIndex != null ? fixes.slice(0, scrubIndex + 1) : fixes;
    return { type: 'FeatureCollection' as const, features: trackLineFeatures(shown, range) };
  }, [fixes, range, scrubIndex]);
  const markers = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: events
        .filter((e) => KEY_EVENT_TYPES.has(e.type))
        .map((e) => ({
          type: 'Feature' as const,
          id: e.id,
          properties: { id: e.id, colour: getEventStyle(e.type).color },
          geometry: { type: 'Point' as const, coordinates: [e.longitude, e.latitude] },
        })),
    }),
    [events],
  );
  const highlight = useMemo(() => {
    const seg = focus?.segment;
    if (!seg || !fixes) return null;
    return line(fixes.slice(seg.startIndex, seg.endIndex + 1).map((f) => ({ lat: f.latitude, lon: f.longitude })));
  }, [focus, fixes]);

  // Open on the flight (or, with no tracklog, the task) — spec "Fit bounds".
  const bounds = useMemo(() => {
    const pts = fixes && fixes.length > 0
      ? fixes.map((f) => [f.longitude, f.latitude])
      : task.turnpoints.map((tp) => [tp.waypoint.lon, tp.waypoint.lat]);
    if (pts.length === 0) return null;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [lon, lat] of pts) {
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
    return { ne: [e, n], sw: [w, s], paddingTop: 50, paddingBottom: 50, paddingLeft: 50, paddingRight: 50 };
  }, [fixes, task]);

  // panToEvent: fly to it, keeping the zoom (spec "Event Highlight").
  useEffect(() => {
    if (!focus) return;
    const t = setTimeout(
      () => camera.current?.setCamera({ centerCoordinate: [focus.longitude, focus.latitude], animationDuration: 1000, animationMode: 'flyTo' }),
      600,
    );
    return () => clearTimeout(t);
  }, [focus]);

  const position = scrubIndex != null && fixes ? fixes[scrubIndex] : null;

  return (
    <View style={styles.fill} testID="track-map">
      <MapView style={styles.fill} styleURL={STYLE_URL} scaleBarEnabled compassEnabled onPress={() => setSelected(null)}>
        <Camera ref={camera} defaultSettings={bounds ? { bounds } : undefined} />
        <RasterDemSource id="mapbox-dem" url="mapbox://mapbox.mapbox-terrain-dem-v1" tileSize={512} maxZoomLevel={14}>
          <Terrain style={{ exaggeration: TERRAIN_EXAGGERATION }} />
        </RasterDemSource>
        <SkyLayer id="sky" style={{ skyType: 'atmosphere', skyAtmosphereSun: [0, 90], skyAtmosphereSunIntensity: 15 }} />
        <Images images={{ 'task-arrow': require('./task-arrow.png') }} />

        <ShapeSource id="task-line" shape={taskFeatures.line as GeoJSON.FeatureCollection}>
          <LineLayer id="task-line" style={{ lineColor: TASK_COLOR, lineWidth: 2, lineDasharray: [4, 4], lineOpacity: 0.8, lineJoin: 'round', lineCap: 'round' }} />
          <SymbolLayer
            id="task-line-arrows"
            style={{ symbolPlacement: 'line', symbolSpacing: 40, iconImage: 'task-arrow', iconSize: 0.55, iconAllowOverlap: true, iconRotationAlignment: 'map' }}
          />
        </ShapeSource>
        <ShapeSource id="task-cylinders" shape={taskFeatures.cylinders as GeoJSON.FeatureCollection}>
          <FillLayer id="task-cylinders-fill" style={{ fillColor: TYPE_COLOUR as never, fillOpacity: 0.15 }} />
          <LineLayer id="task-cylinders-stroke" style={{ lineColor: TYPE_COLOUR as never, lineWidth: 2, lineOpacity: 0.8 }} />
        </ShapeSource>
        <ShapeSource id="task-exit-arrows" shape={taskFeatures.exitArrows as GeoJSON.FeatureCollection}>
          <FillLayer id="task-exit-arrows" style={{ fillColor: '#a855f7', fillOpacity: 0.9 }} />
        </ShapeSource>
        <ShapeSource id="task-goal-line" shape={taskFeatures.goalLine as GeoJSON.FeatureCollection}>
          <LineLayer id="task-goal-line" style={{ lineColor: '#a855f7', lineWidth: 4, lineOpacity: 0.9, lineCap: 'round' }} />
        </ShapeSource>

        {track ? (
          <ShapeSource id="track" shape={track as GeoJSON.FeatureCollection}>
            <LineLayer
              id="track-line-outline"
              style={{
                lineColor: '#000000',
                lineOpacity: 0.6,
                lineJoin: 'round',
                lineCap: 'round',
                lineWidth: ['interpolate', ['linear'], ['zoom'], 3, ALT_WIDTH(4, 12), 8, ALT_WIDTH(6, 18), 12, ALT_WIDTH(5, 16)] as never,
              }}
            />
            <LineLayer
              id="track-line"
              style={{
                lineColor: ['interpolate', ['linear'], ['get', 'normalizedAlt'], 0, '#8B5A2B', 0.25, '#43A047', 0.5, '#039BE5', 0.75, '#29B6F6', 1, '#4FC3F7'] as never,
                lineOpacity: 0.95,
                lineJoin: 'round',
                lineCap: 'round',
                lineWidth: ['interpolate', ['linear'], ['zoom'], 3, ALT_WIDTH(2, 6), 8, ALT_WIDTH(3, 9), 12, ALT_WIDTH(3, 9)] as never,
              }}
            />
          </ShapeSource>
        ) : null}

        {highlight ? (
          <ShapeSource id="highlight-segment" shape={highlight as GeoJSON.Feature}>
            <LineLayer id="highlight-segment" style={{ lineColor: HIGHLIGHT_COLOR, lineWidth: 6, lineOpacity: 0.9, lineJoin: 'round', lineCap: 'round' }} />
          </ShapeSource>
        ) : null}

        <ShapeSource id="task-points" shape={taskFeatures.points as GeoJSON.FeatureCollection}>
          <CircleLayer id="task-points" style={{ circleRadius: 6, circleColor: TYPE_COLOUR as never, circleStrokeWidth: 2, circleStrokeColor: '#ffffff' }} />
          <SymbolLayer
            id="task-labels"
            style={{
              textField: ['get', 'name'] as never,
              textSize: 20,
              textOffset: [0, 1.5],
              textAnchor: 'top',
              textColor: '#1e293b',
              textHaloColor: '#ffffff',
              textHaloWidth: 2,
            }}
          />
        </ShapeSource>
        <ShapeSource id="task-segment-labels" shape={taskFeatures.segmentLabels as GeoJSON.FeatureCollection}>
          <SymbolLayer
            id="task-segment-labels"
            style={{
              textField: ['get', 'distance'] as never,
              textSize: 16,
              textRotate: ['get', 'bearing'] as never,
              textRotationAlignment: 'map',
              textAnchor: 'center',
              textColor: TASK_COLOR,
              textHaloColor: '#eeeeee',
              textHaloWidth: 2,
            }}
          />
        </ShapeSource>

        {openDistanceLine ? (
          <ShapeSource
            id="open-distance-lines"
            shape={{ ...line([openDistanceLine.origin, openDistanceLine.end]), properties: { label: formatDistance(openDistanceLine.distance, { decimals: 1, prefs }).withUnit } } as GeoJSON.Feature}>
            <LineLayer id="open-distance-line" style={{ lineColor: TASK_COLOR, lineWidth: 2, lineDasharray: [4, 4], lineOpacity: 0.8 }} />
            <SymbolLayer
              id="open-distance-labels"
              style={{ symbolPlacement: 'line-center', textField: ['get', 'label'] as never, textOffset: [0, -0.8], textSize: 16, textColor: TASK_COLOR, textHaloColor: '#eeeeee', textHaloWidth: 2 }}
            />
          </ShapeSource>
        ) : null}
        {bestProgressRoute && bestProgressRoute.coords.length >= 2 ? (
          <ShapeSource
            id="best-progress-route"
            shape={{ ...line(bestProgressRoute.coords), properties: { label: `${formatDistance(bestProgressRoute.distanceToGoal, { decimals: 1, prefs }).withUnit} short of goal` } } as GeoJSON.Feature}>
            <LineLayer id="best-progress-route-line" style={{ lineColor: '#f59e0b', lineWidth: 2.5, lineOpacity: 0.9, lineJoin: 'round', lineCap: 'round' }} />
            <SymbolLayer
              id="best-progress-route-label"
              style={{ symbolPlacement: 'line-center', textField: ['get', 'label'] as never, textOffset: [0, -0.8], textSize: 15, textColor: '#b45309', textHaloColor: '#ffffff', textHaloWidth: 2 }}
            />
          </ShapeSource>
        ) : null}

        <ShapeSource
          id="event-markers"
          shape={markers as GeoJSON.FeatureCollection}
          onPress={(e) => {
            const id = e.features[0]?.properties?.id as string | undefined;
            setSelected(events.find((ev) => ev.id === id) ?? null);
          }}>
          <CircleLayer id="event-markers" style={{ circleRadius: 10, circleColor: ['get', 'colour'] as never, circleStrokeWidth: 2, circleStrokeColor: '#ffffff' }} />
        </ShapeSource>

        {position ? (
          <MarkerView coordinate={[position.longitude, position.latitude]} allowOverlap>
            <View style={styles.position} />
          </MarkerView>
        ) : null}
        {focus ? (
          <MarkerView coordinate={[focus.longitude, focus.latitude]} allowOverlap>
            <Throb colour={getEventStyle(focus.type).color} />
          </MarkerView>
        ) : null}
      </MapView>

      {selected || scrubIndex != null ? (
        <View style={styles.sheet} pointerEvents="box-none">
          {selected ? (
            <View style={styles.callout} testID="event-callout">
              <Text style={styles.calloutTitle}>{selected.description}</Text>
              {selected.time.getTime() > 0 ? (
                <Text style={styles.calloutTime}>{formatTimeInZone(selected.time, timeZone ?? undefined)}</Text>
              ) : null}
            </View>
          ) : null}
          {scrubIndex != null ? (
            <Pressable accessibilityRole="button" onPress={() => setClipToFocus(false)} style={styles.button} testID="whole-flight">
              <Text style={styles.buttonText}>Show the whole flight</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The point marker for the picked-out event: it throbs four times. */
function Throb({ colour }: { colour: string }) {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const pulse = Animated.sequence([
      Animated.timing(scale, { toValue: 1.6, duration: 250, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: 250, useNativeDriver: true }),
    ]);
    Animated.loop(pulse, { iterations: 4 }).start();
  }, [scale]);
  return <Animated.View style={[styles.throb, { backgroundColor: colour, transform: [{ scale }] }]} />;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  missingText: { fontSize: 15, textAlign: 'center', opacity: 0.7 },
  position: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#3b82f6',
    borderWidth: 2.5,
    borderColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  throb: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 3,
    borderColor: '#ffffff',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  // Under the scale bar rather than at the foot: the tab bar floats over the
  // bottom of the screen on iOS.
  sheet: { position: 'absolute', left: 16, right: 16, top: 40, gap: 8, alignItems: 'center' },
  callout: {
    alignSelf: 'stretch',
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 12,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  calloutTitle: { fontSize: 15, fontWeight: '600', color: '#1d1d1f' },
  calloutTime: { fontSize: 13, color: '#5f5f65', marginTop: 2 },
  button: { backgroundColor: '#ffffff', borderRadius: 20, paddingHorizontal: 16, minHeight: 40, justifyContent: 'center' },
  buttonText: { fontSize: 15, fontWeight: '600', color: '#007aff' },
});
