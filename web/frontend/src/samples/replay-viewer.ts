// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * ReplayViewer — raw Three.js (no R3F) 3D replay of competition flight tracks.
 *
 * Design follows docs/flight-replay-3d-brief.md:
 *  - All trails are ONE merged THREE.LineSegments with a custom ShaderMaterial.
 *    A single `uTime` uniform animates every pilot at once (comet-tail fade +
 *    future-discard per vertex), so scrubbing is zero CPU per frame.
 *  - Current-position markers are an InstancedMesh, CPU-lerped each frame.
 *  - Vertical exaggeration is a Y-scale on the world group, so trails, markers
 *    and task cylinders stay aligned automatically.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadTracks, samplePilot, type LoadedTracks } from './track-data';

export type ColorMode = 'pilot' | 'altitude';

export interface HoverInfo {
  pilotIdx: number;
  name: string;
  altMsl: number;
  climb: number;
  /** Screen position for the tooltip (canvas-relative px). */
  screenX: number;
  screenY: number;
}

export interface ViewerCallbacks {
  onTime?(tRel: number): void;
  onPlayState?(playing: boolean): void;
  onHover?(info: HoverInfo | null): void;
  onScale?(metresPerPixel: number): void;
  onCompass?(northAngleDeg: number): void;
}

const UP = new THREE.Vector3(0, 1, 0);
const WALL_HEIGHT = 1400; // metres, task-cylinder walls (pre vertical exaggeration)

export class ReplayViewer {
  private container: HTMLElement;
  private tracks!: LoadedTracks;
  private cb: ViewerCallbacks;

  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private world!: THREE.Group; // holds trails + cylinders + grid (vertical-scaled)

  private trailMat!: THREE.ShaderMaterial;
  private markers!: THREE.InstancedMesh;
  private dummy = new THREE.Object3D();
  private markerColors!: Float32Array;

  private raf = 0;
  private lastFrame = 0;
  private resizeObs!: ResizeObserver;

  // playback / view state
  private duration = 0;
  private time = 0;
  private playing = false;
  private speed = 16;
  private vScale = 3;
  private follow = -1;

  // bookkeeping for picking
  private markerScreen: { x: number; y: number; active: boolean }[] = [];
  private hoverPilot = -1;
  private extentXZ = 1000;
  private alt0 = 0;

  constructor(container: HTMLElement, callbacks: ViewerCallbacks = {}) {
    this.container = container;
    this.cb = callbacks;
  }

  async load(manifestUrl: string, binUrl: string): Promise<LoadedTracks> {
    this.tracks = await loadTracks(manifestUrl, binUrl);
    this.alt0 = this.tracks.manifest.origin.alt0;
    this.duration = this.tracks.manifest.t1 - this.tracks.manifest.t0;
    this.initThree();
    this.buildTrails();
    this.buildMarkers();
    this.buildTaskGeometry();
    this.buildGround();
    this.resetCamera();
    this.start();
    return this.tracks;
  }

  // --- scene setup ---------------------------------------------------------

