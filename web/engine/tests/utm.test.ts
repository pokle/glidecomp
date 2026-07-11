import { describe, it, expect } from 'bun:test';
import { utmToLatLon } from '../src/utm';

describe('utmToLatLon (WGS84 inverse UTM)', () => {
  it('converts northern-hemisphere grid refs (hg-worlds A01/A11)', () => {
    // A01: UTM 33T 354663 5130093 — the DMS/decimal siblings give 46.30883 N, 13.11250 E
    const a01 = utmToLatLon(33, true, 354663, 5130093);
    expect(a01.lat).toBeCloseTo(46.308828, 4);
    expect(a01.lon).toBeCloseTo(13.1125, 4);
    // A11: UTM 33T 322054 5148455 — FS gives N 46 27 58.24, E 012 40 56.42
    const a11 = utmToLatLon(33, true, 322054, 5148455);
    expect(a11.lat).toBeCloseTo(46.46618, 4);
    expect(a11.lon).toBeCloseTo(12.68234, 4);
  });

  it('applies the 10 000 km false northing in the southern hemisphere', () => {
    // Sydney ≈ -33.864, 151.215 → UTM 56H 334905 6251492
    const syd = utmToLatLon(56, false, 334905, 6251492);
    expect(syd.lat).toBeCloseTo(-33.864, 3);
    expect(syd.lon).toBeCloseTo(151.215, 3);
  });
});
