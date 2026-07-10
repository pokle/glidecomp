/**
 * Editable route map for the task route editor (RouteEditorDialog).
 *
 * A thin React wrapper around the shared analysis MapProvider — the same
 * Mapbox/Leaflet renderers the score-details map uses, so visuals follow
 * docs/mapbox-interactions-spec.md. It renders the task being edited live
 * (cylinders + optimised route line), draws loaded waypoints as pickable
 * markers, and reports picks back:
 *   - clicking a waypoint marker  → onWaypointPick(waypoint)
 *   - clicking bare ground (pick mode) → onMapPick(lat, lon)
 *
 * Loaded lazily (via React.lazy in the dialog) so the map libraries and CSS
 * stay out of the SSR'd task-detail bundle.
 */
import { useEffect, useRef, useState } from "react";
import type { XCTask } from "@glidecomp/engine";
import {
  createMapProvider,
  type MapProvider,
  type MapWaypoint,
} from "../../analysis/map-provider";
import "mapbox-gl/dist/mapbox-gl.css";
import "leaflet/dist/leaflet.css";

export default function RouteMap({
  task,
  waypoints,
  addMode,
  onWaypointPick,
  onMapPick,
}: {
  /** The task being edited — drawn live as cylinders + optimised route line. */
  task: XCTask | null;
  /** Loaded waypoints, drawn as pickable markers. */
  waypoints: MapWaypoint[];
  /**
   * When false (default): a tap picks the nearest loaded waypoint within a
   * finger-friendly tolerance. When true: a tap reports its ground point via
   * onMapPick so the editor can place a brand-new waypoint (crosshair cursor).
   */
  addMode: boolean;
  onWaypointPick: (waypoint: MapWaypoint) => void;
  onMapPick: (lat: number, lon: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [provider, setProvider] = useState<MapProvider | null>(null);
  // See ScoreDetailMap: clear*() on a destroyed map throws and blanks the app
  // on unmount; this flag lets the data-effect cleanups skip what destroy did.
  const destroyedRef = useRef(false);

  // Latest pick handlers held in refs so the provider callbacks (registered
  // once) always call the current closure without re-registering.
  const onWaypointPickRef = useRef(onWaypointPick);
  const onMapPickRef = useRef(onMapPick);
  onWaypointPickRef.current = onWaypointPick;
  onMapPickRef.current = onMapPick;

  // Create the provider once per mount; destroy on unmount. Each mount gets
  // its own inner node (StrictMode double-mount + Leaflet re-init guard).
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
    const providerType = import.meta.env.VITE_MAPBOX_TOKEN ? "mapbox" : "leaflet";
    createMapProvider(inner, providerType, { appControls: false })
      .then((p) => {
        if (cancelled) {
          p.destroy();
          return;
        }
        created = p;
        p.onWaypointClick?.((wp) => onWaypointPickRef.current(wp));
        p.onMapClick?.((lat, lon) => onMapPickRef.current(lat, lon));
        setProvider(p);
      })
      .catch((err) => {
        console.error("Failed to initialise route map:", err);
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

  // Fit the view when the route first appears and each time it grows (open,
  // pick, add) — but not on coordinate-only edits (drag, typing), so fine
  // adjustments don't re-zoom the map out from under the user.
  const lastFitCountRef = useRef(-1);
  useEffect(() => {
    if (!provider) return;
    const count = task?.turnpoints.length ?? 0;
    if (task && count > 0) {
      void provider.setTask(task, { fit: count > lastFitCountRef.current });
      lastFitCountRef.current = count;
    } else if (!destroyedRef.current) {
      provider.clearTask();
      lastFitCountRef.current = -1;
    }
  }, [provider, task]);

  useEffect(() => {
    if (!provider) return;
    provider.setWaypoints?.(waypoints);
    return () => {
      if (!destroyedRef.current) provider.clearWaypoints?.();
    };
  }, [provider, waypoints]);

  useEffect(() => {
    if (!provider) return;
    provider.setInteractionMode?.(addMode ? "add-waypoint" : "view");
  }, [provider, addMode]);

  // Keep the map painted correctly as the responsive layout resizes it.
  useEffect(() => {
    const container = containerRef.current;
    if (!provider || !container) return;
    const observer = new ResizeObserver(() => provider.invalidateSize());
    observer.observe(container);
    return () => observer.disconnect();
  }, [provider]);

  return <div ref={containerRef} className="h-full w-full" />;
}
