// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * FlightScene — the backend-agnostic Three.js content for the replay:
 * merged trail LineSegments (GPU-time-animated ShaderMaterial), task cylinders,
 * and InstancedMesh current-position markers.
 *
 * It is deliberately decoupled from *how* it's drawn so the same objects can be
 * hosted by either the standalone abstract backend (its own camera) or the
 * Mapbox terrain backend (a custom layer with a mercator model matrix).
 *
 * Vertical exaggeration is therefore applied per-object, NOT via a parent
 * group scale:
 *   - trails:    `uVScale` multiplies position.y in the vertex shader
 *   - markers:   y is multiplied by vScale in JS (keeps the cone undistorted)
 *   - cylinders: the wall mesh is scaled on its own Y axis
 * This keeps every host transform uniform, so neither backend has to special-case
 * a non-uniform scale (which would shear the marker cones).
 */

import * as THREE from 'three';
import { samplePilot, type LoadedTracks } from './track-data';
import { type GaggleResult } from './gaggles';
import { GaggleLayer } from './gaggle-layer';

export type ColorMode = 'pilot' | 'altitude' | 'vario' | 'speed' | 'glide';

const UP = new THREE.Vector3(0, 1, 0);
const WALL_HEIGHT = 1400; // metres, task-cylinder walls (pre vertical exaggeration)
const TASK_LINE_COLOR = 0x6366f1; // indigo — matches the 2D analysis optimised line

/** Vertical-speed colour mode saturates at ±this many m/s. */
export const VARIO_MAX = 4;

/**
 * Speed colour mode ramps from SPEED_MIN to SPEED_MAX m/s (≈18–108 km/h).
 * The floor isn't 0 because nobody flies below stall speed — starting the
 * ramp there would waste its bottom third and compress the useful range.
 */
export const SPEED_MIN = 5;
export const SPEED_MAX = 30;

/**
 * Glide-ratio colour mode: the ramp runs logarithmically from GLIDE_LO to
 * GLIDE_HI (ratios span a large range, and 4 → 8 matters as much as 16 → 32).
 * Climbing / level segments render as a flat colour — glide ratio is
 * effectively infinite there (the shader reuses the themed vario-zero colour).
 */
export const GLIDE_LO = 2;
export const GLIDE_HI = 32;

/** One pilot's interpolated marker state in local ENU metres (y already exaggerated). */
export interface MarkerSample {
  pilot: number;
  active: boolean;
  /** True once the pilot has landed — the marker is held at the landing spot. */
  landed: boolean;
  x: number;
  y: number;
  z: number;
  /** Altitude MSL (metres), un-exaggerated. */
  altMsl: number;
  /** Climb rate, m/s (averaged over the caller's fixed smoothing window). */
  climb: number;
  /** Ground speed, m/s (averaged over the same window). */
  speed: number;
  /** Near-instantaneous climb, m/s (±3-fix window) — the live gauge needle. */
  climbInst: number;
  name: string;
}

export class FlightScene {
  /** Trails + task cylinders. Add to the render root. */
  readonly group = new THREE.Group();
  /** Current-position markers. Add to the render root. */
  markers!: THREE.InstancedMesh;
  /**
   * Light mode only: a dark inverted-hull silhouette behind each cone, so
   * pale pilot colours (light lime, yellow…) still read against the
   * off-white backdrop without altering the identity colour itself. Lives in
   * `group`; matrices mirror `markers` each frame.
   */
  private markerOutlines?: THREE.InstancedMesh;

  readonly center = new THREE.Vector3();
  extentXZ = 1000;
  readonly bbox = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  private tracks: LoadedTracks;
  private trailMat!: THREE.ShaderMaterial;
  private dummy = new THREE.Object3D();
  private dir = new THREE.Vector3(); // scratch, reused per marker per frame
  private samplesOut: MarkerSample[] = []; // reused each frame (one per pilot)
  private vScale = 3;
  private highlight = -1;
  private width = 3; // trail width in CSS px
  private disposed = false;

