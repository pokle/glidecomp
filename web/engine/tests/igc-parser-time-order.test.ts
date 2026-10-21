// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Parse-time handling of non-monotonic B-record timestamps (issue #530).
 *
 * `parseIGC` guarantees its `fixes` are non-decreasing in time, because every
 * time-window loop in the engine assumes that and nothing else can establish
 * it — B records carry no date. This suite pins down the policy that produces
 * the guarantee:
 *
 *   - duplicate seconds are KEPT (legitimate above 1 Hz);
 *   - strictly backwards fixes are DROPPED, never clamped or coalesced;
 *   - an isolated forward spike is popped rather than allowed to truncate the
 *     rest of the flight;
 *   - the midnight-rollover heuristic is driven only by VALIDATED time fields,
 *     and applies at most one crossing per file.
 *
 * No file in the 5,590-track corpus exercises any of this — see
 * `scoring-changes/050-monotonic-fix-timestamps.md`.
 */
import { describe, it, expect } from 'bun:test';
import { parseIGC } from '../src/igc-parser';

/** A well-formed B record at `hhmmss`, with a distinct latitude per call so
 * the identity of a retained fix is checkable. */
function b(hhmmss: string, latMillis = 0): string {
  const lat = `4728${String(200 + latMillis).padStart(3, '0')}`;
  return `B${hhmmss}${lat}N01152432EA0123401567`;
}

function file(...lines: string[]): string {
  return ['HFDTE150124', ...lines, ''].join('\n');
}

/** Fix times as HH:MM:SS strings on their (offset) day. */
function times(content: string): string[] {
  return parseIGC(content).fixes.map((f) =>
    f.time.toISOString().substring(11, 19)
  );
}

/** The invariant the whole policy exists to provide. */
function expectNonDecreasing(content: string): void {
  const ms = parseIGC(content).fixes.map((f) => f.time.getTime());
  for (let i = 1; i < ms.length; i++) {
    expect(Number.isFinite(ms[i])).toBe(true);
    expect(ms[i]).toBeGreaterThanOrEqual(ms[i - 1]);
  }
}

describe('duplicate timestamps', () => {
  it('keeps every fix a >1 Hz logger stamps into the same second', () => {
    // The B record's resolution is one second, so a 5 Hz logger writes five
    // fixes per second. 24 of the 5,590 archived tracks do exactly this;
    // dropping them would throw away real position data.
    const content = file(
      b('100000', 1),
      b('100000', 2),
      b('100000', 3),
      b('100001', 4)
    );
    const parsed = parseIGC(content);
    expect(parsed.fixes).toHaveLength(4);
    expect(parsed.timeOrder.duplicateTimeFixCount).toBe(2);
    expect(parsed.timeOrder.droppedFixCount).toBe(0);
    expectNonDecreasing(content);
  });
});

describe('strictly backwards timestamps', () => {
  it('drops an isolated backwards fix and keeps the flight around it', () => {
    const content = file(
      b('100000', 1),
      b('100001', 2),
      b('095900', 3),
      b('100002', 4)
    );
    const parsed = parseIGC(content);
    expect(times(content)).toEqual(['10:00:00', '10:00:01', '10:00:02']);
    expect(parsed.timeOrder.droppedFixCount).toBe(1);
    expect(parsed.timeOrder.maxBackwardsJumpMs).toBe(61_000);
    // Dropped, not clamped: the retained fixes are the logged ones, and no
    // fabricated zero-dt pair appears where the bad fix was.
    expect(parsed.fixes.map((f) => f.latitude)).toEqual(
      [1, 2, 4].map((n) => parseIGC(file(b('100000', n))).fixes[0].latitude)
    );
    expectNonDecreasing(content);
  });

  it('drops the FIRST of two fixes that disagree, having no context yet', () => {
    // With one fix kept there is nothing to tell the outlier from the flight,
    // and popping is never the worse guess: it costs one fix here, and saves
    // every following fix when the leading one is a wild spike (below).
    const content = file(b('100000', 1), b('095900', 2), b('100001', 3));
    expect(times(content)).toEqual(['09:59:00', '10:00:01']);
    expect(parseIGC(content).timeOrder.droppedFixCount).toBe(1);
    expectNonDecreasing(content);
  });

  it('pops an isolated forward spike instead of truncating the flight', () => {
    // One fix stamped hours ahead must cost one fix, not every fix after it.
    const content = file(
      b('100000', 1),
      b('100001', 2),
      b('170000', 3),
      b('100002', 4),
      b('100003', 5)
    );
    const parsed = parseIGC(content);
    expect(times(content)).toEqual([
      '10:00:00',
      '10:00:01',
      '10:00:02',
      '10:00:03',
    ]);
    expect(parsed.timeOrder.droppedFixCount).toBe(1);
    expectNonDecreasing(content);
  });

  it('pops a spike sitting at the very start of the file', () => {
    const content = file(b('235900', 1), b('100000', 2), b('100001', 3));
    expect(times(content)).toEqual(['10:00:00', '10:00:01']);
    expect(parseIGC(content).timeOrder.droppedFixCount).toBe(1);
    expectNonDecreasing(content);
  });

  it('drops a sustained rewind — the first ordering wins', () => {
    // A rewound RUN is not a spike: popping per fix would let the second
    // reading of the clock overwrite the first one fix at a time.
    const content = file(
      b('120000', 1),
      b('120001', 2),
      b('110000', 3),
      b('110001', 4),
      b('110002', 5),
      b('120002', 6)
    );
    const parsed = parseIGC(content);
    expect(times(content)).toEqual(['12:00:00', '12:00:01', '12:00:02']);
    expect(parsed.timeOrder.droppedFixCount).toBe(3);
    expect(parsed.timeOrder.maxBackwardsJumpMs).toBe(3_601_000);
    expectNonDecreasing(content);
  });

  it('reports a clean file as having nothing to report', () => {
    const parsed = parseIGC(file(b('100000', 1), b('100010', 2), b('100020', 3)));
    expect(parsed.timeOrder).toEqual({
      totalRecordCount: 3,
      malformedRecordCount: 0,
      droppedFixCount: 0,
      duplicateTimeFixCount: 0,
      maxBackwardsJumpMs: 0,
      dayRollovers: 0,
      suppressedDayRollovers: 0,
    });
  });
});

