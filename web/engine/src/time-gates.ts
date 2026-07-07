/**
 * Start-gate time resolution (FAI S7F §6.3.3, §8.3.1).
 *
 * XCTrack task files carry start gates as time-of-day strings ("13:30:00Z",
 * UTC), while tracklogs carry absolute times. This module turns a task's
 * gates into absolute epoch times near a reference instant taken from the
 * flight, so the scorer can snap each pilot's start to a gate.
 *
 * In a race to goal, a pilot's start time is the last gate at or before
 * their start-cylinder crossing — not the crossing itself (§8.3.1). A
 * crossing after the last gate takes the last gate. A crossing before the
 * first gate is a failed ("early") start, handled by §12.2.
 */

import type { XCTask } from './xctsk-parser';

const TIME_OF_DAY_RE = /^(\d{1,2}):(\d{2})(?::(\d{2}))?Z?$/;

/**
 * Parse an xctsk time-of-day string to seconds since midnight UTC.
 * Accepts "HH:MM:SSZ" (the XCTrack format), plus "HH:MM:SS" and "HH:MM".
 * Returns null for anything unparseable or out of range.
 */
export function parseTimeOfDayUTC(value: string): number | null {
  const m = TIME_OF_DAY_RE.exec(value.trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const s = m[3] ? parseInt(m[3], 10) : 0;
  if (h > 23 || min > 59 || s > 59) return null;
  return h * 3600 + min * 60 + s;
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Resolve a time-of-day (seconds since midnight UTC) to the absolute epoch
 * time nearest a reference instant.
 *
 * Combining a time-of-day with "the flight's date" naively breaks near
 * midnight UTC (an Australian task at 01:30 UTC flown from a track whose
 * first fix is 23:50 UTC the previous day would land a day early). Instead
 * the occurrence within ±12 h of the reference is chosen.
 */
export function resolveTimeOfDayNear(
  secondsOfDay: number,
  referenceMs: number,
): number {
  const dayStart = Math.floor(referenceMs / DAY_MS) * DAY_MS;
  let candidate = dayStart + secondsOfDay * 1000;
  if (candidate - referenceMs > DAY_MS / 2) candidate -= DAY_MS;
  else if (referenceMs - candidate > DAY_MS / 2) candidate += DAY_MS;
  return candidate;
}

/**
 * A task's start gates as sorted absolute epoch-ms times, or null when the
 * task is not a gated race.
 *
 * Returns null when:
 * - the task's SSS is not RACE type (elapsed-time tasks are timed from the
 *   pilot's actual crossing — already spec-correct without gates), or
 * - there are no parseable gates, or
 * - the only gate is "00:00:00Z" — the placeholder toXctskJSON writes to
 *   satisfy the format's non-empty-gates rule. A real midnight-UTC start
 *   gate does not occur in practice, while the placeholder is common in
 *   hand-built tasks, so a lone midnight gate is treated as "no gates".
 *
 * @param task - The competition task
 * @param referenceMs - An instant during the flight (e.g. a start-cylinder
 *   crossing or the first fix) used to place the gates on the right day
 */
export function resolveStartGates(
  task: XCTask,
  referenceMs: number,
): number[] | null {
  if (task.sss?.type !== 'RACE') return null;
  const raw = task.sss.timeGates ?? [];
  const seconds = raw
    .map(parseTimeOfDayUTC)
    .filter((s): s is number => s !== null);
  if (seconds.length === 0) return null;
  if (seconds.length === 1 && seconds[0] === 0) return null; // placeholder
  const resolved = seconds.map((s) => resolveTimeOfDayNear(s, referenceMs));
  resolved.sort((a, b) => a - b);
  // Dedupe — repeated gate times add nothing and would misreport gateCount.
  return resolved.filter((t, i) => i === 0 || t !== resolved[i - 1]);
}

/**
 * The gate defining a pilot's start time: the last gate at or before the
 * crossing (§8.3.1), the last gate for crossings after it. Returns the
 * index into `gates`, or -1 when the crossing precedes the first gate
 * (an early start, §12.2).
 *
 * @param gates - Sorted absolute gate times from {@link resolveStartGates}
 * @param crossingMs - The pilot's start-cylinder crossing time
 */
export function gateIndexForCrossing(
  gates: number[],
  crossingMs: number,
): number {
  if (crossingMs < gates[0]) return -1;
  let idx = 0;
  while (idx + 1 < gates.length && gates[idx + 1] <= crossingMs) idx++;
  return idx;
}
