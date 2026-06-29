# Pilot Cluster (Gaggle) Detection — Plan

Find and visualize **clusters of pilots flying together** during a competition
task, and make those clusters easy to notice forming/dissolving as you scrub the
3D replay. We build and iterate against the existing **`/samples/3dvis`** flight
replay (Corryong Cup 2026 Task 1, ~32 pilots).

---

## 1. What we're detecting and why

A *gaggle* is a group of pilots flying close together for a sustained period.
They are interesting to watch and learn from:

- Pilots take off separately, then **wait for each other in a thermal** and
  start the course together → a large **start gaggle** near the SSS.
- Others **join a gaggle midway** through the course to share the search for the
  next thermal → smaller, shifting **mid-course gaggles**.

So clusters:

- **form, grow, shrink, split, merge and dissolve over time** — they are not a
  static partition of the field;
- **form during different segments** (start cylinder, each leg, each thermal);
- have **changing membership** (a pilot joins or drops a gaggle mid-episode).

The detector must capture this temporal, fluid structure — not just "who is near
whom right now" — and the presentation must make formation/dissolution obvious
while scrubbing.

---

## 2. Where this fits the existing architecture

The 3D replay (see `docs/3d-flight-replay-notes.md`) is already a clean three-stage
pipeline we can hook into without disturbing:

```
IGC + task.xctsk ─▶ packTracks() (pure) ─▶ tracks.bin.gz + manifest.json
                                                  │ load → typed arrays + samplePilot()
                                                  ▼
                                          [FlightScene]  shared Three objects
                                                  │
                              [AbstractBackend] / [TerrainBackend]
                                                  │
                                          [ReplayViewer] clock · picking · state
```

Key facts we reuse:

- **Positions are already in a metric ENU frame** (`x` = East m, `y` = Up m,
  `z` = South m; North = −Z), projected once in `track-packer.ts`. Proximity in
  this frame is **plain Euclidean distance in metres** — no lat/lon math, so we
  do *not* touch `geo.ts` here (it's for lat/lon; using it would mean
  re-projecting needlessly). If we ever cluster from raw fixes instead, use
  `andoyerDistance` from `geo.ts` per the project rule — never inline geo math.
- `samplePilot(tracks, i, t, alt0)` already binary-searches + lerps one pilot's
  interpolated position at any time, returning `{active, x, y, z, ...}`. We sample
  every pilot on a time grid to get cluster input — zero new parsing.
- `FlightScene.updateMarkers(t)` already returns a reused `MarkerSample[]` (one
  per pilot, `active` + ENU pos) **every frame**. The live gaggle overlay can be
  driven straight off those samples — no extra sampling in the hot loop.
- Per-frame work is tiny today (~32 marker lerps); the field is small, so even
  O(n²) clustering per grid step is free.

### Module placement

| Concern | Location | Why |
|---|---|---|
| Cluster + episode detection (pure, tested) | **`web/engine/src/cluster-detector.ts`** (export from `index.ts`) | DOM/fs-free, unit-testable, reusable in a Worker later — same discipline as `track-packer.ts` |
| Engine tests | **`web/engine/tests/cluster-detector.test.ts`** | matches existing `web/engine/tests/*.test.ts` layout |
| Live in-scene overlay (Three) | **`web/frontend/src/samples/gaggle-layer.ts`** | sibling to `flight-scene.ts`; hosted by both backends |
| Wiring (panel, timeline ribbon, toggle) | **`web/frontend/src/samples/3dvis.ts` / `3dvis.html`** | same place pilot legend / controls already live |

**Compute timing:** run detection **at load time in the browser** (right after
`viewer.load(...)`, from the loaded tracks), *not* at build time — so tuning a
threshold is a page reload, not an asset rebuild. The detector is pure, so it can
later be lifted into `build-3dvis` (bake an episodes timeline into the manifest)
or a Worker exactly as `packTracks()` is — call that out but don't do it yet.

---

## 3. Detection algorithm

Two layers: **per-frame spatial clustering** + **temporal tracking into episodes**.

### 3.1 Sample a time grid

Sample every active pilot every `stepSeconds` (start ~10 s) over `[t0, t1]` using
`samplePilot`. Inactive pilots (before takeoff / after landing / gap) are excluded
from that frame. Result: `frames: { t, states: { pilot, x, y, z }[] }[]`.

