/**
 * Three.js Globe Provider
 *
 * 3D globe implementation of the MapProvider interface using three-globe.
 * Renders flight tracks, task turnpoints, and events on a WGS84 globe
 * textured with Natural Earth I 1:50m raster data.
 */

import ThreeGlobe from 'three-globe';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  getBoundingBox, getEventStyle, calculateGlideMarkers,
  calculateOptimizedTaskLine, getOptimizedSegmentDistances,
  type IGCFix, type XCTask, type FlightEvent, type GlideContext, type TurnpointSequenceResult,
} from '@taskscore/engine';
import type { MapProvider, MapBounds } from './map-provider';
import { config } from './config';
import {
  TRACK_COLOR, TRACK_OUTLINE_COLOR, HIGHLIGHT_COLOR, TASK_COLOR,
  getTurnpointColor, KEY_EVENT_TYPES, getAltitudeColorNormalized,
  findNearestFixIndex, createCirclePolygon,
  createTrackPointHUD, updateTrackPointHUD, hideTrackPointHUD as sharedHideTrackPointHUD,
  CROSSHAIR_MAP_SVG,
  buildTrackPointHUDData, buildNextTurnpointContext, ensureTurnpointCache,
  formatGlideLabel, formatTurnpointLabel, computeSegmentLabels,
  createGlideLegend, showGlideLegend,
} from './map-provider-shared';

// ── Types ────────────────────────────────────────────────────────────────────

interface PathSpec {
  type: 'track-outline' | 'track' | 'task-route' | 'highlight';
  points: Array<{ lat: number; lng: number; alt: number }>;
  colors: string | string[];
  width: number;
  dashLen: number;
  dashGap: number;
}

interface PolygonSpec {
  geometry: GeoJSON.Polygon;
  color: string;
  index: number;
}

interface HtmlElementSpec {
  lat: number;
  lng: number;
  alt: number;
  el: HTMLElement;
  key: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const GLOBE_RADIUS = 100;
const CAMERA_STORAGE_KEY = 'taskscore:threejs-camera';

// ── Helpers ──────────────────────────────────────────────────────────────────

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Convert lat/lng/altitude to 3D position matching three-globe's polar2Cartesian */
function latLngToVec3(lat: number, lng: number, altitude: number): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180);
  const theta = (90 - lng) * (Math.PI / 180);
  const r = GLOBE_RADIUS * (1 + altitude);
  const phiSin = Math.sin(phi);
  return new THREE.Vector3(
    r * phiSin * Math.cos(theta),
    r * Math.cos(phi),
    r * phiSin * Math.sin(theta),
  );
}

