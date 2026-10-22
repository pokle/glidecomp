/**
 * The waypoints screen's map: a competition's waypoint set as the website's
 * pickable-waypoint markers (docs/mapbox-interactions-spec.md, "Pickable
 * Waypoint Markers"), fitted to the set on load, and flown to a waypoint when
 * its row is tapped ("Locate from the table").
 *
 * Like TrackMap, the only place a screen meets Mapbox: the library may lag
 * an Expo SDK (plan §7), and this folder is all that would have to change.
 */
import { HIGHLIGHT_COLOR } from '@glidecomp/client/map-geometry';
import { formatAltitude, type WaypointFileRecord } from '@glidecomp/engine';
import Mapbox, { Camera, CircleLayer, MapView, ShapeSource, SymbolLayer } from '@rnmapbox/maps';
import Constants from 'expo-constants';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useUnits } from '@/settings/units';

const TOKEN = (Constants.expoConfig?.extra as { mapboxPublicToken?: string } | undefined)?.mapboxPublicToken;
if (TOKEN) void Mapbox.setAccessToken(TOKEN);

/** The website's default style (mapbox-provider.ts, "Outdoors"). */
const STYLE_URL = 'mapbox://styles/poklet/cmkceyuoc00ha01svg6lb767k';
/** "Locate from the table" zooms in to at least this, never further out. */
const LOCATE_MIN_ZOOM = 13;

export interface WaypointMapProps {
  waypoints: WaypointFileRecord[];
  /**
   * The waypoint to fly to, and a counter that changes on every tap, so a
   * second tap on the same row re-centres (the spec's "bumped key").
   */
  focus: { index: number; key: number } | null;
}

export function WaypointMap(props: WaypointMapProps) {
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

function MapBody({ waypoints, focus }: WaypointMapProps) {
  const prefs = useUnits();
  const map = useRef<MapView>(null);
  const camera = useRef<Camera>(null);
  const [picked, setPicked] = useState<number | null>(null);

  const points = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: waypoints.map((w, i) => ({
        type: 'Feature' as const,
        id: i,
        properties: { index: i, code: w.code },
        geometry: { type: 'Point' as const, coordinates: [w.longitude, w.latitude] },
      })),
    }),
    [waypoints],
  );

  // Fit on load: the whole set, 40 pt padding, never closer than zoom 12.
  const bounds = useMemo(() => {
    if (waypoints.length === 0) return null;
    let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of waypoints) {
      w = Math.min(w, p.longitude);
      e = Math.max(e, p.longitude);
      s = Math.min(s, p.latitude);
      n = Math.max(n, p.latitude);
    }
    return { ne: [e, n], sw: [w, s], paddingTop: 40, paddingBottom: 40, paddingLeft: 40, paddingRight: 40 };
  }, [waypoints]);

  useEffect(() => {
    if (!focus) return;
    const w = waypoints[focus.index];
    if (!w) return;
    setPicked(focus.index);
    let cancelled = false;
    void (async () => {
      const zoom = await map.current?.getZoom().catch(() => undefined);
      if (cancelled) return;
      camera.current?.setCamera({
        centerCoordinate: [w.longitude, w.latitude],
        zoomLevel: Math.max(zoom ?? LOCATE_MIN_ZOOM, LOCATE_MIN_ZOOM),
        animationDuration: 800,
        animationMode: 'flyTo',
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [focus, waypoints]);

  const shown = picked != null ? waypoints[picked] : null;

  return (
    <View style={styles.fill} testID="waypoint-map">
      <MapView ref={map} style={styles.fill} styleURL={STYLE_URL} scaleBarEnabled={false} compassEnabled onPress={() => setPicked(null)}>
        <Camera ref={camera} defaultSettings={bounds ? { bounds } : undefined} maxZoomLevel={bounds ? undefined : 2} />
        <ShapeSource
          id="waypoints"
          shape={points as GeoJSON.FeatureCollection}
          hitbox={{ width: 44, height: 44 }}
          onPress={(e) => {
            const index = e.features[0]?.properties?.index as number | undefined;
            setPicked(index ?? null);
          }}>
          <CircleLayer
            id="waypoints"
            style={{ circleRadius: 5, circleColor: '#64748b', circleOpacity: 0.9, circleStrokeWidth: 1.5, circleStrokeColor: '#ffffff' }}
          />
          <SymbolLayer
            id="waypoint-labels"
            minZoomLevel={10}
            style={{
              textField: ['get', 'code'] as never,
              textSize: 11,
              textOffset: [0, 1.1],
              textAnchor: 'top',
              textColor: '#475569',
              textHaloColor: '#ffffff',
              textHaloWidth: 1.5,
            }}
          />
        </ShapeSource>
        {shown ? (
          <ShapeSource
            id="waypoint-picked"
            shape={{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [shown.longitude, shown.latitude] } }}>
            <CircleLayer
              id="waypoint-picked"
              style={{ circleRadius: 8, circleColor: HIGHLIGHT_COLOR, circleStrokeWidth: 2, circleStrokeColor: '#ffffff' }}
            />
          </ShapeSource>
        ) : null}
      </MapView>
      {shown ? (
        <View style={styles.callout} testID="waypoint-callout" pointerEvents="none">
          <Text style={styles.calloutTitle}>
            {shown.code}
            {shown.name && shown.name !== shown.code ? ` · ${shown.name}` : ''}
          </Text>
          <Text style={styles.calloutDetail}>
            {/* A zero altitude is a known one; only an absent one says so. */}
            {shown.altitude === undefined ? 'No altitude in the file' : formatAltitude(shown.altitude, { prefs }).withUnit}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  missing: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  missingText: { fontSize: 15, textAlign: 'center', opacity: 0.7 },
  callout: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12,
    backgroundColor: '#ffffff',
    borderRadius: 12,
    padding: 10,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  calloutTitle: { fontSize: 15, fontWeight: '600', color: '#1d1d1f' },
  calloutDetail: { fontSize: 13, color: '#5f5f65', marginTop: 2 },
});
