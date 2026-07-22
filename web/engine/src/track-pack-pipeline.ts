// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Pure IGC → packed-tracks pipeline, shared by the offline build CLI
 * (web/engine/cli/build-3dvis.ts) and the competition-api Worker so they stay in
 * lockstep. Given each pilot's raw IGC text (+ optional task xctsk + timezone),
 * it parses fixes, runs GAP scoring to order the legend, and packs everything
 * into the binary manifest+Float32Array the 3D viewer consumes.
 *
 * No fs / gzip / DOM here — the caller does I/O (writeFileSync + zlib in the
 * CLI; R2 + CompressionStream in the Worker), keeping this Worker-portable.
 */

import { parseIGC, fixAltitude } from './igc-parser';
import { parseXCTask, type XCTask } from './xctsk-parser';
import { calculateOptimizedTaskDistance } from './task-optimizer';
import { scoreTask, DEFAULT_GAP_PARAMETERS, type GAPParameters, type PilotFlight } from './gap-scoring';
import { packTracks, type PackedTracks, type PilotTrackInput } from './track-packer';

/** One pilot's raw IGC for the task, with the name/id to display. */
export interface PilotIgc {
  /** Stable id (CIVL id or comp_pilot id) — passed through to the manifest. */
  id: string;
  /** Display name (the competition's registered pilot name). */
  name: string;
  /** Raw IGC file text. */
  igc: string;
}

export interface PackFromIgcInput {
  pilots: PilotIgc[];
  /** Raw xctsk JSON for the task, if any (drives task geometry + scoring). */
  taskXctsk?: string;
  /** IANA timezone for the comp location, stored on the manifest. */
  timezone?: string;
  /** GAP parameter overrides (the comp's gap_params), if any. */
  gapParams?: Partial<GAPParameters>;
}

/**
 * Parse + score + pack a task's IGC tracks into the 3D-replay binary. Pilots are
 * scored together in a single GAP run (one combined ranking for the legend, not
 * per-class) — this is for visualisation, not official results. Unparseable or
 * empty tracks are skipped. Throws only if no pilot has usable fixes.
 */
export function packTracksFromIgc(input: PackFromIgcInput): PackedTracks {
  let task: XCTask | undefined;
  if (input.taskXctsk) {
    try {
      task = parseXCTask(input.taskXctsk);
    } catch {
      task = undefined;
    }
  }

  const pilots: PilotTrackInput[] = [];
  const flights: PilotFlight[] = [];
  for (const p of input.pilots) {
    let igc;
    try {
      igc = parseIGC(p.igc);
    } catch {
      continue;
    }
    if (igc.fixes.length === 0) continue;
    const fixes = igc.fixes
      .map((f) => ({
        lat: f.latitude,
        lon: f.longitude,
        // Prefer GNSS altitude; fall back to pressure when GNSS is absent.
        alt: fixAltitude(f),
        t: Math.round(f.time.getTime() / 1000),
      }))
      .sort((a, b) => a.t - b.t);
    pilots.push({ id: p.id, name: p.name, fixes });
    flights.push({ pilotName: p.name, trackFile: p.id, fixes: igc.fixes });
  }

  // Score with CIVL GAP to order the legend by result. Best-effort: if scoring
  // throws (odd data / no task), the legend falls back to roster order.
  if (task) {
    try {
      const params: Partial<GAPParameters> = { ...DEFAULT_GAP_PARAMETERS, ...(input.gapParams ?? {}) };
      // Mirror the official scoring path (competition-api scoring.ts): default
      // nominalDistance to 70% of task distance whenever the *stored* params
      // didn't set it. Checking `params` after merging defaults never fires
      // because DEFAULT_GAP_PARAMETERS.nominalDistance is 70 km, so gate on the
      // raw input instead.
      if (!input.gapParams?.nominalDistance) {
        params.nominalDistance = calculateOptimizedTaskDistance(task) * 0.7;
      }
      const result = scoreTask(task, flights, params);
      // Pair by trackFile (the stable pilot id we fed in) — names can collide.
      const byId = new Map(result.pilotScores.map((ps) => [ps.trackFile, ps]));
      for (const p of pilots) {
        const ps = byId.get(p.id);
        if (ps) {
          p.rank = ps.rank;
          p.score = ps.totalScore;
          // Turnpoint reach times (UTC seconds) so the viewer can resolve each
          // pilot's "next turnpoint" at any replay time — feeds the required-
          // glide readout in the metrics callout.
          p.reached = ps.turnpointResult.sequence.map((r) => ({
            tp: r.taskIndex,
            t: r.time.getTime() / 1000,
          }));
        }
      }
    } catch {
      /* leave pilots unranked */
    }
  }

  return packTracks({ pilots, task, timezone: input.timezone });
}
