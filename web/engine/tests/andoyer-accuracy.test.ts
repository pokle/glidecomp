/**
 * Andoyer distance accuracy tests.
 *
 * Validates andoyerDistance() against a Vincenty (iterative WGS84 geodesic)
 * reference implementation, both for individual point pairs and for
 * accumulated track distances over real IGC flight logs.
 */

import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'fs';
import { resolve, extname, basename } from 'path';
import { andoyerDistance } from '../src/geo';
import { parseIGC, type IGCFix } from '../src/igc-parser';

// ── Vincenty reference implementation (iterative WGS84 geodesic) ────────────

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);

function vincentyDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const phi1 = lat1 * toRad, phi2 = lat2 * toRad;
  const L = (lon2 - lon1) * toRad;
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(phi1));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(phi2));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);
  let lambda = L, lambdaP: number, iterLimit = 100;
  let sinSigma: number, cosSigma: number, sigma: number;
  let sinAlpha: number, cosSqAlpha: number, cos2SigmaM: number;
  do {
    const sinL = Math.sin(lambda), cosL = Math.cos(lambda);
    sinSigma = Math.sqrt((cosU2 * sinL) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosL) ** 2);
    if (sinSigma === 0) return 0;
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosL;
    sigma = Math.atan2(sinSigma, cosSigma);
    sinAlpha = cosU1 * cosU2 * sinL / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - 2 * sinU1 * sinU2 / cosSqAlpha : 0;
    const C = WGS84_F / 16 * cosSqAlpha * (4 + WGS84_F * (4 - 3 * cosSqAlpha));
    lambdaP = lambda;
    lambda = L + (1 - C) * WGS84_F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
  } while (Math.abs(lambda - lambdaP!) > 1e-12 && --iterLimit > 0);
  const uSq = cosSqAlpha! * (WGS84_A ** 2 - WGS84_B ** 2) / (WGS84_B ** 2);
  const A = 1 + uSq / 16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = uSq / 1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const ds = B * sinSigma! * (cos2SigmaM! + B / 4 * (cosSigma! * (-1 + 2 * cos2SigmaM! ** 2) -
    B / 6 * cos2SigmaM! * (-3 + 4 * sinSigma! ** 2) * (-3 + 4 * cos2SigmaM! ** 2)));
  return WGS84_B * A * (sigma! - ds);
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function trackDistance(fixes: IGCFix[], fn: (lat1: number, lon1: number, lat2: number, lon2: number) => number): number {
  let total = 0;
  for (let i = 0; i < fixes.length - 1; i++) {
    total += fn(fixes[i].latitude, fixes[i].longitude, fixes[i + 1].latitude, fixes[i + 1].longitude);
  }
  return total;
}

function loadIGCFiles(dir: string): string[] {
  const files: string[] = [];
  for (const f of readdirSync(dir)) {
    if (extname(f).toLowerCase() === '.igc') {
      files.push(resolve(dir, f));
    }
  }
  return files.sort();
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('andoyerDistance vs Vincenty reference', () => {
  describe('point-to-point accuracy', () => {
    const cases: [string, number, number, number, number][] = [
      ['London to Paris', 51.5007, -0.1246, 48.8584, 2.2945],
      ['Melbourne to Sydney', -37.8136, 144.9631, -33.8688, 151.2093],
      ['Across date line', -17.7134, 178.065, -21.1789, -175.1982],
      ['Equator crossing', 1.0, 0.0, -1.0, 0.0],
      ['Short segment (50m)', 47.0, 11.0, 47.0, 11.000657],
      ['1 degree latitude', 47.0, 11.0, 48.0, 11.0],
      ['Near-antipodal', 0, 0, 0, 179],
    ];

    for (const [name, lat1, lon1, lat2, lon2] of cases) {
      it(`${name}: error < 50 ppm`, () => {
        const a = andoyerDistance(lat1, lon1, lat2, lon2);
        const v = vincentyDistance(lat1, lon1, lat2, lon2);
        const ppm = Math.abs(a - v) / v * 1e6;
        expect(ppm).toBeLessThan(50);
      });
    }

    it('should return 0 for identical points', () => {
      expect(andoyerDistance(47.0, 11.0, 47.0, 11.0)).toBe(0);
    });

    it('should be symmetric', () => {
      const ab = andoyerDistance(47.123, 11.456, 48.789, 12.012);
      const ba = andoyerDistance(48.789, 12.012, 47.123, 11.456);
      expect(ab).toBe(ba);
    });
  });

  describe('accumulated track distance on IGC fixtures (<1m error per track)', () => {
    const fixtureDir = resolve(__dirname, 'fixtures/corryong-cup-2026-t1');
    const igcFiles = loadIGCFiles(fixtureDir);

    for (const file of igcFiles) {
      const name = basename(file, '.igc');
      it(`${name}`, () => {
        const content = readFileSync(file, 'utf-8');
        const igc = parseIGC(content);
        const fixes = igc.fixes.filter(f => f.valid);
        if (fixes.length < 2) return; // skip files with no valid fixes

        const andoyer = trackDistance(fixes, andoyerDistance);
        const vincenty = trackDistance(fixes, vincentyDistance);
        const errorMeters = Math.abs(andoyer - vincenty);

        expect(errorMeters).toBeLessThan(1.0);
      });
    }
  });
});