  // gaggle overlay (Phase 2): translucent hull blobs + count labels, recomputed
  // each frame from live member samples (see GaggleLayer).
  private gaggles?: GaggleResult;
  private gaggleLayer?: GaggleLayer;

  /**
   * `light` themes the in-scene furniture for a light backdrop (abstract
   * light mode): dark ground-label text with a light halo, and a darker
   * vario-ramp "zero" so near-level trail segments don't vanish into an
   * off-white background. The terrain backdrop always builds with
   * `light = false` — there the backdrop is map imagery, not the UI theme.
   */
  constructor(
    tracks: LoadedTracks,
    gaggles?: GaggleResult,
    private light = false,
  ) {
    this.tracks = tracks;
    this.gaggles = gaggles;
    this.buildTrails();
    this.buildMarkers();
    this.buildTaskGeometry();
    this.buildGaggleLayer();
  }

  get alt0(): number {
    return this.tracks.manifest.origin.alt0;
  }
  get nPilots(): number {
    return this.tracks.manifest.pilots.length;
  }
  get altRange(): number {
    return this.tracks.manifest.altMax - this.tracks.manifest.altMin;
  }

  // --- build ---------------------------------------------------------------

  private buildTrails(): void {
    const { pos, time, pilotIndex, index, manifest } = this.tracks;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aTime', new THREE.BufferAttribute(time, 1));
    geom.setAttribute('aPilot', new THREE.BufferAttribute(pilotIndex, 1));
    geom.setAttribute('aVario', new THREE.BufferAttribute(this.tracks.vario, 1));
    geom.setAttribute('aSpeed', new THREE.BufferAttribute(this.tracks.speed, 1));
    geom.setIndex(new THREE.BufferAttribute(index, 1));

    const nPilots = manifest.pilots.length;
    const colors: THREE.Vector3[] = [];
    for (let i = 0; i < nPilots; i++) {
      const c = manifest.colors[i] ?? [0.8, 0.8, 0.8];
      colors.push(new THREE.Vector3(c[0], c[1], c[2]));
    }

    // One uniforms object shared by the line and the points pass so both stay in
    // sync from a single update.
    const uniforms = {
      uTime: { value: 0 },
      uTailSeconds: { value: 1e9 },
      uColors: { value: colors },
      uVisible: { value: new Float32Array(nPilots).fill(1) },
      uColorMode: { value: 0 },
      uHighlight: { value: -1 },
      uVScale: { value: this.vScale },
      uAltMin: { value: manifest.altMin },
      uAltMax: { value: manifest.altMax },
      uVarioMax: { value: VARIO_MAX },
      uSpeedMin: { value: SPEED_MIN },
      uSpeedMax: { value: SPEED_MAX },
      uWidth: { value: this.width * pixelRatio() },
      // vario-ramp "zero": pale on the dark backdrop, slate on the light one
      uVarioZero: {
        value: this.light ? new THREE.Vector3(0.42, 0.45, 0.5) : new THREE.Vector3(0.85, 0.85, 0.88),
      },
    };

    // depthTest off so trails are never hidden by terrain (and never z-fight it).
    const common = { transparent: true, depthWrite: false, depthTest: false, blending: THREE.NormalBlending } as const;

    this.trailMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: trailVertexShader(nPilots),
      fragmentShader: trailFragmentShader(false),
      ...common,
    });
    const lines = new THREE.LineSegments(geom, this.trailMat);
    lines.frustumCulled = false;
    this.group.add(lines);

    // Round points carry the adjustable width (gl.LINES width is capped at 1px on
    // most platforms). Same attributes, no index (one point per fix), shared uniforms.
    const pgeom = new THREE.BufferGeometry();
    for (const name of ['position', 'aTime', 'aPilot', 'aVario', 'aSpeed']) {
      pgeom.setAttribute(name, geom.getAttribute(name));
    }
    const pointMat = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: trailVertexShader(nPilots),
      fragmentShader: trailFragmentShader(true),
      ...common,
    });
    const points = new THREE.Points(pgeom, pointMat);
    points.frustumCulled = false;
    this.group.add(points);

    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] < minX) minX = pos[i];
      if (pos[i] > maxX) maxX = pos[i];
      if (pos[i + 2] < minZ) minZ = pos[i + 2];
      if (pos[i + 2] > maxZ) maxZ = pos[i + 2];
    }
    Object.assign(this.bbox, { minX, maxX, minZ, maxZ });
    this.extentXZ = Math.max(maxX - minX, maxZ - minZ, 1000);
    this.center.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  }

  private buildMarkers(): void {
    const n = this.nPilots;
    const size = this.extentXZ * 0.012;
    const geom = new THREE.ConeGeometry(size * 0.5, size * 1.8, 10);
    const mat = new THREE.MeshBasicMaterial(); // per-instance colour via setColorAt
    this.markers = new THREE.InstancedMesh(geom, mat, n);
    this.markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.markers.frustumCulled = false;

    if (this.light) {
      // inverted hull: a ~16% larger back-face-only cone reads as a dark rim
      const outlineGeom = new THREE.ConeGeometry(size * 0.5 * 1.16, size * 1.8 * 1.16, 10);
      this.markerOutlines = new THREE.InstancedMesh(
        outlineGeom,
        new THREE.MeshBasicMaterial({ color: 0x334155, side: THREE.BackSide }),
        n,
      );
      this.markerOutlines.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.markerOutlines.frustumCulled = false;
      this.group.add(this.markerOutlines);
    }

    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const c = this.tracks.manifest.colors[i] ?? [0.8, 0.8, 0.8];
      col.setRGB(c[0], c[1], c[2]);
      this.markers.setColorAt(i, col);
      // Reused per-frame sample objects; names never change so set them once.
      this.samplesOut.push({
        pilot: i,
        active: false,
        landed: false,
        x: 0,
        y: 0,
        z: 0,
        altMsl: 0,
        climb: 0,
        speed: 0,
        climbInst: 0,
        name: this.tracks.manifest.pilots[i].name,
      });
    }
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
  }

  private cylinderWalls: THREE.Mesh[] = [];

  private buildTaskGeometry(): void {
    const task = this.tracks.manifest.task;
    if (!task) return;
    this.buildOptimizedPath(task.optimizedPath);
    for (const tp of task.turnpoints) {
      const isStart = tp.type === 'SSS' || tp.type === 'TAKEOFF';
      const isEnd = tp.type === 'ESS';
      // dark-backdrop pastels wash out on the off-white — use deeper shades there
      const color = isStart
        ? this.light ? 0x047857 : 0x34d399
        : isEnd
          ? this.light ? 0xdc2626 : 0xf87171
          : this.light ? 0xb45309 : 0xfbbf24;

      const ringPts: THREE.Vector3[] = [];
      const segs = 72;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        ringPts.push(
          new THREE.Vector3(tp.x + Math.cos(a) * tp.radius, 0, tp.z + Math.sin(a) * tp.radius),
        );
      }
      const ring = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(ringPts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthTest: false }),
      );
      ring.frustumCulled = false;
      this.group.add(ring);

      const wallGeom = new THREE.CylinderGeometry(tp.radius, tp.radius, WALL_HEIGHT, 64, 1, true);
      const wall = new THREE.Mesh(
        wallGeom,
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          // the light-mode wall colour is much darker, so less opacity carries
          // the same weight (DoubleSide walls stack up to 4 layers deep)
          opacity: this.light ? 0.05 : 0.06,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      wall.frustumCulled = false;
      this.cylinderWalls.push(wall);
      this.group.add(wall);

      // Turnpoint name, laid flat on the ground at the centre. Fixed orientation
      // (North = up) so it reads upright when the camera faces north.
      if (tp.name) {
        const label = makeGroundLabel(tp.name, Math.min(tp.radius * 1.5, this.extentXZ * 0.11), this.light);
        label.position.set(tp.x, 0, tp.z);
        label.renderOrder = 5;
        this.group.add(label);
      }
    }
    this.applyWallScale();
  }

  /**
   * The optimised (shortest) task line tagging each cylinder edge, drawn flat on
   * the ground as a dashed indigo polyline with course-direction arrowheads —
   * the same `#6366f1` dashed line + arrows the 2D analysis map shows.
   * Pre-projected to ENU at build time (see track-packer).
   */
  private buildOptimizedPath(path?: { x: number; z: number }[]): void {
    if (!path || path.length < 2) return;
    const pts = path.map((p) => new THREE.Vector3(p.x, 0, p.z));
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineDashedMaterial({
        color: TASK_LINE_COLOR,
        transparent: true,
        opacity: 0.85,
        depthTest: false,
        dashSize: this.extentXZ * 0.012,
        gapSize: this.extentXZ * 0.012,
      }),
    );
    line.computeLineDistances(); // required for the dash pattern
    line.frustumCulled = false;
    line.renderOrder = 4;
    this.group.add(line);
    this.buildPathArrows(pts);
  }

  /**
   * Flat indigo chevrons laid on the ground at each leg's midpoint, pointing
   * along the course so the direction of travel is unambiguous (mirrors the
   * arrow icons the 2D analysis line carries). A chevron (open ">" stroke)
   * rather than a filled triangle, so it isn't mistaken for the triangular
   * shadow a pilot cone casts. depthTest off so it reads over the terrain in
   * the map backend, like the dashed line and cylinder rings.
   */
  private buildPathArrows(pts: THREE.Vector3[]): void {
    const size = Math.min(this.extentXZ * 0.02, 700); // metres (pre-exaggeration)
    // A flat ">" chevron in the XZ plane pointing toward +X (East); we then
    // rotate it about Y so its tip faces the leg direction. Built as two thick
    // arms (an outer V minus an inner V offset back by the stroke width) so the
    // back is concave — the hallmark of a chevron vs. a solid triangle.
    const s = size; //   tip-forward extent
    const zs = size * 0.6; // arm half-span (lateral, on Z)
    const xb = -size * 0.15; // arm-back X (just behind the origin)
    const d = size * 0.55; // stroke width along X
    const O: [number, number] = [s, 0]; //          outer tip
    const UA: [number, number] = [xb, zs]; //        outer upper arm-back
    const LA: [number, number] = [xb, -zs]; //       outer lower arm-back
    const I: [number, number] = [s - d, 0]; //       inner tip (the notch)
    const UI: [number, number] = [xb - d, zs]; //    inner upper arm-back
    const LI: [number, number] = [xb - d, -zs]; //   inner lower arm-back
    const v = (p: [number, number]): number[] => [p[0], 0, p[1]];
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(
        [
          // upper arm quad (UA, O, I, UI)
          ...v(UA), ...v(O), ...v(I),
          ...v(UA), ...v(I), ...v(UI),
          // lower arm quad (O, LA, LI, I)
          ...v(O), ...v(LA), ...v(LI),
          ...v(O), ...v(LI), ...v(I),
        ],
        3,
      ),
    );
    const mat = new THREE.MeshBasicMaterial({
      color: TASK_LINE_COLOR,
      transparent: true,
      opacity: 0.95,
      side: THREE.DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    const minLeg = size * 2; // chevron spans ~1.7·size end-to-end; skip legs too short to fit it
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      if (Math.hypot(dx, dz) < minLeg) continue; // skip legs too short to fit a chevron
      const arrow = new THREE.Mesh(geom, mat);
      // heading clockwise from +X in the XZ plane: rotate about Y by -atan2(dz, dx)
      arrow.rotation.y = -Math.atan2(dz, dx);
      arrow.position.set((a.x + b.x) / 2, 0, (a.z + b.z) / 2);
      arrow.frustumCulled = false;
      arrow.renderOrder = 5;
      this.group.add(arrow);
    }
  }

  /** Scale cylinder walls on their own Y so vertical exaggeration matches the trails. */
  private applyWallScale(): void {
    for (const wall of this.cylinderWalls) {
      wall.scale.y = this.vScale;
      wall.position.y = (WALL_HEIGHT * this.vScale) / 2;
    }
  }

  /** Build the gaggle blob layer (hull + label pool) and host it in the group. */
  private buildGaggleLayer(): void {
    if (!this.gaggles) return;
    this.gaggleLayer = new GaggleLayer(this.gaggles, this.nPilots, this.extentXZ, this.light);
    this.group.add(this.gaggleLayer.group);
  }

  /** Replace the gaggle data and rebuild the blob layer (dev recompute). */
  setGaggles(gaggles: GaggleResult): void {
    this.gaggles = gaggles;
    if (this.gaggleLayer) {
      this.group.remove(this.gaggleLayer.group);
      this.gaggleLayer.dispose();
      this.gaggleLayer = undefined;
    }
    this.buildGaggleLayer();
  }

  /** Show/hide the gaggle blob overlay. */
  setGaggleVisible(visible: boolean): void {
    this.gaggleLayer?.setVisible(visible);
  }

  /** Emphasise one gaggle (others dimmed); -1 clears. */
  setGaggleHighlight(id: number): void {
    this.gaggleLayer?.setHighlight(id);
  }

  // --- per-frame -----------------------------------------------------------

  setTime(t: number): void {
    this.trailMat.uniforms.uTime.value = t;
  }

  /**
   * Update marker instance matrices for time `t` and return per-pilot samples
   * (local ENU metres, y already multiplied by vScale) for the backend to
   * project / follow. `smoothSeconds` is the metric-averaging window of
   * flight time (fixed by the caller; see METRIC_AVG_SECONDS).
   */
  updateMarkers(t: number, smoothSeconds = 6): MarkerSample[] {
    const n = this.nPilots;
    for (let i = 0; i < n; i++) {
      const s = samplePilot(this.tracks, i, t, this.alt0, smoothSeconds);
      const out = this.samplesOut[i];
      if (!s.active) {
        out.active = false;
        out.landed = false;
        out.x = out.y = out.z = 0;
        out.climb = out.speed = out.climbInst = out.altMsl = 0;
        this.dummy.scale.set(0, 0, 0);
        this.dummy.position.set(0, -1e9, 0);
        this.dummy.updateMatrix();
        this.markers.setMatrixAt(i, this.dummy.matrix);
        this.markerOutlines?.setMatrixAt(i, this.dummy.matrix);
        continue;
      }
      const wy = s.y * this.vScale;
      this.dummy.position.set(s.x, wy, s.z);
      this.dir.set(Math.sin(s.heading), 0, Math.cos(s.heading));
      if (this.dir.lengthSq() < 1e-6) this.dir.set(0, 0, 1);
      this.dummy.quaternion.setFromUnitVectors(UP, this.dir);
      const sc = i === this.highlight ? 1.7 : 1;
      this.dummy.scale.set(sc, sc, sc);
      this.dummy.updateMatrix();
      this.markers.setMatrixAt(i, this.dummy.matrix);
      this.markerOutlines?.setMatrixAt(i, this.dummy.matrix);
      out.active = true;
      out.landed = s.landed;
      out.x = s.x;
      out.y = wy;
      out.z = s.z;
      out.altMsl = s.altMsl;
      out.climb = s.climb;
      out.speed = s.speed;
      out.climbInst = s.climbInst;
    }
    this.markers.instanceMatrix.needsUpdate = true;
    if (this.markerOutlines) this.markerOutlines.instanceMatrix.needsUpdate = true;
    this.gaggleLayer?.update(t, this.samplesOut);
    return this.samplesOut;
  }

  // --- controls ------------------------------------------------------------

  setVScale(v: number): void {
    this.vScale = v;
    this.trailMat.uniforms.uVScale.value = v;
    this.applyWallScale();
  }

  setColorMode(mode: ColorMode): void {
    const modes: Record<ColorMode, number> = { pilot: 0, altitude: 1, vario: 2, speed: 3, glide: 4 };
    this.trailMat.uniforms.uColorMode.value = modes[mode] ?? 0;
  }

  /** Trail width in CSS px (drives the round-points pass). */
  setWidth(px: number): void {
    this.width = px;
    this.trailMat.uniforms.uWidth.value = px * pixelRatio();
  }

  setTailSeconds(s: number): void {
    this.trailMat.uniforms.uTailSeconds.value = s;
  }

  setVisible(idx: number, visible: boolean): void {
    (this.trailMat.uniforms.uVisible.value as Float32Array)[idx] = visible ? 1 : 0;
  }

  setHighlight(idx: number): void {
    this.highlight = idx;
    this.trailMat.uniforms.uHighlight.value = idx;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const free = (o: THREE.Object3D) => {
      const any = o as unknown as {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      any.geometry?.dispose();
      const m = any.material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else m?.dispose();
    };
    this.gaggleLayer?.dispose();
    this.group.traverse(free);
    this.markers.geometry.dispose();
    (this.markers.material as THREE.Material).dispose();
    this.markers.dispose();
    this.markerOutlines?.dispose();
  }
}

