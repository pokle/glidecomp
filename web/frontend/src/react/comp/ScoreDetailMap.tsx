/**
 * Read-only evidence map for the score-details page.
 *
 * Thin React wrapper around the shared analysis MapProvider (Mapbox or
 * Leaflet — the same renderers the analysis page uses, so visuals follow
 * docs/mapbox-interactions-spec.md). Loaded lazily so the map libraries
 * stay out of the main app bundle.
 */
import { useEffect, useRef, useState } from "react";
import type { FlightEvent, IGCFix, XCTask } from "@glidecomp/engine";
import {
  createMapProvider,
  type MapProvider,
  type OpenDistanceLine,
} from "../../analysis/map-provider";
import "mapbox-gl/dist/mapbox-gl.css";
import "leaflet/dist/leaflet.css";

/** A pan/highlight request — bump `nonce` to re-trigger the same event. */
export interface MapFocus {
  event: FlightEvent;
  nonce: number;
}

export default function ScoreDetailMap({
  task,
  fixes,
  events,
  focus,
  openDistanceLine,
}: {
  task: XCTask | null;
  fixes: IGCFix[] | null;
  events: FlightEvent[];
  focus: MapFocus | null;
  /** The scored open-distance line (exit → furthest), when applicable. */
  openDistanceLine?: OpenDistanceLine | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [provider, setProvider] = useState<MapProvider | null>(null);

  // Create the provider once per mount; destroy on unmount (guarding the
  // async creation against StrictMode's mount/unmount/mount cycle).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let created: MapProvider | null = null;
    const providerType = import.meta.env.VITE_MAPBOX_TOKEN ? "mapbox" : "leaflet";
    createMapProvider(container, providerType, { appControls: false })
      .then((p) => {
        if (cancelled) {
          p.destroy();
          return;
        }
        created = p;
        setProvider(p);
      })
      .catch((err) => {
        console.error("Failed to initialise map:", err);
      });
    return () => {
      cancelled = true;
      created?.destroy();
      setProvider(null);
    };
  }, []);

  useEffect(() => {
    if (!provider || !task) return;
    void provider.setTask(task);
    return () => provider.clearTask();
  }, [provider, task]);

  useEffect(() => {
    if (!provider || !fixes || fixes.length === 0) return;
    provider.setTrack(fixes);
    return () => provider.clearTrack();
  }, [provider, fixes]);

  useEffect(() => {
    if (!provider || events.length === 0) return;
    provider.setEvents(events);
    return () => provider.clearEvents();
  }, [provider, events]);

  useEffect(() => {
    if (!provider || !openDistanceLine) return;
    provider.setOpenDistanceLines?.([openDistanceLine]);
    return () => provider.clearOpenDistanceLines?.();
  }, [provider, openDistanceLine]);

  useEffect(() => {
    if (!provider || !focus) return;
    provider.panToEvent(focus.event);
  }, [provider, focus]);

  // Keep the map painted correctly when the responsive layout resizes it.
  useEffect(() => {
    const container = containerRef.current;
    if (!provider || !container) return;
    const observer = new ResizeObserver(() => provider.invalidateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [provider]);

  return <div ref={containerRef} className="h-full w-full" />;
}
