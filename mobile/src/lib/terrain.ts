/**
 * Ground elevations for Check altitudes, read the way the website reads them:
 * the shared decoder (@glidecomp/client/terrain-elevation — hand-decoded
 * Terrain-RGB, never through a canvas), with fflate standing in for the
 * DecompressionStream Hermes lacks, and the build's public Mapbox token.
 */
import { fetchElevations, type LatLon } from '@glidecomp/client/terrain-elevation';
import Constants from 'expo-constants';
import { unzlibSync } from 'fflate';

const TOKEN = (Constants.expoConfig?.extra as { mapboxPublicToken?: string } | undefined)?.mapboxPublicToken;

export const TERRAIN_AVAILABLE = !!TOKEN;

export function readElevations(points: LatLon[]): Promise<(number | null)[]> {
  return fetchElevations(points, TOKEN ?? '', { inflate: (data) => unzlibSync(data) });
}
