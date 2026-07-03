# 3D Flight Replay — Implementation Notes & Learnings

A WebGL replay of a whole competition task: every pilot's IGC track rendered as
time-animated 3D trajectories, scrubbable, in either an abstract free-orbit view
or draped over a Mapbox satellite/terrain map. Lives at **`/replay`**
(standalone page, no auth; track data comes from the competition-api Worker —
see §8).

This doc captures the architecture, the non-obvious decisions, and the gotchas
that cost real time. It assumes the original engineering brief (the spec the
viewer was built from) as background.

---

## 1. What was built

- A page `/replay` showing all ~32 pilots of Corryong Cup 2026 Task 1
  with synchronized playback, pilot identity, altitude/vario colouring, task
  geometry, gaggle detection, and a selectable backdrop (abstract vs Mapbox
  terrain).
- **Per-pilot live metrics** (see §5.15): rank badges pinned to the marker
  cones, and a draggable metrics callout (altitude / climb / ground speed /
  glide ratio) with a leader line to the pilot's cone. There is deliberately
  **no tooltip window next to the pilot** — hovering a cone routes that
  pilot's metrics into the callout as a live preview; clicking the cone pins
  (follows) them. Clicking/tapping away from every cone toggles play/pause
  (as does the spacebar), so the whole canvas is the play button.
- The packing logic is **pure and fs/DOM-free** (`packTracksFromIgc` in the
  engine), so the *same* code runs in two places:
  - **Runtime, Worker-served (primary):** `GET /api/comp/:comp_id/task/:task_id/3dvis`
    (and `GET /api/comp/sample-3dvis` for the public sample) reads each pilot's
    IGC from R2, packs, and returns one binary **bundle** — `[uint32 manifestLen]
    [manifest JSON][gzipped Float32 data]` — cached in KV. This is what the page
    loads (`viewer.loadBundle`).
  - **Build-time mirror (offline):** the `build-3dvis` CLI writes the same
    manifest + `tracks.bin.gz` to `web/frontend/public/replay-offline/` for
    offline inspection/regression. No longer on the page's hot path.
- The sample is a **real competition in the database** (comp + task + pilots +
  IGC in R2), so every user can view it; see *Sample competition* below.

### Run / regenerate

```bash
bun run dev                   # workers + frontend; http://localhost:3000/replay
bun run seed:sample           # load the sample comp into local D1 + R2 (idempotent)
bun run seed:sample --remote  # …or into production D1 + R2
bun run build-3dvis           # offline: regenerate the static asset mirror
```

The page calls `/api/comp/sample-3dvis` by default; `?comp=<id>&task=<id>` points
the same viewer at any competition task the user may view.

---

## 2. Architecture

Three stages, kept cleanly separated (per the brief):