describe('malformed B records and the rollover heuristic', () => {
  it('does not let a corrupt hour field arm the midnight crossing', () => {
    // `B99...` fails field validation, but its raw hour field reads 99 — which
    // used to arm `prevHours >= 18`, so the next honest morning fix shifted
    // the whole remainder of the track a day forward.
    const content = file(
      b('050000', 1),
      b('050001', 2),
      'B995959GARBAGE',
      b('050002', 3)
    );
    const parsed = parseIGC(content);
    expect(parsed.fixes.map((f) => f.time.getUTCDate())).toEqual([15, 15, 15]);
    expect(parsed.timeOrder.malformedRecordCount).toBe(1);
    expect(parsed.timeOrder.totalRecordCount).toBe(3);
    expect(parsed.timeOrder.dayRollovers).toBe(0);
    expect(parsed.timeOrder.droppedFixCount).toBe(0);
    expectNonDecreasing(content);
  });

  it('does not let a non-numeric hour field disarm a genuine crossing', () => {
    // `parseInt('XX')` is NaN, which compares false against everything — a
    // corrupt line between the evening and morning fixes used to swallow the
    // crossing and leave the whole post-midnight leg on the wrong day.
    const content = file(b('235800', 1), 'BXXXXXXnonsense', b('000100', 2));
    const parsed = parseIGC(content);
    expect(parsed.fixes.map((f) => f.time.getUTCDate())).toEqual([15, 16]);
    expect(parsed.timeOrder.dayRollovers).toBe(1);
    expect(parsed.timeOrder.malformedRecordCount).toBe(1);
    expectNonDecreasing(content);
  });

  it('still crosses midnight for a real overnight flight', () => {
    const content = file(
      b('235800', 1),
      b('235900', 2),
      b('000100', 3),
      b('044739', 4)
    );
    const parsed = parseIGC(content);
    expect(parsed.fixes.map((f) => f.time.getUTCDate())).toEqual([15, 15, 16, 16]);
    expect(parsed.timeOrder.dayRollovers).toBe(1);
    expect(parsed.timeOrder.droppedFixCount).toBe(0);
    expectNonDecreasing(content);
  });

  it('applies at most one crossing, so a clock that keeps wrapping cannot span days', () => {
    // Uncapped, a clock that wraps past midnight twice marches the day offset
    // forward: the timestamps stay monotone, so nothing downstream objects,
    // while track quality sees a flight days away from its task.
    const content = file(
      b('235900', 1),
      b('000100', 2),
      b('110000', 3),
      b('220000', 4),
      b('235900', 5),
      b('000100', 6)
    );
    const parsed = parseIGC(content);
    const days = parsed.fixes.map((f) => f.time.getUTCDate());
    expect(Math.max(...days) - Math.min(...days)).toBeLessThanOrEqual(1);
    expect(parsed.timeOrder.dayRollovers).toBe(1);
    expect(parsed.timeOrder.suppressedDayRollovers).toBe(1);
    expectNonDecreasing(content);
  });

  it('does not read an evening/morning oscillation as a crossing', () => {
    // A six-hour wrap is not a step any logger makes across midnight.
    const content = file(b('230000', 1), b('050000', 2), b('230000', 3), b('050000', 4));
    const parsed = parseIGC(content);
    expect(parsed.timeOrder.dayRollovers).toBe(0);
    expect(new Set(parsed.fixes.map((f) => f.time.getUTCDate()))).toEqual(new Set([15]));
    expectNonDecreasing(content);
  });
});