/** Convert camera position to lat/lng matching three-globe's cartesian2Polar */
function cameraToLatLng(camera: THREE.Camera): { lat: number; lng: number } {
  const { x, y, z } = camera.position;
  const r = Math.sqrt(x * x + y * y + z * z);
  const phi = Math.acos(y / r);
  const theta = Math.atan2(z, x);
  const lat = 90 - phi * (180 / Math.PI);
  let lng = 90 - theta * (180 / Math.PI);
  if (theta < -Math.PI / 2) lng -= 360;
  return { lat, lng };
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function createThreeJsProvider(container: HTMLElement): Promise<MapProvider> {
  return new Promise((resolve) => {
    // State
    let currentFixes: IGCFix[] = [];
    let currentTask: XCTask | null = null;
    let currentEvents: FlightEvent[] = [];
    let isTrackVisible = true;
    let isTaskVisible = true;
    let isAltitudeColorsMode = false;
    let is3DMode = false;
    let altMin = 0;
    let altMax = 1;
    let altRange = 1;

    // Cached turnpoint data
    let cachedSequenceResult: TurnpointSequenceResult | null = null;
    let cachedOptimizedPath: { lat: number; lon: number }[] | null = null;

    // Path data arrays
    let trackPaths: PathSpec[] = [];
    let taskPaths: PathSpec[] = [];
    let highlightPaths: PathSpec[] = [];

    // Polygon data
    let taskPolygons: PolygonSpec[] = [];

    // HTML element data
    let eventElements: HtmlElementSpec[] = [];
    let taskLabelElements: HtmlElementSpec[] = [];
    let highlightElements: HtmlElementSpec[] = [];
    let crosshairElement: HtmlElementSpec | null = null;

    // Callbacks
    let trackClickCallback: ((fixIndex: number) => void) | null = null;
    let turnpointClickCallback: ((turnpointIndex: number) => void) | null = null;
    let boundsChangeCallback: (() => void) | null = null;
    let menuButtonCallback: (() => void) | null = null;
    let panelToggleCallback: (() => void) | null = null;

    // DOM elements
    let hudElement: HTMLElement | null = null;
    let glideLegendElement: HTMLElement | null = null;

    // Camera animation
    let cameraTarget: THREE.Vector3 | null = null;

    // ── Three.js setup ─────────────────────────────────────────────────────

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    container.style.position = 'relative';
    container.appendChild(renderer.domElement);

    // CSS2DRenderer for HTML overlay elements (turnpoint labels, event markers)
    const cssRenderer = new CSS2DRenderer();
    cssRenderer.setSize(container.clientWidth, container.clientHeight);
    cssRenderer.domElement.style.position = 'absolute';
    cssRenderer.domElement.style.top = '0';
    cssRenderer.domElement.style.left = '0';
    cssRenderer.domElement.style.pointerEvents = 'none';
    container.appendChild(cssRenderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a1a);

    const camera = new THREE.PerspectiveCamera(
      45,
      container.clientWidth / container.clientHeight,
      1,
      2000,
    );
    camera.position.set(0, 0, 300);

    // Restore saved camera position
    restoreCamera();

    // Lights
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(1, 1, 1);
    scene.add(sun);

    // Globe
    const globe = new ThreeGlobe({ animateIn: false })
      .globeImageUrl('/textures/earth.webp')
      .bumpImageUrl('/textures/earth-bump.webp')
      .atmosphereColor('#4FC3F7')
      .atmosphereAltitude(0.15)
      .showGraticules(false)
      .pathTransitionDuration(0)
      .polygonsTransitionDuration(0)
      .htmlTransitionDuration(0);

    scene.add(globe);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false;
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.minDistance = 100.01;
    controls.maxDistance = 600;
    controls.rotateSpeed = 0.5;

    // Save camera debounce
    let cameraSaveTimeout: ReturnType<typeof setTimeout> | null = null;
    controls.addEventListener('change', () => {
      boundsChangeCallback?.();
      if (cameraSaveTimeout) clearTimeout(cameraSaveTimeout);
      cameraSaveTimeout = setTimeout(saveCamera, 5000);
    });

    // ── Animation loop ─────────────────────────────────────────────────────

    let animationId: number;
    function animate() {
      animationId = requestAnimationFrame(animate);

      // Smooth camera animation
      if (cameraTarget) {
        camera.position.lerp(cameraTarget, 0.05);
        if (camera.position.distanceTo(cameraTarget) < 0.5) {
          camera.position.copy(cameraTarget);
          cameraTarget = null;
        }
      }

      // Adjust near clipping plane based on altitude above surface
      // so we never clip into the globe when zoomed close
      const altitude = camera.position.length() - GLOBE_RADIUS;
      camera.near = Math.max(0.001, altitude * 0.1);
      camera.far = camera.position.length() + GLOBE_RADIUS * 5;
      camera.updateProjectionMatrix();

      controls.update();
      renderer.render(scene, camera);
      cssRenderer.render(scene, camera);
    }
    animate();

    // ── Resize observer ────────────────────────────────────────────────────

    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
        cssRenderer.setSize(w, h);
      }
    });
    resizeObserver.observe(container);

    // ── Raycaster for click detection ──────────────────────────────────────

    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();

    renderer.domElement.addEventListener('click', (event) => {
      const rect = renderer.domElement.getBoundingClientRect();
      mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      raycaster.setFromCamera(mouse, camera);

      // Intersect with globe sphere
      const globeSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), GLOBE_RADIUS);
      const intersectPoint = new THREE.Vector3();
      if (raycaster.ray.intersectSphere(globeSphere, intersectPoint)) {
        // Convert intersection to lat/lng
        const p = intersectPoint.normalize();
        const lat = Math.asin(p.y) * (180 / Math.PI);
        const lng = Math.atan2(p.x, -p.z) * (180 / Math.PI);

        // Check for track click
        if (trackClickCallback && currentFixes.length > 0 && isTrackVisible) {
          const fixIndex = findNearestFixIndex(currentFixes, lat, lng);
          if (fixIndex >= 0) {
            // Check if click is reasonably close to the track
            const clickDist = Math.sqrt(
              Math.pow(lat - currentFixes[fixIndex].latitude, 2) +
              Math.pow(lng - currentFixes[fixIndex].longitude, 2),
            );
            if (clickDist < 2) { // ~2 degrees tolerance on globe
              trackClickCallback(fixIndex);
            }
          }
        }
      }
    });

    // ── DOM overlay controls ───────────────────────────────────────────────

    const controlStyle = `
      position:absolute; z-index:10; cursor:pointer;
      background:rgba(0,0,0,0.5); color:white; border:none; border-radius:6px;
      padding:6px 10px; font-size:13px; font-family:system-ui,sans-serif;
      backdrop-filter:blur(4px); transition:background 0.15s;
    `;

    // Menu button (top-left)
    const menuBtn = document.createElement('button');
    menuBtn.innerHTML = '\u2318K';
    menuBtn.title = 'Command Menu';
    menuBtn.style.cssText = controlStyle + 'top:10px;left:10px;';
    menuBtn.addEventListener('mouseenter', () => menuBtn.style.background = 'rgba(0,0,0,0.7)');
    menuBtn.addEventListener('mouseleave', () => menuBtn.style.background = 'rgba(0,0,0,0.5)');
    menuBtn.addEventListener('click', () => menuButtonCallback?.());
    container.appendChild(menuBtn);

    // Panel toggle button (top-right)
    const panelBtn = document.createElement('button');
    panelBtn.innerHTML = '\u2630';
    panelBtn.title = 'Analysis Panel';
    panelBtn.style.cssText = controlStyle + 'top:10px;right:10px;';
    panelBtn.addEventListener('mouseenter', () => panelBtn.style.background = 'rgba(0,0,0,0.7)');
    panelBtn.addEventListener('mouseleave', () => panelBtn.style.background = 'rgba(0,0,0,0.5)');
    panelBtn.addEventListener('click', () => panelToggleCallback?.());
    container.appendChild(panelBtn);

    // ── Camera helpers ─────────────────────────────────────────────────────

    function animateCameraTo(lat: number, lng: number, distance?: number) {
      const dist = distance ?? camera.position.length();
      cameraTarget = latLngToVec3(lat, lng, (dist / GLOBE_RADIUS) - 1);
    }

    function saveCamera() {
      const { x, y, z } = camera.position;
      localStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify({ x, y, z }));
    }

    function restoreCamera() {
      try {
        const saved = JSON.parse(localStorage.getItem(CAMERA_STORAGE_KEY) ?? 'null');
        if (saved) camera.position.set(saved.x, saved.y, saved.z);
      } catch { /* ignore */ }
    }

    /**
     * Compute camera distance from globe center so that a geographic bounding
     * box fills approximately 70% of the viewport.
     *
     * Geometry: the bbox endpoints sit on the globe surface (radius R). The
     * camera looks at the bbox center. The angular half-size of the bbox as
     * seen from the camera at distance d is:
     *   arctan(R·sin(halfSpan) / (d − R·cos(halfSpan)))
     * We set that equal to 35% of the FOV (so full span = 70% of viewport)
     * and solve for d.
     */
    function distanceToFitSpan(latSpan: number, lngSpan: number, centerLat: number): number {
      const FILL = 0.70;
      const vFovRad = camera.fov * (Math.PI / 180);
      const hFovRad = 2 * Math.atan(camera.aspect * Math.tan(vFovRad / 2));

      // Angular spans on the globe (lng shrinks with cos(lat))
      const latRad = Math.max(latSpan, 0.01) * (Math.PI / 180);
      const lngRad = Math.max(lngSpan * Math.cos(centerLat * Math.PI / 180), 0.01) * (Math.PI / 180);

      // Distance required for each axis
      const dForLat = GLOBE_RADIUS * (
        Math.cos(latRad / 2) + Math.sin(latRad / 2) / Math.tan(FILL / 2 * vFovRad)
      );
      const dForLng = GLOBE_RADIUS * (
        Math.cos(lngRad / 2) + Math.sin(lngRad / 2) / Math.tan(FILL / 2 * hFovRad)
      );

      // Take the larger (further back) so both axes fit
      const d = Math.max(dForLat, dForLng);
      return Math.max(controls.minDistance, Math.min(controls.maxDistance, d));
    }

    // ── Data rebuild functions ──────────────────────────────────────────────

    function getNormalizedAlt(fix: IGCFix): number {
      return altRange > 0 ? (fix.gnssAltitude - altMin) / altRange : 0;
    }

    function getFixAlt(fix: IGCFix): number {
      return is3DMode ? getNormalizedAlt(fix) * 0.05 : 0;
    }

    function rebuildPaths() {
      const allPaths: PathSpec[] = [];
      if (isTrackVisible) allPaths.push(...trackPaths);
      if (isTaskVisible) allPaths.push(...taskPaths);
      allPaths.push(...highlightPaths);

      globe
        .pathsData(allPaths)
        .pathPoints('points')
        .pathPointLat('lat')
        .pathPointLng('lng')
        .pathPointAlt('alt')
        .pathColor('colors')
        .pathStroke('width')
        .pathDashLength('dashLen')
        .pathDashGap('dashGap')
        .pathTransitionDuration(0);
    }

    function rebuildPolygons() {
      if (isTaskVisible) {
        globe
          .polygonsData(taskPolygons)
          .polygonGeoJsonGeometry('geometry' as any)
          .polygonCapColor(((d: any) => hexToRgba(d.color, 0.08)) as any)
          .polygonSideColor((() => 'rgba(0,0,0,0)') as any)
          .polygonStrokeColor(((d: any) => d.color) as any)
          .polygonAltitude(0.0005)
          .polygonsTransitionDuration(0);
      } else {
        globe.polygonsData([]).polygonsTransitionDuration(0);
      }
    }

    function rebuildHtmlElements() {
      const allElements: HtmlElementSpec[] = [];
      if (isTrackVisible) allElements.push(...eventElements);
      if (isTaskVisible) allElements.push(...taskLabelElements);
      allElements.push(...highlightElements);
      if (crosshairElement) allElements.push(crosshairElement);

      globe
        .htmlElementsData(allElements)
        .htmlLat('lat')
        .htmlLng('lng')
        .htmlAltitude('alt')
        .htmlElement(((d: any) => d.el) as any)
        .htmlTransitionDuration(0);
    }

    // ── Track rendering ────────────────────────────────────────────────────

    function buildTrackPaths() {
      if (currentFixes.length < 2) {
        trackPaths = [];
        return;
      }

      const points = currentFixes.map(f => ({
        lat: f.latitude,
        lng: f.longitude,
        alt: getFixAlt(f),
      }));

      if (isAltitudeColorsMode) {
        // Per-point altitude colors
        const colors = currentFixes.map(f => getAltitudeColorNormalized(getNormalizedAlt(f)));

        trackPaths = [
          {
            type: 'track-outline',
            points,
            colors: TRACK_OUTLINE_COLOR,
            width: 5,
            dashLen: 1,
            dashGap: 0,
          },
          {
            type: 'track',
            points,
            colors,
            width: 3,
            dashLen: 1,
            dashGap: 0,
          },
        ];
      } else {
        trackPaths = [
          {
            type: 'track-outline',
            points,
            colors: TRACK_OUTLINE_COLOR,
            width: 5,
            dashLen: 1,
            dashGap: 0,
          },
          {
            type: 'track',
            points,
            colors: TRACK_COLOR,
            width: 3,
            dashLen: 1,
            dashGap: 0,
          },
        ];
      }
    }

    // ── Task rendering ─────────────────────────────────────────────────────

    function buildTaskData() {
      if (!currentTask) {
        taskPaths = [];
        taskPolygons = [];
        taskLabelElements = [];
        return;
      }

      const optimizedLine = calculateOptimizedTaskLine(currentTask);
      const segmentDistances = getOptimizedSegmentDistances(currentTask);

      // Route line (dashed indigo)
      taskPaths = [{
        type: 'task-route',
        points: optimizedLine.map(p => ({ lat: p.lat, lng: p.lon, alt: 0.002 })),
        colors: TASK_COLOR,
        width: 3,
        dashLen: 0.3,
        dashGap: 0.15,
      }];

      // Cylinders as GeoJSON polygons
      taskPolygons = currentTask.turnpoints.map((tp, i) => {
        const polygon = createCirclePolygon(tp.waypoint.lon, tp.waypoint.lat, tp.radius);
        return {
          geometry: polygon,
          color: getTurnpointColor(tp.type ?? 'DEFAULT'),
          index: i,
        };
      });

      // Turnpoint labels as HTML elements
      // three-globe scales HTML elements with CSS3D perspective, so they appear
      // tiny at typical globe zoom. We use a large base size + transform: scale()
      // so they remain readable.
      taskLabelElements = currentTask.turnpoints.map((tp, i) => {
        const el = document.createElement('div');
        const color = getTurnpointColor(tp.type ?? 'DEFAULT');
        el.style.cssText = `
          pointer-events:auto; cursor:pointer; text-align:center; white-space:nowrap;
          transform:translate(-50%, -100%);
        `;

        // Dot
        const dot = document.createElement('div');
        dot.style.cssText = `
          width:14px; height:14px; border-radius:50%;
          background:${color}; border:2px solid white;
          box-shadow:0 2px 4px rgba(0,0,0,0.3);
          margin:0 auto 4px;
        `;
        el.appendChild(dot);

        // Label text
        const label = document.createElement('div');
        label.style.cssText = `
          font-size:13px; font-weight:600; color:#1e293b;
          text-shadow:-1px -1px 0 white,1px -1px 0 white,-1px 1px 0 white,1px 1px 0 white;
          line-height:1.3; max-width:200px;
        `;
        label.textContent = formatTurnpointLabel(tp, i);
        el.appendChild(label);

        el.addEventListener('click', (e) => {
          e.stopPropagation();
          turnpointClickCallback?.(i);
        });

        return { lat: tp.waypoint.lat, lng: tp.waypoint.lon, alt: 0.005, el, key: `tp-${i}` };
      });

      // Segment distance labels
      const segLabels = computeSegmentLabels(optimizedLine, segmentDistances);
      for (const sl of segLabels) {
        const el = document.createElement('div');
        el.style.cssText = `
          font-size:14px; font-weight:600; color:${TASK_COLOR};
          text-shadow:-1px -1px 0 #eee,1px -1px 0 #eee,-1px 1px 0 #eee,1px 1px 0 #eee;
          white-space:nowrap; pointer-events:none;
          transform:rotate(${sl.bearing}deg);
        `;
        el.textContent = sl.text;
        taskLabelElements.push({ lat: sl.midLat, lng: sl.midLon, alt: 0.003, el, key: `seg-${sl.text}` });
      }
    }

    // ── Event rendering ────────────────────────────────────────────────────

    function buildEventElements() {
      eventElements = [];
      const keyEvents = currentEvents.filter(e => KEY_EVENT_TYPES.has(e.type));

      for (const event of keyEvents) {
        const style = getEventStyle(event.type);
        const el = document.createElement('div');
        el.style.cssText = `
          width:20px; height:20px; border-radius:50%;
          background:${style.color}; border:2px solid white;
          cursor:pointer; box-shadow:0 2px 4px rgba(0,0,0,0.3);
          pointer-events:auto;
        `;
        el.title = `${event.type}: ${event.description}`;
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          // Trigger event selection through analysis panel
          // The main.ts wires this via onTrackClick + panel selection
        });

        eventElements.push({
          lat: event.latitude,
          lng: event.longitude,
          alt: 0.005,
          el,
          key: `event-${event.id}`,
        });
      }
    }

    // ── Turnpoint context for HUD ──────────────────────────────────────────

    function getNextTurnpointContext(glideStartTime: number): GlideContext | undefined {
      if (!currentTask || currentFixes.length === 0) return undefined;
      const cache = ensureTurnpointCache(currentTask, currentFixes, {
        sequenceResult: cachedSequenceResult,
        optimizedPath: cachedOptimizedPath,
      });
      cachedSequenceResult = cache.sequenceResult;
      cachedOptimizedPath = cache.optimizedPath;

      return buildNextTurnpointContext(
        currentTask,
        currentFixes,
        cache.sequenceResult,
        cache.optimizedPath,
        glideStartTime,
        (_lat, _lon, altSmoothed) => altSmoothed ?? null,
      );
    }

    // ── Highlight helpers ──────────────────────────────────────────────────

    function clearHighlights() {
      highlightPaths = [];
      highlightElements = [];
      crosshairElement = null;
    }

    // ── Resolve and build the provider ─────────────────────────────────────

    const provider: MapProvider = {
      supports3D: true,
      supportsAltitudeColors: true,

      setTrack(fixes: IGCFix[]) {
        currentFixes = fixes;
        cachedSequenceResult = null;
        cachedOptimizedPath = null;

        // Compute altitude range
        if (fixes.length > 0) {
          const altitudes = fixes.map(f => f.gnssAltitude);
          altMin = Math.min(...altitudes);
          altMax = Math.max(...altitudes);
          altRange = altMax - altMin || 1;
        }

        buildTrackPaths();
        rebuildPaths();

        // Fit view to track — compute camera distance so bbox fills ~70% of viewport
        if (fixes.length > 0) {
          const bbox = getBoundingBox(fixes);
          const centerLat = (bbox.minLat + bbox.maxLat) / 2;
          const centerLng = (bbox.minLon + bbox.maxLon) / 2;
          const dist = distanceToFitSpan(bbox.maxLat - bbox.minLat, bbox.maxLon - bbox.minLon, centerLat);
          animateCameraTo(centerLat, centerLng, dist);
        }
      },

      clearTrack() {
        currentFixes = [];
        trackPaths = [];
        cachedSequenceResult = null;
        cachedOptimizedPath = null;
        clearHighlights();
        rebuildPaths();
        rebuildHtmlElements();
      },

      async setTask(task: XCTask) {
        currentTask = task;
        cachedSequenceResult = null;
        cachedOptimizedPath = null;
        buildTaskData();
        rebuildPaths();
        rebuildPolygons();
        rebuildHtmlElements();
      },

      clearTask() {
        currentTask = null;
        taskPaths = [];
        taskPolygons = [];
        taskLabelElements = [];
        cachedSequenceResult = null;
        cachedOptimizedPath = null;
        rebuildPaths();
        rebuildPolygons();
        rebuildHtmlElements();
      },

      setEvents(events: FlightEvent[]) {
        currentEvents = events;
        buildEventElements();
        rebuildHtmlElements();
      },

      clearEvents() {
        currentEvents = [];
        eventElements = [];
        clearHighlights();
        rebuildHtmlElements();
      },

      panToEvent(event: FlightEvent, options?: { skipPan?: boolean }) {
        clearHighlights();

        // Glide legend
        const isGlideEvent = event.type === 'glide_start' || event.type === 'glide_end';
        if (isGlideEvent && !glideLegendElement) {
          glideLegendElement = createGlideLegend(container);
          glideLegendElement.style.display = 'none';
        }
        showGlideLegend(glideLegendElement, isGlideEvent);

        // Highlight segment
        if (event.segment && currentFixes.length > 0) {
          const { startIndex, endIndex } = event.segment;
          const segmentFixes = currentFixes.slice(startIndex, endIndex + 1);

          if (segmentFixes.length > 1) {
            highlightPaths = [{
              type: 'highlight',
              points: segmentFixes.map(f => ({
                lat: f.latitude,
                lng: f.longitude,
                alt: getFixAlt(f) + 0.001,
              })),
              colors: HIGHLIGHT_COLOR,
              width: 6,
              dashLen: 1,
              dashGap: 0,
            }];

            // Glide chevrons and speed labels
            if (isGlideEvent) {
              const glideMarkers = calculateGlideMarkers(segmentFixes, getNextTurnpointContext);
              for (const gm of glideMarkers) {
                if (gm.type === 'speed-label') {
                  const { speed, detailText, reqText } = formatGlideLabel(gm);
                  const el = document.createElement('div');
                  el.style.cssText = `
                    font-size:13px; font-weight:600; color:#3b82f6;
                    white-space:nowrap; text-align:center; line-height:1.3;
                    text-shadow:-1px -1px 0 white,1px -1px 0 white,-1px 1px 0 white,1px 1px 0 white;
                    pointer-events:none;
                  `;
                  el.innerHTML = reqText
                    ? `${speed}<br>${detailText}<br>${reqText}`
                    : `${speed}<br>${detailText}`;
                  highlightElements.push({
                    lat: gm.lat, lng: gm.lon, alt: 0.015, el, key: `glide-label-${gm.lat}`,
                  });
                } else {
                  // Chevron
                  const el = document.createElement('div');
                  el.style.cssText = `display:flex;align-items:center;justify-content:center;pointer-events:none;`;
                  el.innerHTML = `<svg width="20" height="12" viewBox="0 0 20 12" style="transform:rotate(${gm.bearing}deg);">
                    <path d="M2 10 L10 2 L18 10" fill="none" stroke="#3b82f6" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                  </svg>`;
                  highlightElements.push({
                    lat: gm.lat, lng: gm.lon, alt: 0.01, el, key: `chevron-${gm.lat}`,
                  });
                }
              }
            }
          }
        }

        // Endpoint markers
        const style = getEventStyle(event.type);
        const isStartEvent = event.type === 'thermal_entry' || event.type === 'glide_start';

        if (event.segment && currentFixes.length > 0) {
          const startFix = currentFixes[event.segment.startIndex];
          const endFix = currentFixes[event.segment.endIndex];

          // Start marker (ring)
          const startEl = document.createElement('div');
          startEl.style.cssText = `
            width:14px; height:14px; border-radius:50%;
            background:transparent; border:3px solid ${style.color};
            box-shadow:0 2px 6px rgba(0,0,0,0.4);
            pointer-events:none;
          `;
          if (isStartEvent) startEl.classList.add('throb-marker');
          highlightElements.push({
            lat: startFix.latitude, lng: startFix.longitude, alt: getFixAlt(startFix) + 0.002,
            el: startEl, key: 'highlight-start',
          });

          // End marker (filled)
          const endEl = document.createElement('div');
          endEl.style.cssText = `
            width:14px; height:14px; border-radius:50%;
            background:${style.color}; border:3px solid white;
            box-shadow:0 2px 6px rgba(0,0,0,0.4);
            pointer-events:none;
          `;
          if (!isStartEvent) endEl.classList.add('throb-marker');
          highlightElements.push({
            lat: endFix.latitude, lng: endFix.longitude, alt: getFixAlt(endFix) + 0.002,
            el: endEl, key: 'highlight-end',
          });
        } else {
          // Single point marker
          const markerEl = document.createElement('div');
          markerEl.style.cssText = `
            width:16px; height:16px; border-radius:50%;
            background:${style.color}; border:3px solid white;
            box-shadow:0 2px 6px rgba(0,0,0,0.4);
            pointer-events:none;
          `;
          markerEl.classList.add('throb-marker');
          highlightElements.push({
            lat: event.latitude, lng: event.longitude, alt: 0.005,
            el: markerEl, key: 'highlight-single',
          });
        }

        rebuildPaths();
        rebuildHtmlElements();

        if (!options?.skipPan) {
          animateCameraTo(event.latitude, event.longitude);
        }
      },

      getBounds(): MapBounds {
        const { lat, lng } = cameraToLatLng(camera);
        const dist = camera.position.length();
        const halfExtent = Math.asin(Math.min(1, GLOBE_RADIUS / dist)) * (180 / Math.PI);
        return {
          north: Math.min(90, lat + halfExtent),
          south: Math.max(-90, lat - halfExtent),
          west: lng - halfExtent,
          east: lng + halfExtent,
        };
      },

      onBoundsChange(callback: () => void) {
        boundsChangeCallback = callback;
      },

      destroy() {
        cancelAnimationFrame(animationId);
        resizeObserver.disconnect();
        controls.dispose();
        renderer.dispose();
        renderer.domElement.remove();
        cssRenderer.domElement.remove();
        menuBtn.remove();
        panelBtn.remove();
        hudElement?.remove();
        glideLegendElement?.remove();
      },

      invalidateSize() {
        const w = container.clientWidth;
        const h = container.clientHeight;
        if (w > 0 && h > 0) {
          camera.aspect = w / h;
          camera.updateProjectionMatrix();
          renderer.setSize(w, h);
          cssRenderer.setSize(w, h);
        }
      },

      set3DMode(enabled: boolean) {
        is3DMode = enabled;
        buildTrackPaths();
        // Rebuild highlight paths too since they use altitude
        // Note: highlights will be rebuilt on next panToEvent call
        rebuildPaths();
      },

      setAltitudeColors(enabled: boolean) {
        isAltitudeColorsMode = enabled;
        buildTrackPaths();
        rebuildPaths();
      },

      setTaskVisibility(visible: boolean) {
        isTaskVisible = visible;
        rebuildPaths();
        rebuildPolygons();
        rebuildHtmlElements();
      },

      setTrackVisibility(visible: boolean) {
        isTrackVisible = visible;
        rebuildPaths();
        rebuildHtmlElements();
      },

      onTrackClick(callback: (fixIndex: number) => void) {
        trackClickCallback = callback;
      },

      onTurnpointClick(callback: (turnpointIndex: number) => void) {
        turnpointClickCallback = callback;
      },

      panToTurnpoint(turnpointIndex: number) {
        if (!currentTask || turnpointIndex < 0 || turnpointIndex >= currentTask.turnpoints.length) {
          return;
        }
        const tp = currentTask.turnpoints[turnpointIndex];
        animateCameraTo(tp.waypoint.lat, tp.waypoint.lon);
      },

      showTrackPointHUD(fixIndex: number) {
        const data = buildTrackPointHUDData(currentFixes, currentEvents, fixIndex, getNextTurnpointContext);
        if (!data) return;

        // Hide glide legend
        showGlideLegend(glideLegendElement, false);

        // Clear previous crosshair
        crosshairElement = null;

        // Add crosshair marker
        const crosshairEl = document.createElement('div');
        crosshairEl.innerHTML = CROSSHAIR_MAP_SVG;
        crosshairEl.style.cssText = 'pointer-events:none;';
        crosshairElement = {
          lat: data.fix.latitude,
          lng: data.fix.longitude,
          alt: getFixAlt(data.fix) + 0.002,
          el: crosshairEl,
          key: 'crosshair',
        };
        rebuildHtmlElements();

        // Show HUD
        if (!hudElement) {
          hudElement = createTrackPointHUD(container);
        }
        updateTrackPointHUD(hudElement, data);
      },

      hideTrackPointHUD() {
        sharedHideTrackPointHUD(hudElement);
        crosshairElement = null;
        rebuildHtmlElements();
      },

      onMenuButtonClick(callback: () => void) {
        menuButtonCallback = callback;
      },

      onPanelToggleClick(callback: () => void) {
        panelToggleCallback = callback;
      },
    };

    resolve(provider);
  });
}
