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

export type ColorMode = 'pilot' | 'altitude' | 'vario';

const UP = new THREE.Vector3(0, 1, 0);
const WALL_HEIGHT = 1400; // metres, task-cylinder walls (pre vertical exaggeration)

/** Vertical-speed colour mode saturates at ±this many m/s. */
export const VARIO_MAX = 4;

/** One pilot's interpolated marker state in local ENU metres (y already exaggerated). */
export interface MarkerSample {
  pilot: number;
  active: boolean;
  x: number;
  y: number;
  z: number;
  /** Altitude MSL (metres), un-exaggerated. */
  altMsl: number;
  /** Climb rate, m/s. */
  climb: number;
  name: string;
}

export class FlightScene {
  /** Trails + task cylinders. Add to the render root. */
  readonly group = new THREE.Group();
  /** Current-position markers. Add to the render root. */
  markers!: THREE.InstancedMesh;

  readonly center = new THREE.Vector3();
  extentXZ = 1000;
  readonly bbox = { minX: 0, maxX: 0, minZ: 0, maxZ: 0 };

  private tracks: LoadedTracks;
  private trailMat!: THREE.ShaderMaterial;
  private dummy = new THREE.Object3D();
  private vScale = 3;
  private highlight = -1;
  private disposed = false;
  /** True when hosted by the Mapbox (mercator) backend — flips ground labels. */
  private geo: boolean;

  constructor(tracks: LoadedTracks, geo = false) {
    this.tracks = tracks;
    this.geo = geo;
    this.buildTrails();
    this.buildMarkers();
    this.buildTaskGeometry();
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
    geom.setIndex(new THREE.BufferAttribute(index, 1));

    const nPilots = manifest.pilots.length;
    const colors: THREE.Vector3[] = [];
    for (let i = 0; i < nPilots; i++) {
      const c = manifest.colors[i] ?? [0.8, 0.8, 0.8];
      colors.push(new THREE.Vector3(c[0], c[1], c[2]));
    }

    this.trailMat = new THREE.ShaderMaterial({
      uniforms: {
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
      },
      vertexShader: trailVertexShader(nPilots),
      fragmentShader: TRAIL_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      // depthTest off so trails are never hidden by terrain (and never z-fight it).
      depthTest: false,
      blending: THREE.NormalBlending,
    });

    const lines = new THREE.LineSegments(geom, this.trailMat);
    lines.frustumCulled = false;
    this.group.add(lines);

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

    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const c = this.tracks.manifest.colors[i] ?? [0.8, 0.8, 0.8];
      col.setRGB(c[0], c[1], c[2]);
      this.markers.setColorAt(i, col);
    }
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
  }

  private cylinderWalls: THREE.Mesh[] = [];

  private buildTaskGeometry(): void {
    const task = this.tracks.manifest.task;
    if (!task) return;
    for (const tp of task.turnpoints) {
      const isStart = tp.type === 'SSS' || tp.type === 'TAKEOFF';
      const isEnd = tp.type === 'ESS';
      const color = isStart ? 0x34d399 : isEnd ? 0xf87171 : 0xfbbf24;

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
          opacity: 0.06,
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
        const label = makeGroundLabel(tp.name, Math.min(tp.radius * 1.5, this.extentXZ * 0.11), this.geo);
        label.position.set(tp.x, 0, tp.z);
        label.renderOrder = 5;
        this.group.add(label);
      }
    }
    this.applyWallScale();
  }

  /** Scale cylinder walls on their own Y so vertical exaggeration matches the trails. */
  private applyWallScale(): void {
    for (const wall of this.cylinderWalls) {
      wall.scale.y = this.vScale;
      wall.position.y = (WALL_HEIGHT * this.vScale) / 2;
    }
  }

  // --- per-frame -----------------------------------------------------------

  setTime(t: number): void {
    this.trailMat.uniforms.uTime.value = t;
  }

  /**
   * Update marker instance matrices for time `t` and return per-pilot samples
   * (local ENU metres, y already multiplied by vScale) for the backend to
   * project / follow.
   */
  updateMarkers(t: number): MarkerSample[] {
    const out: MarkerSample[] = [];
    const n = this.nPilots;
    for (let i = 0; i < n; i++) {
      const s = samplePilot(this.tracks, i, t, this.alt0);
      const name = this.tracks.manifest.pilots[i].name;
      if (!s.active) {
        this.dummy.scale.set(0, 0, 0);
        this.dummy.position.set(0, -1e9, 0);
        this.dummy.updateMatrix();
        this.markers.setMatrixAt(i, this.dummy.matrix);
        out.push({ pilot: i, active: false, x: 0, y: 0, z: 0, altMsl: 0, climb: 0, name });
        continue;
      }
      const wy = s.y * this.vScale;
      this.dummy.position.set(s.x, wy, s.z);
      const dir = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      this.dummy.quaternion.setFromUnitVectors(UP, dir);
      const sc = i === this.highlight ? 1.7 : 1;
      this.dummy.scale.set(sc, sc, sc);
      this.dummy.updateMatrix();
      this.markers.setMatrixAt(i, this.dummy.matrix);
      out.push({ pilot: i, active: true, x: s.x, y: wy, z: s.z, altMsl: s.altMsl, climb: s.climb, name });
    }
    this.markers.instanceMatrix.needsUpdate = true;
    return out;
  }

  // --- controls ------------------------------------------------------------

  setVScale(v: number): void {
    this.vScale = v;
    this.trailMat.uniforms.uVScale.value = v;
    this.applyWallScale();
  }

  setColorMode(mode: ColorMode): void {
    this.trailMat.uniforms.uColorMode.value = mode === 'altitude' ? 1 : mode === 'vario' ? 2 : 0;
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
    this.group.traverse(free);
    this.markers.geometry.dispose();
    (this.markers.material as THREE.Material).dispose();
    this.markers.dispose();
  }
}

