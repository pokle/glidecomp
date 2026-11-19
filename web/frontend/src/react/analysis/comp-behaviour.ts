/**
 * One behaviour of a comp analysis, read task by task: what the ranking's
 * track draws and what the behaviour's own page lists. Shared, so the row and
 * the page it opens cannot disagree about a task's figure or whether it could
 * be chance.
 */
import type { TrackReading } from "@/react/rac/meter";
import type { CompMetricAggregate } from "./types";
import { formatShownRho, shownRho } from "./units";

/** Did this task's coefficient clear its own noise floor? Null when the task
 * produced no coefficient at all. */
export function taskInformative(m: CompMetricAggregate, i: number): boolean | null {
  const c = m.perTaskCorrelation[i];
  return c === null || c === undefined ? null : Math.abs(c.rho) >= c.noiseFloor;
}

/** "T1" as the badge on a track: "1". A label that is not of that shape is
 * kept whole. */
export function taskBadge(label: string): string {
  return /^T\d+$/.test(label) ? label.slice(1) : label;
}

/** The tasks that produced a coefficient, as readings for the track. The
 * sign is the reader's: positive is more of it going with doing well. */
export function taskReadings(m: CompMetricAggregate, taskLabels: readonly string[]): TrackReading[] {
  return m.perTaskRho.flatMap((rho, i) =>
    rho === null
      ? []
      : [
          {
            key: taskLabels[i] ?? `task ${i + 1}`,
            badge: taskBadge(taskLabels[i] ?? String(i + 1)),
            value: shownRho(rho),
            hollow: taskInformative(m, i) === false,
          },
        ]
  );
}

/** Every task's figure as one sentence, for the track's accessible value:
 * "T1 +0.79, T2 +0.66 (could be chance), T3 not measured". */
export function taskReadingsWords(m: CompMetricAggregate, taskLabels: readonly string[]): string {
  return m.perTaskRho
    .map((rho, i) => {
      const label = taskLabels[i] ?? `task ${i + 1}`;
      if (rho === null) return `${label} not measured`;
      return `${label} ${formatShownRho(rho)}${
        taskInformative(m, i) === false ? " (could be chance)" : ""
      }`;
    })
    .join(", ");
}
