/**
 * Reverse direction of `resolvePilotId`: given an existing `pilot` row,
 * find unlinked `comp_pilot` rows that were pre-registered by an admin
 * for the same person and claim them by setting their `pilot_id`.
 *
 * This is the mechanism by which a user who signed up AFTER an admin
 * pre-registered them from a spreadsheet gets automatically linked to
 * their pre-existing competition registration.
 *
 * Triggered in two places (see docs/competition-spec.md, Iteration 8g):
 *
 *   1. `PATCH /api/comp/pilot` — after the user saves their pilot
 *      profile, scan ALL open competitions for unlinked rows matching
 *      the updated identity.
 *   2. `ensureCompPilot` in the IGC upload path — before inserting a
 *      fresh comp_pilot row, check for a matching unlinked row in the
 *      SAME comp and claim it instead of creating a duplicate.
 *
 * Priority chain (first hit wins per comp_pilot row):
 *   1. CIVL ID
 *   2. Any of SAFA / USHPA / BHPA / DHV / FFVL / FAI IDs
 *   3. Email (via user.email)
 *
 * Name-only matches are intentionally excluded — same rationale as the
 * resolver: two people can share a name. The admin will still need to
 * fix up name-only pre-registrations by hand.
 */

export interface LinkedRegistration {
  comp_pilot_id: number;
  comp_id: number;
  /** Denormalised pilot name from the comp_pilot row, used for audit. */
  registered_pilot_name: string;
  /** Which field the link was made on — for audit descriptions. */
  matched_by:
    | "civl_id"
    | "safa_id"
    | "ushpa_id"
    | "bhpa_id"
    | "dhv_id"
    | "ffvl_id"
    | "fai_id"
    | "email";
}

interface PilotIdentity {
  civl_id: string | null;
  safa_id: string | null;
  ushpa_id: string | null;
  bhpa_id: string | null;
  dhv_id: string | null;
  ffvl_id: string | null;
  fai_id: string | null;
  email: string | null;
}

const ID_FIELDS = [
  "civl_id",
  "safa_id",
  "ushpa_id",
  "bhpa_id",
  "dhv_id",
  "ffvl_id",
  "fai_id",
] as const;

type IdField = (typeof ID_FIELDS)[number];

/**
 * Look up a pilot's identity fields (the ones used for matching) in one
 * query. Email comes via the user table join.
 */
async function loadPilotIdentity(
  db: D1Database,
  pilotId: number
): Promise<PilotIdentity | null> {
  return db
    .prepare(
      `SELECT p.civl_id, p.safa_id, p.ushpa_id, p.bhpa_id,
              p.dhv_id, p.ffvl_id, p.fai_id, u.email
       FROM pilot p
       LEFT JOIN "user" u ON p.user_id = u.id
       WHERE p.pilot_id = ?`
    )
    .bind(pilotId)
    .first<PilotIdentity>();
}

/**
 * Scan unlinked `comp_pilot` rows matching the given pilot's identity
 * and set `pilot_id` on each match. Returns the list of newly linked
 * registrations so the caller can write audit entries.
 *
 * @param scope
 *   - `"open-comps"`: search all competitions whose `close_date` is NULL
 *     or in the future. Used by profile updates.
 *   - `{ comp_id }`: search only within the given competition. Used by
 *     the IGC upload path so we scope to the comp being uploaded to.
 *
 * Concurrency: two updates can race to claim the same unlinked row. The
 * partial unique index on (comp_id, pilot_id) WHERE pilot_id IS NOT NULL
 * catches this — the losing update throws with a UNIQUE violation. We
 * catch and ignore per-row errors so a single conflict doesn't abort the
 * whole linking pass.
 */
