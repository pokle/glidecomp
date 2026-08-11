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
 *      profile, scan ALL competitions for unlinked rows matching the
 *      updated identity. Closed comps are included deliberately: a link
 *      is a statement about identity, not a competition mutation (it
 *      never touches scores), and the "My Flights" competition-flights
 *      list is mostly about historical comps — a pilot who signs up
 *      after the season must still be able to claim their record.
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
 *   - `"all-comps"`: search every competition, closed ones included
 *     (see the header note). Used by profile updates.
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
  scope: "all-comps" | { comp_id: number }
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

  // Scope: every comp, or a specific one (the IGC-upload path).
  let compScopeSql = "";
  if (scope !== "all-comps") {
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
 * The identifier kinds a person can be asked to type to name themselves.
 *
 * Same vocabulary and same priority as the linker above, so the two never
 * drift. `name` is deliberately absent and must stay absent: two people share
 * a name, which is why neither the linker nor the resolver will auto-link on
 * one, and an anonymous caller has strictly less standing than either.
 */
export const PILOT_IDENTIFIER_KINDS = [...ID_FIELDS, "email"] as const;

export type PilotIdentifierKind = (typeof PILOT_IDENTIFIER_KINDS)[number];

export function isPilotIdentifierKind(v: string): v is PilotIdentifierKind {
  return (PILOT_IDENTIFIER_KINDS as readonly string[]).includes(v);
}

/** How each kind reads in a sentence a human is going to be shown. */
export const PILOT_IDENTIFIER_LABELS: Record<PilotIdentifierKind, string> = {
  civl_id: "CIVL ID",
  safa_id: "SAFA ID",
  ushpa_id: "USHPA ID",
  bhpa_id: "BHPA ID",
  dhv_id: "DHV ID",
  ffvl_id: "FFVL ID",
  fai_id: "FAI ID",
  email: "email address",
};

export interface CompPilotMatch {
  comp_pilot_id: number;
  registered_pilot_name: string;
  pilot_class: string;
  /** Set once the registration has been claimed by a GlideComp account. */
  pilot_id: number | null;
  /** Where to write to this pilot, preferring what the organiser registered
   * over the account address. Null when neither exists. */
  notify_email: string | null;
}

/**
 * Find the registrations in ONE competition that answer to a single typed
 * identifier — the question "who on this comp's roster is this?".
 *
 * Deliberately NOT the linker's query, though it shares its vocabulary:
 *
 *   - the linker reads only `registered_pilot_*` and only on rows nobody has
 *     claimed yet, because its job is to claim them. This has to see claimed
 *     rows too: a pilot who has an account but is at launch with no session
 *     must still be able to submit.
 *   - so it also has to look at the linked account's own identity, because
 *     once a row is claimed the ids may live on `pilot`/`user` rather than on
 *     the registration the organiser typed.
 *
 * Comparison is case-insensitive. A person typing their own email address at
 * the end of a flying day will get the case wrong, and a match that fails on
 * capitalisation reads to them as "the organiser never registered me".
 *
 * Returns every match. Deciding what to do with none, one, or several is the
 * caller's — an ambiguous roster is a thing to report, never to guess at.
 */
export async function findCompPilotsByIdentifier(
  db: D1Database,
  compId: number,
  kind: PilotIdentifierKind,
  value: string
): Promise<CompPilotMatch[]> {
  const trimmed = value.trim();
  if (trimmed === "") return [];

  // The column name comes from the ID_FIELDS whitelist via the kind union,
  // never from the request, so it cannot carry an injection.
  const condition =
    kind === "email"
      ? `(cp.registered_pilot_email = ?2 COLLATE NOCASE OR u.email = ?2 COLLATE NOCASE)`
      : `(cp.registered_pilot_${kind} = ?2 COLLATE NOCASE OR p.${kind} = ?2 COLLATE NOCASE)`;

  const rows = await db
    .prepare(
      `SELECT cp.comp_pilot_id, cp.registered_pilot_name, cp.pilot_class,
              cp.pilot_id, cp.registered_pilot_email, u.email AS account_email
       FROM comp_pilot cp
       LEFT JOIN pilot p ON p.pilot_id = cp.pilot_id
       LEFT JOIN "user" u ON u.id = p.user_id
       WHERE cp.comp_id = ?1 AND ${condition}`
    )
    .bind(compId, trimmed)
    .all<{
      comp_pilot_id: number;
      registered_pilot_name: string;
      pilot_class: string;
      pilot_id: number | null;
      registered_pilot_email: string | null;
      account_email: string | null;
    }>();

  return rows.results.map((r) => ({
    comp_pilot_id: r.comp_pilot_id,
    registered_pilot_name: r.registered_pilot_name,
    pilot_class: r.pilot_class,
    pilot_id: r.pilot_id,
    notify_email: r.registered_pilot_email ?? r.account_email ?? null,
  }));
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

// ---------------------------------------------------------------------------
// Names may propose, never dispose
// ---------------------------------------------------------------------------

/**
 * How alike two pilot names look. Higher is more alike; 0 is "nothing".
 *
 * READ THIS BEFORE USING IT. Everything else in this file refuses to match on
 * names, and that refusal is correct: two people share a name, so a name is
 * never proof of identity. This function does NOT change that rule. It exists
 * only to ORDER a list that a human is about to choose from — the pilot's own
 * likely registration first, so they are not scrolling a roster of two hundred
 * looking for themselves.
 *
 * Nothing may branch on it. The decision of whether to ASK at all is "does the
 * comp have an unclaimed registration", which involves no names whatsoever
 * (see `findUnclaimedRegistrations`). If you find yourself writing
 * `if (nameAffinity(a, b) > n)` to link, claim, or skip something, that is the
 * bug this comment is here to prevent.
 *
 *   2 — the same words in some order ("SMITH, Jane" / "jane smith" / "Müller")
 *   1 — same last word, and one first name is the other's initial ("J Smith")
 *   0 — anything else
 */
export function nameAffinity(a: string, b: string): 0 | 1 | 2 {
  const at = nameTokens(a);
  const bt = nameTokens(b);
  if (at.length === 0 || bt.length === 0) return 0;

  if (at.length === bt.length && at.every((t, i) => t === bt[i])) return 2;

  // Surname plus an initial. Compare the ORIGINAL order for this one — the
  // sorted form has already lost which token was the family name.
  const ao = nameTokensOrdered(a);
  const bo = nameTokensOrdered(b);
  if (ao.length >= 2 && bo.length >= 2) {
    const sameLast = ao[ao.length - 1] === bo[bo.length - 1];
    const initialOf = (x: string, y: string) => x.length === 1 && y.startsWith(x);
    if (sameLast && (initialOf(ao[0], bo[0]) || initialOf(bo[0], ao[0]))) return 1;
  }
  return 0;
}

/** Casefolded, de-accented, punctuation-free words, in their original order. */
function nameTokensOrdered(name: string): string[] {
  return name
    .normalize("NFD")
    // Strip combining marks so "Müller" and "Muller" are the same word. A
    // roster imported from a spreadsheet loses accents constantly.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** The same words, sorted, so "SMITH, Jane" and "Jane Smith" agree. */
function nameTokens(name: string): string[] {
  return nameTokensOrdered(name).sort();
}

/** A registration nobody has claimed yet — someone the pilot might be. */
export interface UnclaimedRegistration {
  comp_pilot_id: number;
  registered_pilot_name: string;
  pilot_class: string;
  registered_pilot_email: string | null;
}

/**
 * Every registration in this comp that no account has claimed.
 *
 * This is what makes the duplicate impossible: if the answer is non-empty, the
 * upload route asks the pilot which of these they are rather than guessing.
 * Deliberately NOT filtered by name — filtering here would mean a pilot whose
 * organiser spelled them "Mick" instead of "Michael" silently gets the
 * duplicate again, which is the whole bug.
 */
export async function findUnclaimedRegistrations(
  db: D1Database,
  compId: number
): Promise<UnclaimedRegistration[]> {
  const rows = await db
    .prepare(
      `SELECT comp_pilot_id, registered_pilot_name, pilot_class,
              registered_pilot_email
       FROM comp_pilot
       WHERE comp_id = ? AND pilot_id IS NULL
       ORDER BY registered_pilot_name`
    )
    .bind(compId)
    .all<UnclaimedRegistration>();
  return rows.results;
}

/** Most-likely-you first, then alphabetical. Ordering only — see nameAffinity. */
export function orderByLikelihood<T extends { registered_pilot_name: string }>(
  rows: T[],
  accountName: string
): T[] {
  return [...rows].sort(
    (a, b) =>
      nameAffinity(b.registered_pilot_name, accountName) -
        nameAffinity(a.registered_pilot_name, accountName) ||
      a.registered_pilot_name.localeCompare(b.registered_pilot_name)
  );
}
