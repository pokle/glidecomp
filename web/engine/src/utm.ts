/**
 * UTM ↔ WGS84 lat/lon conversion.
 *
 * Kept in its own module (not geo.ts) on purpose: it's only used by the
 * waypoint-file parsers, and geo.ts is part of the scoring import closure, so
 * putting projection maths there would force a scoring-engine version bump on
 * every change. This is the standard inverse Transverse-Mercator (Snyder /
 * USGS series) — the same maths proj4 uses for EPSG:326xx/327xx.
 */

// WGS84 ellipsoid
const WGS84_A = 6378137.0; // semi-major axis (metres)
const WGS84_F = 1 / 298.257223563; // flattening

/**
 * Convert a WGS84 UTM grid reference to latitude/longitude (degrees).
 *
 * @param zone - UTM zone number (1–60)
 * @param isNorthern - true for the northern hemisphere (band letter N–X)
 * @param easting - metres east (includes the 500 km false easting)
 * @param northing - metres north (10 000 km false northing in the south)
 * @returns the point in (lat, lon), the codebase's convention
 */
export function utmToLatLon(
  zone: number,
  isNorthern: boolean,
  easting: number,
  northing: number
): { lat: number; lon: number } {
  const a = WGS84_A;
  const eccSquared = WGS84_F * (2 - WGS84_F);
  const k0 = 0.9996;
  const e1 = (1 - Math.sqrt(1 - eccSquared)) / (1 + Math.sqrt(1 - eccSquared));

  const x = easting - 500000.0; // remove 500 km false easting
  const y = isNorthern ? northing : northing - 10000000.0;
  const longOrigin = (zone - 1) * 6 - 180 + 3; // zone's central meridian
  const eccPrimeSquared = eccSquared / (1 - eccSquared);

  const M = y / k0;
  const mu =
    M / (a * (1 - eccSquared / 4 - (3 * eccSquared ** 2) / 64 - (5 * eccSquared ** 3) / 256));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);

  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const tanPhi1 = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - eccSquared * sinPhi1 ** 2);
  const T1 = tanPhi1 ** 2;
  const C1 = eccPrimeSquared * cosPhi1 ** 2;
  const R1 = (a * (1 - eccSquared)) / (1 - eccSquared * sinPhi1 ** 2) ** 1.5;
  const D = x / (N1 * k0);

  const latRad =
    phi1 -
    ((N1 * tanPhi1) / R1) *
      (D ** 2 / 2 -
        ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * eccPrimeSquared) * D ** 4) / 24 +
        ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * eccPrimeSquared - 3 * C1 ** 2) *
          D ** 6) /
          720);
  const lonRad =
    (D -
      ((1 + 2 * T1 + C1) * D ** 3) / 6 +
      ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * eccPrimeSquared + 24 * T1 ** 2) * D ** 5) /
        120) /
    cosPhi1;

  return {
    lat: (latRad * 180) / Math.PI,
    lon: longOrigin + (lonRad * 180) / Math.PI,
  };
}

/** A WGS84 UTM grid reference. */
export interface UtmRef {
  /** UTM zone number (1–60). */
  zone: number;
  /** MGRS latitude band letter (C–X). */
  band: string;
  /** Metres east, including the 500 km false easting. */
  easting: number;
  /** Metres north (with the 10 000 km false northing in the south). */
  northing: number;
  /** True for the northern hemisphere. */
  isNorthern: boolean;
}

/** MGRS latitude band letter for a given latitude (C at −80°… X at 84°). */
function latitudeBand(lat: number): string {
  const letters = 'CDEFGHJKLMNPQRSTUVWX';
  if (lat >= 84) return 'X';
  if (lat < -80) return 'C';
  return letters[Math.floor((lat + 80) / 8)] ?? 'Z';
}

/**
 * Convert a WGS84 latitude/longitude (degrees) to a UTM grid reference — the
 * forward of {@link utmToLatLon} (standard forward Transverse Mercator, Snyder
 * / USGS series). Used only to write `$FormatUTM` waypoint files. Norway/
 * Svalbard zone exceptions are not applied (irrelevant for waypoint export).
 */
export function latLonToUtm(lat: number, lon: number): UtmRef {
  const a = WGS84_A;
  const eccSquared = WGS84_F * (2 - WGS84_F);
  const k0 = 0.9996;
  const eccPrimeSquared = eccSquared / (1 - eccSquared);

  const zone = Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  const longOrigin = (zone - 1) * 6 - 180 + 3; // zone's central meridian
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const longOriginRad = (longOrigin * Math.PI) / 180;

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const tanLat = Math.tan(latRad);
  const N = a / Math.sqrt(1 - eccSquared * sinLat ** 2);
  const T = tanLat ** 2;
  const C = eccPrimeSquared * cosLat ** 2;
  const A = cosLat * (lonRad - longOriginRad);
  const M =
    a *
    ((1 - eccSquared / 4 - (3 * eccSquared ** 2) / 64 - (5 * eccSquared ** 3) / 256) * latRad -
      ((3 * eccSquared) / 8 + (3 * eccSquared ** 2) / 32 + (45 * eccSquared ** 3) / 1024) *
        Math.sin(2 * latRad) +
      ((15 * eccSquared ** 2) / 256 + (45 * eccSquared ** 3) / 1024) * Math.sin(4 * latRad) -
      ((35 * eccSquared ** 3) / 3072) * Math.sin(6 * latRad));

  const easting =
    k0 *
      N *
      (A +
        ((1 - T + C) * A ** 3) / 6 +
        ((5 - 18 * T + T ** 2 + 72 * C - 58 * eccPrimeSquared) * A ** 5) / 120) +
    500000.0;
  let northing =
    k0 *
    (M +
      N *
        tanLat *
        (A ** 2 / 2 +
          ((5 - T + 9 * C + 4 * C ** 2) * A ** 4) / 24 +
          ((61 - 58 * T + T ** 2 + 600 * C - 330 * eccPrimeSquared) * A ** 6) / 720));
  const isNorthern = lat >= 0;
  if (!isNorthern) northing += 10000000.0; // false northing in the south

  return { zone, band: latitudeBand(lat), easting, northing, isNorthern };
}
