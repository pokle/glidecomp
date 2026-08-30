// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Tiny shared idioms used across the task-analysis foundation and metrics.
 * Nothing here computes a number a report prints — these exist so the same
 * three-line patterns aren't hand-spelled in eight places.
 */

/** Milliseconds in one hour — the bucketing unit for every hourly view. */
export const HOUR_MS = 3_600_000;

/** Epoch ms of the start of the UTC hour containing `tMs`. */
export function hourStartMs(tMs: number): number {
  return Math.floor(tMs / HOUR_MS) * HOUR_MS;
}

/** Append `value` to the array at `key`, creating the array on first use. */
export function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