### 3.2 Per-frame clustering (single-linkage / union-find)

At each frame, link two pilots if they are **close in both horizontal distance and
altitude**:

```
linked(a, b)  ⟺  hypot(ax−bx, az−bz) ≤ horizontalRadius
             AND  |ay − by|           ≤ verticalBand
```

Then take **connected components** via union-find. Component size ≥ `minPilots` is
a cluster; smaller groups are dropped (lone pilots are not a gaggle).

- Separate horizontal + vertical gates (rather than a single scaled 3D distance)
  because they mean different things and are independently explainable — "within
  400 m laterally and 300 m vertically." A thermal is a tall column, so
  `verticalBand` is deliberately generous.
- **Single-linkage caveat:** a strung-out line of pilots each just under the
  radius chains into one giant cluster. At competition scale with a tight radius
  this is rare and a loose gaggle *is* one group, so we start here. If chaining
  shows up while iterating, swap the component step for **DBSCAN** (`eps =
  horizontalRadius`, `minPts = minPilots`) — same input, resists chaining, yields
  "core" gaggles. Keep `clusterFrame` swappable behind one function.

`clusterFrame(states, params) → number[][]` (arrays of pilot indices) is the unit
the tests pin down.

### 3.3 Temporal tracking into episodes

Cluster each frame independently, then **stitch frames into persistent episodes**
so a gaggle keeps an identity as it moves and its membership shifts — this is what
turns "instantaneous proximity" into "flew together," and gates out brief
fly-bys.

Greedy multi-object tracking over frames:

- Maintain a set of **open episodes**, each with current members and `lastSeen`.
- For each new frame cluster, match it to the open episode with the **largest
  membership overlap** above a threshold (`trackMinShared` shared pilots, or
  Jaccard ≥ ~0.3). On match: extend the episode, update members (this is how
  *joins/drops mid-episode* are captured), append a `{t, members}` snapshot.
- Unmatched frame clusters → **open a new episode**.
- Open episodes not matched for longer than `bridgeSeconds` → **close** (the
  bridge tolerates a one-frame dropout / momentary spread so the blob doesn't
  flicker out and back).
- After the pass, **drop episodes shorter than `minDurationSeconds`** — this is
  the filter that removes two pilots crossing paths for 10 s.

Splits/merges fall out naturally: when one cluster matches two open episodes (or
vice-versa) the greedy rule keeps the strongest overlap and the other
continues/opens — good enough to read visually; we don't need formal merge IDs in
v1.

### 3.4 Output (explainable, per the project rule)

```ts
export interface GaggleEpisode {
  id: number;
  tStart: number; tEnd: number;          // tRel seconds (manifest.t0 based)
  members: number[];                     // union of all pilots ever in it
  timeline: { t: number; members: number[] }[];  // live membership per grid step
  peakSize: number;
  nearTurnpoint?: number;                // nearest task TP at midpoint, if task present
}
export interface GaggleResult { params: GaggleParams; episodes: GaggleEpisode[]; }
```

The `timeline` lets the viewer draw **exactly who is in the gaggle at the current
scrub time** (membership at the nearest grid step), and lets us answer "why" —
e.g. "Gaggle 3: 6 pilots, 13:42–13:58, near ELLIOT; X and Y joined at 13:49."

### 3.5 Parameters (starting values, all tunable)

```ts
export interface GaggleParams {
  stepSeconds: number;        // 10   grid resolution
  horizontalRadius: number;   // 400  link distance, metres
  verticalBand: number;       // 300  max altitude gap, metres
  minPilots: number;          // 3    smallest "gaggle" (2 = "flying together")
  minDurationSeconds: number; // 60   reject brief fly-bys
  trackMinShared: number;     // 2    members shared to continue an episode
  bridgeSeconds: number;      // 20   tolerated dropout before closing
}
```

These are first guesses to calibrate against the real sample (§5), not final.

---

## 4. Visualization — make clusters obvious while scrubbing

Three coordinated layers: an **in-scene blob** (micro, "this group, right now"),
a **timeline ribbon** (macro, "where gaggles happen across the task"), and a
**gaggle panel** (the explainable list).

### 4.1 In-scene gaggle blob (`gaggle-layer.ts`) — the headline

For each gaggle active at time `t`, take its **current members** (from the episode
`timeline`, intersected with currently-`active` `MarkerSample`s) and draw a
translucent shape that **wraps them**:

