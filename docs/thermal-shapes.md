# Thermal shapes

Each competition task is a natural experiment: many pilots climb the same
thermal, so pooling every pilot's track through one climb reconstructs the
thermal itself. The idea comes from Tomas Suchanek's thermal model in *Secrets
of Champions* (Pagen): a thermal has mass, so it stands against the wind like a
tethered balloon — it leans downwind, and the lift is strongest near the sharp
upwind edge. The archive data supports both claims (see "What the archive
says" below).

Everything is **measured, never modelled**: no fitted lift profile, no assumed
symmetry. Where the sampling is too thin, a band is dropped rather than
invented.

## How a shape is measured

`web/engine/src/field-analysis/thermal-shape.ts`, on top of the shared-thermal
clustering (`shared-thermals.ts`) and the circle detector.

1. Cluster every pilot's thermal segments into shared thermals (space + time
   union-find). Because the linking is transitive, a soared ridge chains into
   one 2 km "thermal" and a house thermal into an 80-minute blob — so clusters
   that are too elongated (> 1 km along their principal axis) or too
   long-lived (> 30 min) are **split recursively** at the widest gap along the
   offending axis.
2. Pool the fixes of every use, with a smoothed vario per fix (±2.5 s window).
3. Cut the pool into 100 m altitude bands. A band's **core** is the
   lift-weighted centroid of its fixes — so the band-by-band core positions
   trace the lean, and everything computed *around* the core (sector roses,
   radii) is normalised for lean and drift by construction.
4. Per band: working radius (lift-weighted RMS), extent radius (p90 of all
   fixes), mean/max climb, 8-sector lift rose, and **sub-cores** (union-find
   clusters of the strongest fixes — two or more in one band are separate
   feeders that had not merged yet).
5. Per thermal: the **lean** (weighted fit of band cores vs altitude, with a
   `confounded` flag when altitude and time correlate > 0.85 across the pool —
   a field climbing as one wave cannot separate lean from drift), the
   **wind** (per-circle estimates: direction from the vector mean, speed from
   the median magnitude — a vector mean's length collapses with scatter and
   would misreport a windy day as calm), and the **strongest side**.

## Storage and surfaces

- The field-analysis report carries `thermals` — summaries only, no point
  clouds — capped at `MAX_THERMAL_SHAPES` with `totalShapeCount` recording the
  census (a UI must say "top N of M", never present the cap as the census).
  Added in `FIELD_ANALYSIS_VERSION` 20; stale-first storage, ETag, SSR seed
  and invalidation all ride the existing `task_field_analysis` machinery.
- **Task analysis page** (`/comp/:id/analysis/task/:id`): "The day's thermals"
  section — census table, top-down lift rose, readouts, climb profile, band
  table. The model-wind cross-check comes from the task's weather column
  (independent request, `windAtHeight` interpolation) and is always drawn
  dashed and credited as a model run, never blended with the measurement.
- **3D replay** (`/replay?comp=&task=`): `ThermalLayer` draws each thermal as
  a ring stack (one ring per band at the measured core + working radius), the
  core axis, and feeder diamonds. The pilots' own trails are the point cloud.
  Columns fade with the clock outside their active window. `?thermal=<id>`
  deep-links one column (the analysis page's "watch this thermal" link);
  picking one in the drawer flies the camera in and jumps the clock.
  The replay fetches the same stored report the analysis page renders, so the
  two surfaces cannot disagree.
- **Research CLI**: `bun web/engine/cli/thermal-shapes.ts <task-dir>` — works
  directly on `glidecomp-archive` task dirs (no scoring needed), with
  `--out`/`--min-pilots`/`--no-samples`/`--no-weather`.

## What the archive says

Sweep over the archive (`open` classes, 2022–2026, four sites; the sweep
script lives with the analysis session, results summarised here):

- Flatland leans track the model's downwind direction far above chance.
- The strongest sector is biased toward the model's **upwind** direction —
  Suchanek's upwind ridge, visible in aggregate.
- Track-measured wind direction agrees with the model closely on windy days;
  both are noisy below ~3 m/s.

## Caveats to keep in mind

- Sampling is where pilots flew, not where the thermal was: a side nobody
  explored is invisible, not weak. Lift-weighted cores inherit this bias.
- Per-fix vario is differentiated GPS/baro altitude — individual samples are
  noisy; the band statistics are the trustworthy layer.
- Shapes are per pilot class (the report is); on multi-class tasks the replay
  overlays the largest class's shapes.