export async function linkExistingRegistrations(
  db: D1Database,
  pilotId: number,
  scope: "open-comps" | { comp_id: number }
): Promise<LinkedRegistration[]> {
  const identity = await loadPilotIdentity(db, pilotId);
  if (!identity) return [];

  // Nothing to match on — skip entirely.
  const hasAnyId = ID_FIELDS.some((f) => identity[f] !== null);
  if (!hasAnyId && !identity.email) return [];

  // Build the WHERE clause. Each field contributes an "OR" branch that
  // matches against the corresponding registered_pilot_<field> column.
  // Email matches registered_pilot_email.
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  for (const field of ID_FIELDS) {
    const value = identity[field];
    if (value === null) continue;
    conditions.push(`registered_pilot_${field} = ?`);
    bindings.push(value);
  }
  if (identity.email) {
    conditions.push("registered_pilot_email = ?");
    bindings.push(identity.email);
  }

  // Scope: open comps or a specific comp
  let compScopeSql = "";
  if (scope === "open-comps") {
    compScopeSql = `AND comp_id IN (
      SELECT comp_id FROM comp
      WHERE close_date IS NULL OR close_date >= date('now')
    )`;
  } else {
    compScopeSql = "AND comp_id = ?";
    bindings.push(scope.comp_id);
  }

  const candidates = await db
    .prepare(
      `SELECT comp_pilot_id, comp_id, registered_pilot_name,
              registered_pilot_civl_id, registered_pilot_safa_id,
              registered_pilot_ushpa_id, registered_pilot_bhpa_id,
              registered_pilot_dhv_id, registered_pilot_ffvl_id,
              registered_pilot_fai_id, registered_pilot_email
       FROM comp_pilot
       WHERE pilot_id IS NULL
         AND (${conditions.join(" OR ")})
         ${compScopeSql}`
    )
    .bind(...bindings)
    .all<{
      comp_pilot_id: number;
      comp_id: number;
      registered_pilot_name: string;
      registered_pilot_civl_id: string | null;
      registered_pilot_safa_id: string | null;
      registered_pilot_ushpa_id: string | null;
      registered_pilot_bhpa_id: string | null;
      registered_pilot_dhv_id: string | null;
      registered_pilot_ffvl_id: string | null;
      registered_pilot_fai_id: string | null;
      registered_pilot_email: string | null;
    }>();

  if (candidates.results.length === 0) return [];

  // Classify each candidate by which field drove the match, preserving
  // priority order (CIVL first). One comp_pilot row might match multiple
  // fields; we record the highest-priority match for the audit.
  const linked: LinkedRegistration[] = [];
  for (const row of candidates.results) {
    const matched_by = classifyMatch(identity, row);
    if (!matched_by) continue; // shouldn't happen — the WHERE clause guarantees a match

    // Claim the row. On UNIQUE violation (another concurrent update won
    // the race), silently skip — we don't want a partial failure to
    // abort the rest of the pass.
    try {
      await db
        .prepare(
          "UPDATE comp_pilot SET pilot_id = ? WHERE comp_pilot_id = ? AND pilot_id IS NULL"
        )
        .bind(pilotId, row.comp_pilot_id)
        .run();
    } catch (err) {
      // Most likely the partial unique index fired because the pilot is
      // already linked to another row in this comp. That's a pre-existing
      // inconsistency (admin pre-registered the same person twice), not
      // something we should mask the whole linker for — but within a
      // single link pass we skip and continue.
      console.error("pilot-linker claim failed", { err, row });
      continue;
    }

    linked.push({
      comp_pilot_id: row.comp_pilot_id,
      comp_id: row.comp_id,
      registered_pilot_name: row.registered_pilot_name,
      matched_by,
    });
  }
  return linked;
}

/**
 * Work out which field a candidate matched against, in priority order.
 * Returns the first field that agrees. Used for audit descriptions and
 * to distinguish real matches from phantom ones (shouldn't happen given
 * the WHERE clause, but defensive).
 */
function classifyMatch(
  identity: PilotIdentity,
  row: {
    registered_pilot_civl_id: string | null;
    registered_pilot_safa_id: string | null;
    registered_pilot_ushpa_id: string | null;
    registered_pilot_bhpa_id: string | null;
    registered_pilot_dhv_id: string | null;
    registered_pilot_ffvl_id: string | null;
    registered_pilot_fai_id: string | null;
    registered_pilot_email: string | null;
  }
): IdField | "email" | null {
  for (const field of ID_FIELDS) {
    const pilotValue = identity[field];
    const rowValue = row[`registered_pilot_${field}` as keyof typeof row];
    if (pilotValue !== null && rowValue === pilotValue) {
      return field;
    }
  }
  if (identity.email !== null && row.registered_pilot_email === identity.email) {
    return "email";
  }
  return null;
}
