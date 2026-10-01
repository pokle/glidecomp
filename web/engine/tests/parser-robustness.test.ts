/**
 * Parser robustness / fuzz tests.
 *
 * `parseIGC` and `parseXCTask` consume untrusted files (uploaded IGC tracks,
 * pasted / fetched XCTSK task definitions) entirely client-side. The contract
 * this suite pins down:
 *
 *   - `parseIGC` must NEVER throw, for any input. It is defensive by design
 *     (length checks + parseInt, which yields NaN rather than throwing) and
 *     callers do not all wrap it in try/catch.
 *   - `parseXCTask` is allowed to throw on invalid input (every caller wraps it
 *     in try/catch), but it must only throw *clean, catchable* errors
 *     (`SyntaxError` from `JSON.parse`, or a descriptive `Error`). It must never
 *     throw a `TypeError` from dereferencing/operating on a value of the wrong
 *     shape — those are latent crashes that bypass the intended error UX.
 *
 * Closes the long-standing "IGC / XCTask parser fuzzing" scope gap from the
 * security review (open since 2026-04-20). Two robustness defects this suite
 * locks closed:
 *   1. `parseXCTask('null' | '123' | '"x"' | 'true')` threw
 *      `TypeError: null is not an Object` via the `'turnpoints' in data` check.
 *   2. A non-string `waypoint.name`/`description`/`n` in otherwise-valid JSON
 *      threw `TypeError: input.replace is not a function` from `sanitizeText`
 *      (now `toText`, which coerces and no longer encodes).
 */
import { describe, it, expect } from 'bun:test';
import { parseIGC } from '../src/igc-parser';
import { parseXCTask, parseXCTaskAsync } from '../src/xctsk-parser';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rnd: () => number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) {
    // Span the BMP, including control chars, IGC record letters, and JSON punctuation.
    s += String.fromCharCode(Math.floor(rnd() * 0x120));
  }
  return s;
}

function randomJson(rnd: () => number, depth: number): unknown {
  if (depth <= 0) {
    const r = rnd();
    if (r < 0.2) return null;
    if (r < 0.4) return rnd() * 1e9 - 5e8;
    if (r < 0.6) return randomString(rnd, 6);
    if (r < 0.8) return rnd() < 0.5;
    return 0;
  }
  if (rnd() < 0.5) {
    const arr: unknown[] = [];
    const len = Math.floor(rnd() * 6);
    for (let i = 0; i < len; i++) arr.push(randomJson(rnd, depth - 1));
    return arr;
  }
  const keys = [
    't', 'z', 'turnpoints', 'waypoint', 'lat', 'lon', 'r', 'n', 'name',
    'description', 'sss', 'goal', 'takeoff', 's', 'g', 'version', 'taskType',
    'timeGates', 'radius', 'type', 'altSmoothed', 'e', 'to', 'tc', 'd', 'fa',
  ];
  const obj: Record<string, unknown> = {};
  const count = Math.floor(rnd() * 6);
  for (let i = 0; i < count; i++) {
    obj[keys[Math.floor(rnd() * keys.length)]] = randomJson(rnd, depth - 1);
  }
  return obj;
}

describe('parseIGC robustness', () => {
  it('never throws on a fixed set of hostile inputs', () => {
    const cases = [
      '',
      'random garbage that is not igc',
      'B§',
      'HFDTE999999',
      'C'.repeat(40),
      'B' + 'X'.repeat(60),
      'HFPLTPILOT:'.padEnd(2000, 'A'),
      '\r\n\r\n\r\n',
      'A'.repeat(100000),
    ];
    for (const c of cases) {
      expect(() => parseIGC(c)).not.toThrow();
    }
  });

  it('never throws across 5000 random inputs', () => {
    const rnd = mulberry32(0xC0FFEE);
    for (let i = 0; i < 5000; i++) {
      const s = randomString(rnd, Math.floor(rnd() * 200));
      expect(() => parseIGC(s)).not.toThrow();
    }
  });

  it('never throws on random multi-line B/H/C/E record soup', () => {
    const rnd = mulberry32(0x5EED);
    const recordTypes = 'BHCELGIJKFDARTUVWXYZ';
    for (let i = 0; i < 2000; i++) {
      const lines: string[] = [];
      const lineCount = Math.floor(rnd() * 20);
      for (let j = 0; j < lineCount; j++) {
        const t = recordTypes[Math.floor(rnd() * recordTypes.length)];
        lines.push(t + randomString(rnd, Math.floor(rnd() * 50)));
      }
      expect(() => parseIGC(lines.join('\n'))).not.toThrow();
    }
  });
});