- A **convex hull** of member positions in the horizontal (XZ) plane (Andrew's
  monotone chain — small pure helper), drawn as a filled translucent polygon +
  bright outline at the members' **mean altitude**, with thin droppers to each
  member marker. Recomputed each frame from live samples, so as a pilot
  approaches you literally **see the hull reach out and engulf them** — the exact
  "cluster forming" moment we want. Degenerate cases: 2 members → a capsule/line,
  1 active → fade out.
- A **count label** ("6") floating at the centroid (canvas sprite, same
  technique as `makeGroundLabel`).
- **Stable per-gaggle colour** keyed off `episode.id`, visually distinct from the
  name-hashed *pilot* colours (e.g. translucent white/cyan family) so a gaggle
  reads as a shared envelope, not another pilot.
- **Fade-in on episode start / fade-out on end** so formation and dissolution are
  legible even at low playback speed.
- Respects `vScale` per-object (mean altitude × vScale), matching the existing
  trail/marker/cylinder convention — never a group scale (would shear cones).

Hosted like `FlightScene.group`: added to the scene by both backends, updated
once per frame off the samples the loop already computes (allocation-free: reuse
geometry buffers and scratch vectors, per the existing perf discipline).

### 4.2 Gaggle timeline ribbon (under the scrubber) — the macro view

A horizontal strip spanning `t0..t1`, lane-packed bars, one per episode,
positioned by `tStart..tEnd`, coloured per gaggle, height/opacity ∝ size. This
makes **"when and where do gaggles form"** glanceable — you can see the fat start
gaggle and the scattered mid-course ones at once. Hover → tooltip (size, members,
near-TP, time). Click → seek to `tStart` (optionally start following it). A
playhead marker tracks the scrubber.

### 4.3 Gaggle panel (collapsible, like the pilot legend)

Reuse `makeCollapsible`. Toggle "currently active only / all episodes". Each row:
gaggle swatch · size · time range · near-turnpoint · member names. Hover →
highlight that blob and dim others (mirror the pilot-legend highlight). Click →
seek + **follow the gaggle centroid** (reuse the existing follow-delta mechanism
by feeding a synthetic `MarkerSample` at the live centroid).

### 4.4 Controls

A "Gaggles" toggle (show/hide the overlay) next to the existing view controls,
plus — for iteration — optional dev-only sliders (`import.meta.env.DEV`) for
`horizontalRadius` / `verticalBand` / `minPilots` so thresholds can be felt
live without editing constants.

---

## 5. Demo & iterate loop (on the 3dvis sample)

1. `bun run dev:frontend` → http://localhost:3000/samples/3dvis (asset already
   built; `bun run build-3dvis` only if regenerating).
2. Compute gaggles at load from the loaded tracks; render blobs + ribbon + panel.
3. **Calibrate against ground truth in the sample:**
   - The **start gaggle** — most pilots bunched in/near the SSS cylinder before
     the start time — should show as one big, long-lived episode. Tune
     `horizontalRadius` / `minPilots` until it's captured without absorbing the
     whole sky.
   - **Mid-course thermal gaggles** — scrub each leg; smaller episodes should
     appear at climbs and dissolve on glides. Tune `minDurationSeconds` /
     `bridgeSeconds` so transient crossings don't register and real climbs don't
     flicker.
   - Watch a **join** — a trailing pilot catching a gaggle at a thermal — and
     confirm the blob visibly engulfs them.
4. Adjust params (dev sliders or constants), reload, repeat.
5. **Verify visually with Playwright** (per `docs/3d-flight-replay-notes.md`: the
   abstract view screenshots fine in the preview harness; Mapbox needs Playwright
   with a real viewport). Capture a forming gaggle and the start gaggle.

---

## 6. Tests (`web/engine/tests/cluster-detector.test.ts`)

Pure engine, synthetic frames — fast and deterministic:

- **`clusterFrame`**: two pilots within `horizontalRadius` → one cluster; beyond →
  none; same horizontal but altitude gap > `verticalBand` → not linked; a chain
  of three documents single-linkage behaviour; `minPilots` filtering.
- **`detectGaggles` / tracking**: a gaggle that forms (members grow), persists
  across a one-frame dropout (bridged), gains a member mid-episode (snapshot
  membership updates), splits, and dissolves; `minDurationSeconds` drops a brief
  fly-by; episode `tStart/tEnd/peakSize/timeline` correct.
