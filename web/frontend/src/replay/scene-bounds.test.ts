// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

import { describe, expect, it } from 'vitest';
import { clipToTask, type SceneBounds, type TaskBoundsSource } from './scene-bounds';

/** A ~24 km task, the shape of the one that exposed this. */
const TASK: TaskBoundsSource = {
  turnpoints: [
    { x: -55_000, z: -16_000, radius: 400 },
    { x: -44_000, z: -10_000, radius: 5_000 },
    { x: -50_000, z: -22_000, radius: 1_000 },
  ],
};
// box: x −55 400…−39 000 (16.4 km), z −22 000…−5 000 (17 km) → pad 8.2 km
const span = (b: SceneBounds) => [b.maxX - b.minX, b.maxZ - b.minZ];

describe('clipToTask', () => {
  it('cuts a track in the wrong country down to the task', () => {
    // The real case: one file ~2,150 km east and 618 km south of the field
    // took the scene extent to 2,225 km, so every pilot drew into five pixels.
    const wrecked: SceneBounds = { minX: -55_308, maxX: 2_160_000, minZ: -16_000, maxZ: 630_000 };
    const [sx, sz] = span(clipToTask(wrecked, TASK));
    expect(sx).toBeLessThan(30_000);
    expect(sz).toBeLessThan(30_000);
  });

  it('leaves a field that flies the task alone', () => {
    // Inside the padded box, so nothing is clipped — the tracks still decide.
    const real: SceneBounds = { minX: -58_000, maxX: -42_000, minZ: -24_000, maxZ: -8_000 };
    expect(clipToTask(real, TASK)).toEqual(real);
  });

  it('still lets a land-out past goal extend the frame', () => {
    // 6 km outside the task box on each side: within the slack, so it survives
    // clipping. A pilot who lands out must not be cropped off the map.
    const strayed: SceneBounds = { minX: -61_400, maxX: -33_000, minZ: -28_000, maxZ: 1_000 };
    const clipped = clipToTask(strayed, TASK);
    expect(clipped).toEqual(strayed);
  });

  it('falls back to the track bounds when the task has no turnpoints', () => {
    const b: SceneBounds = { minX: -1, maxX: 2, minZ: -3, maxZ: 4 };
    expect(clipToTask(b, undefined)).toEqual(b);
    expect(clipToTask(b, { turnpoints: [] })).toEqual(b);
  });

  it('does not collapse the scene onto a task box that is really a point', () => {
    // One turnpoint of no radius, and several on the same spot: the box has no
    // size, so the pad has none either. Clipping to it would put every bound
    // on that point and leave the whole field off-frame — worse than the fault
    // being guarded against, so the tracks win instead.
    const field: SceneBounds = { minX: -20_000, maxX: 20_000, minZ: -20_000, maxZ: 20_000 };
    expect(clipToTask(field, { turnpoints: [{ x: 0, z: 0, radius: 0 }] })).toEqual(field);
    expect(
      clipToTask(field, {
        turnpoints: [
          { x: 500, z: 500, radius: 100 },
          { x: 500, z: 500, radius: 100 },
        ],
      }),
    ).toEqual(field);
  });

  it('still clips against a small but real task', () => {
    // A 4 km box is well under a normal task and still far more trustworthy
    // than a track in another country, so it must not be waved through.
    const tiny: TaskBoundsSource = {
      turnpoints: [
        { x: 0, z: 0, radius: 400 },
        { x: 3_200, z: 0, radius: 400 },
      ],
    };
    const clipped = clipToTask({ minX: -9e9, maxX: 9e9, minZ: -9e9, maxZ: 9e9 }, tiny);
    expect(clipped.maxX - clipped.minX).toBe(8_000); // 4 km box + 2 km either side
  });

  it('ignores turnpoints carrying unusable coordinates', () => {
    const withJunk: TaskBoundsSource = {
      turnpoints: [
        { x: NaN, z: 0, radius: 100 },
        { x: 0, z: 0, radius: 1_000 },
        { x: 2_000, z: 2_000, radius: 1_000 },
      ],
    };
    const clipped = clipToTask({ minX: -9e9, maxX: 9e9, minZ: -9e9, maxZ: 9e9 }, withJunk);
    // box −1 000…3 000 on both axes (4 km) → pad 2 km → −3 000…5 000
    expect(clipped).toEqual({ minX: -3_000, maxX: 5_000, minZ: -3_000, maxZ: 5_000 });
  });

  it('pads both axes by the same distance, so a narrow task keeps room', () => {
    // A task that is long east-west and thin north-south: the short axis must
    // still get real slack, because that is where a land-out sits.
    const narrow: TaskBoundsSource = {
      turnpoints: [
        { x: 0, z: 0, radius: 0 },
        { x: 40_000, z: 0, radius: 0 },
      ],
    };
    const clipped = clipToTask({ minX: -9e9, maxX: 9e9, minZ: -9e9, maxZ: 9e9 }, narrow);
    expect(clipped.maxZ - clipped.minZ).toBe(40_000); // 20 km either side of the line
  });
});