describe('one corrupt hour digit (engine review 2026-10-20, 3.1)', () => {
  it('rejects an out-of-range hour as malformed, without touching the day', () => {
    // The review's reproduction: B0518… → B2518…. Every other field is well
    // formed, so this is the line digit-only validation let through.
    const content = file(b('051758', 1), b('051759', 2), b('251800', 3), b('051801', 4));
    const parsed = parseIGC(content);
    expect(parsed.timeOrder.malformedRecordCount).toBe(1);
    expect(parsed.timeOrder.dayRollovers).toBe(0);
    expect(times(content)).toEqual(['05:17:58', '05:17:59', '05:18:01']);
    expect(parsed.fixes.map((f) => f.time.getUTCDate())).toEqual([15, 15, 15]);
  });

  it('pops a valid-looking evening hour instead of moving the rest of the flight', () => {
    // B0518… → B2318… is a legal time, so it cannot be rejected as malformed.
    // Under the old "≥18h then ≤6h" rule it armed a crossing and every fix
    // after it moved 24 h forward; now it is one forward spike, popped.
    const content = file(
      b('051758', 1),
      b('051759', 2),
      b('231800', 3),
      b('051801', 4),
      b('051802', 5)
    );
    const parsed = parseIGC(content);
    expect(parsed.timeOrder.dayRollovers).toBe(0);
    expect(parsed.timeOrder.droppedFixCount).toBe(1);
    expect(times(content)).toEqual(['05:17:58', '05:17:59', '05:18:01', '05:18:02']);
    expect(parsed.fixes.map((f) => f.time.getUTCDate())).toEqual([15, 15, 15, 15]);
    expectNonDecreasing(content);
  });

  it('pops a pre-midnight spike inside a post-midnight run without crossing', () => {
    const content = file(b('001100', 1), b('235000', 2), b('001200', 3), b('001300', 4));
    const parsed = parseIGC(content);
    expect(parsed.timeOrder.dayRollovers).toBe(0);
    expect(times(content)).toEqual(['00:11:00', '00:12:00', '00:13:00']);
    expect(parsed.fixes.map((f) => f.time.getUTCDate())).toEqual([15, 15, 15]);
  });

  it('still crosses midnight after a logging gap of under an hour', () => {
    const content = file(b('233000', 1), b('002000', 2), b('002100', 3));
    const parsed = parseIGC(content);
    expect(parsed.timeOrder.dayRollovers).toBe(1);
    expect(parsed.fixes.map((f) => f.time.getUTCDate())).toEqual([15, 16, 16]);
  });

  it('rejects an event whose hour is out of range', () => {
    const parsed = parseIGC(file(b('100000', 1), 'E250000PEVbad', b('100010', 2)));
    expect(parsed.events).toHaveLength(0);
  });
});

describe('E records', () => {
  it('drops an event whose time field is not a time', () => {
    // An unvalidated HHMMSS produced an Invalid Date event, and steered the
    // shared rollover state on its way through.
    const content = file(b('100000', 1), 'EXXXXXXPEVbroken', b('100010', 2));
    const parsed = parseIGC(content);
    expect(parsed.events).toHaveLength(0);
    expect(parsed.fixes.map((f) => f.time.getUTCDate())).toEqual([15, 15]);
  });

  it('keeps a well-formed event and its midnight offset', () => {
    const parsed = parseIGC(
      file(b('235800', 1), 'E235900PEVBefore midnight', b('000100', 2), 'E000200PEVAfter')
    );
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0].time.getUTCDate()).toBe(15);
    expect(parsed.events[1].time.getUTCDate()).toBe(16);
    expect(parsed.events[1].code).toBe('PEV');
  });
});

describe('the invariant holds for hostile input', () => {
  it('never returns fixes that go backwards, whatever the file says', () => {
    const cases = [
      '',
      'B',
      file(),
      file(b('120000'), b('000000'), b('235959'), b('120000')),
      file(b('000000'), b('235959'), b('000000'), b('235959')),
      file('B240000' + '4728200N01152432EA0123401567'),
      file(b('100000'), 'B      x', b('100001')),
      file(...Array.from({ length: 200 }, (_, i) => b(i % 2 ? '235959' : '000000'))),
    ];
    for (const content of cases) expectNonDecreasing(content);
  });
});