/**
 * A turnpoint name as a canvas texture on a ground-flat plane, oriented so the
 * letters' top points North (-Z) and reading runs West→East (+X) — i.e. upright
 * when the camera faces north, upside-down from the south.
 *
 * With the right-handed ENU frame (North = -Z), `rotation.x = -π/2` lays the plane
 * flat with its textured face UP and text drawn normally. Both backends render
 * the same chirality (the mercator model-matrix reflection and Mapbox's own
 * north-up mercator flip cancel out), so no per-backend canvas flip is needed.
 */
function makeGroundLabel(text: string, worldWidth: number, light = false): THREE.Mesh {
  const fontPx = 64;
  const pad = 28;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width + pad * 2);
  const h = 128;
  canvas.width = w;
  canvas.height = h;
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  // halo + text invert with the backdrop theme
  ctx.strokeStyle = light ? 'rgba(250,250,246,0.92)' : 'rgba(8,12,22,0.9)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = light ? '#1e293b' : '#f1f5f9';
  ctx.fillText(text, w / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const geom = new THREE.PlaneGeometry(worldWidth, worldWidth * (h / w));
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geom, mat);
  // Lay flat, textured face up (North = -Z → local +Y maps to North under -π/2).
  mesh.rotation.x = -Math.PI / 2;
  mesh.frustumCulled = false;
  return mesh;
}