```
IGC + task.xctsk ──▶ packTracksFromIgc() (pure) ──▶ manifest + Float32 data
                       │                                      │
        ┌──────────────┴───────────────┐                     │
        ▼                               ▼                     │
 [build-3dvis CLI]            [competition-api Worker]        │
 tracks.bin.gz + manifest      GET …/3dvis → bundle (KV-cached)│
 (offline mirror)              R2 IGC → pack → one response    │
                                                        ┌──────┘
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

Engine (pure, no DOM — runs in both the Worker and the CLI):
- `web/engine/src/track-packer.ts` — pure `packTracks()`: project, time-align,
  pack the binary + manifest, palette, task geometry. Exported from `index.ts`.
- `web/engine/src/track-pack-pipeline.ts` — `packTracksFromIgc()`: parse IGC →
  GAP score → `packTracks`. Shared by the Worker and the CLI.
- `web/engine/cli/build-3dvis.ts` — offline mirror: reads IGC + task, resolves
  the timezone (geo-tz), gzips, writes the static asset.

Worker (`web/workers/competition-api/src/`):
- `visualization.ts` (`buildTask3dvisBundle`) + `routes/visualization.ts` — the
  runtime path the page actually loads (see §8).

Frontend (`web/frontend/src/replay.html` + `web/frontend/src/replay/`):
- `track-data.ts` — `loadTracksBundle` (one Worker fetch) / `loadTracks`
  (two-file mirror) + `DecompressionStream("gzip")` → typed arrays;
  per-vertex `aPilot`/`aVario`; `samplePilot()` binary-search + lerp.
- `flight-scene.ts` — the backend-agnostic Three content + custom shaders.
- `backend.ts` — the `Backend` interface.
- `abstract-backend.ts` / `terrain-backend.ts` — the two implementations.
- `replay-viewer.ts` — orchestrator (owns view state, drives the loop).
- `map-styles.ts` — Mapbox style list (no mapbox-gl import → stays out of the
  initial bundle).
- `replay.html` / `replay/main.ts` — page chrome + wiring.

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
  baked into the manifest; the legend sorts by rank, showing each pilot's rank
  chip (same badge as their cone in the scene) + score. Matches the published
  AirScore order at the top.
- **Pilot colours hash the name** (`colorForName` in `track-packer.ts`), not the
  roster index, so a pilot keeps the same colour across rebuilds even if the
  field changes. FNV-1a → hue, reusing `buildPalette`'s saturation/lightness
  bands so it stays visually consistent. Trade-off: hashing can occasionally put
  two pilots on near-identical hues (the golden-angle palette guaranteed maximal
  separation) — name-stability was judged worth it. Re-run `bun run build-3dvis`
  to regenerate the manifest after touching the colour logic.

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

### 5.11 Matching OrbitControls mouse/touch to Mapbox — don't fight the built-in swap

We want both backdrops to feel identical: **drag pans, Ctrl/⌘+drag orbits**
(Mapbox's default), and Shift+drag (Mapbox box-zoom) does nothing here. Three
non-obvious facts made this a multi-attempt fix:

- **OrbitControls already swaps PAN↔ROTATE while a modifier is held.** When the
  resolved mouse action is `ROTATE` *and* `ctrlKey/metaKey/shiftKey` is down, it
  deliberately switches to PAN (and `PAN`+modifier → ROTATE). So forcing
  `mouseButtons.LEFT = ROTATE` on Ctrl is *wrong* — OrbitControls swaps it right
  back to PAN and you never orbit. **Fix:** set both `LEFT` and `RIGHT` to `PAN`
  and let the built-in swap produce the orbit. No per-event remapping.
- **macOS delivers Ctrl+click as a right-click** (`button === 2`). That's why
  `RIGHT` must also be `PAN` — otherwise Ctrl+drag on a Mac lands on the RIGHT
  slot and the swap never runs. (This burned a whole "it doesn't orbit at all"
  round; the user was on a Mac.)
- **Swallowing Shift+drag needs a capture listener on the canvas's _parent_.**
  A capture listener on the canvas itself does **not** beat OrbitControls: when
  the canvas is the event target, all its listeners fire in registration order
  (capture flag ignored), and OrbitControls registered first. Listen on the
  parent in the capture phase and `stopPropagation()` before the event ever
  descends to the canvas.
- Touch: `touches.ONE = PAN`, `touches.TWO = DOLLY_ROTATE` to mirror Mapbox
  (one finger pans, two fingers orbit + pinch-zoom).

Verify with Playwright `browser_run_code_unsafe` driving real `page.mouse` +
`page.keyboard` with modifiers; assert on `controls.getAzimuthalAngle()` /
`getPolarAngle()` (expose `controls` on `window` under `import.meta.env.DEV`).
Comparing the compass transform *string* is too noisy — parse the bearing number.

### 5.12 Free-look follow — track the pilot's delta, don't snap onto it

The first follow implementation set `controls.target = pilot` every frame, which
fights the user: any pan is overwritten next frame. The wanted behaviour is
"keep the pilot wherever it is on screen when the follow starts (or after I
pan/orbit)". Implementation: on the first follow frame **anchor** the pilot's
position without moving the camera; each later frame shift **both** `target` and
`camera.position` by the pilot's movement since the last frame
(`sample.pos − lastPos`). The camera↔target offset is never touched, so
pan/orbit/zoom all persist and the pilot stays pinned. Re-anchor (don't apply a
delta) when the followed pilot changes or goes inactive, to avoid a jump. Same
idea on terrain: `map.setCenter(center + pilotDelta)` reading the live centre
first so user drag survives. (Verified: pure follow pins the pilot to the exact
pixel; only transient OrbitControls damping causes a few px of settle after an
orbit/pan.)

### 5.13 Orientation presets (compass / top / side) — drive OrbitControls via Spherical

Compass-click = north-up, plus Top/Side buttons. There's no `setAzimuthalAngle`
on OrbitControls, so tween in `render()`: read the current camera→target offset
into a `THREE.Spherical`, lerp `theta`/`phi` (ease-in-out cubic) keeping
`radius`, then `camera.position = target + offset.setFromSpherical(s)`. **θ = 0
is north-up** (camera due south of target, looking north) — matches
`getBearingDeg`'s `atan2(dir.x, −dir.z)`. Top = `phi ≈ 0.02`, Side =
`phi = maxPolarAngle`. This coexists with damping (`controls.update()` recomputes
its spherical from the position we set, with zero user input) and with follow
(the tween sets position relative to the follow-shifted target). These presets
deliberately **keep** the active follow; only Reset clears it. Terrain uses
`map.easeTo({ bearing/pitch })`.

### 5.14 Optimised task line — pre-project at build time, not runtime

The viewer draws the same optimised (shortest) task line as the 2D analysis map.
`calculateOptimizedTaskLine(task)` returns **lat/lon** tagging each cylinder
edge, but the runtime has no lat/lon task (only the ENU manifest), so we run the
optimiser in `packTracks()` and store the result pre-projected into ENU as
`manifest.task.optimizedPath: {x,z}[]` (same `projX/projZ` as the turnpoints).
`FlightScene.buildOptimizedPath()` then draws it as a flat `#6366f1` dashed
`LineDashedMaterial` (call `computeLineDistances()` or the dash pattern is
inert), with flat indigo arrowheads at each leg midpoint rotated by
`rotation.y = −atan2(dz, dx)` to show course direction (legs shorter than the
arrow are skipped). It lives in the shared `FlightScene.group`, so both backends
get it for free; `depthTest: false` keeps it over the terrain like the rings.
**The line starts at the takeoff centre, not an edge**, when turnpoint 0 is a
`TAKEOFF` — FAI treats a takeoff as a fixed point (`firstTurnpointRadius` → 0),
and this matches the 2D analysis map exactly. Don't "fix" it to start at the
SSS edge; it's intentional and rule-correct.

