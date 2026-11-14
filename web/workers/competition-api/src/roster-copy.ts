/**
 * Copying a roster from one competition into another.
 *
 * Two routes copy a roster. The clone route copies it into a competition it
 * has just made. "Copy pilots from another competition" on the pilots page
 * copies it into a roster that may already hold pilots. Both use the plan
 * here, so the two cannot disagree about who is the same pilot.
 *
 * ── What is copied ────────────────────────────────────────────────────────
 *
 * The registration: name, email, the sporting-body IDs, glider, class, team
 * and driver contact. Two fields stay behind, because each is a fact about
 * one competition and not about the pilot:
 *
 *   - the WPRS points and where they came from (migrations 0029/0030): a
 *     ranking as it stood in one month. "Fill from CIVL" refills it from the
 *     list that is current now.
 *   - the first start order: one year's launch order.
 *
 * ── Who is already on the roster ──────────────────────────────────────────
 *
 * A source pilot is skipped when the target roster already holds them: the
 * same GlideComp account, any of the same sporting-body IDs, or the same
 * email (the registered one or the linked account's). A name alone never
 * decides it: names may propose, never dispose. A copied pilot who shares a
 * name with someone already there is copied, and the plan says so, so the
 * review can point at the pair.
 *
 * ── Linking to accounts ───────────────────────────────────────────────────
 *
 * A source row that is linked to an account stays linked: the source is a
 * competition the caller administers, so this copies a link that is already
 * established. Nothing here guesses one. An unlinked row goes through the
 * same resolver as a roster import (pilot-resolver.ts: an ID, then an email,
 * never a name alone), so a pilot who has made an account since is linked.
 *
 * ── Classes and teams ─────────────────────────────────────────────────────
 *
 * A class the target competition does not have becomes the target's default
 * class, and the plan reports each such change. Team names go through
 * TeamSpellings, as every write of `team_name` does.
 *
 * ── Scores and the audit log ──────────────────────────────────────────────
 *
 * A copied pilot has no tracks, no manual flights and no statuses, so no
 * task score changes and nothing is marked stale (the bulk save treats a new
 * pilot the same way). The caller writes the audit entries:
 * `rosterCopyAudits()` gives them, in the bulk save's shape.
 */
import type { AuditEntry } from "./audit";
import { mapWithConcurrency } from "./lib/concurrency";
import { resolvePilotId } from "./pilot-resolver";
import { TeamSpellings } from "./team-name";
import { MAX_PILOTS_PER_COMP } from "./validators";

/** How many account lookups run at once (as in the bulk save). */
const RESOLVE_CONCURRENCY = 10;

/** Columns of a roster row the copy reads. */
interface RosterRow {
  comp_pilot_id: number;
  pilot_id: number | null;
  registered_pilot_name: string;
  registered_pilot_email: string | null;
  registered_pilot_civl_id: string | null;
  registered_pilot_safa_id: string | null;
  registered_pilot_ushpa_id: string | null;
  registered_pilot_bhpa_id: string | null;
  registered_pilot_dhv_id: string | null;
  registered_pilot_ffvl_id: string | null;
  registered_pilot_fai_id: string | null;
  registered_pilot_glider: string | null;
  pilot_class: string;
  team_name: string | null;
  driver_contact: string | null;
  /** The linked account's email, when the row is linked. */
  linked_email: string | null;
}

/** The sporting-body ID columns, with the words the review uses for each. */
const ID_COLUMNS = [
  ["registered_pilot_civl_id", "CIVL ID"],
  ["registered_pilot_safa_id", "SAFA ID"],
  ["registered_pilot_ushpa_id", "USHPA ID"],
  ["registered_pilot_bhpa_id", "BHPA ID"],
  ["registered_pilot_dhv_id", "DHV ID"],
  ["registered_pilot_ffvl_id", "FFVL ID"],
  ["registered_pilot_fai_id", "FAI ID"],
] as const;

/** One pilot the copy will add. */
export interface CopiedPilot {
  source: RosterRow;
  /** The account the new row is linked to, or null. */
  pilot_id: number | null;
  /** The class the new row gets (the source's, or the target's default). */
  pilot_class: string;
  /** The team as it will be stored. */
  team_name: string | null;
  /** Someone already on the target roster with the same name, if any. */
  same_name_as: string | null;
}

/** One pilot the copy leaves out, and why. */
export interface SkippedPilot {
  name: string;
  /** e.g. "Already on this roster as Jane Doe (same CIVL ID)". */
  reason: string;
}

export interface RosterCopyPlan {
  copy: CopiedPilot[];
  skip: SkippedPilot[];
  /** Classes the target does not have, and what their pilots became. */
  remapped: Array<{ from: string; to: string; count: number }>;
  /** Set when the copy cannot be applied (the roster would be too big). */
  error: string | null;
}

