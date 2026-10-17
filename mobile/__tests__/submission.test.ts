import {
  applyOutcome,
  classifyAttempt,
  isDue,
  keep,
  KEEP_SENT_MS,
  ordered,
  retryDelayMs,
  sendBlock,
  statusWords,
  submissionTitle,
  type Submission,
} from '@/lib/submission';
import { isIncomingFileUrl } from '@/lib/incoming-url';

const NOW = 10_000_000;

function sub(over: Partial<Submission> = {}): Submission {
  return {
    id: 's1',
    queuedAt: NOW - 1000,
    accountId: 'u1',
    compId: 'abc',
    taskId: 'def',
    compName: 'Canungra Classic',
    taskName: 'Task 3',
    timezone: 'Australia/Brisbane',
    as: { kind: 'self' },
    forLabel: 'Jo Smith',
    fileName: 'jo.igc',
    rawBytes: 1000,
    filePilotName: null,
    file: 's1.igc.gz',
    status: 'waiting',
    attempts: 0,
    lastAttemptAt: null,
    ...over,
  };
}

describe('one attempt’s answer (#481: a failure to ask is not an answer)', () => {
  it('no answer, or a 5xx, is tried again — never recorded as a refusal', () => {
    expect(classifyAttempt(null, null)).toEqual({ kind: 'retry' });
    expect(classifyAttempt(502, '<html>Bad gateway</html>')).toEqual({ kind: 'retry' });
    expect(classifyAttempt(500, '{"error":"boom"}')).toEqual({ kind: 'retry' });
  });

  it('a 4xx is the server’s real answer, with its sentence and code', () => {
    expect(
      classifyAttempt(404, JSON.stringify({ error: 'No pilot matches that CIVL ID', code: 'no_pilot_match' })),
    ).toEqual({ kind: 'refused', failure: { error: 'No pilot matches that CIVL ID', code: 'no_pilot_match' } });
    // A rate limit is an answer too: sending again only spends more of it.
    expect(classifyAttempt(429, JSON.stringify({ error: 'Too many', code: 'rate_limited' })).kind).toBe('refused');
  });

  it('a refusal whose body says nothing still says something', () => {
    expect(classifyAttempt(400, 'not json')).toEqual({
      kind: 'refused',
      failure: { error: 'We could not accept that track.' },
    });
  });

  it('a stored track counts as stored, even if its body cannot be read', () => {
    expect(classifyAttempt(201, JSON.stringify({ comp_pilot_id: 'p1', replaced: true }))).toEqual({
      kind: 'sent',
      accepted: { comp_pilot_id: 'p1', replaced: true },
    });
    expect(classifyAttempt(200, '').kind).toBe('sent');
  });
});

describe('applying an outcome', () => {
  it('a retry stays waiting, and counts the attempt', () => {
    const next = applyOutcome(sub(), { kind: 'retry' }, NOW);
    expect(next.status).toBe('waiting');
    expect(next.attempts).toBe(1);
    expect(next.lastAttemptAt).toBe(NOW);
  });

  it('sent and refused say so, and keep what the server said', () => {
    const sent = applyOutcome(sub(), { kind: 'sent', accepted: { comp_pilot_id: 'p1' } }, NOW);
    expect(sent).toMatchObject({ status: 'sent', sentAt: NOW, accepted: { comp_pilot_id: 'p1' } });
    const refused = applyOutcome(sub(), { kind: 'refused', failure: { error: 'No' } }, NOW);
    expect(refused).toMatchObject({ status: 'refused', failure: { error: 'No' } });
  });
});

describe('when to try again', () => {
  it('backs off, and never waits more than ten minutes', () => {
    expect(retryDelayMs(1)).toBe(15_000);
    expect(retryDelayMs(2)).toBe(30_000);
    expect(retryDelayMs(3)).toBe(60_000);
    expect(retryDelayMs(50)).toBe(10 * 60_000);
  });

  it('a track never tried is due at once; only waiting tracks are ever due', () => {
    expect(isDue(sub(), NOW)).toBe(true);
    expect(isDue(sub({ attempts: 1, lastAttemptAt: NOW - 5_000 }), NOW)).toBe(false);
    expect(isDue(sub({ attempts: 1, lastAttemptAt: NOW - 15_000 }), NOW)).toBe(true);
    expect(isDue(sub({ status: 'refused' }), NOW)).toBe(false);
    expect(isDue(sub({ status: 'sent' }), NOW)).toBe(false);
  });
});

