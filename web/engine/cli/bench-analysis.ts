#!/usr/bin/env bun
/**
 * bench-analysis CLI — Time the client-side flight-analysis functions
 * (detectFlightEvents + detectCircles) over a whole field for one bundled
 * sample task. Complements bench-task.ts, which times the Worker scoring /
 * 3D-replay paths; this covers the analysis page (`web/frontend`), which runs
 * these two detectors per pilot in the browser.
 *
 * Reports the median and min wall-clock over the whole field across N timed
 * iterations (after a warmup), plus per-track figures, as JSON.
 *
 * Usage:
 *   bun web/engine/cli/bench-analysis.ts <task-dir> [N]
 *
 * Example:
 *   bun web/engine/cli/bench-analysis.ts web/samples/comps/corryong-cup-2026-open-t1
 *
 * Before/after comparison: run it once against a git worktree of the baseline
 * commit and once against HEAD, on the SAME fixture, interleaving several
 * rounds and taking the median — single runs are JIT/GC-noisy, and this
 * environment's process-to-process noise floor is ~±10% (established by
 * comparing byte-identical parseIGC across revisions).
 */
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { parseIGC } from "../src/igc-parser";
import { parseXCTask } from "../src/xctsk-parser";
import { detectFlightEvents } from "../src/event-detector";
import { detectCircles } from "../src/circle-detector";
import type { IGCFix } from "../src/igc-parser";

const args = process.argv.slice(2);
const taskDir = args.find((a) => !a.startsWith("--"));
const N = Number(args.find((a) => /^\d+$/.test(a)) ?? 9);
if (!taskDir) {
  process.stderr.write("Usage: bench-analysis <task-dir> [N]\n");
  process.exit(1);
}

const xctskFile = readdirSync(taskDir).find((f) => f.endsWith(".xctsk"));
if (!xctskFile) throw new Error(`no .xctsk in ${taskDir}`);
const task = parseXCTask(readFileSync(join(taskDir, xctskFile), "utf8"));

// Parse every track once — parseIGC cost is measured by bench-task, not here.
const tracks: IGCFix[][] = readdirSync(taskDir)
  .filter((f) => f.endsWith(".igc"))
  .sort()
  .map((f) => parseIGC(readFileSync(join(taskDir, f), "utf8")).fixes)
  .filter((fx) => fx.length > 0);

const totalFixes = tracks.reduce((s, f) => s + f.length, 0);

// Warmup so the JIT has compiled the hot loops before timing.
for (let w = 0; w < 2; w++)
  for (const fixes of tracks) {
    detectFlightEvents(fixes, task);
    detectCircles(fixes);
  }

/** Median + min whole-field ms over N timed passes. */
function timeN(fn: (fixes: IGCFix[]) => unknown) {
  const runs: number[] = [];
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    for (const fixes of tracks) fn(fixes);
    runs.push(performance.now() - t);
  }
  runs.sort((a, b) => a - b);
  const median = runs[Math.floor(N / 2)];
  return {
    median: +median.toFixed(1),
    min: +runs[0].toFixed(1),
    perTrackMedian: +(median / tracks.length).toFixed(2),
  };
}

console.log(
  JSON.stringify(
    {
      task: basename(taskDir),
      runtime:
        typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
          ? "bun"
          : `node ${process.version}`,
      tracks: tracks.length,
      totalFixes,
      N,
      detectFlightEvents_ms: timeN((fixes) => detectFlightEvents(fixes, task)),
      detectCircles_ms: timeN((fixes) => detectCircles(fixes)),
    },
    null,
    1
  )
);
