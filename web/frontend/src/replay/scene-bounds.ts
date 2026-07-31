// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * The replay's scene bounds — the one number that sets the scale of everything
 * drawn.
 *
 * `FlightScene.extentXZ` and `center` derive from these bounds, and eight
 * things read them: the abstract backdrop's grid and camera distance, the
 * pilot marker cones, the turnpoint and start/goal labels, the gaggle hull
 * padding and count-label width. So the bounds are not "the initial view" —
 * they are the scene's unit of scale, and every one of those sizes is wrong
 * together when the bounds are wrong.
 *
 * Taking them from the tracks alone makes them only as trustworthy as the
 * worst file anyone uploaded. One track from another day and another country
 * put a comp task's bounds at 2,225 km against a real field of 28 km: every
 * pilot collapsed into a five-pixel smudge and the marker cones grew to 27 km
 * across. The task's own turnpoints cannot be corrupted that way — they come
 * from the task definition, not from a pilot's file.
 *
 * So the task defines the stage and the tracks may extend it, but only so far.
 */

/** Axis-aligned bounds in scene metres (x = East, z = North). */
export interface SceneBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** The turnpoint geometry the manifest carries, as far as bounds care. */
export interface TaskBoundsSource {
  turnpoints: { x: number; z: number; radius: number }[];
}

/**
 * How far past the task's own box a track is still allowed to push the
 * bounds. Pilots legitimately fly outside it — a launch outside the first
 * cylinder, a glide past goal, a long land-out — so the tracks must be able
 * to extend the frame. Half the task's size again is roomy enough for those
 * and still nowhere near a track in the wrong country.
 */
const TASK_BOX_SLACK = 0.5;

/**
 * Track bounds, clipped to the task's turnpoint box grown by TASK_BOX_SLACK.
 *
 * Returns `track` unchanged when the task has no turnpoints to measure
 * against (free-flight replays, and the 0-turnpoint tasks the manifest
 * documents), which is the old behaviour and the best available.
 */
export function clipToTask(track: SceneBounds, task?: TaskBoundsSource): SceneBounds {
  const box = taskBox(task);
  if (!box) return track;

  // Grow the task box by a share of its LONGEST side, so the slack is the
  // same distance on both axes. Growing each axis by its own length would
  // give a narrow task almost no room across its short side, which is
  // exactly where a land-out sits.
  const pad = Math.max(box.maxX - box.minX, box.maxZ - box.minZ) * TASK_BOX_SLACK;
  return {
    minX: Math.max(track.minX, box.minX - pad),
    maxX: Math.min(track.maxX, box.maxX + pad),
    minZ: Math.max(track.minZ, box.minZ - pad),
    maxZ: Math.min(track.maxZ, box.maxZ + pad),
  };
}

/** The bounds of the task's turnpoint cylinders, or null if there are none. */
function taskBox(task?: TaskBoundsSource): SceneBounds | null {
  if (!task?.turnpoints?.length) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minZ = Infinity,
    maxZ = -Infinity;
  for (const tp of task.turnpoints) {
    if (!Number.isFinite(tp.x) || !Number.isFinite(tp.z)) continue;
    const r = Number.isFinite(tp.radius) ? Math.abs(tp.radius) : 0;
    minX = Math.min(minX, tp.x - r);
    maxX = Math.max(maxX, tp.x + r);
    minZ = Math.min(minZ, tp.z - r);
    maxZ = Math.max(maxZ, tp.z + r);
  }
  return Number.isFinite(minX) ? { minX, maxX, minZ, maxZ } : null;
}
