import { gzipSync, strToU8 } from 'fflate';

import { igcText } from '@/lib/igc-text';
import { sectionPoints } from '@/lib/section-points';

describe('sectionPoints', () => {
  it('puts the points beside what was on offer', () => {
    expect(sectionPoints({ points: 143.44, pointsAvailable: 156.16 })).toBe('143.4 of 156.2 pts');
  });

  it('prints points alone when nothing was on offer to compare with', () => {
    expect(sectionPoints({ points: -20 })).toBe('-20 pts');
  });

  it('says nothing for a section with no points of its own', () => {
    expect(sectionPoints({})).toBeUndefined();
  });
});

describe('igcText', () => {
  const igc = 'AXXX\nB1200004700000N01100000EA0100001000\n';

  it('reads a tracklog the HTTP stack already decompressed', () => {
    expect(igcText(strToU8(igc))).toBe(igc);
  });

  it('decompresses one that arrived still gzipped', () => {
    expect(igcText(gzipSync(strToU8(igc)))).toBe(igc);
  });
});
