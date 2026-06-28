# 3D Flight Replay — Implementation Notes & Learnings

A WebGL replay of a whole competition task: every pilot's IGC track rendered as
time-animated 3D trajectories, scrubbable, in either an abstract free-orbit view
or draped over a Mapbox satellite/terrain map. Lives at **`/samples/3dvis`**
(static, no auth).

This doc captures the architecture, the non-obvious decisions, and the gotchas
that cost real time — so the next person (or the Worker port) doesn't re-learn
them. It assumes the engineering brief (`flight-replay-3d-brief.md`, the original
spec) as background.

---

## 1. What was built

- A static page `/samples/3dvis` showing all ~32 pilots of Corryong Cup 2026
  Task 1 with synchronized playback, pilot identity, altitude/vario colouring,
  task geometry, and a selectable backdrop (abstract vs Mapbox terrain).
- A **build-time asset pipeline**: IGC files → one gzipped `Float32` binary +
  a small JSON manifest, committed under `web/frontend/public/samples/3dvis/`.
- The packing logic is **pure and fs/DOM-free**, so the same code can run in a
  Cloudflare Worker later (swap zlib for `CompressionStream`, disk for R2).

### Run / regenerate

```bash
bun run dev:frontend          # http://localhost:3000/samples/3dvis
bun run build-3dvis           # regenerate the asset from web/samples/comps/corryong-cup-2026-t1
```

`build-3dvis [<comp-dir> <out-dir>]` defaults to the Corryong sample comp and the
frontend public dir.

---

## 2. Architecture

Three stages, kept cleanly separated (per the brief):

```
IGC + task.xctsk ──▶ [build-3dvis CLI] ──▶ tracks.bin.gz + manifest.json
                       packTracks() (pure)        (committed to public/)
                                                        │
                                                        ▼
                                   [FlightScene]  shared Three objects
                              (merged LineSegments + Points + markers + cylinders)
                                                        │
                          ┌─────────────────────────────┴───────────────────────┐
                          ▼                                                       ▼
                  [AbstractBackend]                                      [TerrainBackend]
            own WebGL canvas + OrbitControls                     Mapbox GL custom 3D layer
                          └─────────────────────────────┬───────────────────────┘
                                                        ▼
                                              [ReplayViewer] orchestrator
                                   playback clock · picking · state · setBackdrop()
```

### Files

Engine (build-time, no DOM):
- `web/engine/src/track-packer.ts` — pure `packTracks()`: project, time-align,
  pack the binary + manifest, palette, task geometry. Exported from `index.ts`.
- `web/engine/cli/build-3dvis.ts` — reads IGC + task, runs GAP scoring for ranks,
  resolves the timezone (geo-tz), gzips, writes the asset.

Frontend (`web/frontend/src/samples/`):
- `track-data.ts` — fetch + `DecompressionStream("gzip")` → typed arrays;
  per-vertex `aPilot`/`aVario`; `samplePilot()` binary-search + lerp.
- `flight-scene.ts` — the backend-agnostic Three content + custom shaders.
- `backend.ts` — the `Backend` interface.
- `abstract-backend.ts` / `terrain-backend.ts` — the two implementations.
- `replay-viewer.ts` — orchestrator (owns view state, drives the loop).
- `map-styles.ts` — Mapbox style list (no mapbox-gl import → stays out of the
  initial bundle).
- `3dvis.html` / `3dvis.ts` — page chrome + wiring.

`mapbox-gl` is **lazy-imported** by `terrain-backend.ts` only, so it's a separate
~508 KB-gzip chunk fetched only when the user picks the map backdrop; the initial
`3dvis` chunk is Three-only (~142 KB gzip).

---

## 3. The binary format

`manifest.json` (tiny): origin (`lat0/lon0/alt0`), `mPerDegLat/Lon`, `t0/t1`,
`altMin/altMax`, `colors` palette, `timezone`, and `pilots[]` with
`{id, name, colorIdx, vertexOffset, vertexCount, rank, score}` plus optional
`task.turnpoints[]` (projected `x/z`, radius, type, name).

`tracks.bin.gz`: gzip of one interleaved `Float32Array`, **4 floats per vertex**
`[x, y, z, tRel]`, pilots concatenated in `pilots[]` order. Per-vertex pilot
index, colour and vario are **derived at load** (not stored) to keep it minimal
(~4.6 MB raw → ~3.0 MB gzipped for 287k vertices).

Loaded via `res.body.pipeThrough(new DecompressionStream("gzip"))` straight into
a `Float32Array` — no unzip library. (Has a fallback for servers that
transparently gunzip.)

---

## 4. Key decisions

