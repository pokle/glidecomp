// Copyright (c) 2026, Tushar Pokle.  All rights reserved.
/**
 * Task features — everything known before anybody launches.
 *
 * These are constant across a task-class, so they can only help the model by
 * telling it what KIND of day it is looking at (a 40 km triangle in the hills
 * is a different problem from a 180 km flatlands run). Nothing here reads a
 * track, and nothing reads the field.
 */

import {
  ellipsoidDistance,
  resolveStartGates,
  resolveTaskDeadline,
  resolveLaunchWindowOpen,
  mean,
  median,
  type GAPParameters,
} from '@glidecomp/engine';
import type { FeatureBlock } from './track-features';
import { turnAnglesDeg, type TaskGeometry } from './geometry';

export interface TaskFeatureContext {
  geom: TaskGeometry;
  /** Resolved GAP parameters — the same ones the field was scored under. */
  params: GAPParameters;
  /** A time inside the task day, for resolving the clock fields. */
  referenceMs: number;
  /** Offset of the comp's zone at `referenceMs`, so clock features are local. */
  timeZoneOffsetMs: number;
}

export function taskFeatures(ctx: TaskFeatureContext): FeatureBlock {
  const { geom, params } = ctx;
  const task = geom.task;

  const waypointMeters = centreToCentreMeters(geom);
  const radii = task.turnpoints.map((t) => t.radius).filter((r) => Number.isFinite(r));
  const turns = turnAnglesDeg(geom.legBearings).map(Math.abs);
  const elevations = task.turnpoints
    .map((t) => t.waypoint.altSmoothed)
    .filter((a): a is number => typeof a === 'number');

  const gates = resolveStartGates(task, ctx.referenceMs);
  const deadline = resolveTaskDeadline(task, ctx.referenceMs);
  const windowOpen = resolveLaunchWindowOpen(task, ctx.referenceMs);
  const firstGate = gates?.[0] ?? null;
  const gateInterval =
    gates && gates.length > 1 ? (gates[1] - gates[0]) / 1000 : null;

  return {
    'task.optimised_m': geom.totalMeters,
    'task.waypoint_m': waypointMeters,
    // How much the optimiser saves over flying centre to centre: a proxy for
    // how much of the task is cylinder geometry rather than distance.
    'task.optimiser_saving_frac':
      waypointMeters > 0 ? 1 - geom.totalMeters / waypointMeters : null,
    'task.n_turnpoints': task.turnpoints.length,
    'task.n_legs': geom.legMeters.length,
    'task.leg_m_mean': finite(mean(geom.legMeters)),
    'task.leg_m_min': geom.legMeters.length > 0 ? Math.min(...geom.legMeters) : null,
    'task.leg_m_max': geom.legMeters.length > 0 ? Math.max(...geom.legMeters) : null,
    'task.leg_m_median': finite(median(geom.legMeters)),
    'task.turn_angle_mean_deg': finite(mean(turns)),
    'task.turn_angle_max_deg': turns.length > 0 ? Math.max(...turns) : null,
    'task.radius_m_median': finite(median(radii)),
    'task.radius_m_min': radii.length > 0 ? Math.min(...radii) : null,
    'task.radius_m_max': radii.length > 0 ? Math.max(...radii) : null,
    'task.start_radius_m': task.turnpoints[geom.sssIndex]?.radius ?? null,
    'task.goal_radius_m': task.turnpoints[geom.goalIndex]?.radius ?? null,
    'task.goal_is_line': task.goal?.type === 'LINE' ? 1 : 0,
    'task.sss_is_race': task.sss?.type === 'RACE' ? 1 : 0,
    'task.sss_is_exit': task.sss?.direction === 'EXIT' ? 1 : 0,
    'task.n_gates': gates ? gates.length : null,
    'task.gate_interval_s': gateInterval,
    'task.first_gate_local_s': firstGate === null ? null : localSecondsOfDay(firstGate, ctx),
    'task.deadline_local_s': deadline === null ? null : localSecondsOfDay(deadline, ctx),
    'task.launch_open_local_s':
      windowOpen === null ? null : localSecondsOfDay(windowOpen, ctx),
    'task.window_s': firstGate !== null && deadline !== null ? (deadline - firstGate) / 1000 : null,
    'task.launch_elev_m': task.turnpoints[0]?.waypoint.altSmoothed ?? null,
    'task.route_elev_mean_m': finite(mean(elevations)),
    'task.route_elev_min_m': elevations.length > 0 ? Math.min(...elevations) : null,
    'task.route_elev_max_m': elevations.length > 0 ? Math.max(...elevations) : null,
    'task.nominal_distance_m': finite(params.nominalDistance),
    'task.nominal_time_s': finite(params.nominalTime),
    'task.minimum_distance_m': finite(params.minimumDistance),
  };
}

function centreToCentreMeters(geom: TaskGeometry): number {
  const tps = geom.task.turnpoints;
  let total = 0;
  for (let i = 1; i < tps.length; i++) {
    total += ellipsoidDistance(
      tps[i - 1].waypoint.lat, tps[i - 1].waypoint.lon,
      tps[i].waypoint.lat, tps[i].waypoint.lon,
    );
  }
  return total;
}

function localSecondsOfDay(atMs: number, ctx: TaskFeatureContext): number {
  const local = atMs + ctx.timeZoneOffsetMs;
  return ((((local % 86_400_000) + 86_400_000) % 86_400_000) / 1000);
}

function finite(v: number | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
