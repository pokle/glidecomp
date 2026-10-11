/**
 * The stage 1 engine check: proves the scoring engine runs unchanged on the
 * phone's JavaScript engine (Hermes), including the two places it touches
 * platform APIs — decompressing an XCTSKZ task, and time zones through Intl.
 *
 * Pure: no React Native imports, so Jest runs it and bun can too.
 */
import {
  calculateOptimizedTaskDistance,
  parseIGC,
  parseXCTaskAsync,
  resolveCompGapParams,
  scoreTask,
  type GAPParameters,
  type PilotFlight,
} from '@glidecomp/engine';
import { timezoneForXctsk } from '@glidecomp/engine/timezone';
import { strFromU8, strToU8, unzlibSync, zlibSync } from 'fflate';

export interface EngineCheckInput {
  taskName: string;
  xctsk: string;
  /** The comp's stored GAP settings, merged over the category defaults. */
  gapParams: Partial<GAPParameters>;
  tracks: readonly { file: string; igc: string }[];
}

export interface EngineCheckResult {
  taskName: string;
  /** Optimised task distance, km, two decimals — AirScore prints the same. */
  distanceKm: string;
  /** IANA zone derived from the task's first turnpoint. */
  zone: string;
  winner: {
    name: string;
    points: number;
    /** Start gate taken, in the comp's zone, HH:MM:SS. */
    start: string;
    /** End of speed section, in the comp's zone, HH:MM:SS. */
    ess: string;
  };
  pilotsScored: number;
  elapsedMs: number;
}

/**
 * The app supplies its own inflater, so the engine never needs Hermes to have
 * DecompressionStream. XCTSKZ is base64 over a zlib stream.
 */
export async function inflateXctskz(base64: string): Promise<string> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return strFromU8(unzlibSync(bytes));
}

/** The inverse, so the check can exercise the compressed path on a plain file. */
export function deflateToXctskz(json: string): string {
  const bytes = zlibSync(strToU8(json));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `XCTSKZ:${btoa(binary)}`;
}

export function formatClock(date: Date, zone: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: zone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

export async function runEngineCheck(input: EngineCheckInput): Promise<EngineCheckResult> {
  const started = Date.now();

  // Round-trip the task through XCTSKZ so the injected inflater is what parses it.
  const task = await parseXCTaskAsync(deflateToXctskz(input.xctsk), inflateXctskz);
  const zone = timezoneForXctsk(task);
  if (!zone) throw new Error('No time zone for the task');

  const pilots: PilotFlight[] = input.tracks.map(({ file, igc }) => {
    const parsed = parseIGC(igc);
    return { pilotName: parsed.header.pilot || file, trackFile: file, fixes: parsed.fixes };
  });

  // As the competition API scores a task: the comp's settings over its
  // category's defaults, with nominal distance at 70% of the optimised route.
  const taskDistance = calculateOptimizedTaskDistance(task);
  const params = resolveCompGapParams('hg', input.gapParams);
  params.nominalDistance = taskDistance * 0.7;
  const result = scoreTask(task, pilots, params);

  const winner = result.pilotScores.find((p) => p.rank === 1);
  const start = winner?.turnpointResult.startGate?.time ?? winner?.turnpointResult.sssReaching?.time;
  const ess = winner?.turnpointResult.essReaching?.time;
  if (!winner || !start || !ess) throw new Error('The sample has no pilot in goal');

  return {
    taskName: input.taskName,
    distanceKm: (taskDistance / 1000).toFixed(2),
    zone,
    winner: {
      name: winner.pilotName,
      points: Math.round(winner.totalScore),
      start: formatClock(start, zone),
      ess: formatClock(ess, zone),
    },
    pilotsScored: result.pilotScores.length,
    elapsedMs: Date.now() - started,
  };
}