- **Raw Three.js, no R3F.** One merged `LineSegments` + a custom `ShaderMaterial`
  animated by a single `uTime` uniform (comet-tail fade + future-discard per
  vertex). Scrubbing is `uniforms.uTime.value = t` — zero CPU per frame.
- **Markers** are an `InstancedMesh` of cones, CPU-lerped each frame and oriented
  along velocity.
- **Altitude source:** GPS (the airScore-generated IGC files have pressure alt =
  0). `alt0` = min altitude, so the scene floor sits at y=0.
- **Origin:** mean of pilots' first fixes (takeoffs).
- **Scoring ranks** are computed at build time via the engine's `scoreTask()` and
  baked into the manifest; the legend sorts by rank ("1. Jon Durand … 1000").
  Matches the published AirScore order at the top.

---

## 5. Gotchas & learnings (the expensive ones)

### 5.1 Coordinate handedness — use North = −Z

The single biggest bug. Projecting with **North = +Z** in a right-handed Y-up
Three scene is a *left-handed geographic* frame: a plain camera facing north
renders **East on the LEFT** — the whole abstract scene is mirrored E–W. It hid
for a long time because trails and cones are symmetric, and the Mapbox backend's
model matrix happened to compensate; the tell was turnpoint *positions* (ELLIOT
is east of CUDG in reality).

**Fix:** geographically-correct right-handed ENU in the packer:
`x = (lon−lon0)·mPerDegLon` (East = +X), `z = (lat0−lat)·mPerDegLat`
(**North = −Z**), `y = alt−alt0` (Up = +Y). Then a north-facing camera shows
East on the right.

