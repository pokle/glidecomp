/**
 * The geometry hashes that key every `track_analysis` row.
 *
 * A stored per-track analysis is valid only for the exact task shape it was
 * computed under, so each variant carries a hash of the inputs that shape it.
 * Two different passes must agree on that hash CHARACTER FOR CHARACTER or the
 * second one silently misses the store — and a miss is indistinguishable from
 * a cold cache, so nothing fails and no test catches it. That is not a
 * hypothetical: the per-pilot transparency endpoint recovers the scorer's
 * §12.3.4 equalized window by looking up the row the scorer wrote, and it used
 * to rebuild the scorer's hash format from a second, hand-written copy of the
 * same template. A drift there would have shown a pilot a stopped-task
 * narrative that disagreed with their published score, with nothing to see it
 * happen.
 *
 * So the formats live here, once, and every pass calls the same function.
 *
 * Each builder takes {@link TaskScoringGeometry} rather than loose arguments
 * for the same reason: a caller cannot pass the leading formula for a task
 * scored with a different distance origin, because it never holds the pieces
 * apart in the first place.
 */

import { SCORING_ENGINE_VERSION } from "@glidecomp/engine";
import type { TaskScoringGeometry } from "./types";

/** Short SHA-256 hex digest (16 chars) of a string — used for state keys
 * and the track_analysis geometry hashes. */
export async function shortHash(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * The "gap" variant: the field-independent turnpoint analysis.
 *
 * Any change to the task geometry (xctsk) or distance origin invalidates every
 * stored analysis. Leading comps also reuse rows — but the leading aggregate
 * depends on the formula, so it is folded in (and the payload carries the
 * aggregate). The leading vs no-leading variants hash differently so a hit
 * always has the shape it needs. A task stop reshapes every per-track result
 * (window clip + altitude bonus), so the resolved stop time and glide ratio
 * fold in too — the goal altitude comes from the xctsk, already in the key.
 */
export function gapGeomHash(g: TaskScoringGeometry): Promise<string> {
  const stop = g.stopBase
    ? ` stop:${g.stopBase.stopTimeMs}:${g.stopBase.glideRatio}`
    : "";
  const leading = g.useLeading ? `lead:${g.leadingFormula}` : "nolead";
  return shortHash(
    `${g.taskRow.xctsk} ${g.distanceOrigin} ${leading}${stop} engine:${SCORING_ENGINE_VERSION}`
  );
}

/**
 * The "od" variant: one pilot's open distance.
 *
 * Only the task geometry matters — the take-off cylinder lives in the xctsk,
 * and open distance ignores GAP parameters entirely.
 */
export function odGeomHash(g: TaskScoringGeometry): Promise<string> {
  return shortHash(`${g.taskRow.xctsk} engine:${SCORING_ENGINE_VERSION}`);
}

/**
 * The "quality" variant: the data-quality verdict (track-quality.ts).
 *
 * Carries only what the verdict depends on: the route, the task's day and
 * zone, and the class. Deliberately NOT distanceOrigin/leading/stop — a stop
 * announcement must not re-fetch every track just to redo quality.
 */
export function qualityGeomHash(g: TaskScoringGeometry): Promise<string> {
  return shortHash(
    `${g.taskRow.xctsk} date:${g.taskRow.task_date} cat:${g.category} ` +
      `tz:${g.taskRow.timezone ?? ""} engine:${SCORING_ENGINE_VERSION}`
  );
}

/**
 * The "pilot-detail" variant: the per-pilot transparency payload.
 *
 * The day/zone/category terms are here because the payload carries the
 * data-quality verdict, which depends on them: without them, an admin
 * correcting a mistyped task date would leave every pilot's page showing the
 * old "wrong day" finding forever.
 *
 * `windowEndMs` is the pilot's own §12.3.4 equalized scored-window end, so
 * this is the one hash that is per-pilot rather than per-task.
 */
export function pilotDetailGeomHash(
  g: TaskScoringGeometry,
  windowEndMs: number | null
): Promise<string> {
  const stop = g.stopBase
    ? ` stop:${g.stopBase.stopTimeMs}:${g.stopBase.glideRatio}:${windowEndMs ?? ""}`
    : "";
  return shortHash(
    `${g.taskRow.xctsk} ${g.scoringFormat} ${g.distanceOrigin}${stop}` +
      ` day:${g.taskRow.task_date}@${g.taskRow.timezone ?? ""} cat:${g.taskRow.category}` +
      ` engine:${SCORING_ENGINE_VERSION}`
  );
}
