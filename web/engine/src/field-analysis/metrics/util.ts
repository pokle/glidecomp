// Copyright (c) 2026, Tushar Pokle.  All rights reserved.

/**
 * Scaffolding shared by the metric families — the per-pilot null shapes and
 * fix-time readers every computer spells out. Metric MATHS stays in each
 * family's file; only the boilerplate lives here.
 */

import type { IGCFix } from '../../igc-parser';
import type { FieldContext, PilotAnalysisContext, PilotMetricValue } from '../types';

/** A null (not-applicable) per-pilot value. */
export function na(p: PilotAnalysisContext): PilotMetricValue {
  return { trackFile: p.trackFile, value: null };
}

/** One null entry per pilot — the shape field-level metrics must return. */
export function allNullPerPilot(field: FieldContext): PilotMetricValue[] {
  return field.pilots.map(na);
}

/** Epoch ms of a fix. */
export function fixMs(f: IGCFix): number {
  return f.time.getTime();
}

/**
 * Epoch ms of the pilot's fix at `fixIndex`. The index-taking twin of
 * {@link fixMs}, for call sites that hold an index into a known-good range
 * rather than the fix itself.
 */
export function fixMsAt(p: PilotAnalysisContext, fixIndex: number): number {
  return p.fixes[fixIndex].time.getTime();
}