The brief explicitly warned about this ("North ends up pointing toward the
default camera; flip the sign of z … the #1 source of 'why is everything
mirrored' confusion"). Believe it. **Verify E/W against the satellite map, not
against symmetric trails.**

### 5.2 Mapbox container collapses to 0 height

Mapbox adds the class `.mapboxgl-map { position: relative }` to its container,
which **overrides a Tailwind `absolute`**. With `position: relative`, `inset-0`
no longer resolves a height → the container collapses to 0 → the map renders
**solid black** (the abstract Three canvas was immune because it sets its own
pixel size). Fix: give the map container an explicit `h-full w-full`, never rely
on `absolute inset-0` for a Mapbox container.

### 5.3 Hosting Three in a raw Mapbox custom layer (no Threebox)

A raw `{ type: 'custom', renderingMode: '3d' }` layer reuses our `uTime`
ShaderMaterial verbatim (Threebox would fight it). The bridge: in `render(gl,
matrix)`, set `camera.projectionMatrix = mapboxMatrix · modelMatrix`, where the
model matrix maps local ENU metres → mercator:

```
mercator.x = originMerc.x + xE · s
mercator.y = originMerc.y + zS · s     (local +Z is south; mercator Y is south)
mercator.z = alt0·vScale·s + yUp · s
```

with `s = originMerc.meterInMercatorCoordinateUnits()`. Notes:
- With North = −Z this model matrix is a **reflection (det < 0)** — but it
  **cancels Mapbox's own north-up mercator flip**, so the visible chirality
  matches the abstract backend. Net result: positions correct in both, and text
  labels need **no per-backend flip**.
- mapbox-gl v3.25 custom-layer render signature is still `(gl, matrix:number[])`
  for mercator; `map.redraw()` does **not** exist (use the internal `_render(0)`
  if you must force a synchronous frame).
- Anchoring `originMerc` at `alt0` reconstructs true MSL automatically, so the
  same asset works for both backends with **no absolute-altitude regen**.
- `setStyle()` wipes all sources/layers (DEM, sky, custom layer) and the
  `style.load` handler must re-add them every time; only frame the camera on the
  first load so style switches keep the view. Reuse the `WebGLRenderer` across
  switches (the GL context persists). Switching raster↔vector styles logs a
  benign `"style diff … Rebuilding"` warning.

### 5.4 InstancedMesh per-instance colour → do NOT set `vertexColors: true`

Use a plain `MeshBasicMaterial()` + `mesh.setColorAt(i, c)`; the renderer applies
`instanceColor` itself. Setting `vertexColors: true` makes the shader multiply by
the geometry's `color` attribute, which a `ConeGeometry` doesn't have → it
defaults to (0,0,0) and **every instance renders black**.

### 5.5 `scene.fog` darkens lit materials but not ShaderMaterials

Fog faded the (Lambert) marker cones to near-black at competition-scale distances
while the (ShaderMaterial) trails stayed bright. Dropped the fog and made markers
unlit `MeshBasicMaterial` (reads pure pilot colour from any angle anyway).

### 5.6 `gl.LINES` width is capped at 1px

`linewidth` is ignored on most platforms. To make trail width adjustable, render
the fixes **additionally as round `Points`** sized by a `uWidth` uniform
(`gl_PointSize`), layered over the thin connecting line (the line fills gaps when
zoomed in; the points give thickness; overlapping round dots merge into a smooth
thick ribbon). The points reuse the trail vertex shader and **share its uniforms
object**, so time-fade/colour/visibility/highlight all apply for free. (The
brief's "v2" alternative is `Line2`/`LineMaterial`, a bigger rewrite.)

### 5.7 Ground text labels — orientation is fiddly

Turnpoint names are canvas-texture planes laid flat (`rotation.x = −π/2`) with a
fixed orientation (North up, reading W→E), so they're upright facing north and
upside-down from the south (not billboards). After the North = −Z fix both
backends share chirality, so **no per-backend flip is needed** (an earlier
version needed one — that was a symptom of the handedness bug). When verifying
text orientation, symmetric glyphs (E/I/O) hide flips — **check L and T**, and
read on the high-contrast Dark map style zoomed in.

### 5.8 Vertical exaggeration applied per-object (on purpose)

Not a single group scale. Trails: `uVScale` in the vertex shader; markers:
`y *= vScale` in JS (keeps the cone shape); cylinder walls: `scale.y`. This keeps
every host transform **uniform**, so neither backend has to deal with a
non-uniform scale (which would shear the marker cones). Mapbox terrain
exaggeration is kept equal to `vScale`.

### 5.9 Local time — geo-tz at build time

IGC fixes are UTC and the comp's timezone isn't in the data. Resolve the IANA
zone from the task origin with **`geo-tz`** at build time (offline; added as an
engine *devDependency* so it never reaches the browser/Worker bundle) and store
`manifest.timezone` (e.g. `Australia/Melbourne`). The viewer formats with
`Intl`, which applies the correct DST offset per fix date. Compute the zone
*label* at the comp date, not today's, or the abbreviation is off by an hour
across a DST boundary. (For runtime lookups in a Worker, `@photostructure/tz-lookup`
is small enough to bundle; prebaking is better whenever there's a build step.)

### 5.10 Headless preview can't screenshot Mapbox — use Playwright

The `preview_*` harness reports a `0×0` viewport, suspends `requestAnimationFrame`
(so Mapbox never auto-paints), and Mapbox's canvas is `preserveDrawingBuffer:false`.
Result: Mapbox screenshots as black even when it works. **`_render(0)` + `gl.readPixels`
gives FALSE POSITIVES** (it reads the off-screen backbuffer, not the composited
canvas — it once "confirmed" a black map as working). Verify Mapbox with the
Playwright MCP (`browser_navigate` + `browser_take_screenshot`): real viewport,
live rAF. The abstract Three view does screenshot fine in the preview harness.

Also: suspended rAF in a hidden tab means a backgrounded-then-resumed tab gets a
huge first `dt` → clamp `dt` in the playback loop (`Math.min(dt, 0.1)`).

---

## 6. Performance notes

- ~287k vertices, one merged `LineSegments` draw call — trivial for the GPU
  (fill-rate bound from overdraw, not vertex bound).
- The per-frame cost is just ~32 marker lerps + uniform updates. Keep the rAF
  loop allocation-free: reuse a single `MarkerSample[]` and scratch `Vector3`s,
  cache the mercator model matrix (rebuild only on `vScale` change), and don't
  project the hovered marker twice.
- Pilot picking is screen-space nearest-marker (project all markers, pick within
  ~20px) — no raycasting/GPU-picking needed at this scale.

---

## 7. Possible follow-ups

- **Thick presentational strokes** via `Line2`/`LineMaterial` (true pixel width,
  no point-bead artefacts) — would need the `uTime` clipping ported into
  `LineMaterial`'s shader, or one draw call per pilot.
- **Vario as a 5th packed float** instead of deriving it at load (the brief's
  option) — currently smoothed in `track-data.ts`.
- **Task geometry depth** — turnpoint rings sit at `alt0`, not draped on the DEM;
  could query terrain elevation per turnpoint.
- **Worker preprocessing on upload** — lift `packTracks()` into a Worker writing
  to R2 (the packer is already pure for this).
- **Follow-cam smoothing**, colour-by leader-gap, airspace volumes.

---

## 8. Conventions to keep

- Local ENU frame: **X = East, Y = Up, Z = South (North = −Z)**, right-handed.
- `mapbox-gl` stays lazy-imported (terrain-backend only); keep style/data lists
  in dependency-free modules so they don't drag the chunk into the initial load.
- Verify map/geography changes in a real browser (Playwright), and check E/W
  against the satellite imagery.