describe('whose session sends it', () => {
  it('a track queued signed in goes with that account and no other', () => {
    expect(sendBlock(sub(), 'u1')).toBeNull();
    expect(sendBlock(sub(), null)).toBe('signed-out');
    expect(sendBlock(sub(), 'u2')).toBe('other-account');
  });

  it('an anonymous track needs no session at all', () => {
    const anon = sub({
      accountId: null,
      as: { kind: 'anonymous', identifierKind: 'civl_id', identifierValue: '77001' },
    });
    expect(sendBlock(anon, null)).toBeNull();
    expect(sendBlock(anon, 'u2')).toBeNull();
  });
});

describe('what the list keeps', () => {
  it('a track still on the phone is never dropped, however old', () => {
    expect(keep(sub({ queuedAt: 0 }), NOW + KEEP_SENT_MS * 10)).toBe(true);
    expect(keep(sub({ status: 'refused', queuedAt: 0 }), NOW + KEEP_SENT_MS * 10)).toBe(true);
  });

  it('a receipt is kept for a week', () => {
    expect(keep(sub({ status: 'sent', sentAt: NOW }), NOW + KEEP_SENT_MS - 1)).toBe(true);
    expect(keep(sub({ status: 'sent', sentAt: NOW }), NOW + KEEP_SENT_MS)).toBe(false);
  });

  it('puts what is still on the phone first, newest first', () => {
    const list = ordered([
      sub({ id: 'old-sent', status: 'sent', queuedAt: 5 }),
      sub({ id: 'old-waiting', queuedAt: 1 }),
      sub({ id: 'new-sent', status: 'sent', queuedAt: 9 }),
      sub({ id: 'new-refused', status: 'refused', queuedAt: 8 }),
    ]);
    expect(list.map((s) => s.id)).toEqual(['new-refused', 'old-waiting', 'new-sent', 'old-sent']);
  });
});

describe('the words a pilot reads', () => {
  it('a track on the phone never reads as submitted', () => {
    for (const words of [
      statusWords(sub(), { sending: false, block: null }),
      statusWords(sub(), { sending: true, block: null }),
      statusWords(sub(), { sending: false, block: 'signed-out' }),
    ]) {
      expect(words.status).not.toMatch(/submitted/i);
    }
    expect(statusWords(sub(), { sending: false, block: null })).toEqual({
      status: 'Waiting for signal',
      detail: 'Saved on this phone. It hasn’t been submitted yet.',
    });
  });

  it('a stored track says submitted, or replaced', () => {
    expect(statusWords(sub({ status: 'sent', accepted: { comp_pilot_id: 'p' } }), { sending: false, block: null }).status).toBe(
      'Submitted',
    );
    expect(
      statusWords(sub({ status: 'sent', accepted: { comp_pilot_id: 'p', replaced: true } }), { sending: false, block: null })
        .status,
    ).toBe('Replaced');
  });

  it('a refusal says the server’s sentence', () => {
    expect(
      statusWords(sub({ status: 'refused', failure: { error: 'This task is closed for track submissions.' } }), {
        sending: false,
        block: null,
      }),
    ).toEqual({ status: 'Not accepted', detail: 'This task is closed for track submissions.' });
  });

  it('names the task and the comp', () => {
    expect(submissionTitle(sub())).toBe('Task 3 — Canungra Classic');
    expect(submissionTitle({ taskName: null, compName: null })).toBe('Track');
  });
});

describe('a file the app was opened with', () => {
  it('is a file:// or content:// URL, never a link to a screen', () => {
    expect(isIncomingFileUrl('file:///private/var/mobile/Containers/Data/Application/X/Documents/Inbox/t.igc')).toBe(true);
    expect(isIncomingFileUrl('content://com.android.providers.downloads.documents/document/42')).toBe(true);
    expect(isIncomingFileUrl('glidecomp-dev:///comp/canungra-abc')).toBe(false);
    expect(isIncomingFileUrl('/submit')).toBe(false);
    expect(isIncomingFileUrl('https://glidecomp.com/comp/x')).toBe(false);
  });
});
