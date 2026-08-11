/**
 * Satellite backdrop for the thermal rose — the terrain the thermal actually
 * worked, drawn to the rose's own scale.
 *
 * The camera opens LOCKED so the map's metres-per-CSS-pixel equals the rose
 * SVG's metres-per-unit over the rendered box, which is what lets the rings
 * and wedges above it sit at true ground size. But the backdrop is also how a
 * reader answers "where IS this thermal?", so pan and zoom are allowed: the
 * moment a gesture moves the camera off that locked framing the figure
 * reports it (`onAwayChange`), the caller fades the rose out — its marks are
 * true only at the locked scale — and a marker keeps pointing at the core.
 * Bumping `recentreToken` snaps the camera home and the lock re-applies.
 * Rotation and pitch stay disabled throughout: north-up is part of the rose's
 * compass contract.
 *
 * Inline the map sits in a long scrolling page, so touch gestures are
 * COOPERATIVE (two fingers to pan — one finger keeps scrolling the page);
 * the full-screen sheet has no page under it and turns that off.
 *
 * Raw mapbox-gl rather than the shared analysis MapProvider — the provider
 * exists for the interactive analysis map (docs/mapbox-interactions-spec.md)
 * with its full control chrome; this is a locator backdrop whose one
 * interaction is looking around.
 *
 * Lazy-loaded (mapbox-gl and its CSS stay out of the main and SSR bundles)
 * and only ever mounted client-side: the "Map" toggle that renders it is off
 * in the SSR snapshot.
 */
import { useEffect, useRef } from "react";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";

/** WGS84 equatorial circumference, metres — Mapbox's own tiling constant. */
const EARTH_CIRCUMFERENCE = 40075016.686;

export default function ThermalRoseMap({
  lat,
  lon,
  metresPerSvgUnit,
  svgSize,
  cooperativeGestures = true,
  onAwayChange,
  recentreToken = 0,
}: {
  /** Thermal core location (sample-weighted over the bands). */
  lat: number;
  lon: number;
  /** The rose's scale: metres represented by one SVG viewBox unit. */
  metresPerSvgUnit: number;
  /** The rose's viewBox edge length in SVG units. */
  svgSize: number;
  /** Two-finger touch pan (for a map embedded in a scrolling page). */
  cooperativeGestures?: boolean;
  /** Told whenever the camera leaves or returns to the locked framing. */
  onAwayChange?: (away: boolean) => void;
  /** Bump to snap the camera back to the locked framing. */
  recentreToken?: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const awayRef = useRef(false);
  // Latest callback without tying the map's lifetime to its identity.
  const onAwayRef = useRef(onAwayChange);
  onAwayRef.current = onAwayChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      // Pan and zoom only — never rotation or pitch, so the compass reading
      // holds and re-centring restores exactly the rose's framing.
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      cooperativeGestures,
      // Attribution is a licence requirement; compact keeps it to the ⓘ.
      attributionControl: false,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    map.addControl(new mapboxgl.AttributionControl({ compact: true }));

    // The core's own pin: the rose fades out while the camera is away, and
    // this is what still says where the thermal is.
    const dot = document.createElement("div");
    dot.className =
      "size-3 rounded-full border-2 border-white/90 bg-primary shadow-md";
    markerRef.current = new mapboxgl.Marker({ element: dot });

    // A camera event carrying originalEvent is a user gesture (drag, pinch,
    // wheel, keyboard); jumpTo from the lock below never carries one. The
    // typings for "zoomstart" omit the field, but mapbox attaches it to every
    // camera event a gesture caused.
    const onUserMove = (e: { originalEvent?: unknown }) => {
      if (e.originalEvent && !awayRef.current) {
        awayRef.current = true;
        onAwayRef.current?.(true);
      }
    };
    map.on("movestart", onUserMove);
    map.on("zoomstart", (e) => onUserMove(e as { originalEvent?: unknown }));

    mapRef.current = map;
    return () => {
      mapRef.current = null;
      markerRef.current = null;
      map.remove();
    };
  }, [cooperativeGestures]);

  // Lock the camera to the rose's scale; re-lock when the thermal changes,
  // the responsive layout resizes the box (the scale is per-CSS-pixel), or
  // the caller asks to re-centre. Each of those means the locked framing
  // again, so any excursion ends here.
  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container) return;
    if (awayRef.current) {
      awayRef.current = false;
      onAwayRef.current?.(false);
    }
    markerRef.current?.setLngLat([lon, lat]).addTo(map);
    const apply = () => {
      const widthPx = container.clientWidth || svgSize;
      const metresPerCssPx = (metresPerSvgUnit * svgSize) / widthPx;
      const zoom = Math.log2(
        (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) /
          (512 * metresPerCssPx)
      );
      map.jumpTo({ center: [lon, lat], zoom, bearing: 0, pitch: 0 });
    };
    apply();
    const observer = new ResizeObserver(() => {
      map.resize();
      // While away the camera belongs to the user — a resize must not
      // snatch it back; the lock returns with the next re-centre.
      if (!awayRef.current) apply();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [lat, lon, metresPerSvgUnit, svgSize, recentreToken]);

  return <div ref={containerRef} className="h-full w-full" />;
}
