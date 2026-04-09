/**
 * Produce short human-readable summaries of xctsk state and diffs for
 * the audit log. Not a general-purpose diffing utility — just enough to
 * answer "what changed about the task route?" in a single sentence.
 *
 * The worker stores xctsk as a JSON string in `task.xctsk`. We don't
 * import the full XCTask type because the audit helper only needs to
 * peek at a few well-known fields and we want to tolerate partial or
 * unexpected shapes without throwing.
 */

type Unknown = Record<string, unknown>;

interface Waypoint {
  name?: string;
  lat?: number;
  lon?: number;
}
interface Turnpoint {
  type?: string;
  radius?: number;
  waypoint?: Waypoint;
}
interface TaskLike {
  taskType?: string;
  turnpoints?: Turnpoint[];
  sss?: { type?: string; direction?: string; timeGates?: string[] };
  goal?: { type?: string; deadline?: string };
}

function asTask(value: unknown): TaskLike | null {
  if (!value || typeof value !== "object") return null;
  return value as TaskLike;
}

function safeParse(json: string | null): TaskLike | null {
  if (!json) return null;
  try {
    return asTask(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Short summary of a task's current state. Used when the task route is
 * being set for the first time. Example: "7 turnpoints, race, goal cylinder".
 */
export function describeTaskSummary(task: unknown): string {
  const t = asTask(task);
  if (!t) return "task route";
  const parts: string[] = [];
  const tpCount = t.turnpoints?.length ?? 0;
  parts.push(`${tpCount} turnpoint${tpCount === 1 ? "" : "s"}`);
  if (t.sss?.type) parts.push(t.sss.type.toLowerCase());
  if (t.goal?.type) parts.push(`goal ${t.goal.type.toLowerCase()}`);
  return parts.join(", ");
}

/**
 * Compare two xctsk states and return a short phrase describing what
 * changed, or null if no meaningful difference is detected. Up to 3
 * changes are listed; beyond that, the overflow is summarised as "+N more".
 *
 * Input types: old is the raw JSON string stored in D1; new is the
 * parsed object from the request body (Zod gives us `z.record(z.unknown())`).
 */
export function summarizeXctskChange(
  oldJson: string | null,
  newValue: unknown
): string | null {
  const oldTask = safeParse(oldJson);
  const newTask = asTask(newValue);
  if (!newTask) return null;
  if (!oldTask) {
    // Treat null→task as the initial-set case rather than a diff.
    return describeTaskSummary(newTask);
  }

  const changes: string[] = [];

  if (oldTask.taskType !== newTask.taskType) {
    changes.push(`type ${oldTask.taskType ?? "?"} → ${newTask.taskType ?? "?"}`);
  }

  const oldCount = oldTask.turnpoints?.length ?? 0;
  const newCount = newTask.turnpoints?.length ?? 0;
  if (oldCount !== newCount) {
    changes.push(`${oldCount} → ${newCount} turnpoints`);
  } else {
    // Walk turnpoints in parallel and note per-index changes.
    for (let i = 0; i < newCount; i++) {
      const o = oldTask.turnpoints![i];
      const n = newTask.turnpoints![i];
      if (!o || !n) continue;
      const label = `TP${i + 1}${n.waypoint?.name ? ` (${n.waypoint.name})` : ""}`;
      if (o.waypoint?.name !== n.waypoint?.name) {
        changes.push(`${label}: waypoint ${o.waypoint?.name ?? "?"} → ${n.waypoint?.name ?? "?"}`);
      } else if (o.radius !== n.radius) {
        changes.push(`${label}: radius ${o.radius ?? "?"}m → ${n.radius ?? "?"}m`);
      } else if ((o.type ?? null) !== (n.type ?? null)) {
        changes.push(`${label}: type ${o.type ?? "TP"} → ${n.type ?? "TP"}`);
      } else if (
        Math.abs((o.waypoint?.lat ?? 0) - (n.waypoint?.lat ?? 0)) > 1e-5 ||
        Math.abs((o.waypoint?.lon ?? 0) - (n.waypoint?.lon ?? 0)) > 1e-5
      ) {
        changes.push(`${label}: moved`);
      }
    }
  }

  if ((oldTask.sss?.type ?? null) !== (newTask.sss?.type ?? null)) {
    changes.push(
      `start type ${oldTask.sss?.type ?? "none"} → ${newTask.sss?.type ?? "none"}`
    );
  }
  if ((oldTask.sss?.direction ?? null) !== (newTask.sss?.direction ?? null)) {
    changes.push(
      `start direction ${oldTask.sss?.direction ?? "none"} → ${newTask.sss?.direction ?? "none"}`
    );
  }
  const oldGates = (oldTask.sss?.timeGates ?? []).join(",");
  const newGates = (newTask.sss?.timeGates ?? []).join(",");
  if (oldGates !== newGates) {
    changes.push(`start gates ${oldGates || "none"} → ${newGates || "none"}`);
  }

  if ((oldTask.goal?.type ?? null) !== (newTask.goal?.type ?? null)) {
    changes.push(
      `goal ${oldTask.goal?.type ?? "cylinder"} → ${newTask.goal?.type ?? "cylinder"}`
    );
  }
  if ((oldTask.goal?.deadline ?? null) !== (newTask.goal?.deadline ?? null)) {
    changes.push(
      `goal deadline ${oldTask.goal?.deadline ?? "none"} → ${newTask.goal?.deadline ?? "none"}`
    );
  }

  if (changes.length === 0) return null;

  const MAX_SHOWN = 3;
  if (changes.length <= MAX_SHOWN) return changes.join("; ");
  return `${changes.slice(0, MAX_SHOWN).join("; ")}; +${changes.length - MAX_SHOWN} more`;
}
