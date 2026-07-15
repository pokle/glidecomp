/**
 * Read-only evidence map for the score-details page.
 *
 * Thin React wrapper around the shared analysis MapProvider (Mapbox — the
 * same renderer the analysis page uses, so visuals follow
 * docs/mapbox-interactions-spec.md). Loaded lazily so the map library
 * stays out of the main app bundle.
 */
import { useEffect, useRef, useState } from "react";
import type { FlightEvent, IGCFix, XCTask } from "@glidecomp/engine";
import {
  createMapProvider,
  type MapProvider,
  type OpenDistanceLine,
  type BestProgressRoute,
} from "../../analysis/map-provider";
import "mapbox-gl/dist/mapbox-gl.css";

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
  bestProgressRoute,
}: {
  task: XCTask | null;
  fixes: IGCFix[] | null;
  events: FlightEvent[];
  focus: MapFocus | null;
  /** The scored open-distance line (exit → furthest), when applicable. */
  openDistanceLine?: OpenDistanceLine | null;
  /** A landed-out pilot's routed distance-to-goal line, when applicable. */
  bestProgressRoute?: BestProgressRoute | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [provider, setProvider] = useState<MapProvider | null>(null);
  // On unmount React runs effect cleanups in definition order, so the map is
  // destroy()ed before the data-effect cleanups below run. Calling clear*()
  // on a destroyed Mapbox map throws (its style is gone), and an error thrown
  // while React is unmounting for a navigation takes the whole app down — a
  // blank page on browser-back. This flag lets the later cleanups skip work
  // that destroy() already did.
  const destroyedRef = useRef(false);

  // Create the provider once per mount; destroy on unmount. Each mount gets
  // its own inner DOM node — StrictMode mounts twice, and the async provider
  // creation races otherwise over a shared container.
  useEffect(() => {
    const outer = containerRef.current;
    if (!outer) return;
    const inner = document.createElement("div");
    inner.style.width = "100%";
    inner.style.height = "100%";
    outer.appendChild(inner);
    let cancelled = false;
    let created: MapProvider | null = null;
    destroyedRef.current = false;
    createMapProvider(inner, { appControls: false })
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
      destroyedRef.current = true;
      try {
        created?.destroy();
      } catch (err) {
        console.warn("Map teardown failed:", err);
      }
      setProvider(null);
      inner.remove();
    };
  }, []);

  useEffect(() => {
    if (!provider || !task) return;
    void provider.setTask(task);
    return () => {
      if (!destroyedRef.current) provider.clearTask();
    };
  }, [provider, task]);

  useEffect(() => {
    if (!provider || !fixes || fixes.length === 0) return;
    provider.setTrack(fixes);
    return () => {
      if (!destroyedRef.current) provider.clearTrack();
    };
  }, [provider, fixes]);

  useEffect(() => {
    if (!provider || events.length === 0) return;
    provider.setEvents(events);
    return () => {
      if (!destroyedRef.current) provider.clearEvents();
    };
  }, [provider, events]);

  useEffect(() => {
    if (!provider || !openDistanceLine) return;
    provider.setOpenDistanceLines?.([openDistanceLine]);
    return () => {
      if (!destroyedRef.current) provider.clearOpenDistanceLines?.();
    };
  }, [provider, openDistanceLine]);

  useEffect(() => {
    if (!provider || !bestProgressRoute) return;
    provider.setBestProgressRoute?.(bestProgressRoute);
    return () => {
      if (!destroyedRef.current) provider.clearBestProgressRoute?.();
    };
  }, [provider, bestProgressRoute]);

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
