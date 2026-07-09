/**
 * The fixed, competition-wide pilot status vocabulary (FAI Sporting Code
 * S7F §9.1). Every competition uses exactly this set — it is NOT
 * admin-configurable (issue #261).
 *
 *   (no row) → Present  — the default. A registered pilot with no
 *                         task_pilot_status row is Present: present at
 *                         launch and intending to fly.
 *   absent   → Absent    (FAI ABS) — not present at launch. Excluded from
 *                         launch validity entirely.
 *   dnf      → Did Not Fly (FAI DNF) — present but chose not to launch.
 *                         Counts among "pilots present", not "pilots flying".
 *   landed   → Landed    — took off (has a track). Set automatically when a
 *                         track is uploaded; also selectable by admins for
 *                         the rare no-tracklog case.
 *
 * Only the three non-default statuses are ever stored as rows; Present is
 * the absence of a row (so selecting Present clears the row). Keys are the
 * short/TLA form stored in the DB — the UI always shows the full English
 * label (we don't surface TLAs to users).
 */
export type PilotStatusKey = "absent" | "dnf" | "landed";

export const PILOT_STATUS_KEYS: readonly PilotStatusKey[] = [
  "absent",
  "dnf",
  "landed",
] as const;

/** Full English label shown in the UI for each stored key. */
export const PILOT_STATUS_LABELS: Record<PilotStatusKey, string> = {
  absent: "Absent",
  dnf: "Did Not Fly",
  landed: "Landed",
};

/** The label for the implicit default (no stored row). */
export const PRESENT_LABEL = "Present";

export function isPilotStatusKey(key: string): key is PilotStatusKey {
  return (PILOT_STATUS_KEYS as readonly string[]).includes(key);
}

/** English label for a stored status key; falls back to the raw key for
 * any legacy value that somehow survived the migration. */
export function pilotStatusLabel(key: string): string {
  return isPilotStatusKey(key) ? PILOT_STATUS_LABELS[key] : key;
}
