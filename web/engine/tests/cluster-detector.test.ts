// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { describe, it, expect } from 'bun:test';
import {
  clusterFrame,
  detectGaggles,
  gagglesAt,
  type Frame,
  type GaggleParams,
  type PilotState,
} from '../src/cluster-detector';

const P: GaggleParams = {
  stepSeconds: 10,
  horizontalRadius: 400,
  verticalBand: 300,
  minPilots: 2,
  minDurationSeconds: 30,
  trackMinShared: 2,
  bridgeSeconds: 20,
};

const st = (pilot: number, x: number, y: number, z: number): PilotState => ({ pilot, x, y, z });
const frame = (t: number, states: PilotState[]): Frame => ({ t, states });

describe('clusterFrame', () => {
  it('links two pilots within the horizontal radius into one cluster', () => {
    const clusters = clusterFrame([st(0, 0, 1000, 0), st(1, 100, 1000, 0)], P);
    expect(clusters).toEqual([[0, 1]]);
  });

  it('does not link pilots beyond the horizontal radius', () => {
    const clusters = clusterFrame([st(0, 0, 1000, 0), st(1, 500, 1000, 0)], P);
    expect(clusters).toEqual([]);
  });

  it('does not link pilots horizontally close but beyond the vertical band', () => {
    // same x/z, but 400 m apart vertically (> 300 m band)
    const clusters = clusterFrame([st(0, 0, 1000, 0), st(1, 0, 1400, 0)], P);
    expect(clusters).toEqual([]);
  });

  it('chains a line of three via single-linkage (A-B, B-C, not A-C directly)', () => {
    // A↔B = 300, B↔C = 300 (both ≤400), A↔C = 600 (>400) — chained into one
    const clusters = clusterFrame(
      [st(0, 0, 1000, 0), st(1, 300, 1000, 0), st(2, 600, 1000, 0)],
      P,
    );
    expect(clusters).toEqual([[0, 1, 2]]);
  });

  it('drops components smaller than minPilots', () => {
    const clusters = clusterFrame([st(0, 0, 1000, 0), st(1, 100, 1000, 0)], { ...P, minPilots: 3 });
    expect(clusters).toEqual([]);
  });

  it('returns members sorted ascending regardless of input order', () => {
    const clusters = clusterFrame([st(5, 0, 1000, 0), st(2, 100, 1000, 0), st(9, 50, 1000, 0)], P);
    expect(clusters).toEqual([[2, 5, 9]]);
  });
});

describe('detectGaggles — tracking', () => {
  it('tracks a pair that stays together as a single persistent episode', () => {
    const frames = [0, 10, 20, 30, 40].map((t) =>
      frame(t, [st(0, t * 2, 1000, 0), st(1, t * 2 + 100, 1000, 0)]),
    );
    const { episodes } = detectGaggles(frames, P);
    expect(episodes).toHaveLength(1);
    const e = episodes[0];
    expect(e.members).toEqual([0, 1]);
    expect(e.tStart).toBe(0);
    expect(e.tEnd).toBe(40);
    expect(e.peakSize).toBe(2);
    expect(e.timeline).toHaveLength(5);
  });

  it('drops a brief fly-by shorter than minDurationSeconds', () => {
    const frames = [
      frame(0, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]), // together once
      frame(10, [st(0, 0, 1000, 0), st(1, 2000, 1000, 0)]), // apart
    ];
    const { episodes } = detectGaggles(frames, P);
    expect(episodes).toEqual([]);
  });

  it('bridges a one-frame dropout instead of splitting into two episodes', () => {
    const frames = [
      frame(0, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]),
      frame(10, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]),
      frame(20, [st(0, 0, 1000, 0), st(1, 2000, 1000, 0)]), // momentarily apart
      frame(30, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]),
      frame(40, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]),
    ];
    const { episodes } = detectGaggles(frames, P);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].tStart).toBe(0);
    expect(episodes[0].tEnd).toBe(40);
    // the dropout frame contributes no snapshot
    expect(episodes[0].timeline.map((s) => s.t)).toEqual([0, 10, 30, 40]);
  });

  it('captures a member joining mid-episode', () => {
    const frames = [
      frame(0, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]),
      frame(10, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]),
      frame(20, [st(0, 0, 1000, 0), st(1, 100, 1000, 0), st(2, 200, 1000, 0)]),
      frame(30, [st(0, 0, 1000, 0), st(1, 100, 1000, 0), st(2, 200, 1000, 0)]),
    ];
    const { episodes } = detectGaggles(frames, P);
    expect(episodes).toHaveLength(1);
    expect(episodes[0].members).toEqual([0, 1, 2]);
    expect(episodes[0].peakSize).toBe(3);
    // pilot 2 only present from t=20
    expect(episodes[0].timeline.find((s) => s.t === 10)!.members).toEqual([0, 1]);
    expect(episodes[0].timeline.find((s) => s.t === 20)!.members).toEqual([0, 1, 2]);
  });

  it('handles a split into two persistent episodes', () => {
    const together = [st(0, 0, 1000, 0), st(1, 100, 1000, 0), st(2, 200, 1000, 0), st(3, 300, 1000, 0)];
    // split: {0,1} stay near x≈0, {2,3} move far away together — held long
    // enough that the split-off survives minDurationSeconds
    const apart = [st(0, 0, 1000, 0), st(1, 100, 1000, 0), st(2, 5000, 1000, 0), st(3, 5100, 1000, 0)];
    const frames = [
      frame(0, together),
      frame(10, together),
      frame(20, apart),
      frame(30, apart),
      frame(40, apart),
      frame(50, apart),
    ];
    const { episodes } = detectGaggles(frames, P);
    expect(episodes).toHaveLength(2);
    const memberSets = episodes.map((e) => e.members);
    // The original episode keeps its identity; `members` is the UNION over its
    // life, so it carries all four. The split-off {2,3} becomes its own episode.
    expect(memberSets).toContainEqual([0, 1, 2, 3]);
    expect(memberSets).toContainEqual([2, 3]);
    // ...and the original's live membership has narrowed to {0,1} by the end.
    const original = episodes.find((e) => e.members.length === 4)!;
    expect(original.timeline.at(-1)!.members).toEqual([0, 1]);
  });

  it('is deterministic — same input yields identical episodes', () => {
    const frames = [0, 10, 20, 30].map((t) =>
      frame(t, [st(0, 0, 1000, 0), st(1, 100, 1000, 0), st(2, 250, 1000, 0)]),
    );
    expect(detectGaggles(frames, P)).toEqual(detectGaggles(frames, P));
  });
});