// --- shaders ---------------------------------------------------------------

function trailVertexShader(nPilots: number): string {
  return /* glsl */ `
    attribute float aTime;
    attribute float aPilot;
    attribute float aVario;
    attribute float aSpeed;
    uniform float uTime;
    uniform vec3  uColors[${nPilots}];
    uniform float uVisible[${nPilots}];
    uniform int   uColorMode;   // 0 pilot, 1 altitude, 2 vertical speed, 3 speed, 4 glide ratio
    uniform int   uHighlight;   // -1 = none
    uniform float uVScale;      // vertical exaggeration
    uniform float uAltMin;
    uniform float uAltMax;
    uniform float uVarioMax;
    uniform float uSpeedMin;
    uniform float uSpeedMax;
    uniform vec3  uVarioZero;   // vario-ramp centre / glide "infinity" colour (theme-dependent)
    uniform float uWidth;       // point size (px); ignored by LineSegments
    varying float vAge;
    varying vec3  vColor;
    varying float vDim;

    vec3 altRamp(float t) {
      vec3 c0 = vec3(0.13, 0.40, 0.85);
      vec3 c1 = vec3(0.10, 0.75, 0.80);
      vec3 c2 = vec3(0.30, 0.80, 0.30);
      vec3 c3 = vec3(0.95, 0.80, 0.20);
      vec3 c4 = vec3(0.92, 0.25, 0.20);
      if (t < 0.25) return mix(c0, c1, t / 0.25);
      if (t < 0.50) return mix(c1, c2, (t - 0.25) / 0.25);
      if (t < 0.75) return mix(c2, c3, (t - 0.50) / 0.25);
      return mix(c3, c4, (t - 0.75) / 0.25);
    }

    // diverging: blue (sink) -> uVarioZero (level) -> red (climb)
    vec3 varioRamp(float t) {
      vec3 sink = vec3(0.20, 0.45, 0.95);
      vec3 climb = vec3(0.95, 0.25, 0.20);
      return t < 0.5 ? mix(sink, uVarioZero, t / 0.5) : mix(uVarioZero, climb, (t - 0.5) / 0.5);
    }

    // sequential: red (poor glide) -> yellow -> green (good glide)
    vec3 glideRamp(float t) {
      vec3 poor = vec3(0.86, 0.24, 0.20);
      vec3 mid  = vec3(0.95, 0.80, 0.20);
      vec3 good = vec3(0.16, 0.68, 0.38);
      return t < 0.5 ? mix(poor, mid, t / 0.5) : mix(mid, good, (t - 0.5) / 0.5);
    }

    void main() {
      int pid = int(aPilot + 0.5);
      vAge = uTime - aTime;
      vDim = (uHighlight >= 0 && pid != uHighlight) ? 0.12 : 1.0;
      vColor = uColors[pid];
      if (uColorMode == 1) {
        float a = clamp((position.y - uAltMin) / max(1.0, uAltMax - uAltMin), 0.0, 1.0);
        vColor = altRamp(a);
      } else if (uColorMode == 2) {
        float a = clamp(aVario / uVarioMax * 0.5 + 0.5, 0.0, 1.0);
        vColor = varioRamp(a);
      } else if (uColorMode == 3) {
        vColor = altRamp(clamp((aSpeed - uSpeedMin) / (uSpeedMax - uSpeedMin), 0.0, 1.0));
      } else if (uColorMode == 4) {
        if (aVario > -0.05) {
          vColor = uVarioZero;            // climbing/level: glide is infinite — flat colour
        } else {
          // log scale over GLIDE_LO..GLIDE_HI (${GLIDE_LO}..${GLIDE_HI}):
          // a 4 -> 8 improvement reads as strongly as 16 -> 32
          float g = aSpeed / -aVario;
          float t = clamp(log2(g / ${GLIDE_LO.toFixed(1)}) / ${Math.log2(GLIDE_HI / GLIDE_LO).toFixed(1)}, 0.0, 1.0);
          vColor = glideRamp(t);
        }
      }
      if (uVisible[pid] < 0.5) {
        gl_Position = vec4(0.0, 0.0, 0.0, -1.0);
        return;
      }
      vec3 p = position;
      p.y *= uVScale;                          // exaggerate altitude
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      gl_PointSize = uWidth;                   // used by the Points pass; ignored by lines
      if (aTime > uTime) gl_Position.w = -1.0; // cheap discard of the future
    }
  `;
}

/**
 * Trail fragment shader. `round` adds a circular clip (via gl_PointCoord) so the
 * wide Points pass reads as a smooth thick trail rather than squares; the line
 * pass passes false.
 */
function trailFragmentShader(round: boolean): string {
  return /* glsl */ `
    uniform float uTailSeconds;
    varying float vAge;
    varying vec3  vColor;
    varying float vDim;

    void main() {
      if (vAge < 0.0) discard;                  // future
      ${round ? 'vec2 d = gl_PointCoord - vec2(0.5); if (dot(d, d) > 0.25) discard;' : ''}
      float f = 1.0 - vAge / uTailSeconds;      // 1 at the head -> 0 at the tail cutoff
      if (f <= 0.0) discard;                     // older than the trail length (Full = never)
      gl_FragColor = vec4(vColor, (0.18 + 0.82 * f) * vDim);
    }
  `;
}

/** Renderer pixel ratio (clamped to 2, matching the backends) for sizing points. */
function pixelRatio(): number {
  return Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2);
}
