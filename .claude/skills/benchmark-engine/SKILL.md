---
name: benchmark-engine
description: Benchmark the GlideComp analysis engine (web/engine) and compare performance before vs after a change. Use whenever asked for a performance test, benchmark, timing, throughput, or perf-regression check of the scoring / turnpoint / IGC-parsing / flight-event / circle-detection / 3D-packing code.
---

# Benchmark the analysis engine

`web/engine` is where the compute-heavy work lives (IGC parsing, turnpoint
sequence resolution, GAP + open-distance scoring, flight-event & circle
detection, 3D track packing). Two ready-made harnesses time the real code
against bundled sample comps — never microbenchmark a function in isolation;
use these so the input is realistic.

## The two harnesses

Run from the repo root. Both print JSON with per-stage millisecond timings.
Pass args after `--`.

- **`bun run bench-task -- <task-dir> [--leading] [--open-distance]`**
  (`web/engine/cli/bench-task.ts`) — the **Worker paths**. Mirrors
  competition-api: per track `gunzip → parseIGC → resolveTurnpointSequence →
  toFlightScoringData`, then one `scoreFlights` over the field; and the 3D
  path `packTracksFromIgc → gzip`. `--leading` also times the leading-coefficient
  scan (`computeLeadingAggregate`/`lcContribution`, the per-fix hot path);
  `--open-distance` swaps in `openDistanceForFlight`/`scoreOpenDistanceFlights`.
  Output keys: `scoring_ms.{gunzip,parseIGC,resolveTurnpoints,leadingScan,scoreFormula,TOTAL}`,
  `threedvis_ms.{parseScorePack,gzipBundle,TOTAL}`, plus `tracks`, `totalFixes`.

- **`bun run bench-analysis -- <task-dir> [N]`**
  (`web/engine/cli/bench-analysis.ts`) — the **browser analysis path**. Times
  `detectFlightEvents` + `detectCircles` over the whole field (median/min of N
  passes after a warmup). This is the client-side path the analysis page runs.

## Fixtures

Bundled comps under `web/samples/comps/` (each has a `task.xctsk` + real `.igc`
tracks):

- `corryong-cup-2026-open-t1` — **33 real IGC tracks, ~287k fixes**. The default
  GAP-race fixture; also the AirScore-parity comp.
- `big-chip-t1` — 50 synthetic tracks, tow-launch open distance
  (use with `--open-distance`).
- `kosci-loop-t{1,2,3}` — exit-turnpoint / out-and-return race tasks.

## Before/after comparison (the important part)

Do NOT compare a single run on each revision — this environment's
**process-to-process noise floor is ~±10%** (JIT, GC, shared-CPU drift). The
method that survives it:

1. **Baseline in a throwaway worktree** (worktrees don't share `node_modules`):
   ```bash
   git worktree add /tmp/bench-base <baseline-commit>   # e.g. the merge-base of your branch
   (cd /tmp/bench-base && bun install)
   ```
   Run `bench-task` from *inside* the worktree so its `../src` imports resolve to
   the baseline engine; run `bench-analysis` against
   `/tmp/bench-base/web/engine/src/index.ts` (its arg can be an engine index path).
2. **Interleave** several rounds — `for r in 1..5: run HEAD; run BASE` — so CPU
   drift hits both equally. Take the **median** (and note the min) per stage.
3. **Calibrate with a control.** `parseIGC` (and `packTracksFromIgc`'s parse) is
   almost always unchanged by an engine refactor. Its before/after delta IS your
   noise floor for that run — any changed function whose delta is smaller than,
   or scatters around, the control's is within noise. A real regression is
   *systematic* (one direction across every stage); noise scatters both ways.
4. Clean up: `git worktree remove --force /tmp/bench-base`.

Report a table: function → baseline median, HEAD median, Δ%, and explicitly
call out the control's Δ as the noise floor. Flag only functions whose Δ is
consistently outside the noise band across rounds.

## Why per-fix vs per-field matters

Scores/tracks have **10k–40k fixes each**. A cost added inside a per-fix loop
(parse record, distance calc, thermal/glide scan, leading scan) is ~1000× more
impactful than one added per-task, per-pilot, or per-segment. When a benchmark
shows a real regression, first check whether the change landed inside a per-fix
loop — that's where it will actually hurt.