const ROSTER_SELECT = `SELECT cp.comp_pilot_id, cp.pilot_id, cp.registered_pilot_name,
    cp.registered_pilot_email, cp.registered_pilot_civl_id, cp.registered_pilot_safa_id,
    cp.registered_pilot_ushpa_id, cp.registered_pilot_bhpa_id, cp.registered_pilot_dhv_id,
    cp.registered_pilot_ffvl_id, cp.registered_pilot_fai_id, cp.registered_pilot_glider,
    cp.pilot_class, cp.team_name, cp.driver_contact, u.email AS linked_email
  FROM comp_pilot cp
  LEFT JOIN pilot p ON cp.pilot_id = p.pilot_id
  LEFT JOIN "user" u ON p.user_id = u.id
  WHERE cp.comp_id = ?
  ORDER BY cp.registered_pilot_name COLLATE NOCASE ASC, cp.comp_pilot_id ASC`;

async function readRoster(db: D1Database, compId: number): Promise<RosterRow[]> {
  return (await db.prepare(ROSTER_SELECT).bind(compId).all<RosterRow>()).results;
}

/** Trimmed, lower-cased, or null when blank: how two IDs or emails compare. */
function norm(value: string | null | undefined): string | null {
  const v = value?.trim().toLowerCase();
  return v ? v : null;
}

/** Every email a row answers to: its registered one and its account's. */
function emailsOf(row: RosterRow): string[] {
  return [norm(row.registered_pilot_email), norm(row.linked_email)].filter(
    (e): e is string => e !== null
  );
}

/**
 * Who on `target` is the same person as `row`, and by what, or null.
 * Account first, then the IDs, then email: the resolver's order.
 */
function sameAs(
  row: RosterRow,
  pilotId: number | null,
  target: RosterRow[]
): { name: string; by: string } | null {
  if (pilotId !== null) {
    const hit = target.find((t) => t.pilot_id === pilotId);
    if (hit) return { name: hit.registered_pilot_name, by: "same GlideComp account" };
  }
  for (const [column, label] of ID_COLUMNS) {
    const id = norm(row[column]);
    if (id === null) continue;
    const hit = target.find((t) => norm(t[column]) === id);
    if (hit) return { name: hit.registered_pilot_name, by: `same ${label}` };
  }
  const emails = emailsOf(row);
  if (emails.length > 0) {
    const hit = target.find((t) => emailsOf(t).some((e) => emails.includes(e)));
    if (hit) return { name: hit.registered_pilot_name, by: "same email" };
  }
  return null;
}

/**
 * Work out what copying `fromCompId`'s roster into `toCompId` would do,
 * against both rosters as they are now. Nothing is written.
 *
 * `toClasses`/`toDefaultClass` are the target's classes after any change
 * the caller is making in the same request (the clone route copies the
 * classes first).
 */
export async function planRosterCopy(
  db: D1Database,
  fromCompId: number,
  toCompId: number,
  toClasses: string[],
  toDefaultClass: string
): Promise<RosterCopyPlan> {
  const [source, target] = await Promise.all([
    readRoster(db, fromCompId),
    readRoster(db, toCompId),
  ]);

  // An unlinked source row may belong to someone who has made an account
  // since: the resolver links on an ID or an email, never a name alone.
  const links = await mapWithConcurrency(source, RESOLVE_CONCURRENCY, async (row) => {
    if (row.pilot_id !== null) return row.pilot_id;
    const resolved = await resolvePilotId(db, {
      name: row.registered_pilot_name,
      email: row.registered_pilot_email,
      civl_id: row.registered_pilot_civl_id,
      safa_id: row.registered_pilot_safa_id,
      ushpa_id: row.registered_pilot_ushpa_id,
      bhpa_id: row.registered_pilot_bhpa_id,
      dhv_id: row.registered_pilot_dhv_id,
      ffvl_id: row.registered_pilot_ffvl_id,
      fai_id: row.registered_pilot_fai_id,
    });
    return resolved.pilot_id;
  });

  const fallback = toClasses.includes(toDefaultClass) ? toDefaultClass : toClasses[0];
  const spellings = new TeamSpellings(target.map((t) => t.team_name));
  const targetNames = new Map(
    target.map((t) => [t.registered_pilot_name.trim().toLowerCase(), t.registered_pilot_name])
  );
  const linkedSoFar = new Map<number, string>(); // pilot_id → name, among the copied
  const remapped = new Map<string, number>();
  const plan: RosterCopyPlan = { copy: [], skip: [], remapped: [], error: null };

  source.forEach((row, i) => {
    const pilotId = links[i];
    const already = sameAs(row, pilotId, target);
    if (already) {
      plan.skip.push({
        name: row.registered_pilot_name,
        reason: `Already on this roster as ${already.name} (${already.by})`,
      });
      return;
    }
    // Two source rows for one account (the source has a pilot registered
    // twice): the second would break the one-row-per-account rule.
    if (pilotId !== null && linkedSoFar.has(pilotId)) {
      plan.skip.push({
        name: row.registered_pilot_name,
        reason: `The same GlideComp account as ${linkedSoFar.get(pilotId)}, who is copied`,
      });
      return;
    }
    if (pilotId !== null) linkedSoFar.set(pilotId, row.registered_pilot_name);

    const keepsClass = toClasses.includes(row.pilot_class);
    if (!keepsClass) remapped.set(row.pilot_class, (remapped.get(row.pilot_class) ?? 0) + 1);
    plan.copy.push({
      source: row,
      pilot_id: pilotId,
      pilot_class: keepsClass ? row.pilot_class : fallback,
      team_name: spellings.spell(row.team_name),
      same_name_as: targetNames.get(row.registered_pilot_name.trim().toLowerCase()) ?? null,
    });
  });

  plan.remapped = [...remapped.entries()].map(([from, count]) => ({
    from,
    to: fallback,
    count,
  }));
  if (target.length + plan.copy.length > MAX_PILOTS_PER_COMP) {
    plan.error =
      `This would make ${target.length + plan.copy.length} pilots. ` +
      `A competition can have at most ${MAX_PILOTS_PER_COMP}.`;
  }
  return plan;
}

