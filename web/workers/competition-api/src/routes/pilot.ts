import { Hono } from "hono";
import type { AuthedEnv } from "../env";
import { encodeId, decodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import { hiddenFromViewer } from "../comp-visibility";
import {
  updatePilotSchema,
  updateCompPilotSchema,
  createCompPilotSchema,
  bulkPilotsSchema,
  civlRankingLookupSchema,
  validated,
} from "../validators";
import { matchRoster, type RankedEntry } from "../civl-ranking-match";
import { resolvePilotId, type MatchedBy } from "../pilot-resolver";
import { linkExistingRegistrations } from "../pilot-linker";
import { audit, auditAll, describeChange, describePrivateChange } from "../audit";
import { mapWithConcurrency } from "../lib/concurrency";
import { bumpAndRevalidateScores, taskIdsForPilots } from "../score-store";
import { deleteTrackFiles, trackFileKeysForPilots } from "../track-files";
import { TeamSpellings, rosterTeamNames } from "../team-name";

/** How many pilot-link lookups to run at once on a bulk roster import. */
const PILOT_RESOLVE_CONCURRENCY = 10;

const MAX_PILOTS_PER_COMP = 250;

/**
 * Values per statement in the CIVL ranking lookup. D1 rejects a statement with
 * more than 100 bound parameters ("too many SQL variables"), and a full roster
 * carries 250 names and 250 ids — so the IN lists are chunked, comfortably
 * under the limit.
 */
const LOOKUP_CHUNK = 90;

/** Split into runs of at most `size`. Empty in, empty out (no empty IN list). */
function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

/**
 * Each list we hold, mapped to its newest snapshot date.
 *
 * The importer writes a new month before deleting the old one (migration
 * 0025), so the table transiently holds two for a list. Every reader has to
 * drop the outgoing month, or a pilot's best rank could be one they no longer
 * hold — which is exactly the sort of number nobody could reproduce later.
 */
async function latestSnapshots(db: D1Database): Promise<Map<string, string>> {
  const rows = await db
    .prepare(
      `SELECT ranking_slug, MAX(ranking_date) AS ranking_date
         FROM pilot_ranking GROUP BY ranking_slug`
    )
    .all<{ ranking_slug: string; ranking_date: string }>();
  return new Map(rows.results.map((r) => [r.ranking_slug, r.ranking_date]));
}

/**
 * Ranked rows that could match this roster, from every list at once.
 *
 * Chunked because D1 allows at most 100 bound parameters per statement and a
 * full roster is 250 names plus 250 ids; the whole batch is still one round
 * trip. Rows outside a list's latest snapshot are dropped here, and a row
 * fetched twice (a pilot matched by BOTH their id and their name) is
 * de-duplicated on the table's own unique key — left in, it would read as two
 * ranked pilots and the matcher would refuse a perfectly good name.
 */
async function rankedCandidates(
  db: D1Database,
  opts: { names: string[]; ids: string[]; lists: Map<string, string> }
): Promise<RankedEntry[]> {
  const sql = (column: string, count: number) =>
    `SELECT ranking_slug, ranking_name, ranking_date, "rank", points, civl_id, pilot_name
     FROM pilot_ranking
     WHERE ${column} IN (${Array(count).fill("?").join(",")})`;
  const statements = [
    ...chunk(opts.ids, LOOKUP_CHUNK).map((values) =>
      db.prepare(sql("civl_id", values.length)).bind(...values)
    ),
    ...chunk(opts.names, LOOKUP_CHUNK).map((values) =>
      db.prepare(sql("pilot_name COLLATE NOCASE", values.length)).bind(...values)
    ),
  ];
  if (statements.length === 0) return [];

  const batched = await db.batch<RankedEntry>(statements);
  const seen = new Set<string>();
  const entries: RankedEntry[] = [];
  for (const row of batched.flatMap((r) => r.results)) {
    if (opts.lists.get(row.ranking_slug) !== row.ranking_date) continue;
    const key = `${row.ranking_slug}|${row.civl_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(row);
  }
  return entries;
}

const COMP_PILOT_COLUMNS = [
  "cp.comp_pilot_id",
  "cp.comp_id",
  "cp.pilot_id",
  "cp.registered_pilot_name",
  "cp.registered_pilot_email",
  "cp.registered_pilot_civl_id",
  "cp.registered_pilot_safa_id",
  "cp.registered_pilot_ushpa_id",
  "cp.registered_pilot_bhpa_id",
  "cp.registered_pilot_dhv_id",
  "cp.registered_pilot_ffvl_id",
  "cp.registered_pilot_fai_id",
  "cp.registered_pilot_glider",
  "cp.pilot_class",
  "cp.team_name",
  "cp.driver_contact",
  "cp.wprs_points",
  "cp.civl_ranking_slug",
  "cp.civl_ranking_date",
  "cp.first_start_order",
] as const;

/**
 * How many tracks a roster row holds, as a column of the row's own SELECT.
 *
 * Removing a pilot deletes their tracks with them (the cascade, plus
 * deleteTrackFiles), so an editor that offers Remove needs this number to say
 * what Remove costs. Served by idx_task_track_by_pilot (migration 0020).
 */
const TRACK_COUNT_COLUMN =
  "(SELECT COUNT(*) FROM task_track tt WHERE tt.comp_pilot_id = cp.comp_pilot_id) AS track_count";

interface CompPilotRow {
  comp_pilot_id: number;
  comp_id: number;
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
  wprs_points: number | null;
  civl_ranking_slug: string | null;
  civl_ranking_date: string | null;
  first_start_order: number | null;
  /** Present when the SELECT included TRACK_COUNT_COLUMN. */
  track_count?: number;
}

function serializeCompPilot(
  alphabet: string,
  row: CompPilotRow & { linked_email?: string | null; linked_username?: string | null }
) {
  return {
    comp_pilot_id: encodeId(alphabet, row.comp_pilot_id),
    linked: row.pilot_id !== null,
    linked_email: row.linked_email ?? null,
    linked_username: row.linked_username ?? null,
    name: row.registered_pilot_name,
    email: row.registered_pilot_email,
    civl_id: row.registered_pilot_civl_id,
    safa_id: row.registered_pilot_safa_id,
    ushpa_id: row.registered_pilot_ushpa_id,
    bhpa_id: row.registered_pilot_bhpa_id,
    dhv_id: row.registered_pilot_dhv_id,
    ffvl_id: row.registered_pilot_ffvl_id,
    fai_id: row.registered_pilot_fai_id,
    glider: row.registered_pilot_glider,
    pilot_class: row.pilot_class,
    team_name: row.team_name,
    driver_contact: row.driver_contact,
    // The WPRS score the organiser is running this comp off, plus where it
    // came from. Both source fields are null when the number was typed in by
    // hand — that difference is what the roster renders as "set by organiser",
    // so it must survive the round trip.
    wprs_points: row.wprs_points,
    civl_ranking_slug: row.civl_ranking_slug,
    civl_ranking_date: row.civl_ranking_date,
    first_start_order: row.first_start_order,
    track_count: row.track_count ?? 0,
  };
}

/**
 * Public serialiser for the read-only pilot list. SEC-15: the admin-only
 * fields are PII (admin-entered email, Better Auth account email, and the
 * emergency-contact phone in `driver_contact`). National-body IDs and
 * glider model are left in — they are intentionally public on every comp
 * results page and the public table column-renders `civl_id` / `safa_id`.
 *
 * Returns the same key set as `serializeCompPilot` so the frontend type
 * stays valid; redacted fields are emitted as `null`.
 */
function serializeCompPilotPublic(
  alphabet: string,
  row: CompPilotRow & { linked_email?: string | null; linked_username?: string | null }
) {
  const full = serializeCompPilot(alphabet, row);
  full.email = null;
  full.linked_email = null;
  full.linked_username = null;
  full.driver_contact = null;
  return full;
}

// Fields that both INSERT and UPDATE touch. Kept in lockstep with
// buildInsertValues / buildUpdateValues and the SQL templates below.
const COMP_PILOT_WRITE_COLUMNS = [
  "pilot_id",
  "registered_pilot_name",
  "registered_pilot_email",
  "registered_pilot_civl_id",
  "registered_pilot_safa_id",
  "registered_pilot_ushpa_id",
  "registered_pilot_bhpa_id",
  "registered_pilot_dhv_id",
  "registered_pilot_ffvl_id",
  "registered_pilot_fai_id",
  "registered_pilot_glider",
  "pilot_class",
  "team_name",
  "driver_contact",
  "wprs_points",
  "civl_ranking_slug",
  "civl_ranking_date",
  "first_start_order",
] as const;

interface WritableFields {
  registered_pilot_name: string;
  registered_pilot_email?: string | null;
  registered_pilot_civl_id?: string | null;
  registered_pilot_safa_id?: string | null;
  registered_pilot_ushpa_id?: string | null;
  registered_pilot_bhpa_id?: string | null;
  registered_pilot_dhv_id?: string | null;
  registered_pilot_ffvl_id?: string | null;
  registered_pilot_fai_id?: string | null;
  registered_pilot_glider?: string | null;
  pilot_class: string;
  team_name?: string | null;
  driver_contact?: string | null;
  wprs_points?: number | null;
  civl_ranking_slug?: string | null;
  civl_ranking_date?: string | null;
  first_start_order?: number | null;
}

const INSERT_COMP_PILOT_SQL = `INSERT INTO comp_pilot (
  comp_id, ${COMP_PILOT_WRITE_COLUMNS.join(", ")}
) VALUES (?, ${COMP_PILOT_WRITE_COLUMNS.map(() => "?").join(", ")})`;

const UPDATE_COMP_PILOT_SQL = `UPDATE comp_pilot SET ${COMP_PILOT_WRITE_COLUMNS
  .map((c) => `${c} = ?`)
  .join(", ")} WHERE comp_pilot_id = ? AND comp_id = ?`;

function buildInsertValues(
  compId: number,
  pilotId: number | null,
  row: WritableFields
): unknown[] {
  return [
    compId,
    pilotId,
    row.registered_pilot_name,
    row.registered_pilot_email ?? null,
    row.registered_pilot_civl_id ?? null,
    row.registered_pilot_safa_id ?? null,
    row.registered_pilot_ushpa_id ?? null,
    row.registered_pilot_bhpa_id ?? null,
    row.registered_pilot_dhv_id ?? null,
    row.registered_pilot_ffvl_id ?? null,
    row.registered_pilot_fai_id ?? null,
    row.registered_pilot_glider ?? null,
    row.pilot_class,
    row.team_name ?? null,
    row.driver_contact ?? null,
    row.wprs_points ?? null,
    row.civl_ranking_slug ?? null,
    row.civl_ranking_date ?? null,
    row.first_start_order ?? null,
  ];
}

function buildUpdateValues(
  pilotId: number | null,
  row: WritableFields,
  compPilotId: number,
  compId: number
): unknown[] {
  return [
    pilotId,
    row.registered_pilot_name,
    row.registered_pilot_email ?? null,
    row.registered_pilot_civl_id ?? null,
    row.registered_pilot_safa_id ?? null,
    row.registered_pilot_ushpa_id ?? null,
    row.registered_pilot_bhpa_id ?? null,
    row.registered_pilot_dhv_id ?? null,
    row.registered_pilot_ffvl_id ?? null,
    row.registered_pilot_fai_id ?? null,
    row.registered_pilot_glider ?? null,
    row.pilot_class,
    row.team_name ?? null,
    row.driver_contact ?? null,
    row.wprs_points ?? null,
    row.civl_ranking_slug ?? null,
    row.civl_ranking_date ?? null,
    row.first_start_order ?? null,
    compPilotId,
    compId,
  ];
}

async function fetchCompPilot(
  db: D1Database,
  compPilotId: number
): Promise<
  (CompPilotRow & { linked_email: string | null; linked_username: string | null }) | null
> {
  return db
    .prepare(
      `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, ${TRACK_COUNT_COLUMN}, u.email AS linked_email, u.username AS linked_username
       FROM comp_pilot cp
       LEFT JOIN pilot p ON cp.pilot_id = p.pilot_id
       LEFT JOIN "user" u ON p.user_id = u.id
       WHERE cp.comp_pilot_id = ?`
    )
    .bind(compPilotId)
    .first<CompPilotRow & { linked_email: string | null; linked_username: string | null }>();
}

/**
 * The roster fields an account link can be resolved from. The name is not one
 * of them: the resolver never links on a name alone, so a name can neither
 * make a link nor undo one.
 */
const LINK_IDENTITY_FIELDS = [
  "registered_pilot_email",
  "registered_pilot_civl_id",
  "registered_pilot_safa_id",
  "registered_pilot_ushpa_id",
  "registered_pilot_bhpa_id",
  "registered_pilot_dhv_id",
  "registered_pilot_ffvl_id",
  "registered_pilot_fai_id",
] as const;

type LinkIdentity = Pick<WritableFields, "registered_pilot_name" | (typeof LINK_IDENTITY_FIELDS)[number]>;

function resolverFields(row: LinkIdentity) {
  return {
    name: row.registered_pilot_name,
    email: row.registered_pilot_email ?? null,
    civl_id: row.registered_pilot_civl_id ?? null,
    safa_id: row.registered_pilot_safa_id ?? null,
    ushpa_id: row.registered_pilot_ushpa_id ?? null,
    bhpa_id: row.registered_pilot_bhpa_id ?? null,
    dhv_id: row.registered_pilot_dhv_id ?? null,
    ffvl_id: row.registered_pilot_ffvl_id ?? null,
    fai_id: row.registered_pilot_fai_id ?? null,
  };
}

/**
 * Which GlideComp account a roster row is linked to once it holds `next`.
 *
 * Shared by the single-pilot PATCH and the bulk save, which used to decide
 * this differently and both got it wrong. A row can be linked in three ways:
 * the resolver matched the organiser's email or ID (pilot-resolver.ts), the
 * pilot claimed the row themselves when uploading (`claimed-by-choice` in
 * routes/igc.ts), or the pilot joined through open registration and the row
 * was created already linked. The last two leave the organiser's identity
 * columns untouched — a self-registered row has no email at all — so the
 * resolver cannot explain them, and re-running it is not evidence against
 * them. Bulk save re-ran it on every row, every time, and so unlinked every
 * self-registered pilot whenever an organiser saved the roster. Their next
 * upload then asked them which registration was theirs — about a row they had
 * made themselves — and "none of these" would have registered them twice.
 *
 * An unlinked row whose identity is unchanged is not re-resolved either. An
 * account that turns up later finds its rows itself: linkExistingRegistrations
 * runs when the pilot saves their profile and when they upload.
 *
 * So:
 *   - An edit that leaves the identity alone leaves the link alone.
 *   - An identity that now matches an account links to it — the organiser's
 *     email or ID naming a different pilot is the way a wrong link is fixed.
 *   - An identity that matches nobody drops the link only if the OLD identity
 *     is what made it. That keeps "I typed the wrong email, and it linked to
 *     the wrong person" fixable, without letting an organiser adding a SAFA
 *     number undo a pilot's own claim.
 *
 * `before` is null for a row being created.
 */
async function nextPilotLink(
  db: D1Database,
  before: (LinkIdentity & { pilot_id: number | null }) | null,
  next: LinkIdentity
): Promise<number | null> {
  // Blank and absent are the same fact: the column is empty either way.
  const same = (a: string | null | undefined, b: string | null | undefined) =>
    (a || null) === (b || null);
  if (before && LINK_IDENTITY_FIELDS.every((f) => same(before[f], next[f]))) {
    return before.pilot_id;
  }

  const resolved = (await resolvePilotId(db, resolverFields(next))).pilot_id;
  if (resolved !== null || before === null || before.pilot_id === null) {
    return resolved;
  }

  const madeByOldIdentity =
    (await resolvePilotId(db, resolverFields(before))).pilot_id === before.pilot_id;
  return madeByOldIdentity ? null : before.pilot_id;
}

/** What the resolver matched on, as the request field and the words for it. */
const MATCHED_FIELD: Record<NonNullable<MatchedBy>, { field: string; noun: string }> = {
  email: { field: "registered_pilot_email", noun: "email" },
  civl_id: { field: "registered_pilot_civl_id", noun: "CIVL ID" },
  safa_id: { field: "registered_pilot_safa_id", noun: "SAFA ID" },
  ushpa_id: { field: "registered_pilot_ushpa_id", noun: "USHPA ID" },
  bhpa_id: { field: "registered_pilot_bhpa_id", noun: "BHPA ID" },
  dhv_id: { field: "registered_pilot_dhv_id", noun: "DHV ID" },
  ffvl_id: { field: "registered_pilot_ffvl_id", noun: "FFVL ID" },
  fai_id: { field: "registered_pilot_fai_id", noun: "FAI ID" },
};

/**
 * The refusal for a row whose email or ID belongs to a pilot already on the
 * roster: who they are, and which field said so — so the form can put it
 * under that field ("Tushar Pokle is already registered with this email.")
 * instead of leaving the organiser to work out which of eight fields it means.
 */
async function alreadyRegistered(
  db: D1Database,
  compId: number,
  pilotId: number,
  matchedBy: MatchedBy,
  exceptCompPilotId: number | null = null
): Promise<{ error: string; field?: string }> {
  const row = await db
    .prepare(
      `SELECT registered_pilot_name FROM comp_pilot
        WHERE comp_id = ? AND pilot_id = ? AND comp_pilot_id IS NOT ?`
    )
    .bind(compId, pilotId, exceptCompPilotId)
    .first<{ registered_pilot_name: string }>();
  const who = row?.registered_pilot_name ?? "This pilot";
  const matched = matchedBy ? MATCHED_FIELD[matchedBy] : null;
  return matched
    ? { error: `${who} is already registered with this ${matched.noun}.`, field: matched.field }
    : { error: `${who} is already registered in this competition.` };
}

export const pilotRoutes = new Hono<AuthedEnv>()
  // ── GET /api/comp/pilot ── Get current user's pilot profile
  // (literal path — must be registered before /api/comp/:comp_id/pilot)
  // ── GET /api/comp/:comp_id/pilot ── List registered pilots for a comp
  .get(
    "/api/comp/:comp_id/pilot",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT comp_id, test, share_key FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number; share_key: string | null }>();

      if (!comp) {
        return c.json({ error: "Not found" }, 404);
      }

      // A hidden comp opens for its admins and for whoever holds its link.
      if (
        await hiddenFromViewer(c.env.DB, compId, comp, user, c.var.ids.comp_key)
      ) {
        return c.json({ error: "Not found" }, 404);
      }

      // SEC-15: PII (admin-entered email, linked Better Auth email,
      // driver_contact phone) must only be returned to a comp admin — on a
      // hidden comp too, where a share-link visitor reads the same redacted
      // roster as the public does on a published one. Names/IDs/classes stay
      // visible; the PII fields go via `serializeCompPilotPublic`.
      const isAdmin = await isCompAdmin(c.env.DB, compId, user);

      const pilots = await c.env.DB.prepare(
        `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, ${TRACK_COUNT_COLUMN}, u.email AS linked_email, u.username AS linked_username
         FROM comp_pilot cp
         LEFT JOIN pilot p ON cp.pilot_id = p.pilot_id
         LEFT JOIN "user" u ON p.user_id = u.id
         WHERE cp.comp_id = ?
         ORDER BY cp.registered_pilot_name COLLATE NOCASE ASC`
      )
        .bind(compId)
        .all<CompPilotRow & { linked_email: string | null; linked_username: string | null }>();

      const serialize = isAdmin ? serializeCompPilot : serializeCompPilotPublic;
      return c.json({
        pilots: pilots.results.map((p) => serialize(alphabet, p)),
      });
    }
  )

  // ── POST /api/comp/:comp_id/pilot ── Admin: create a single pilot
  .post(
    "/api/comp/:comp_id/pilot",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", createCompPilotSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      // Validate pilot_class
      const comp = await c.env.DB.prepare(
        "SELECT pilot_classes FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ pilot_classes: string }>();
      if (!comp) return c.json({ error: "Competition not found" }, 404);

      const compClasses = JSON.parse(comp.pilot_classes) as string[];
      if (!compClasses.includes(body.pilot_class)) {
        return c.json(
          {
            error: `Invalid pilot class. Must be one of: ${compClasses.join(", ")}`,
          },
          400
        );
      }

      // Enforce 250 pilots per comp cap
      const countRow = await c.env.DB.prepare(
        "SELECT COUNT(*) AS cnt FROM comp_pilot WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ cnt: number }>();
      if (countRow && countRow.cnt >= MAX_PILOTS_PER_COMP) {
        return c.json(
          { error: `Maximum ${MAX_PILOTS_PER_COMP} pilots per competition` },
          400
        );
      }

      // Attempt to link to an existing pilot
      const resolved = await resolvePilotId(c.env.DB, {
        name: body.registered_pilot_name,
        email: body.registered_pilot_email,
        civl_id: body.registered_pilot_civl_id,
        safa_id: body.registered_pilot_safa_id,
        ushpa_id: body.registered_pilot_ushpa_id,
        bhpa_id: body.registered_pilot_bhpa_id,
        dhv_id: body.registered_pilot_dhv_id,
        ffvl_id: body.registered_pilot_ffvl_id,
        fai_id: body.registered_pilot_fai_id,
      });

      // Guard against linking to a pilot already registered in this comp
      if (resolved.pilot_id !== null) {
        const dupe = await c.env.DB.prepare(
          "SELECT comp_pilot_id FROM comp_pilot WHERE comp_id = ? AND pilot_id = ?"
        )
          .bind(compId, resolved.pilot_id)
          .first();
        if (dupe) {
          return c.json(
            await alreadyRegistered(c.env.DB, compId, resolved.pilot_id, resolved.matched_by),
            409
          );
        }
      }

      // A team goes in under the spelling the roster already uses for it.
      const team_name = new TeamSpellings(await rosterTeamNames(c.env.DB, compId)).spell(
        body.team_name
      );
      const insertValues = buildInsertValues(compId, resolved.pilot_id, { ...body, team_name });
      const res = await c.env.DB.prepare(INSERT_COMP_PILOT_SQL)
        .bind(...insertValues)
        .run();

      const newCompPilotId = res.meta.last_row_id;

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "pilot",
        subject_id: newCompPilotId,
        subject_name: body.registered_pilot_name,
        description: resolved.pilot_id
          ? `Registered pilot "${body.registered_pilot_name}" (class: ${body.pilot_class}, linked to existing account)`
          : `Registered pilot "${body.registered_pilot_name}" (class: ${body.pilot_class})`,
      });

      const row = await fetchCompPilot(c.env.DB, newCompPilotId);
      return c.json(serializeCompPilot(alphabet, row!), 201);
    }
  )

  // ── POST /api/comp/:comp_id/pilot/bulk ── Admin: bulk upsert pilots
  .post(
    "/api/comp/:comp_id/pilot/bulk",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", bulkPilotsSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const { pilots, remove } = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT pilot_classes FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ pilot_classes: string }>();
      if (!comp) return c.json({ error: "Competition not found" }, 404);
      const compClasses = JSON.parse(comp.pilot_classes) as string[];

      // The rows the caller asked to remove, decoded once. Undefined is the
      // older whole-roster contract (see bulkPilotsSchema).
      let removeIds: Set<number> | undefined;
      if (remove !== undefined) {
        removeIds = new Set();
        for (const sqid of remove) {
          const id = decodeId(alphabet, sqid);
          if (id === null) {
            return c.json({ error: `Invalid comp_pilot_id in remove: ${sqid}` }, 400);
          }
          removeIds.add(id);
        }
      }

      // Decode every row's id ONCE, up front, into a plan that says what each
      // row IS. Everything downstream — the delete set, the score-affected
      // set, the statements, the audit — reads the plan rather than decoding
      // the same sqid again behind another `!`, which is how the handler used
      // to do it six times per row.
      type PlannedRow =
        | { kind: "update"; index: number; id: number; row: (typeof pilots)[number] }
        | { kind: "insert"; index: number; row: (typeof pilots)[number] };

      const errors: { index: number; error: string }[] = [];
      const planned: PlannedRow[] = [];
      const idsSeen = new Set<number>();

      // Validate every row up front. Return all errors at once so the admin
      // can fix them in one pass.
      for (const [index, row] of pilots.entries()) {
        if (!compClasses.includes(row.pilot_class)) {
          errors.push({
            index,
            error: `Invalid pilot class "${row.pilot_class}". Must be one of: ${compClasses.join(", ")}`,
          });
          continue;
        }
        if (!row.comp_pilot_id) {
          planned.push({ kind: "insert", index, row });
          continue;
        }
        const id = decodeId(alphabet, row.comp_pilot_id);
        if (id === null) {
          errors.push({ index, error: "Invalid comp_pilot_id" });
          continue;
        }
        if (idsSeen.has(id)) {
          errors.push({ index, error: "Duplicate comp_pilot_id in payload" });
          continue;
        }
        if (removeIds?.has(id)) {
          errors.push({ index, error: "The same pilot is both updated and removed" });
          continue;
        }
        idsSeen.add(id);
        planned.push({ kind: "update", index, id, row });
      }

      if (errors.length > 0) {
        return c.json({ errors }, 400);
      }

      // Load current state: existing comp_pilot rows for this comp.
      const existingRows = await c.env.DB.prepare(
        `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, NULL AS linked_email
         FROM comp_pilot cp
         WHERE cp.comp_id = ?`
      )
        .bind(compId)
        .all<CompPilotRow & { linked_email: null }>();

      const existingById = new Map<number, CompPilotRow>(
        existingRows.results.map((row) => [row.comp_pilot_id, row])
      );

      for (const p of planned) {
        if (p.kind === "update" && !existingById.has(p.id)) {
          errors.push({
            index: p.index,
            error: "comp_pilot_id does not exist in this competition",
          });
        }
      }
      if (errors.length > 0) {
        return c.json({ errors }, 400);
      }

      const updatedIds = new Set(
        planned.flatMap((p) => (p.kind === "update" ? [p.id] : []))
      );
      // Who goes. With a `remove` list, exactly the rows it names — and only
      // those still here: a pilot another organiser already removed is gone,
      // which is what was asked. Without one, the older contract: every row
      // the payload does not mention.
      //
      // The older contract is the reason `remove` exists. It deletes rows the
      // caller never saw — a pilot who joined through open registration while
      // an organiser had the editor open was deleted by that organiser's next
      // save, and their tracks with them.
      const toDelete = removeIds
        ? [...removeIds].filter((id) => existingById.has(id))
        : [...existingById.keys()].filter((id) => !updatedIds.has(id));
      const deleting = new Set(toDelete);

      // Teams go in under the spelling the roster already uses — the roster
      // as this save leaves it, so the rows it rewrites can rename a team
      // (an import that corrects "alpha" to "Alpha" for all five members),
      // and two new rows spelling one new team two ways become one team.
      const spellings = new TeamSpellings(
        existingRows.results
          .filter((r) => !updatedIds.has(r.comp_pilot_id) && !deleting.has(r.comp_pilot_id))
          .map((r) => r.team_name)
      );
      for (const p of planned) {
        if (p.row.team_name !== undefined) {
          p.row = { ...p.row, team_name: spellings.spell(p.row.team_name) };
        }
      }

      // Resolve linking for each row that needs one. Each resolution is an
      // independent D1 read, so they overlap rather than queueing: a 250-row
      // roster paste used to be 250 strictly serialized round trips.
      const resolvedPilotIds = await mapWithConcurrency(
        planned,
        PILOT_RESOLVE_CONCURRENCY,
        async (p) =>
          nextPilotLink(
            c.env.DB,
            p.kind === "update" ? existingById.get(p.id)! : null,
            p.row
          )
      );

      // Enforce the partial unique index: no two rows may end up linked to
      // the same pilot. That includes the rows this save leaves alone, which
      // only exist under a `remove` list — the older contract deletes them.
      const untouchedByPilot = new Map<number, string>(); // pilot_id → name
      for (const row of existingById.values()) {
        if (row.pilot_id === null) continue;
        if (updatedIds.has(row.comp_pilot_id) || deleting.has(row.comp_pilot_id)) continue;
        untouchedByPilot.set(row.pilot_id, row.registered_pilot_name);
      }
      const linkedSeen = new Map<number, number>(); // pilot_id → row index
      for (const [i, pilotId] of resolvedPilotIds.entries()) {
        if (pilotId === null) continue;
        const untouched = untouchedByPilot.get(pilotId);
        if (untouched !== undefined) {
          errors.push({
            index: planned[i].index,
            error: `Resolved to the same pilot as "${untouched}", who is already registered`,
          });
          continue;
        }
        const first = linkedSeen.get(pilotId);
        if (first !== undefined) {
          errors.push({
            index: planned[i].index,
            error: `Two rows resolved to the same pilot (also row ${first})`,
          });
        } else {
          linkedSeen.set(pilotId, planned[i].index);
        }
      }
      if (errors.length > 0) {
        return c.json({ errors }, 400);
      }

      // Enforce cap on post-write size
      const inserts = planned.filter((p) => p.kind === "insert").length;
      const finalSize = existingById.size - toDelete.length + inserts;
      if (finalSize > MAX_PILOTS_PER_COMP) {
        return c.json(
          { error: `Maximum ${MAX_PILOTS_PER_COMP} pilots per competition` },
          400
        );
      }

      // Scores embed each pilot's name and class, and deleting a pilot
      // cascade-deletes their tracks — resolve which tasks that touches
      // BEFORE the batch runs (the cascade removes the task_track rows this
      // looks at), then mark them stale after it commits. A new pilot has no
      // tracks yet, so only updates that move a name or class count.
      const scoreAffectedTaskIds = await taskIdsForPilots(c.env.DB, [
        ...toDelete,
        ...planned.flatMap((p) => {
          if (p.kind !== "update") return [];
          const old = existingById.get(p.id)!;
          return old.registered_pilot_name !== p.row.registered_pilot_name ||
            old.pilot_class !== p.row.pilot_class
            ? [p.id]
            : [];
        }),
      ]);

      // Build the batch. All statements execute atomically in D1.batch().
      const statements: D1PreparedStatement[] = [
        ...toDelete.map((id) =>
          c.env.DB.prepare(
            "DELETE FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?"
          ).bind(id, compId)
        ),
        ...planned.map((p, i) =>
          p.kind === "update"
            ? c.env.DB.prepare(UPDATE_COMP_PILOT_SQL).bind(
                ...buildUpdateValues(resolvedPilotIds[i], p.row, p.id, compId)
              )
            : c.env.DB.prepare(INSERT_COMP_PILOT_SQL).bind(
                ...buildInsertValues(compId, resolvedPilotIds[i], p.row)
              )
        ),
      ];

      // The removed pilots' track files, named before the cascade drops the
      // rows that point at them.
      const trackKeys = await trackFileKeysForPilots(c.env.DB, toDelete);

      if (statements.length > 0) {
        await c.env.DB.batch(statements);
      }
      await deleteTrackFiles(c.env.R2, trackKeys);

      await bumpAndRevalidateScores(c, scoreAffectedTaskIds);

      // Audit: one per change up to 5 total, otherwise a single rollup.
      const updates = planned.length - inserts;
      const totalChanges = planned.length + toDelete.length;
      if (totalChanges > 0) {
        await auditAll(
          c.env.DB,
          c.var.user,
          compId,
          totalChanges <= 5
            ? [
                ...planned.map((p) => ({
                  subject_type: "pilot" as const,
                  subject_id: p.kind === "update" ? p.id : null,
                  subject_name: p.row.registered_pilot_name,
                  description:
                    p.kind === "update"
                      ? `Updated pilot "${p.row.registered_pilot_name}"`
                      : `Registered pilot "${p.row.registered_pilot_name}" (class: ${p.row.pilot_class})`,
                })),
                ...toDelete.map((id) => ({
                  subject_type: "pilot" as const,
                  subject_id: id,
                  subject_name: existingById.get(id)!.registered_pilot_name,
                  description: `Removed pilot "${existingById.get(id)!.registered_pilot_name}"`,
                })),
              ]
            : [
                {
                  subject_type: "pilot" as const,
                  subject_id: null,
                  subject_name: null,
                  description: `Bulk pilot update: ${[
                    inserts > 0 ? `${inserts} added` : null,
                    updates > 0 ? `${updates} updated` : null,
                    toDelete.length > 0 ? `${toDelete.length} removed` : null,
                  ]
                    .filter(Boolean)
                    .join(", ")}`,
                },
              ]
        );
      }

      // Return the new state of all pilots in the comp.
      const after = await c.env.DB.prepare(
        `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, ${TRACK_COUNT_COLUMN}, u.email AS linked_email, u.username AS linked_username
         FROM comp_pilot cp
         LEFT JOIN pilot p ON cp.pilot_id = p.pilot_id
         LEFT JOIN "user" u ON p.user_id = u.id
         WHERE cp.comp_id = ?
         ORDER BY cp.registered_pilot_name COLLATE NOCASE ASC`
      )
        .bind(compId)
        .all<CompPilotRow & { linked_email: string | null; linked_username: string | null }>();

      return c.json({
        pilots: after.results.map((p) => serializeCompPilot(alphabet, p)),
        deleted: toDelete.length,
        total: after.results.length,
      });
    }
  )

  // ── POST /api/comp/:comp_id/pilot/civl-rankings ── Admin: what the CIVL
  // world ranking lists say about this roster.
  //
  // A read that takes a body, because what it reads about is the roster
  // sitting UNSAVED in the editor's grid: an organiser types names and ids,
  // then asks what the rankings make of them. Answering from the stored roster
  // instead would answer about a state they are in the middle of leaving.
  //
  // Every list we hold is returned, matched or not, so the picker can show
  // "0 of 24" for the wrong discipline rather than hiding it.
  .post(
    "/api/comp/:comp_id/pilot/civl-rankings",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", civlRankingLookupSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const roster = c.req.valid("json").pilots;
      if (roster.length === 0) {
        return c.json({ matches: {}, matched_count: 0, rankable_count: 0 });
      }

      // The catalogue first: one row per list, at its latest snapshot. The
      // table transiently holds two months for a list (the importer writes the
      // new one before deleting the old — migration 0025), so "latest" is a
      // MAX, not an assumption. It is also how the outgoing month's rows are
      // kept out of a pilot's best rank.
      const lists = await latestSnapshots(c.env.DB);
      if (lists.size === 0) {
        return c.json({ matches: {}, matched_count: 0, rankable_count: 0 });
      }

      const entries = await rankedCandidates(c.env.DB, {
        names: [...new Set(roster.map((p) => p.name.trim()).filter(Boolean))],
        ids: [...new Set(roster.flatMap((p) => (p.civl_id ? [p.civl_id.trim()] : [])))],
        lists,
      });

      // Each match carries its own list, which is what the roster stores and
      // shows per row. No roster-wide list summary: the editor stopped naming
      // lists when it stopped asking anyone to choose one.
      return c.json(matchRoster(roster, entries));
    }
  )

  // ── PATCH /api/comp/:comp_id/pilot/:comp_pilot_id ── Admin: sparse update
  .patch(
    "/api/comp/:comp_id/pilot/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    validated("json", updateCompPilotSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      const existing = await c.env.DB.prepare(
        `SELECT * FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?`
      )
        .bind(compPilotId, compId)
        .first<CompPilotRow>();

      if (!existing) {
        return c.json({ error: "Pilot not found in this competition" }, 404);
      }

      if (body.pilot_class !== undefined) {
        const comp = await c.env.DB.prepare(
          "SELECT pilot_classes FROM comp WHERE comp_id = ?"
        )
          .bind(compId)
          .first<{ pilot_classes: string }>();
        const compClasses = JSON.parse(comp!.pilot_classes) as string[];
        if (!compClasses.includes(body.pilot_class)) {
          return c.json(
            {
              error: `Invalid pilot class. Must be one of: ${compClasses.join(", ")}`,
            },
            400
          );
        }
      }

      // The stored row with the body laid over it. A field the body names
      // wins, null included — null is how a field is cleared. Only a field
      // the body leaves out keeps its stored value. (This was
      // `body.x ?? existing.x`, which read null as "leave it alone", so no
      // field could ever be cleared: a driver's number, once typed, stayed.)
      const overlay = <T,>(sent: T | undefined, stored: T): T =>
        sent !== undefined ? sent : stored;
      // A team goes in under the spelling the REST of the roster uses for it
      // — this pilot's own row left out, so a team of one can still have its
      // capitals corrected.
      const teamName =
        body.team_name === undefined
          ? existing.team_name
          : new TeamSpellings(await rosterTeamNames(c.env.DB, compId, [compPilotId])).spell(
              body.team_name
            );
      const merged = {
        registered_pilot_name: overlay(body.registered_pilot_name, existing.registered_pilot_name),
        registered_pilot_email: overlay(body.registered_pilot_email, existing.registered_pilot_email),
        registered_pilot_civl_id: overlay(body.registered_pilot_civl_id, existing.registered_pilot_civl_id),
        registered_pilot_safa_id: overlay(body.registered_pilot_safa_id, existing.registered_pilot_safa_id),
        registered_pilot_ushpa_id: overlay(body.registered_pilot_ushpa_id, existing.registered_pilot_ushpa_id),
        registered_pilot_bhpa_id: overlay(body.registered_pilot_bhpa_id, existing.registered_pilot_bhpa_id),
        registered_pilot_dhv_id: overlay(body.registered_pilot_dhv_id, existing.registered_pilot_dhv_id),
        registered_pilot_ffvl_id: overlay(body.registered_pilot_ffvl_id, existing.registered_pilot_ffvl_id),
        registered_pilot_fai_id: overlay(body.registered_pilot_fai_id, existing.registered_pilot_fai_id),
        registered_pilot_glider: overlay(body.registered_pilot_glider, existing.registered_pilot_glider),
        pilot_class: overlay(body.pilot_class, existing.pilot_class),
        team_name: teamName,
        driver_contact: overlay(body.driver_contact, existing.driver_contact),
        wprs_points: overlay(body.wprs_points, existing.wprs_points),
        // The source travels with the number: a PATCH that moves the score
        // without naming a list is a hand override, and leaving the old list
        // and month attached would date-stamp a value CIVL never published.
        civl_ranking_slug:
          body.wprs_points !== undefined
            ? (body.civl_ranking_slug ?? null)
            : overlay(body.civl_ranking_slug, existing.civl_ranking_slug),
        civl_ranking_date:
          body.wprs_points !== undefined
            ? (body.civl_ranking_date ?? null)
            : overlay(body.civl_ranking_date, existing.civl_ranking_date),
        first_start_order: overlay(body.first_start_order, existing.first_start_order),
      };

      // See nextPilotLink: an edit that leaves the identity alone leaves the
      // link alone, and a pilot's own claim survives an identity that
      // matches nobody.
      const newPilotId = await nextPilotLink(c.env.DB, existing, merged);
      if (newPilotId !== null && newPilotId !== existing.pilot_id) {
        const dupe = await c.env.DB.prepare(
          "SELECT comp_pilot_id FROM comp_pilot WHERE comp_id = ? AND pilot_id = ? AND comp_pilot_id != ?"
        )
          .bind(compId, newPilotId, compPilotId)
          .first();
        if (dupe) {
          // Ask the resolver again for WHICH field matched: the refusal names
          // it, and this is the one path that needs to know.
          const { matched_by } = await resolvePilotId(c.env.DB, resolverFields(merged));
          return c.json(
            await alreadyRegistered(c.env.DB, compId, newPilotId, matched_by, compPilotId),
            409
          );
        }
      }

      await c.env.DB.prepare(UPDATE_COMP_PILOT_SQL)
        .bind(...buildUpdateValues(newPilotId, merged, compPilotId, compId))
        .run();

      // Scores embed the pilot's name and are grouped by class — a change to
      // either marks every task holding one of their tracks stale.
      if (
        merged.registered_pilot_name !== existing.registered_pilot_name ||
        merged.pilot_class !== existing.pilot_class
      ) {
        await bumpAndRevalidateScores(
          c,
          await taskIdsForPilots(c.env.DB, [compPilotId])
        );
      }

      // Audit per changed field
      const auditFields: Array<[keyof typeof merged, string]> = [
        ["registered_pilot_name", "name"],
        ["registered_pilot_email", "email"],
        ["registered_pilot_civl_id", "CIVL ID"],
        ["registered_pilot_safa_id", "SAFA ID"],
        ["registered_pilot_ushpa_id", "USHPA ID"],
        ["registered_pilot_bhpa_id", "BHPA ID"],
        ["registered_pilot_dhv_id", "DHV ID"],
        ["registered_pilot_ffvl_id", "FFVL ID"],
        ["registered_pilot_fai_id", "FAI ID"],
        ["registered_pilot_glider", "glider"],
        ["pilot_class", "class"],
        ["team_name", "team"],
        ["driver_contact", "driver"],
        ["wprs_points", "WPRS points"],
        ["civl_ranking_slug", "CIVL ranking list"],
        ["civl_ranking_date", "CIVL ranking date"],
        ["first_start_order", "first-start order"],
      ];
      // The two fields the public roster withholds (SEC-15). The audit log is
      // public on every non-test comp, so for these it says that the field
      // changed and never what it held.
      const privateFields = new Set<keyof typeof merged>([
        "registered_pilot_email",
        "driver_contact",
      ]);
      const subjectName = merged.registered_pilot_name;
      for (const [key, label] of auditFields) {
        if (body[key as keyof typeof body] === undefined) continue;
        const oldVal = existing[key as keyof CompPilotRow];
        const newVal = merged[key];
        if (oldVal === newVal) continue;
        const change = privateFields.has(key)
          ? describePrivateChange(label, oldVal, newVal)
          : describeChange(label, oldVal, newVal);
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "pilot",
          subject_id: compPilotId,
          subject_name: subjectName,
          description: `${subjectName}: ${change}`,
        });
      }
      if (newPilotId !== existing.pilot_id) {
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "pilot",
          subject_id: compPilotId,
          subject_name: subjectName,
          description: newPilotId
            ? `Linked "${subjectName}" to existing GlideComp account`
            : `Unlinked "${subjectName}" from GlideComp account`,
        });
      }

      const row = await fetchCompPilot(c.env.DB, compPilotId);
      return c.json(serializeCompPilot(alphabet, row!));
    }
  )

  // ── DELETE /api/comp/:comp_id/pilot/:comp_pilot_id ── Admin: delete
  .delete(
    "/api/comp/:comp_id/pilot/:comp_pilot_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const compPilotId = c.var.ids.comp_pilot_id!;

      const existing = await c.env.DB.prepare(
        "SELECT comp_pilot_id, registered_pilot_name FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?"
      )
        .bind(compPilotId, compId)
        .first<{ comp_pilot_id: number; registered_pilot_name: string }>();

      if (!existing) {
        return c.json({ error: "Pilot not found in this competition" }, 404);
      }

      // Resolve which tasks lose a track before the cascade removes the
      // task_track rows this looks at.
      const affectedTaskIds = await taskIdsForPilots(c.env.DB, [compPilotId]);

      const trackKeys = await trackFileKeysForPilots(c.env.DB, [compPilotId]);

      // Cascade deletes task_track rows for this comp_pilot.
      await c.env.DB.prepare(
        "DELETE FROM comp_pilot WHERE comp_pilot_id = ?"
      )
        .bind(compPilotId)
        .run();
      await deleteTrackFiles(c.env.R2, trackKeys);

      await bumpAndRevalidateScores(c, affectedTaskIds);
      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "pilot",
        subject_id: compPilotId,
        subject_name: existing.registered_pilot_name,
        description: `Removed pilot "${existing.registered_pilot_name}"`,
      });

      return c.json({ success: true });
    }
  );
