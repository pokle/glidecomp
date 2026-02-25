export type { IGCFix } from '../src/igc-parser';
import type { IGCFix } from '../src/igc-parser';

export const BASE_TIME = new Date('2024-01-15T10:00:00Z');

/** Create a fix at a time offset (seconds) from BASE_TIME */
export function createFix(
  timeSeconds: number,
  lat: number,
  lon: number,
  altitude = 1000
): IGCFix {
  return {
    time: new Date(BASE_TIME.getTime() + timeSeconds * 1000),
    latitude: lat,
    longitude: lon,
    pressureAltitude: altitude,
    gnssAltitude: altitude,
    valid: true,
  };
}

/** Create a fix at an absolute time */
export function createFixAt(
  time: Date,
  lat: number,
  lon: number,
  altitude = 1000
): IGCFix {
  return {
    time,
    latitude: lat,
    longitude: lon,
    pressureAltitude: altitude,
    gnssAltitude: altitude,
    valid: true,
  };
}