describe('parseXCTask robustness', () => {
  it('throws a clean catchable Error (not a TypeError) on valid-JSON primitives', () => {
    for (const c of ['null', '123', '"hello"', 'true', '-0.5', 'XCTSK:null', 'XCTSK:42']) {
      let thrown: unknown;
      try {
        parseXCTask(c);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(TypeError);
    }
  });

  it('does not throw on a non-string waypoint name/description', () => {
    expect(() =>
      parseXCTask(JSON.stringify({ turnpoints: [{ waypoint: { name: 42, lat: 1, lon: 2 } }] })),
    ).not.toThrow();
    expect(() =>
      parseXCTask(
        JSON.stringify({ turnpoints: [{ waypoint: { name: { a: 1 }, description: [1, 2], lat: 1, lon: 2 } }] }),
      ),
    ).not.toThrow();
    // v2 compact format: non-string `n`.
    expect(() => parseXCTask(JSON.stringify({ t: [{ n: 99, lat: 1, lon: 2 }] }))).not.toThrow();
  });

  it('never throws a TypeError across 8000 random JSON payloads', () => {
    const rnd = mulberry32(0x1234ABCD);
    let typeErrors = 0;
    for (let i = 0; i < 8000; i++) {
      const value = randomJson(rnd, 4);
      const payload = (rnd() < 0.5 ? '' : 'XCTSK:') + JSON.stringify(value);
      try {
        parseXCTask(payload);
      } catch (e) {
        if (e instanceof TypeError) {
          typeErrors++;
          if (typeErrors <= 3) {
            // surface the first few for debugging if this ever regresses
            // eslint-disable-next-line no-console
            console.error('Unexpected TypeError for payload:', payload.slice(0, 80), '->', (e as Error).message);
          }
        }
      }
    }
    expect(typeErrors).toBe(0);
  });
});

/**
 * Extension of the parser-fuzzing scope gap to the two paths the 2026-06-21
 * round left for "next time": the `XCTSKZ:` deflate path in `parseXCTaskAsync`
 * and the v2 polyline decoder reached via a `t[].z` field.
 *
 * Defect this group locks closed (SEC-21): corrupt / truncated base64+deflate
 * input made the `DecompressionStream` path throw a raw runtime `TypeError`
 * (`Z_BUF_ERROR`) AND leak an unhandled promise rejection from the dangling
 * stream writer. `parseXCTaskAsync` must instead only ever reject with a clean,
 * catchable `Error` (the descriptive decompress error, or a downstream
 * `SyntaxError`/`Error` from `parseXCTask`) — never a `TypeError`, and never an
 * escaping unhandled rejection.
 */
describe('parseXCTaskAsync (XCTSKZ deflate) robustness', () => {
  it('rejects corrupt XCTSKZ input with a clean Error, never a TypeError', async () => {
    const cases = [
      'XCTSKZ:',                       // empty payload
      'XCTSKZ:!!!not-base64!!!',       // invalid base64 alphabet
      'XCTSKZ:aGVsbG8gd29ybGQ=',       // valid base64, but not a deflate stream
      'XCTSKZ:eJw=',                   // zlib header start, truncated body
      'XCTSKZ:' + 'A'.repeat(500),     // long valid-base64 garbage
    ];
    for (const c of cases) {
      let thrown: unknown;
      try {
        await parseXCTaskAsync(c);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(TypeError);
    }
  });

  it('does not leak an unhandled rejection on corrupt XCTSKZ input', async () => {
    let unhandled = 0;
    const handler = () => { unhandled++; };
    process.on('unhandledRejection', handler);
    const rnd = mulberry32(0xBADDEED);
    for (let i = 0; i < 1500; i++) {
      const payload = 'XCTSKZ:' + randomString(rnd, Math.floor(rnd() * 120));
      try {
        await parseXCTaskAsync(payload);
      } catch {
        // expected — corrupt input
      }
    }
    // Let any stray microtask rejections flush before asserting.
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', handler);
    expect(unhandled).toBe(0);
  });
});

describe('parseXCTask v2 polyline decoder robustness', () => {
  it('never throws on random polyline `z` fields', () => {
    const rnd = mulberry32(0x5A1B);
    for (let i = 0; i < 3000; i++) {
      const z = randomString(rnd, Math.floor(rnd() * 80));
      const payload = 'XCTSK:' + JSON.stringify({ t: [{ z, n: 'wp', lat: 1, lon: 2 }] });
      expect(() => parseXCTask(payload)).not.toThrow();
    }
  });
});
