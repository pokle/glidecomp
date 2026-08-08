# Bundled sample data — comps, fixtures, and the seed script

The comps GlideComp ships with, where they came from, and the rules the seed
script follows. Current-state reference, not a plan.

## What is bundled

Everything lives under `web/samples/comps/`:

| Comp | Kind | Notes |
|---|---|---|
| **Corryong Cup 2026** | real AirScore download | the canonical example — two pilot classes |
| **Unungra Cup 2020** | real AirScore download | |
| `corryong-cup-2021-open-t1` | curated task folder | the gap-2018 parity fixture the engine tests score |
| **Big Chip** | synthetic, hidden | open-distance |
| **Kosciuszko Loop** | synthetic, hidden | exit turnpoints (issue #347) |

Only each competition's **most recent year** is bundled. The rest of Corryong
2021 lives in the archive (below).

Each comp is one folder per task (`<slug>-<class>-t<N>`) plus a `<slug>/` meta
folder holding a `comp.json` manifest, the region `waypoints.wpt`/`.json`, and —
since the AirScore-formula capture — `gap_params`, the parameters AirScore
actually scored the comp with, mapped by
`web/scripts/lib/airscore-formula-map.ts`, with per-task overrides on the task
entries.

Corryong Cup 2026 is worth understanding because it is the awkward shape:
AirScore scores the event as **two** comps — open and floater — flying different
tasks per day. Here they become one comp with two pilot classes, so a pilot who
flew both (e.g. CIVL 46402) gets one `comp_pilot` row per class.

## History back-catalogue

Older years (Corryong 2017 and 2021–2025) and the wider history (Forbes
Flatlands, Dalby Big Air, Bright Open, …) live in the separate
**[pokle/glidecomp-archive](https://github.com/pokle/glidecomp-archive)** repo,
kept for occasional scoring-parity verification.

All comp scripts accept `GLIDECOMP_COMPS_DIR=<archive>/comps` to operate on that
checkout. Those registry entries are `history: true`, so the default
`bun run seed` never touches them — seed by slug, or with `--history`.

Parity gate: `bun web/scripts/verify-airscore-parity.ts <slug>` compares engine
totals against the published AirScore results.

## Re-downloading from source

`bun web/scripts/download-airscore-comp.ts <slug>` (e.g. `corryong-cup-2026`).
Idempotent and politely rate-limited (`REQUEST_DELAY_MS`, default 3500 ms). It
rebuilds every task folder and the waypoints from xc.highcloud.net, with a curl
fallback for environments where Bun's fetch can't tunnel the egress proxy.

- A folder carrying a `.curated` marker (the AirScore-parity fixtures) is left
  untouched.
- `--manifest-only` regenerates manifests (formula capture + xctsk repairs) from
  the raw JSONs already on disk, with no network.
- New comps go in the `COMPS` registry in that script.

## Seeding into D1 + R2

`bun run seed` — idempotent; `--remote` for production. Seeds every bundled
non-history comp, reading each `comp.json` and loading all tasks, classes,
pilots and tracks (one Miniflare boot is shared across all of them), writing the
comp-level and per-task `gap_params`.

Pass one or more slugs to seed just those: `bun run seed big-chip kosci-loop`.

### A task that was set but never flown

A manifest lists the tasks the source published, and AirScore publishes a day it
called off the same as one it scored: a route, zero results, zero day quality.
Such a folder holds a `task.xctsk` and no IGC at all (Dalby Big Air 2022 T6, both
classes — the last day of that comp). There is nothing to seed for it, so the
task is named on stdout and left out rather than aborting the comp:

```
  open/Task 6 (2022-04-09): no tracklogs — not flown, skipped
```

Skipped, not silently dropped: an empty folder is far more likely to be a task
whose download failed than a real cancellation, and the line is how you tell.

### Manifest fields

| Field | Meaning |
|---|---|
| `comp_name` | the D1 comp name; defaults to the fixed Corryong `SAMPLE_COMP_NAME` |
| `category` | |
| `scoring_format` | `gap` \| `open_distance`; default `gap` |
| `hidden` | seeds with D1 `test=1` → excluded from the public list, anonymous visitors 404. Default public |
| `history` | see back-catalogue above |

### Track-less published pilots

Result rows with no (or empty) IGC are synthesized as DNF statuses or manual
flights at the published distance, so the seeded field matches the field
AirScore scored.

Such a row is **matched onto the pilot's own registration by name within the
class** before a new one is minted (`buildTrackedNameIndex`). This matters
because the two sources identify a pilot differently — an IGC filename carries
the federation id, a published result row carries only a name. Keying them apart
split anyone who flew one day and had an unusable tracklog on another (a
header-only "Failed security check" file) into **two** `comp_pilot` rows: twice
in the scores with a share of their tasks each, and twice in the S7F §9.1
launch-validity buckets. It was 15 of Corryong 2026's 80 registrations.

Two edges:

- A name held by two different federation ids in one class is genuinely
  ambiguous, and still gets its own name-keyed row.
- Where a matched row lands on a task the pilot already has a track for, it is a
  duplicate registration in the source rather than a second flight, and is
  skipped. (AirScore lists Christopher Sutton twice in floater T1 — once with a
  glider and a track, once blank at 0.01 km.) So the seeded field for such a
  task is one smaller than AirScore's own.

### A reseed preserves every id that appears in a URL

`web/scripts/lib/seed-identity.ts`. `/comp/:comp/task/:task/pilot/:pilot` is a
shareable, indexable link, and rebuilding a comp by deleting and reinserting its
rows handed out fresh auto-increment ids and 404'd every saved link.

The comp row was always matched by name and reused. Tasks and pilots now match
the same way one level down — a task by its seeded name (`<name> (<Class>)`), a
pilot registration by the same (class, federation-id-or-name) key that already
collapses a pilot's tasks onto one `comp_pilot` row. Matched rows are UPDATEd in
place, unmatched ones deleted, so the comp still ends up holding exactly what the
source describes.

Consequences worth knowing:

- A pilot who linked their account to a seeded registration keeps that link.
- A task's cached weather survives — it is keyed by route + date, not by a
  revision, so an unchanged task keeps its answer.
- The two organizer-owned task fields the source can't describe
  (`stop_announcement_time`, `weather_notes`) are reset, exactly as the old
  delete-and-reinsert did.
- The wipe still clears that comp's materialized derived caches (`task_scores`,
  `task_field_analysis`, `track_analysis`). The tracks behind them are all
  rebuilt, so every blob is stale even where the ids it names still resolve — and
  a reused task is never deleted, so the FK cascade would not fire for it at all.

### Edge purge on `--remote`

Best-effort purge of that comp's public URLs from Cloudflare's edge: comp hub /
scores / waypoints HTML, the comp-level scores API, and each task page, task
score API and pilot score page — those URLs are stable across reseeds too, and
would otherwise serve pre-reseed content for up to their max-age (three months
for a settled comp).

Chunked at 30 URLs per call (the API's limit). A no-op unless both
`CLOUDFLARE_API_TOKEN` (with Cache Purge permission) and `CLOUDFLARE_ZONE_ID` are
set. The edge purge can't touch an already-cached *browser* copy, so hard-refresh
after reseeding a comp you are viewing.

## Synthetic fixture: Big Chip (open distance)

`web/samples/comps/big-chip/` (meta: `comp.json` + paste-ready `pilots.tsv`)
plus `big-chip-t1/` and `big-chip-t2/`, each a single-`TAKEOFF` open-distance
`task.xctsk` + 50 IGC tracks.

Two tasks tow-launch from Jil Jil Farm near Birchip, VIC, inside a 5 km take-off
("launch") cylinder; pilots fly downwind (Task 1 NE, Task 2 SE). Each track is an
emergent soaring model — hunt for a thermal, circle up, glide downwind, hunt
again, land when the altitude runs out — so distance falls out of how many
thermals a pilot connects with (a bell curve over thermal count: the bulk make
about half the field's best, with thin tails). Open-distance scoring measures
from the cylinder exit, so short flights that never leave it score 0.

Fully fabricated by `bun web/scripts/generate-big-chip.ts` (deterministic seeded
PRNG → byte-stable output; re-run and commit).

```
bun run seed big-chip
bun run score-task -- --open-distance web/samples/comps/big-chip-t1/task.xctsk web/samples/comps/big-chip-t1/
```

Seeds as comp **"Big Chip"**, hidden — it's a fabricated fixture, so it is absent
from the public comp list and 404s for anonymous visitors. Sign in as an admin to
view it.

## Synthetic fixture: Kosciuszko Loop (exit turnpoints, issue #347)

`web/samples/comps/kosci-loop/` (meta) plus `kosci-loop-t{1,2,3}/`, each a
`CLASSIC` GAP race `task.xctsk` with start gates + 44 IGC tracks. A PG
race-to-goal comp centred on Mount Kosciuszko (`-36.455825, 148.263502`, 2228 m);
one shared 44-pilot field flies all three tasks.

- **Task 1 "Grand Loop"** — the canonical #347 shape: concentric
  TAKEOFF/SSS/ESS/GOAL plus one 10 km **exit** ring (fly out across it, turn,
  return to goal).
- **Task 2 "Double Ring"** — a second concentric exit ring (5 km + 11 km,
  sequential exits).
- **Task 3 "Ridge Run"** — point-to-point around named peaks
  (Townsend/Blue Lake/Rams Head/Thredbo), all **enter** turnpoints. The
  contrast and regression-guard case.

Each field spans every outcome — made goal; tagged the ring then landed on
return; never flew out of the ring, so scored the outbound distance; never
crossed the start, so 0 — via a bell curve on how far each pilot flies. Tracks
are route-following with a triangle-wave altitude and cross-track wander, not the
Big Chip soaring model.

Fully fabricated by `bun web/scripts/generate-kosci-loop.ts` (deterministic
seeded PRNG → byte-stable; re-run and commit); the generator sanity-prints
per-task outcomes and the inferred turnpoint directions. Seed with
`bun run seed kosci-loop`. Seeds as comp **"Kosciuszko Loop"**, hidden, same as
Big Chip.

**Headless caveat:** every exit-ring task is fully concentric (all turnpoints at
the summit), so the map's auto-fit has zero extent and won't recenter — verify
the rings and arrowheads by setting the map view manually.

## 3D replay data

The replay at `/replay` loads packed tracks from the competition-api Worker:
`GET /api/comp/sample-3dvis` (the first task by date) or
`/api/comp/:comp_id/task/:task_id/3dvis` for any comp task. Packing is
`packTracksFromIgc` in the engine, shared with the offline `bun run build-3dvis`
mirror. See [3d-flight-replay-notes.md](3d-flight-replay-notes.md).
