import type { ReportSeries } from '@glidecomp/engine';

import { splitText } from '@/analysis/split';
import { daySeries } from '@/charts/DayProfileChart';

describe('the day profile', () => {
  it('picks the series it draws by kind, and ignores a kind it does not know', () => {
    const series = [
      { kind: 'horserace', id: 'h', title: 'H', xLabels: [], yUnit: 'km', perPilot: [] },
      { kind: 'climb-hourly', id: 'c', title: 'Climb', hours: [] },
      { kind: 'something-new', id: 'x', title: 'From a newer engine' },
      { kind: 'wind-hourly', id: 'w', title: 'Wind', hours: [], wholeTask: null },
    ] as unknown as ReportSeries[];
    const out = daySeries(series);
    expect(out.climb?.id).toBe('c');
    expect(out.wind?.id).toBe('w');
    expect(out.timing).toBeNull();
  });
});

describe('airtime split', () => {
  it('reads as three percentages', () => {
    expect(splitText({ climbPct: 52.4, glidePct: 30.6, searchPct: 17, airborneSeconds: 1 })).toBe(
      '52% climbing · 31% gliding · 17% searching',
    );
  });
});
