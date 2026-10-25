import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import {
  REGISTER,
  classify,
  extract,
  fingerprint,
  htmlText,
  judge,
  slice,
  withYear,
  type Standard,
} from './standards-check';

const std = (over: Partial<Standard>): Standard => ({
  id: 'x',
  name: 'X',
  follows: '1.0',
  statedIn: [],
  implementedIn: [],
  check: { kind: 'regex', url: 'https://example.test', pattern: 'v(\\S+)' },
  onChange: '',
  ...over,
});

describe('classify', () => {
  test('two dates are a protocol revision', () => {
    expect(classify('2025-11-25', '2026-07-28')).toBe('revision');
  });
  test('the first number moving is major, a later one minor', () => {
    expect(classify('2026 V1.0', '2027 V1.0')).toBe('major');
    expect(classify('2026 V1.0', '2026 V1.1')).toBe('minor');
    expect(classify('v0.91', 'v0.92')).toBe('minor');
    expect(classify('1.0', '2.0')).toBe('major');
    expect(classify('2.2', '3.0')).toBe('major');
  });
});

describe('reading a source', () => {
  test('extract takes the first capture group', () => {
    expect(extract('**Version**: v0.91 **Status**: Proposal', 'Version\\W*v?([0-9.]+)')).toBe('0.91');
    expect(extract('nothing here', 'Version: (\\S+)')).toBeNull();
    expect(extract('"obsoleted_by": [],', '"obsoleted_by":\\s*\\[([^\\]]*)\\]')).toBe('none');
  });
  test('a re-wrapped or re-indented page has the same fingerprint', () => {
    expect(fingerprint('a  b\r\n\r\n\r\nc ')).toBe(fingerprint('a b\n\nc'));
    expect(fingerprint('a b')).not.toBe(fingerprint('a c'));
  });
  test('htmlText drops markup, scripts and styles', () => {
    expect(htmlText('<p>Hi<script>x()</script><style>p{}</style> there</p>').replace(/\s+/g, ' ').trim()).toBe(
      'Hi there'
    );
  });
  test('slice keeps the section between two markers', () => {
    expect(slice('intro ## Format rules ## Next', '## Format', '## Next')).toBe('## Format rules ');
    expect(slice('no marker', '## Format')).toBe('no marker');
  });
});

describe('judge', () => {
  test('a version we follow is current; a newer one is new, then behind once recorded', () => {
    expect(judge(std({}), '1.0').status).toBe('current');
    expect(judge(std({}), '1.1')).toMatchObject({ status: 'new', change: 'minor' });
    expect(judge(std({ seen: { value: '1.1', checkedAt: '2026-10-25' } }), '1.1').status).toBe('behind');
  });
  test('an unreadable source is a finding, not a pass', () => {
    expect(judge(std({}), null).status).toBe('unreachable');
  });
  test('a vendored copy matching upstream is current, whatever its whitespace', () => {
    const s = std({ check: { kind: 'same-as', url: 'https://example.test', local: 'f.json' } });
    expect(judge(s, fingerprint('{"a": 1}\n'), { local: '{"a": 1}' }).status).toBe('current');
    expect(judge(s, fingerprint('{"a": 2}'), { local: '{"a": 1}' })).toMatchObject({ status: 'new', change: 'content' });
  });
  test('a fingerprinted page is new only when the text moved since the last check', () => {
    const s = std({ check: { kind: 'hash', url: 'https://example.test' }, seen: { value: 'abc', checkedAt: 'd' } });
    expect(judge(s, 'abc').status).toBe('current');
    expect(judge(s, 'def').status).toBe('new');
  });
  test('research queries name this year and the next', () => {
    expect(withYear('S7F {next} edition, {year} V1.1', new Date('2026-10-25'))).toBe('S7F 2027 edition, 2026 V1.1');
  });
  test('research standards are handed to the routine with their searches', () => {
    const s = std({ check: { kind: 'research', queries: ['FAI S7F 2027'] } });
    expect(judge(s, null)).toMatchObject({ status: 'research', detail: 'Search: FAI S7F 2027' });
  });
});

describe('the register', () => {
  const register = JSON.parse(readFileSync(REGISTER, 'utf8')) as { standards: Standard[] };

  test('every entry is complete, and ids are unique', () => {
    const ids = register.standards.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of register.standards) {
      expect(s.name, s.id).toBeTruthy();
      expect(s.follows, s.id).toBeTruthy();
      expect(s.statedIn.length, s.id).toBeGreaterThan(0);
      expect(s.implementedIn.length, s.id).toBeGreaterThan(0);
      expect(s.onChange, s.id).toBeTruthy();
      const check = s.check;
      if (check.kind === 'regex' || check.kind === 'redirect') expect(() => new RegExp(check.pattern)).not.toThrow();
    }
  });

  test('every path it names exists in the tree', () => {
    const root = new URL('../../', import.meta.url);
    for (const s of register.standards) {
      const paths = [...s.statedIn, ...s.implementedIn, ...(s.testedIn ?? [])].map((p) => p.split(/[:#]/)[0]!);
      if (s.check.kind === 'same-as') paths.push(s.check.local);
      for (const p of paths) expect(existsSync(new URL(p, root)), `${s.id}: ${p}`).toBe(true);
    }
  });
});