  private initThree(): void {
    const w = this.container.clientWidth || 800;
    const h = this.container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x0a0f1a, 1);
    this.container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 5_000_000);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.enablePan = true;
    this.controls.maxPolarAngle = Math.PI * 0.495; // don't go below the ground

    this.world = new THREE.Group();
    this.world.scale.y = this.vScale;
    this.scene.add(this.world);

    this.resizeObs = new ResizeObserver(() => this.onResize());
    this.resizeObs.observe(this.container);
    this.renderer.domElement.addEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.addEventListener('pointerleave', this.onPointerLeave);
  }

  // --- trails (merged LineSegments + ShaderMaterial) -----------------------

  private buildTrails(): void {
    const { pos, time, pilotIndex, index, manifest } = this.tracks;
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('aTime', new THREE.BufferAttribute(time, 1));
    geom.setAttribute('aPilot', new THREE.BufferAttribute(pilotIndex, 1));
    geom.setIndex(new THREE.BufferAttribute(index, 1));

    const nPilots = manifest.pilots.length;
    const colors: THREE.Vector3[] = [];
    for (let i = 0; i < nPilots; i++) {
      const c = manifest.colors[i] ?? [0.8, 0.8, 0.8];
      colors.push(new THREE.Vector3(c[0], c[1], c[2]));
    }
    const visible = new Float32Array(nPilots).fill(1);

    this.trailMat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uTailSeconds: { value: 1e9 }, // permanent trail by default
        uColors: { value: colors },
        uVisible: { value: visible },
        uColorMode: { value: 0 },
        uHighlight: { value: -1 },
        uAltMin: { value: manifest.altMin },
        uAltMax: { value: manifest.altMax },
      },
      vertexShader: trailVertexShader(nPilots),
      fragmentShader: TRAIL_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });

    const lines = new THREE.LineSegments(geom, this.trailMat);
    lines.frustumCulled = false;
    this.world.add(lines);

    // horizontal extent for camera framing
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
    this.extentXZ = Math.max(maxX - minX, maxZ - minZ, 1000);
    this.center.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
  }

  private center = new THREE.Vector3();

  // --- markers (InstancedMesh) ---------------------------------------------

  private buildMarkers(): void {
    const n = this.tracks.manifest.pilots.length;
    const size = this.extentXZ * 0.012;
    const geom = new THREE.ConeGeometry(size * 0.5, size * 1.8, 10);
    // Unlit; per-instance colour comes from InstancedMesh.setColorAt (instanceColor),
    // which the renderer applies without a per-vertex colour attribute.
    const mat = new THREE.MeshBasicMaterial();
    this.markers = new THREE.InstancedMesh(geom, mat, n);
    this.markers.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.markers.frustumCulled = false;

    this.markerColors = new Float32Array(n * 3);
    const col = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const c = this.tracks.manifest.colors[i] ?? [0.8, 0.8, 0.8];
      col.setRGB(c[0], c[1], c[2]);
      this.markers.setColorAt(i, col);
      this.markerColors.set([col.r, col.g, col.b], i * 3);
    }
    if (this.markers.instanceColor) this.markers.instanceColor.needsUpdate = true;
    // Markers live in scene root (not the scaled world) and apply vScale to Y
    // manually, so the cone shape stays undistorted by vertical exaggeration.
    this.scene.add(this.markers);
  }

  // --- task cylinders + ground --------------------------------------------

  private buildTaskGeometry(): void {
    const task = this.tracks.manifest.task;
    if (!task) return;
    for (const tp of task.turnpoints) {
      const isStart = tp.type === 'SSS' || tp.type === 'TAKEOFF';
      const isEnd = tp.type === 'ESS';
      const color = isStart ? 0x34d399 : isEnd ? 0xf87171 : 0xfbbf24;

      // ground ring
      const ringPts: THREE.Vector3[] = [];
      const segs = 72;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        ringPts.push(
          new THREE.Vector3(tp.x + Math.cos(a) * tp.radius, 0, tp.z + Math.sin(a) * tp.radius),
        );
      }
      const ringGeom = new THREE.BufferGeometry().setFromPoints(ringPts);
      const ring = new THREE.Line(
        ringGeom,
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }),
      );
      this.world.add(ring);

      // faint cylinder wall
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
      wall.position.set(tp.x, WALL_HEIGHT / 2, tp.z);
      this.world.add(wall);
    }
  }

  private buildGround(): void {
    const size = this.extentXZ * 2.2;
    const divisions = 24;
    const grid = new THREE.GridHelper(size, divisions, 0x33415c, 0x1e293b);
    grid.position.set(this.center.x, 0, this.center.z);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.5;
    this.world.add(grid);
  }

  // --- camera --------------------------------------------------------------

  resetCamera(): void {
    this.follow = -1;
    const d = this.extentXZ * 1.15;
    const midY = ((this.tracks.manifest.altMax - this.tracks.manifest.altMin) / 2) * this.vScale;
    this.controls.target.set(this.center.x, midY, this.center.z);
    this.camera.position.set(
      this.center.x + d * 0.55,
      midY + d * 0.6,
      this.center.z - d * 0.75,
    );
    this.controls.update();
  }

  // --- render loop ---------------------------------------------------------

  private start(): void {
    this.lastFrame = performance.now();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private frame(): void {
    const now = performance.now();
    // Clamp dt so a backgrounded tab (rAF paused) doesn't make playback jump on resume.
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;

    if (this.playing) {
      this.time += dt * this.speed;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.setPlaying(false);
      }
      this.cb.onTime?.(this.time);
    }

    this.trailMat.uniforms.uTime.value = this.time;
    this.updateMarkers();
    this.updateFollow();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);

    this.emitScaleAndCompass();
    if (this.hoverPilot >= 0) this.emitHover();
  }

  private updateMarkers(): void {
    const n = this.tracks.manifest.pilots.length;
    this.markerScreen.length = n;
    const cam = this.camera;
    const w = this.renderer.domElement.clientWidth;
    const h = this.renderer.domElement.clientHeight;
    const v = new THREE.Vector3();

    for (let i = 0; i < n; i++) {
      const s = samplePilot(this.tracks, i, this.time, this.alt0);
      if (!s.active) {
        this.dummy.scale.set(0, 0, 0);
        this.dummy.position.set(0, -1e6, 0);
        this.dummy.updateMatrix();
        this.markers.setMatrixAt(i, this.dummy.matrix);
        this.markerScreen[i] = { x: 0, y: 0, active: false };
        continue;
      }
      const wy = s.y * this.vScale;
      this.dummy.position.set(s.x, wy, s.z);
      const dir = new THREE.Vector3(Math.sin(s.heading), 0, Math.cos(s.heading));
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      this.dummy.quaternion.setFromUnitVectors(UP, dir);
      const sc = i === this.hoverPilot ? 1.7 : 1;
      this.dummy.scale.set(sc, sc, sc);
      this.dummy.updateMatrix();
      this.markers.setMatrixAt(i, this.dummy.matrix);

      v.set(s.x, wy, s.z).project(cam);
      this.markerScreen[i] = {
        x: (v.x * 0.5 + 0.5) * w,
        y: (-v.y * 0.5 + 0.5) * h,
        active: v.z < 1,
      };
    }
    this.markers.instanceMatrix.needsUpdate = true;
  }

  private updateFollow(): void {
    if (this.follow < 0) return;
    const s = samplePilot(this.tracks, this.follow, this.time, this.alt0);
    if (!s.active) return;
    const target = new THREE.Vector3(s.x, s.y * this.vScale, s.z);
    const delta = target.clone().sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  private emitScaleAndCompass(): void {
    // metres per pixel at the target distance
    const dist = this.camera.position.distanceTo(this.controls.target);
    const vFov = (this.camera.fov * Math.PI) / 180;
    const worldH = 2 * dist * Math.tan(vFov / 2);
    const mpp = worldH / this.renderer.domElement.clientHeight;
    this.cb.onScale?.(mpp);

    // compass: angle of North (+Z) relative to screen up
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    const az = Math.atan2(fwd.x, fwd.z); // camera heading
    this.cb.onCompass?.((az * 180) / Math.PI);
  }

  // --- picking -------------------------------------------------------------

  private onPointerMove = (e: PointerEvent): void => {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    let best = -1;
    let bestD = 20; // px threshold
    for (let i = 0; i < this.markerScreen.length; i++) {
      const m = this.markerScreen[i];
      if (!m || !m.active) continue;
      const d = Math.hypot(m.x - px, m.y - py);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (best !== this.hoverPilot) {
      this.hoverPilot = best;
      this.trailMat.uniforms.uHighlight.value = best;
    }
    if (best < 0) this.cb.onHover?.(null);
  };

  private onPointerLeave = (): void => {
    this.hoverPilot = -1;
    this.trailMat.uniforms.uHighlight.value = -1;
    this.cb.onHover?.(null);
  };

  private emitHover(): void {
    const i = this.hoverPilot;
    const s = samplePilot(this.tracks, i, this.time, this.alt0);
    const m = this.markerScreen[i];
    if (!s.active || !m) {
      this.cb.onHover?.(null);
      return;
    }
    this.cb.onHover?.({
      pilotIdx: i,
      name: this.tracks.manifest.pilots[i].name,
      altMsl: s.altMsl,
      climb: s.climb,
      screenX: m.x,
      screenY: m.y,
    });
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // --- public controls -----------------------------------------------------

  setTime(t: number): void {
    this.time = Math.max(0, Math.min(this.duration, t));
    this.trailMat.uniforms.uTime.value = this.time;
    this.cb.onTime?.(this.time);
  }

  get currentTime(): number {
    return this.time;
  }
  get totalDuration(): number {
    return this.duration;
  }
  get isPlaying(): boolean {
    return this.playing;
  }

  setPlaying(p: boolean): void {
    if (p && this.time >= this.duration) this.time = 0;
    this.playing = p;
    this.lastFrame = performance.now();
    this.cb.onPlayState?.(p);
  }
  togglePlay(): void {
    this.setPlaying(!this.playing);
  }
  setSpeed(x: number): void {
    this.speed = x;
  }

  setVScale(s: number): void {
    this.vScale = s;
    this.world.scale.y = s;
  }

  setColorMode(mode: ColorMode): void {
    this.trailMat.uniforms.uColorMode.value = mode === 'altitude' ? 1 : 0;
  }

  setTailSeconds(s: number): void {
    this.trailMat.uniforms.uTailSeconds.value = s;
  }

  setPilotVisible(idx: number, visible: boolean): void {
    // ShaderMaterial re-uploads uniform arrays each frame; mutating in place is enough.
    (this.trailMat.uniforms.uVisible.value as Float32Array)[idx] = visible ? 1 : 0;
  }

  setHighlight(idx: number): void {
    this.hoverPilot = idx;
    this.trailMat.uniforms.uHighlight.value = idx;
  }

  setFollow(idx: number): void {
    this.follow = idx;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.resizeObs?.disconnect();
    this.renderer.domElement.removeEventListener('pointermove', this.onPointerMove);
    this.renderer.domElement.removeEventListener('pointerleave', this.onPointerLeave);
    this.scene.traverse((o) => {
      const any = o as unknown as { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
      any.geometry?.dispose();
      const m = any.material;
      if (Array.isArray(m)) m.forEach((mm) => mm.dispose());
      else m?.dispose();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}

// --- shaders ---------------------------------------------------------------

function trailVertexShader(nPilots: number): string {
  return /* glsl */ `
    attribute float aTime;
    attribute float aPilot;
    uniform float uTime;
    uniform vec3  uColors[${nPilots}];
    uniform float uVisible[${nPilots}];
    uniform int   uColorMode;   // 0 = pilot, 1 = altitude
    uniform int   uHighlight;   // -1 = none
    uniform float uAltMin;
    uniform float uAltMax;
    varying float vAge;
    varying vec3  vColor;
    varying float vDim;

    vec3 altRamp(float t) {
      // blue -> cyan -> green -> yellow -> red
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

    void main() {
      int pid = int(aPilot + 0.5);
      vAge = uTime - aTime;
      vDim = (uHighlight >= 0 && pid != uHighlight) ? 0.12 : 1.0;
      vColor = uColors[pid];
      if (uColorMode == 1) {
        float a = clamp((position.y - uAltMin) / max(1.0, uAltMax - uAltMin), 0.0, 1.0);
        vColor = altRamp(a);
      }
      // discard fixes for hidden pilots by collapsing them
      if (uVisible[pid] < 0.5) {
        gl_Position = vec4(0.0, 0.0, 0.0, -1.0);
        return;
      }
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
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
    if (vAge < 0.0) discard;                 // future
    float a = exp(-vAge / uTailSeconds);     // comet-tail fade
    a = clamp(a, 0.10, 1.0);                  // keep a faint full trail
    gl_FragColor = vec4(vColor, a * vDim);
  }
`;
