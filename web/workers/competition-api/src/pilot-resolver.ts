/**
 * Shared pilot resolution logic.
 *
 * Given admin-entered pilot fields, attempt to match an existing `pilot` row.
 * Used in two places (see docs/competition-spec.md, Iteration 8):
 *
 *   1. When an admin creates/imports a `comp_pilot` — to populate `pilot_id`
 *      for pilots who already have a GlideComp account.
 *   2. (Future, in auth-api) When a user signs up — to link any pre-existing
 *      unlinked `comp_pilot` rows to the new account.
 *
 * Priority chain (first hit wins):
 *   1. CIVL ID
 *   2. Any of SAFA / USHPA / BHPA / DHV / FFVL / FAI IDs
 *   3. Email (joined to `user.email`)
 *   4. Exact name (case-insensitive)
 *
 * A name-only match does NOT auto-link — the admin must resolve it manually.
 * Candidate pilot_ids are returned via `nameOnlyCandidates` so the caller can
 * surface them in an import preview.
 *
 * A single SELECT with OR clauses fetches all potential matches in one round
 * trip. This matters for CSV import, which runs the resolver once per pilot
 * row (up to 250 per request).
 */

export interface ResolveFields {
  name?: string | null;
  email?: string | null;
  civl_id?: string | null;
  safa_id?: string | null;
  ushpa_id?: string | null;
  bhpa_id?: string | null;
  dhv_id?: string | null;
  ffvl_id?: string | null;
  fai_id?: string | null;
}

export type MatchedBy =
  | "civl_id"
  | "safa_id"
  | "ushpa_id"
  | "bhpa_id"
  | "dhv_id"
  | "ffvl_id"
  | "fai_id"
  | "email"
  | null;

export interface ResolveResult {
  /** Matched pilot_id, or null if no confident match. */
  pilot_id: number | null;
  /** Which rule matched — useful for logging / audit strings. */
  matched_by: MatchedBy;
  /**
   * When `pilot_id` is null and only a name match exists, the candidate
   * pilot_ids are returned here so the caller can surface them in an import
   * preview. Empty array means truly no match.
   */
  nameOnlyCandidates: number[];
}

/** Priority order for ID-based matching. Same order is used in the final classification. */
const ID_PRIORITY = [
  "civl_id",
  "safa_id",
  "ushpa_id",
  "bhpa_id",
  "dhv_id",
  "ffvl_id",
  "fai_id",
] as const;

type IdColumn = (typeof ID_PRIORITY)[number];

interface PilotRow {
  pilot_id: number;
  civl_id: string | null;
  safa_id: string | null;
  ushpa_id: string | null;
  bhpa_id: string | null;
  dhv_id: string | null;
  ffvl_id: string | null;
  fai_id: string | null;
  lname: string | null;
  email: string | null;
}

function nonEmpty(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const trimmed = v.trim();
  return trimmed === "" ? null : trimmed;
}

export async function resolvePilotId(
  db: D1Database,
  fields: ResolveFields
): Promise<ResolveResult> {
  const ids: Record<IdColumn, string | null> = {
    civl_id: nonEmpty(fields.civl_id),
    safa_id: nonEmpty(fields.safa_id),
    ushpa_id: nonEmpty(fields.ushpa_id),
    bhpa_id: nonEmpty(fields.bhpa_id),
    dhv_id: nonEmpty(fields.dhv_id),
    ffvl_id: nonEmpty(fields.ffvl_id),
    fai_id: nonEmpty(fields.fai_id),
  };
  const email = nonEmpty(fields.email);
  const name = nonEmpty(fields.name);
  const nameLower = name?.toLowerCase() ?? null;

  // Nothing to match on
  const anyId = ID_PRIORITY.some((c) => ids[c] !== null);
  if (!anyId && !email && !name) {
    return { pilot_id: null, matched_by: null, nameOnlyCandidates: [] };
  }

  // Single SELECT collecting every potential match. Nulls in the bound
  // parameters are safe because `col = NULL` always evaluates to NULL (falsy)
  // in SQL, so those disjuncts contribute nothing.
  const rows = await db
    .prepare(
      `SELECT p.pilot_id,
              p.civl_id, p.safa_id, p.ushpa_id, p.bhpa_id,
              p.dhv_id,  p.ffvl_id, p.fai_id,
              LOWER(p.name) AS lname,
              u.email
       FROM pilot p
       LEFT JOIN "user" u ON p.user_id = u.id
       WHERE p.civl_id  = ?
          OR p.safa_id  = ?
          OR p.ushpa_id = ?
          OR p.bhpa_id  = ?
          OR p.dhv_id   = ?
          OR p.ffvl_id  = ?
          OR p.fai_id   = ?
          OR u.email    = ?
          OR LOWER(p.name) = ?`
    )
    .bind(
      ids.civl_id,
      ids.safa_id,
      ids.ushpa_id,
      ids.bhpa_id,
      ids.dhv_id,
      ids.ffvl_id,
      ids.fai_id,
      email,
      nameLower
    )
    .all<PilotRow>();

  const results = rows.results;
  if (results.length === 0) {
    return { pilot_id: null, matched_by: null, nameOnlyCandidates: [] };
  }

  // Apply priority chain against the fetched rows.
  for (const col of ID_PRIORITY) {
    const target = ids[col];
    if (!target) continue;
    const hit = results.find((r) => r[col] === target);
    if (hit) {
      return { pilot_id: hit.pilot_id, matched_by: col, nameOnlyCandidates: [] };
    }
  }

  if (email) {
    const hit = results.find((r) => r.email === email);
    if (hit) {
      return { pilot_id: hit.pilot_id, matched_by: "email", nameOnlyCandidates: [] };
    }
  }

  if (nameLower) {
    const candidates = results
      .filter((r) => r.lname === nameLower)
      .map((r) => r.pilot_id);
    return { pilot_id: null, matched_by: null, nameOnlyCandidates: candidates };
  }

  return { pilot_id: null, matched_by: null, nameOnlyCandidates: [] };
}
