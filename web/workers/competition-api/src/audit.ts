/**
 * Shared audit log helper.
 *
 * Write a row to `audit_log` describing a mutating action. The caller
 * provides the subject and a human-readable description — the helper
 * takes care of actor resolution, timestamping, and the INSERT.
 *
 * Audit entries are public per comp (for non-test comps) and form the
 * transparency record for score-affecting changes. See the spec
 * (docs/competition-spec.md, Iteration 8) for the design rationale.
 *
 * Description text is the single source of truth — there is no structured
 * `detail` column. Stats queries use regex on `description`.
 */

import type { AuthUser } from "./env";

export type SubjectType = "comp" | "task" | "pilot" | "track";

/**
 * What an action taken without a signed-in account is called, wherever a
 * column or a sentence has to name who did it.
 *
 * Anonymous track submission is the only such actor today. It is deliberately
 * a phrase and not a fabricated user: the audit log is the competition's
 * public transparency record, and "anonymous submission" is the true answer.
 */
export const ANONYMOUS_ACTOR_NAME = "anonymous submission";

export interface AuditEntry {
  subject_type: SubjectType;
  subject_id?: number | null;
  subject_name?: string | null;
  description: string;
}

/**
 * Insert one audit log entry for the given competition.
 *
 * The caller passes the D1 database and the acting user (from
 * c.var.user) directly. When user is null, actor_user_id is null and
 * actor_name is "system".
 *
 * Errors are NOT propagated — audit writes are best-effort and must never
 * cause a mutating request to fail. Failures are logged to the console.
 */
export async function audit(
  db: D1Database,
  user: AuthUser | null | undefined,
  compId: number,
  entry: AuditEntry
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO audit_log (
          comp_id, timestamp, actor_user_id, actor_name,
          subject_type, subject_id, subject_name, description
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        compId,
        new Date().toISOString(),
        user?.id ?? null,
        user?.name ?? "system",
        entry.subject_type,
        entry.subject_id ?? null,
        entry.subject_name ?? null,
        entry.description
      )
      .run();
  } catch (err) {
    console.error("audit write failed", err, { compId, entry });
  }
}

/**
 * Insert several audit entries for one competition, in one round trip.
 *
 * A field-by-field PATCH produces one sentence per changed field, and the
 * handlers used to `await audit()` in a loop — N serialized D1 writes on the
 * response path, none of them in the same transaction as the update they
 * describe. `db.batch()` is one transaction, so the entries describing a
 * change now land together or not at all.
 *
 * Best-effort like {@link audit}: an audit failure must never fail the
 * mutation it describes.
 */
export async function auditAll(
  db: D1Database,
  user: AuthUser | null | undefined,
  compId: number,
  entries: AuditEntry[]
): Promise<void> {
  if (entries.length === 0) return;
  const timestamp = new Date().toISOString();
  try {
    await db.batch(
      entries.map((entry) =>
        db
          .prepare(
            `INSERT INTO audit_log (
              comp_id, timestamp, actor_user_id, actor_name,
              subject_type, subject_id, subject_name, description
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            compId,
            timestamp,
            user?.id ?? null,
            user?.name ?? "system",
            entry.subject_type,
            entry.subject_id ?? null,
            entry.subject_name ?? null,
            entry.description
          )
      )
    );
  } catch (err) {
    console.error("audit batch write failed", err, { compId, entries });
  }
}

/**
 * Convenience: describe a single field change in the form used by
 * field-by-field PATCH audits. Returns a human-readable sentence.
 *
 * Examples:
 *   describeChange("close_date", "2026-05-01", "2026-05-10")
 *     → `Changed close_date from "2026-05-01" to "2026-05-10"`
 *   describeChange("name", undefined, "Bells Beach 2026")
 *     → `Set name to "Bells Beach 2026"`
 */
export function describeChange(
  field: string,
  oldValue: unknown,
  newValue: unknown
): string {
  const fmt = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "(empty)";
    if (typeof v === "string") return `"${v}"`;
    return String(v);
  };
  if (oldValue === undefined || oldValue === null || oldValue === "") {
    return `Set ${field} to ${fmt(newValue)}`;
  }
  return `Changed ${field} from ${fmt(oldValue)} to ${fmt(newValue)}`;
}
