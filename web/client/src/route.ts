/**
 * How a task's route is described in words: turnpoint roles, the start
 * configuration and the goal. Shared by the website's task page and route
 * editor and the app's task screens, so a pilot reads the same sentence on
 * both. Pure: no DOM, deterministic for a given zone (it renders in SSR).
 */
import type { GoalConfig, SSSConfig } from "@glidecomp/engine";
import { utcToZonedHHMM, zoneNameWithOffset } from "./time";

export const TYPE_LABELS: Record<string, string> = {
  TAKEOFF: "Takeoff",
  SSS: "Start Speed Section (SSS)",
  "": "Turnpoint",
  ESS: "End Speed Section (ESS)",
  GOAL: "Goal",
};

/** "HH:MM:SSZ" / "HH:MM" (the xctsk gate format) → "HH:MM", or null. */
export function gateToHHMM(value: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?Z?$/.exec(value.trim());
  if (!m) return null;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** The task's real gates as "HH:MM" — drops the lone 00:00 placeholder. */
export function editableGates(sss: SSSConfig | undefined): string[] {
  const gates = (sss?.timeGates ?? [])
    .map(gateToHHMM)
    .filter((g): g is string => g !== null);
  // toXctskJSON writes a lone 00:00:00Z to satisfy the format's
  // non-empty-gates rule; scoring ignores it, so the editor does too.
  if (gates.length === 1 && gates[0] === "00:00") return [];
  return gates;
}

/**
 * One-line human summary of the start configuration. When the comp's
 * timezone and the task date are known, gate times are shown comp-local
 * (labelled with the zone); otherwise they stay UTC as stored.
 */
export function startConfigSummary(
  sss: SSSConfig,
  opts?: { timeZone?: string | null; taskDate?: string }
): string {
  const kind = sss.type === "ELAPSED-TIME" ? "Elapsed time" : "Race to goal";
  const dir = sss.direction === "ENTER" ? "enter" : "exit";
  let gates = editableGates(sss);
  let zoneLabel = "UTC";
  const tz = opts?.timeZone;
  if (tz && opts?.taskDate && gates.length > 0) {
    const converted = gates.map((g) => utcToZonedHHMM(opts.taskDate!, g, tz));
    if (converted.every((g): g is string => g !== null)) {
      gates = converted;
      zoneLabel = zoneNameWithOffset(new Date(`${opts.taskDate}T12:00:00Z`), tz);
    }
  }
  const gateStr =
    sss.type === "ELAPSED-TIME"
      ? gates.length > 0
        ? ` · start opens ${gates[0]} ${zoneLabel}`
        : ""
      : gates.length > 0
        ? ` · ${gates.length} start gate${gates.length === 1 ? "" : "s"}: ${gates.join(", ")} ${zoneLabel}`
        : " · no start gates (pilots timed from their crossing)";
  return `${kind} · ${dir} start${gateStr}`;
}

/**
 * One-line summary of the goal: "Cylinder", or "Line · deadline 18:00 AEDT
 * (GMT+11)". The deadline is comp-local when the comp has a zone, else UTC
 * as stored.
 */
export function goalSummary(
  goal: GoalConfig,
  opts?: { timeZone?: string | null; taskDate?: string }
): string {
  const typeLabel = goal.type === "LINE" ? "Line" : "Cylinder";
  const deadlineHHMM = goal.deadline ? gateToHHMM(goal.deadline) : null;
  if (!deadlineHHMM) return typeLabel;
  const tz = opts?.timeZone;
  const date = opts?.taskDate;
  const zoned = tz && date ? utcToZonedHHMM(date, deadlineHHMM, tz) : deadlineHHMM;
  const zoneLbl = tz && date ? zoneNameWithOffset(new Date(`${date}T12:00:00Z`), tz) : "UTC";
  return `${typeLabel} · deadline ${zoned ?? deadlineHHMM} ${zoneLbl}`;
}