- **Determinism**: same input → identical episodes/ids.
- **Convex-hull helper** (if added): collinear points, duplicates, n<3.

Run via `bun run test` (engine + typecheck).

---

## 7. Edge cases & performance

- Exclude inactive pilots per frame (pre-takeoff, landed, gaps) — already flagged
  by `samplePilot().active`.
- Grid alignment to `t0`; handle the final partial step; `t1` inclusive.
- Identical/overlapping positions (stacked in a thermal) — fine, distance 0.
- Larger fields (100+ pilots): per-frame O(n²) × frames is still well under a
  frame budget; detection runs once at load. If ever needed, spatial-bin the
  proximity test. **Log** any cap (e.g. max episodes drawn) rather than silently
  truncating.
- Keep the per-frame overlay allocation-free (reuse buffers/scratch vectors);
  recomputing a <32-point hull for <~5 active gaggles is negligible.

---

## 8. Phasing

| Phase | Deliverable | Done when |
|---|---|---|
| **0 — Spike** | Runtime clustering at load + simplest overlay (ground ring per active cluster) | Start gaggle + a mid-course gaggle visibly captured on the sample |
| **1 — Engine** | `cluster-detector.ts` (`clusterFrame`, `detectGaggles`) + tests, exported from `index.ts` | `bun run test` green; episodes match the spike visually |
| **2 — In-scene viz** | `gaggle-layer.ts`: translucent hull blob + count label + stable colour + fade in/out, vScale-correct, both backends | Scrubbing shows blobs form/grow/dissolve; Playwright screenshot confirms |
| **3 — UI** | Timeline ribbon + gaggle panel + toggle + click-to-seek/follow + dev sliders | Can find every gaggle from the ribbon and jump to it |
| **4 — Polish / port** | Move packing into the competition-api Worker; serve a single bundle per comp task; seed the sample as a real DB competition | ✅ Worker serves `GET /api/comp/.../3dvis` (+ `sample-3dvis`); `bun run seed:sample` (idempotent) loads the sample comp; page loads via `loadBundle`. See docs/3d-flight-replay-notes.md §8. |

---

## 9. Open decisions (recommended defaults in **bold**)

1. **Definition of "together":** 3D gates (horizontal + vertical) **[recommended]**
   vs horizontal-only. Vertical gate avoids calling a high pilot and a low pilot
   "together" just because they share a map pixel.
2. **Minimum gaggle size:** **3** (a genuine gaggle) vs 2 ("flying together").
3. **Compute timing:** **runtime at load now** (fast iteration) → bake into
   manifest/Worker later.
4. **Primary visual:** **translucent convex-hull blob + count label, plus the
   timeline ribbon** vs lighter-weight options (centroid sphere, member halos).
5. **Clustering method:** **single-linkage union-find** to start → DBSCAN if
   chaining appears during calibration.

None of these block Phase 0; they're calibrated against the sample during it.

---

## 10. Conventions to honour

- ENU frame **X=East, Y=Up, Z=South (North=−Z)**, right-handed; proximity is
  metric Euclidean in this frame (no `geo.ts` needed unless clustering from
  lat/lon — then use `andoyerDistance`, never inline math).
- Vertical exaggeration **per-object** (mean altitude × `vScale`), never a group
  scale.
- Keep the detector **pure/DOM-free** (Worker/build-time portable, like
  `packTracks`); keep the per-frame overlay allocation-free.
- Decisions explainable: episodes carry `timeline`, `members`, `nearTurnpoint`,
  and time bounds so the UI can always answer "who, when, where, why."

---

## 11. Known follow-ups

- **Revisit `nearTurnpoint` labels (Phase 3).** Some episode labels read wrong —
  e.g. an early-course gaggle near CUDGWE/TINTAL is tagged "near NCORGL". The
  detector picks the turnpoint nearest the episode centroid at its *midpoint*,
  which can land on a geometrically-close-but-wrong TP (and a long episode's
  midpoint may not represent where the gaggle actually was). Worth: sanity-check
  the turnpoint x/z projection feeding `DetectOptions.turnpoints`; consider using
  the *task leg* the gaggle is on (progress along the optimised line) rather than
  nearest-TP-to-centroid; or label by the nearest TP at each snapshot and take
  the mode. Cosmetic only — does not affect detection.
</content>
</invoke>
