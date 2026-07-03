#!/usr/bin/env bun
/**
 * bench-task CLI — Time the two compute-heavy Worker paths for one bundled
 * sample task, with every file local (no D1/R2/KV). Mirrors:
 *
 *   Scoring   (competition-api scoring.ts computeTaskScore):
 *     gunzip → parseIGC → resolveTurnpointSequence → toFlightScoringData
 *     → scoreFlights   (open distance: gunzip → parseIGC → openDistanceForFlight
 *     → scoreOpenDistanceFlights)
 *
 *   3D replay (competition-api visualization.ts buildTask3dvisBundle):
 *     gunzip → packTracksFromIgc (parse + GAP score + pack) → gzip bundle
 *
 * IGC files are gzipped in memory first to mirror what R2 stores, so the
 * gunzip cost the Worker pays is included.
 *
 * Usage:
 *   bun web/engine/cli/bench-task.ts <task-dir> [--open-distance] [--leading]
 *
 * Examples:
 *   bun web/engine/cli/bench-task.ts web/samples/comps/corryong-cup-2026-open-t1
 *   bun web/engine/cli/bench-task.ts web/samples/comps/big-chip-t1 --open-distance
 */
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { gzipSync, gunzipSync } from "zlib";
import { parseIGC } from "../src/igc-parser";
import { parseXCTask } from "../src/xctsk-parser";
import { calculateOptimizedTaskDistance } from "../src/task-optimizer";
import {
  scoreFlights,
  toFlightScoringData,
  taskForDistanceOrigin,
  computeLeadingAggregate,
  DEFAULT_GAP_PARAMETERS,
  type GAPParameters,
  type FlightScoringData,
} from "../src/gap-scoring";
import { resolveTurnpointSequence } from "../src/turnpoint-sequence";
import {
  scoreOpenDistanceFlights,
  openDistanceForFlight,
} from "../src/open-distance-scoring";
import { packTracksFromIgc } from "../src/track-pack-pipeline";

const args = process.argv.slice(2);
const taskDir = args.find((a) => !a.startsWith("--"));
if (!taskDir) {
  process.stderr.write(
    "Usage: bench-task <task-dir> [--open-distance] [--leading]\n"
  );
  process.exit(1);
}
const openDistance = args.includes("--open-distance");
const leading = args.includes("--leading");

const xctskFile = readdirSync(taskDir).find((f) => f.endsWith(".xctsk"));
if (!xctskFile) throw new Error(`no .xctsk in ${taskDir}`);
const xctskText = readFileSync(join(taskDir, xctskFile), "utf8");
const igcFiles = readdirSync(taskDir)
  .filter((f) => f.endsWith(".igc"))
  .sort();

// Pre-gzip all IGC text to mirror what R2 stores.
const gzipped = igcFiles.map((f) => {
  const text = readFileSync(join(taskDir, f), "utf8");
  return { name: f, gz: gzipSync(Buffer.from(text)), rawBytes: Buffer.byteLength(text) };
});
const totalRaw = gzipped.reduce((s, g) => s + g.rawBytes, 0);
const totalGz = gzipped.reduce((s, g) => s + g.gz.length, 0);

const now = () => performance.now();
const ms = (t: number) => +t.toFixed(1);

// ---------------------------------------------------------------------------
// Scoring path
// ---------------------------------------------------------------------------
let tGunzip = 0,
  tParse = 0,
  tResolve = 0,
  tLeading = 0,
  tOpenDist = 0,
  totalFixes = 0;
const xcTask = parseXCTask(xctskText);
const gapParams: Partial<GAPParameters> = {};
if (!openDistance) {
  gapParams.nominalDistance = calculateOptimizedTaskDistance(xcTask) * 0.7;
}
const scoringTask = taskForDistanceOrigin(
  xcTask,
  gapParams.distanceOrigin ?? DEFAULT_GAP_PARAMETERS.distanceOrigin
);

const flights: FlightScoringData[] = [];
const odFlights: { pilotName: string; trackFile: string; distance: number }[] = [];

const t0 = now();
for (const g of gzipped) {
  let t = now();
  const text = gunzipSync(g.gz).toString("utf8");
  tGunzip += now() - t;

  t = now();
  const igc = parseIGC(text);
  tParse += now() - t;
  totalFixes += igc.fixes.length;
  if (igc.fixes.length === 0) continue;

  if (openDistance) {
    t = now();
    const distance = openDistanceForFlight(xcTask, {
      pilotName: g.name,
      trackFile: g.name,
      fixes: igc.fixes,
    });
    tOpenDist += now() - t;
    odFlights.push({ pilotName: g.name, trackFile: g.name, distance });
  } else {
    t = now();
    const result = resolveTurnpointSequence(scoringTask, igc.fixes);
    tResolve += now() - t;
    const base = toFlightScoringData(
      { pilotName: g.name, trackFile: g.name, fixes: igc.fixes },
      result,
      false
    );
    if (leading) {
      t = now();
      const agg = computeLeadingAggregate(
        igc.fixes,
        scoringTask,
        result.sequence,
        base.sssTimeMs,
        base.essTimeMs,
        "weighted"
      );
      tLeading += now() - t;
      flights.push({ ...base, leadingAggregate: agg });
    } else {
      flights.push(base);
    }
  }
}
let t = now();
if (openDistance) scoreOpenDistanceFlights(odFlights);
else scoreFlights(scoringTask, flights, gapParams);
const tScore = now() - t;
const tScoringTotal = now() - t0;

// ---------------------------------------------------------------------------
// 3D-replay path
// ---------------------------------------------------------------------------
const t3 = now();
let tG = now();
const pilots = gzipped.map((g) => ({
  id: g.name,
  name: g.name,
  igc: gunzipSync(g.gz).toString("utf8"),
}));
const t3Gunzip = now() - tG;
tG = now();
const { data } = packTracksFromIgc({ pilots, taskXctsk: xctskText, gapParams: {} });
const t3Pack = now() - tG;
tG = now();
const gz = gzipSync(Buffer.from(data.buffer, data.byteOffset, data.byteLength));
const t3Gzip = now() - tG;
const t3Total = now() - t3;

console.log(
  JSON.stringify(
    {
      task: basename(taskDir),
      runtime:
        typeof (globalThis as { Bun?: unknown }).Bun !== "undefined"
          ? "bun"
          : `node ${process.version}`,
      tracks: igcFiles.length,
      totalFixes,
      rawMB: +(totalRaw / 1e6).toFixed(1),
      gzMB: +(totalGz / 1e6).toFixed(1),
      scoring_ms: {
        gunzip: ms(tGunzip),
        parseIGC: ms(tParse),
        resolveTurnpoints: ms(tResolve),
        ...(leading ? { leadingScan: ms(tLeading) } : {}),
        ...(openDistance ? { openDistance: ms(tOpenDist) } : {}),
        scoreFormula: ms(tScore),
        TOTAL: ms(tScoringTotal),
      },
      threedvis_ms: {
        gunzip: ms(t3Gunzip),
        parseScorePack: ms(t3Pack),
        gzipBundle: ms(t3Gzip),
        TOTAL: ms(t3Total),
        bundleMB: +(gz.length / 1e6).toFixed(1),
        floats: data.length,
      },
    },
    null,
    1
  )
);