/**
 * A turnpoint name as a canvas texture on a ground-flat plane, oriented so the
 * letters' top points North (+Z) and reading runs West→East (+X) — i.e. upright
 * when the camera faces north, upside-down from the south.
 *
 * The plane is laid flat with its textured face pointing DOWN (rotation.x =
 * +π/2), so from above we view the back face; the canvas is drawn mirrored to
 * cancel that, leaving the text correct. (A face-up plane can't show both correct
 * reading and a North-pointing top — that pairing is a reflection, not a
 * rotation.)
 */
function makeGroundLabel(text: string, worldWidth: number, geo: boolean): THREE.Mesh {
  const fontPx = 64;
  const pad = 28;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  const w = Math.ceil(ctx.measureText(text).width + pad * 2);
  const h = 128;
  canvas.width = w;
  canvas.height = h;
  // Pre-flip the canvas to cancel each backend's orientation: the abstract camera
  // shows the plane's back face (needs a horizontal flip); the mercator backend
  // flips it vertically (needs a vertical flip). Either way the text ends up
  // North-up and reading West→East.
  if (geo) {
    ctx.translate(0, h);
    ctx.scale(1, -1);
  } else {
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
  }
  ctx.font = `bold ${fontPx}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(8,12,22,0.9)';
  ctx.strokeText(text, w / 2, h / 2);
  ctx.fillStyle = '#f1f5f9';
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
  // The mercator backend mirrors the scene's chirality vs the abstract camera, so
  // flip which face points up to keep the text correct (North up) in both.
  mesh.rotation.x = geo ? -Math.PI / 2 : Math.PI / 2;
  mesh.frustumCulled = false;
  return mesh;
}

// --- shaders ---------------------------------------------------------------

function trailVertexShader(nPilots: number): string {
  return /* glsl */ `
    attribute float aTime;
    attribute float aPilot;
    attribute float aVario;
    uniform float uTime;
    uniform vec3  uColors[${nPilots}];
    uniform float uVisible[${nPilots}];
    uniform int   uColorMode;   // 0 = pilot, 1 = altitude, 2 = vertical speed
    uniform int   uHighlight;   // -1 = none
    uniform float uVScale;      // vertical exaggeration
    uniform float uAltMin;
    uniform float uAltMax;
    uniform float uVarioMax;
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

    // diverging: blue (sink) -> pale (level) -> red (climb)
    vec3 varioRamp(float t) {
      vec3 sink = vec3(0.20, 0.45, 0.95);
      vec3 zero = vec3(0.85, 0.85, 0.88);
      vec3 climb = vec3(0.95, 0.25, 0.20);
      return t < 0.5 ? mix(sink, zero, t / 0.5) : mix(zero, climb, (t - 0.5) / 0.5);
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
      }
      if (uVisible[pid] < 0.5) {
        gl_Position = vec4(0.0, 0.0, 0.0, -1.0);
        return;
      }
      vec3 p = position;
      p.y *= uVScale;                          // exaggerate altitude
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_Position = projectionMatrix * mv;
      if (aTime > uTime) gl_Position.w = -1.0; // cheap discard of the future
    }
  `;
}

const TRAIL_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTailSeconds;
  varying float vAge;
  varying vec3  vColor;
  varying float vDim;

  void main() {
    if (vAge < 0.0) discard;                  // future
    float f = 1.0 - vAge / uTailSeconds;      // 1 at the head -> 0 at the tail cutoff
    if (f <= 0.0) discard;                     // older than the trail length (Full = never)
    gl_FragColor = vec4(vColor, (0.18 + 0.82 * f) * vDim);
  }
`;
