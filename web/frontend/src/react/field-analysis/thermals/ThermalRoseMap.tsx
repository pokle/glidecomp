/**
 * Satellite backdrop for the thermal rose — the terrain the thermal actually
 * worked, drawn to the rose's own scale.
 *
 * A deliberately NON-interactive mapbox-gl map (no pan, no zoom, no
 * controls): the camera is locked so the map's metres-per-CSS-pixel equals
 * the rose SVG's metres-per-unit over the rendered box, which is what lets
 * the rings and wedges above it sit at true ground size. That fixed-scale
 * contract is why this is raw mapbox-gl rather than the shared analysis
 * MapProvider — the provider exists for the interactive analysis map
 * (docs/mapbox-interactions-spec.md); a locked locator backdrop has no
 * interactions for that spec to govern.
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
}: {
  /** Thermal core location (sample-weighted over the bands). */
  lat: number;
  lon: number;
  /** The rose's scale: metres represented by one SVG viewBox unit. */
  metresPerSvgUnit: number;
  /** The rose's viewBox edge length in SVG units. */
  svgSize: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    mapboxgl.accessToken = import.meta.env.VITE_MAPBOX_TOKEN;
    const map = new mapboxgl.Map({
      container,
      style: "mapbox://styles/mapbox/satellite-streets-v12",
      interactive: false,
      // Attribution is a licence requirement; compact keeps it to the ⓘ.
      attributionControl: false,
    });
    map.addControl(new mapboxgl.AttributionControl({ compact: true }));
    mapRef.current = map;
    return () => {
      mapRef.current = null;
      map.remove();
    };
  }, []);

  // Lock the camera to the rose's scale; re-lock when the thermal changes or
  // the responsive layout resizes the box (the scale is per-CSS-pixel).
  useEffect(() => {
    const map = mapRef.current;
    const container = containerRef.current;
    if (!map || !container) return;
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
      apply();
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [lat, lon, metresPerSvgUnit, svgSize]);

  return <div ref={containerRef} className="h-full w-full" />;
}