const INSERT_SQL = `INSERT INTO comp_pilot (
  comp_id, pilot_id, registered_pilot_name, registered_pilot_email,
  registered_pilot_civl_id, registered_pilot_safa_id, registered_pilot_ushpa_id,
  registered_pilot_bhpa_id, registered_pilot_dhv_id, registered_pilot_ffvl_id,
  registered_pilot_fai_id, registered_pilot_glider, pilot_class, team_name, driver_contact
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * The INSERTs that apply a plan, for the caller to run in one `batch()` —
 * on its own, or with the statements that create the competition.
 * Refuses a plan that carries an error.
 */
export function rosterCopyStatements(
  db: D1Database,
  toCompId: number,
  plan: RosterCopyPlan
): D1PreparedStatement[] {
  if (plan.error) throw new Error(plan.error);
  return plan.copy.map((p) =>
    db
      .prepare(INSERT_SQL)
      .bind(
        toCompId,
        p.pilot_id,
        p.source.registered_pilot_name,
        p.source.registered_pilot_email,
        p.source.registered_pilot_civl_id,
        p.source.registered_pilot_safa_id,
        p.source.registered_pilot_ushpa_id,
        p.source.registered_pilot_bhpa_id,
        p.source.registered_pilot_dhv_id,
        p.source.registered_pilot_ffvl_id,
        p.source.registered_pilot_fai_id,
        p.source.registered_pilot_glider,
        p.pilot_class,
        p.team_name,
        p.source.driver_contact
      )
  );
}

/** "sport became open for 3 pilots; tandem became open for 1 pilot". */
function remapWords(plan: RosterCopyPlan): string {
  return plan.remapped
    .map((r) => `class ${r.from} became ${r.to} for ${r.count} pilot${r.count === 1 ? "" : "s"}`)
    .join("; ");
}

/**
 * The audit entries for an applied copy: one per pilot up to five, then a
 * single summary line, as the bulk save does.
 */
export function rosterCopyAudits(plan: RosterCopyPlan, fromCompName: string): AuditEntry[] {
  const n = plan.copy.length;
  if (n === 0) return [];
  const remap = plan.remapped.length > 0 ? `; ${remapWords(plan)}` : "";
  if (n <= 5) {
    return plan.copy.map((p) => ({
      subject_type: "pilot" as const,
      subject_id: null,
      subject_name: p.source.registered_pilot_name,
      description:
        `Copied pilot "${p.source.registered_pilot_name}" from "${fromCompName}" ` +
        (p.pilot_class !== p.source.pilot_class
          ? `(class: ${p.pilot_class}, was ${p.source.pilot_class})`
          : `(class: ${p.pilot_class})`),
    }));
  }
  return [
    {
      subject_type: "pilot" as const,
      subject_id: null,
      subject_name: null,
      description: `Copied ${n} pilots from "${fromCompName}"${remap}`,
    },
  ];
}

/** The plan as the API returns it: what the review page lists. */
export function serializeRosterCopyPlan(plan: RosterCopyPlan) {
  return {
    copy: plan.copy.map((p) => ({
      name: p.source.registered_pilot_name,
      pilot_class: p.pilot_class,
      team_name: p.team_name,
      linked: p.pilot_id !== null,
      same_name_as: p.same_name_as,
    })),
    skip: plan.skip,
    remapped: plan.remapped,
    error: plan.error,
  };
}