### 5.15 Per-pilot metrics overlays — DOM, not in-scene sprites

Rank badges on the cones and the follow callout are **DOM elements positioned
from `projectToScreen` every frame**, not THREE.Sprites. Reasons:

- The terrain backend bakes the whole view into `camera.projectionMatrix`
  (mercator bridge, §5.3), so sprite billboarding — which reads the
  model-view matrix — mis-orients there. DOM overlays sidestep this entirely
  and behave identically on both backends.
- DOM text is crisp at any zoom, styleable with Tailwind, and free to layer
  (z-index) against the other chrome.

The viewer emits a per-frame `onFrame(samples: PilotScreenSample[])` callback
with every pilot's projected screen position + live metrics; the array is
**reused across frames** (no allocation). Picking (`pickAt`) shares those same
projections. Click-vs-drag on the canvas is discriminated by pointer travel
(≤5 px = click; primary pointer only, so multi-touch gestures never count).
A click on a cone follows that pilot; a background click toggles play/pause
(suppressed when it's dismissing the open control drawer), as does Space
(unless a form control has focus).

**Ground speed and climb are smoothed over a ±3-fix window** in `samplePilot`
(matching the per-vertex vario smoothing). Speed is the horizontal *path
length* over the window — a straight-line delta reads near zero while
circling in a thermal. Glide ratio is derived as `speed / -climb`, shown as
`∞` when level/climbing and capped (>40 → `∞`) so noise never prints absurd
numbers.

The callout is draggable (pointer capture on the bubble, clamped to the
viewport, position persisted in `localStorage`), with an SVG leader line that
exits the bubble's nearest edge and ends in a dot on the pilot's cone —
hidden when the cone is off-screen or under the bubble.

The callout is the **single metrics surface**: hovering any cone shows that
pilot in it (a live preview — no floating tooltip beside the pilot, so the
racing stays unobscured), and clicking pins the followed pilot. The ✕ (stop
following) is hidden during hover-only previews. The old `#tooltip` element
remains only for the gaggle-ribbon hovers (GaggleUI).

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
- ~~**Worker preprocessing**~~ — *done*: the packer runs in the competition-api
  Worker at request time (KV-cached), serving a single bundle; see *Sample
  competition* below.
- **Follow-cam smoothing**, colour-by leader-gap, airspace volumes.

---

## 8. Sample competition (Worker-served data)

The replay is fed by a **real competition in the database** rather than a static
file, so any user can view it and the same path serves any comp task.

- **Source:** `web/samples/comps/corryong-cup-2026-open-t1/` (33 IGC + `task.xctsk`)
  — the first task of the bundled Corryong Cup 2026 comp; `sample-3dvis` serves
  the earliest task by date. See the CLAUDE.md "Updating bundled data" notes for
  the full open/floater multi-class layout.
- **Seed:** `bun run seed:sample` (`--remote` for production). Idempotent — the
  comp is found by name (`SAMPLE_COMP_NAME`, shared in
  `web/workers/competition-api/src/sample.ts`); reruns wipe that comp's tasks /
  pilots / tracks (D1) and IGC objects (R2) and rebuild under the **same
  comp_id**, so a messed-with sample is fixed back up. It's a public comp
  (`test = 0`), single class `open`, scored together for legend order.
- **Endpoint:** `web/workers/competition-api/src/visualization.ts`
  (`buildTask3dvisBundle`) + `routes/visualization.ts`. Mirrors `scoring.ts`:
  fetch `task_track` rows → R2 `get` → gunzip → `packTracksFromIgc` → gzip data
  → frame the bundle → cache in KV (`3dvis:v1:<taskId>:<hash>`, invalidated by
  the same task-state hash as scores).
- **Timezone:** `geo-tz` is node-only, so the seed resolves it and stashes it as
  `_timezone` inside the stored task xctsk JSON; the Worker reads it back and
  puts it on the manifest (`parseXCTask` ignores the extra key). Without it the
  viewer falls back to the browser zone.
- **Frontend:** `loadTracksBundle` in `track-data.ts` (one fetch, split manifest
  from gzipped data) → `ReplayViewer.loadBundle`. `replay/main.ts` builds the URL.
- **Entry points:** the homepage links to the replay (`/replay`, no
  params → `sample-3dvis`). Every competition **task page** (`comp-detail.ts`)
  and the **score page** (`scores.ts`) link to `/replay?comp=<id>&task=<id>`
  for their real tasks — the in-app path needs no `sample-3dvis` (the page knows
  the ids). The task-page link appears once the task has scoreable tracks.

---

## 8. Conventions to keep

- Local ENU frame: **X = East, Y = Up, Z = South (North = −Z)**, right-handed.
- `mapbox-gl` stays lazy-imported (terrain-backend only); keep style/data lists
  in dependency-free modules so they don't drag the chunk into the initial load.
- Verify map/geography changes in a real browser (Playwright), and check E/W
  against the satellite imagery.
