/**
 * Sparse PATCH handlers, driven by a field table instead of by hand.
 *
 * Every sparse update in this worker does the same four things per field:
 * add it to a dynamic UPDATE, compare it against the pre-update row, emit an
 * audit sentence when it moved, and decide whether the move made the
 * materialized scores stale. Written out per field, that is four parallel
 * lists a reader has to keep aligned in their head and an author has to
 * remember to extend in four places. `PATCH /api/comp/:comp_id` had thirteen
 * fields across those four lists, which is 340 lines in which the one thing
 * worth seeing — WHICH fields change a published score — is scattered.
 *
 * A field table puts the four facts about a field on one line, so the whole
 * policy is readable at once and adding a field is one entry. What stays
 * hand-written is the genuinely special: a value that has to be resolved
 * before it can be stored, or a change that needs more than one sentence.
 *
 * Missing an audit entry is a correctness bug here, not a cosmetic one — the
 * log is the competition's public transparency record — so the default is to
 * describe every change, and silence has to be asked for explicitly.
 */

/** One field of a sparse update: where it goes, and what it means. */
export interface PatchField<Body, Value = unknown> {
  /** The database column. */
  column: string;
  /** Body value → stored value. Identity by default. */
  toDb?: (value: Value) => unknown;
  /** Stored value → the space the body speaks in, so the two are comparable.
   *  Identity by default (SQLite booleans are 0/1, so those need one). */
  fromDb?: (stored: unknown) => Value;
  /** Did it actually move? Strict inequality by default. */
  changed?: (was: Value, now: Value) => boolean;
  /** The audit sentence(s). Return [] for a change that needs no record. */
  describe: (was: Value, now: Value) => string | string[];
  /** True when a change here marks the task's materialized scores stale. */
  bumpsScores?: boolean;
  /** @internal Lets the table be written with per-field value types. */
  __body?: Body;
}

/** The table for one PATCH: every optional key of the body may have an entry. */
export type PatchFieldTable<Body> = {
  [K in keyof Body]?: PatchField<Body, NonNullable<Body[K]> | null>;
};

export interface PatchPlan {
  /** `column = ?` fragments, in table order. */
  assignments: string[];
  /** Bound values, aligned with `assignments`. */
  values: unknown[];
  /** One audit sentence per real change. */
  audits: string[];
  /** True when any changed field is a scoring input. */
  bumpsScores: boolean;
}

/**
 * Work out what a PATCH body does to a row.
 *
 * A field absent from the body is untouched. A field PRESENT in the body is
 * always written — a no-op write is how "Save" stays idempotent — but only a
 * field that actually MOVED produces an audit sentence or a score bump.
 */
export function planPatch<Body extends object>(
  body: Body,
  current: Record<string, unknown>,
  table: PatchFieldTable<Body>
): PatchPlan {
  const plan: PatchPlan = {
    assignments: [],
    values: [],
    audits: [],
    bumpsScores: false,
  };

  for (const [key, entry] of Object.entries(table) as [
    keyof Body,
    PatchField<Body, never> | undefined,
  ][]) {
    if (!entry) continue;
    const incoming = body[key];
    if (incoming === undefined) continue;

    const field = entry as unknown as PatchField<Body, unknown>;
    const now = incoming as unknown;
    const was = field.fromDb
      ? field.fromDb(current[field.column])
      : (current[field.column] ?? null);

    plan.assignments.push(`${field.column} = ?`);
    plan.values.push(field.toDb ? field.toDb(now) : now);

    const moved = field.changed ? field.changed(was, now) : was !== now;
    if (!moved) continue;

    const described = field.describe(was, now);
    const lines = Array.isArray(described) ? described : [described];
    if (lines.length === 0) continue;

    plan.audits.push(...lines);
    if (field.bumpsScores) plan.bumpsScores = true;
  }

  return plan;
}

/** Two values that are only comparable once serialised (arrays, objects). */
export const deepChanged = (was: unknown, now: unknown): boolean =>
  JSON.stringify(was) !== JSON.stringify(now);

/** SQLite stores booleans as 0/1. */
export const boolToDb = (value: unknown): number => (value ? 1 : 0);
export const boolFromDb = (stored: unknown): boolean => !!stored;
