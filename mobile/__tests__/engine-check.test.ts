import {
  deflateToXctskz,
  formatClock,
  inflateXctskz,
  runEngineCheck,
} from '@/engine-check/run-engine-check';
import { SAMPLE } from '@/engine-check/sample.generated';

describe('engine check', () => {
  it('scores the sample as AirScore published it', async () => {
    const result = await runEngineCheck(SAMPLE);
    // AirScore: https://xc.highcloud.net/get_task_result.php?comPk=466&tasPk=2027
    expect(result.distanceKm).toBe('78.85');
    expect(result.zone).toBe('Australia/Melbourne');
    expect(result.winner).toMatchObject({ name: 'Jon Durand', points: 1000, start: '15:30:00' });
    expect(result.pilotsScored).toBe(3);
  });

  it('round-trips a task through XCTSKZ with the injected inflater', async () => {
    const encoded = deflateToXctskz(SAMPLE.xctsk);
    expect(encoded.startsWith('XCTSKZ:')).toBe(true);
    expect(await inflateXctskz(encoded.slice('XCTSKZ:'.length))).toBe(SAMPLE.xctsk);
  });

  it('formats a time in the comp zone, not the runtime zone', () => {
    // 04:30 UTC on 5 January is 15:30 in Melbourne (AEDT, UTC+11).
    expect(formatClock(new Date('2026-01-05T04:30:00Z'), 'Australia/Melbourne')).toBe('15:30:00');
  });
});