describe('detectGaggles — start-cylinder exclusion', () => {
  const startCylinder = { x: 0, z: 0, radius: 1000 };

  it('ignores pilots while they are inside the start cylinder', () => {
    // pilots 0,1 loiter together inside the cylinder the whole time
    const frames = [0, 10, 20, 30, 40].map((t) =>
      frame(t, [st(0, 100, 1000, 0), st(1, 200, 1000, 0)]),
    );
    const { episodes } = detectGaggles(frames, P, { startCylinder });
    expect(episodes).toEqual([]);
  });

  it('starts clustering only once pilots have left the start cylinder', () => {
    const frames = [
      frame(0, [st(0, 100, 1000, 0), st(1, 200, 1000, 0)]), // inside → excluded
      frame(10, [st(0, 5000, 1000, 0), st(1, 5100, 1000, 0)]), // out & racing
      frame(20, [st(0, 6000, 1000, 0), st(1, 6100, 1000, 0)]),
      frame(30, [st(0, 7000, 1000, 0), st(1, 7100, 1000, 0)]),
      frame(40, [st(0, 8000, 1000, 0), st(1, 8100, 1000, 0)]),
    ];
    const { episodes } = detectGaggles(frames, P, { startCylinder });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].tStart).toBe(10); // not 0 — the pre-start frame is excluded
    expect(episodes[0].tEnd).toBe(40);
  });

  it('treats pilots never seen inside the cylinder as already racing', () => {
    // both start and stay well outside; never latched as "was inside"
    const frames = [0, 10, 20, 30].map((t) =>
      frame(t, [st(0, 5000, 1000, 0), st(1, 5100, 1000, 0)]),
    );
    const { episodes } = detectGaggles(frames, P, { startCylinder });
    expect(episodes).toHaveLength(1);
    expect(episodes[0].tStart).toBe(0);
  });
});

describe('detectGaggles — nearTurnpoint annotation', () => {
  it('labels an episode with the nearest turnpoint at its midpoint', () => {
    const turnpoints = [
      { x: 0, z: 0 },
      { x: 10000, z: 0 },
    ];
    const frames = [0, 10, 20, 30].map((t) =>
      frame(t, [st(0, 9900, 1000, 0), st(1, 10000, 1000, 0)]),
    );
    const { episodes } = detectGaggles(frames, P, { turnpoints });
    expect(episodes[0].nearTurnpoint).toBe(1);
  });

  it('omits nearTurnpoint when no turnpoints are supplied', () => {
    const frames = [0, 10, 20, 30].map((t) => frame(t, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]));
    const { episodes } = detectGaggles(frames, P);
    expect(episodes[0].nearTurnpoint).toBeUndefined();
  });
});

describe('gagglesAt', () => {
  it('returns the members active at the nearest grid snapshot', () => {
    const frames = [
      frame(0, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]),
      frame(10, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]),
      frame(20, [st(0, 0, 1000, 0), st(1, 100, 1000, 0), st(2, 200, 1000, 0)]),
      frame(30, [st(0, 0, 1000, 0), st(1, 100, 1000, 0), st(2, 200, 1000, 0)]),
    ];
    const result = detectGaggles(frames, P);
    expect(gagglesAt(result, 5)).toEqual([{ id: result.episodes[0].id, members: [0, 1] }]);
    expect(gagglesAt(result, 22)).toEqual([{ id: result.episodes[0].id, members: [0, 1, 2] }]);
  });

  it('returns nothing well outside any episode window', () => {
    const frames = [0, 10, 20, 30].map((t) => frame(t, [st(0, 0, 1000, 0), st(1, 100, 1000, 0)]));
    const result = detectGaggles(frames, P);
    expect(gagglesAt(result, 10_000)).toEqual([]);
  });
});
