/**
 * Editable route map for the task route editor (RouteEditorDialog).
 *
 * A thin React wrapper around the shared analysis MapProvider — the same
 * Mapbox renderer the score-details map uses, so visuals follow
 * docs/mapbox-interactions-spec.md. It renders the task being edited live
 * (cylinders + optimised route line), draws loaded waypoints as pickable
 * markers, and reports picks back:
 *   - clicking a waypoint marker  → onWaypointPick(waypoint)
 *   - clicking bare ground (pick mode) → onMapPick(lat, lon)
 *
 * Loaded lazily (via React.lazy in the dialog) so the map library and CSS
 * stay out of the SSR'd task-detail bundle.
 */
import { useEffect, useRef, useState } from "react";
import type { XCTask } from "@glidecomp/engine";
import {
  createMapProvider,
  type MapPickDetails,
  type MapProvider,
  type MapWaypoint,
} from "../../analysis/map-provider";
import "mapbox-gl/dist/mapbox-gl.css";

export default function RouteMap({
  task,
  waypoints,
  addMode,
  fitNonce,
  focus,
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
  /**
   * Bump this to fit the view to the current waypoints (e.g. after loading a
   * file). Fitting is NOT tied to every `waypoints` change, so editing a
   * coordinate doesn't re-zoom the map out from under the user.
   */
  fitNonce?: number;
  /**
   * Fly the map to a waypoint's coordinates (from a table-row click). `key`
   * changes on every request so clicking the same row re-centres after the
   * user has panned away; the coordinates themselves don't retrigger.
   */
  focus?: { lat: number; lon: number; key: number } | null;
  onWaypointPick: (waypoint: MapWaypoint) => void;
  /** Ground pick. `details` carries best-effort extras from the Mapbox data
   *  (ground elevation, nearby place name), when available. */
  onMapPick: (lat: number, lon: number, details?: MapPickDetails) => void;
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
  // its own inner node (StrictMode double-mount guard over a shared container).
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
        p.onWaypointClick?.((wp) => onWaypointPickRef.current(wp));
        p.onMapClick?.((lat, lon, details) => onMapPickRef.current(lat, lon, details));
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

  // Fit to the waypoints only when the caller bumps fitNonce (e.g. after a
  // load), so editing a coordinate doesn't re-zoom the map.
  const lastFitNonce = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!provider || waypoints.length === 0) return;
    if (fitNonce !== lastFitNonce.current) {
      lastFitNonce.current = fitNonce;
      provider.fitToWaypoints?.();
    }
  }, [provider, fitNonce, waypoints]);

  useEffect(() => {
    if (!provider) return;
    provider.setInteractionMode?.(addMode ? "add-waypoint" : "view");
  }, [provider, addMode]);

  // Fly to a waypoint when a table row asks to (keyed so repeat clicks re-centre).
  const lastFocusKey = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!provider || !focus) return;
    if (focus.key === lastFocusKey.current) return;
    lastFocusKey.current = focus.key;
    provider.panTo?.(focus.lat, focus.lon);
  }, [provider, focus]);

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
