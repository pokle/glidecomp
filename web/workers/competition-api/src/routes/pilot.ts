import { Hono } from "hono";
import type { AuthedEnv } from "../env";
import { encodeId, decodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin } from "../super-admin";
import {
  updatePilotSchema,
  updateCompPilotSchema,
  createCompPilotSchema,
  bulkPilotsSchema,
  validated,
} from "../validators";
import { resolvePilotId } from "../pilot-resolver";
import { linkExistingRegistrations } from "../pilot-linker";
import { audit, auditAll, describeChange } from "../audit";
import { mapWithConcurrency } from "../lib/concurrency";
import { bumpAndRevalidateScores, taskIdsForPilots } from "../score-store";

const PROFILE_COLUMNS = [
  "name",
  "civl_id",
  "safa_id",
  "ushpa_id",
  "bhpa_id",
  "dhv_id",
  "ffvl_id",
  "fai_id",
  "phone",
  "glider",
  "emergency_contact_name",
  "emergency_contact_phone",
] as const;

type ProfileRow = {
  [K in (typeof PROFILE_COLUMNS)[number]]: string | null;
};

/** How many pilot-link lookups to run at once on a bulk roster import. */
const PILOT_RESOLVE_CONCURRENCY = 10;

const MAX_PILOTS_PER_COMP = 250;

// ── GET /api/comp/pilot/flights row/response shapes ──

/** One flight-evidence row (track or manual) joined to its task and comp. */
interface FlightRow {
  task_id: number;
  comp_pilot_id: number;
  recorded_at: string;
  kind: "track" | "manual";
  task_name: string;
  task_date: string;
  pilot_class: string;
  comp_id: number;
  comp_name: string;
}

/** Rank fields json_each-extracted from a task_scores blob inside D1. */
interface RankRow {
  task_id: number;
  comp_pilot_sqid: string;
  rank: number;
  total_score: number;
  class_size: number;
}

/** One serialized flight in the response; ids are sqid-encoded. */
interface FlightEntry {
  comp_id: string;
  comp_name: string;
  task_id: string;
  task_name: string;
  task_date: string;
  pilot_class: string;
  comp_pilot_id: string;
  kind: "track" | "manual";
  recorded_at: string;
  rank: number | null;
  class_size: number | null;
  total_score: number | null;
}

// Columns selected from the `comp_pilot` table (aliased `cp` in joined
// queries). Kept in a single array so the SELECT list and the row type can
// never drift.
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
  "cp.civl_ranking",
  "cp.first_start_order",
] as const;

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
  civl_ranking: number | null;
  first_start_order: number | null;
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
    first_start_order: row.first_start_order,
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
      `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, u.email AS linked_email, u.username AS linked_username
       FROM comp_pilot cp
       LEFT JOIN pilot p ON cp.pilot_id = p.pilot_id
       LEFT JOIN "user" u ON p.user_id = u.id
       WHERE cp.comp_pilot_id = ?`
    )
    .bind(compPilotId)
    .first<CompPilotRow & { linked_email: string | null; linked_username: string | null }>();
}

function serializeProfile(row: ProfileRow | null, fallbackName: string) {
  if (!row) {
    return {
      name: fallbackName,
      civl_id: null,
      safa_id: null,
      ushpa_id: null,
      bhpa_id: null,
      dhv_id: null,
      ffvl_id: null,
      fai_id: null,
      phone: null,
      glider: null,
      emergency_contact_name: null,
      emergency_contact_phone: null,
    };
  }
  return {
    name: row.name,
    civl_id: row.civl_id ?? null,
    safa_id: row.safa_id ?? null,
    ushpa_id: row.ushpa_id ?? null,
    bhpa_id: row.bhpa_id ?? null,
    dhv_id: row.dhv_id ?? null,
    ffvl_id: row.ffvl_id ?? null,
    fai_id: row.fai_id ?? null,
    phone: row.phone ?? null,
    glider: row.glider ?? null,
    emergency_contact_name: row.emergency_contact_name ?? null,
    emergency_contact_phone: row.emergency_contact_phone ?? null,
  };
}

export const pilotRoutes = new Hono<AuthedEnv>()
  // ── GET /api/comp/pilot ── Get current user's pilot profile
  // (literal path — must be registered before /api/comp/:comp_id/pilot)
  .get("/api/comp/pilot", requireAuth, async (c) => {
    const user = c.var.user;

    const pilot = await c.env.DB.prepare(
      `SELECT ${PROFILE_COLUMNS.join(", ")} FROM pilot WHERE user_id = ?`
    )
      .bind(user.id)
      .first<ProfileRow>();

    return c.json(serializeProfile(pilot, user.name));
  })

  // ── GET /api/comp/pilot/flights ── Current user's competition flights
  //
  // Every flight record (track or manual flight) linked to the caller's
  // pilot across all public comps, newest task first, each with the comp /
  // task names for links and the pilot's last-computed rank. These flights
  // belong to the competition, not the user's personal library — there is
  // deliberately no delete here (removal is the comp admin's igc/manual
  // routes).
  //
  // Kept cheap by construction: one unique-index pilot lookup, then ONE
  // statement over the new by-pilot indexes (migration 0020) that only ever
  // touches this pilot's rows, then one json_each() pass that extracts just
  // {rank, score} from the materialized task_scores blobs inside D1 — the
  // blobs (full per-task score payloads) never leave the database and are
  // never parsed in the worker.
  .get("/api/comp/pilot/flights", requireAuth, async (c) => {
    const user = c.var.user;
    const alphabet = c.env.SQIDS_ALPHABET;

    const pilotRow = await c.env.DB.prepare(
      "SELECT pilot_id FROM pilot WHERE user_id = ?"
    )
      .bind(user.id)
      .first<{ pilot_id: number }>();
    if (!pilotRow) return c.json({ flights: [] as FlightEntry[] });

    // Test (hidden) comps are excluded: their pages 404 for non-admin
    // visitors, so a link here would be a dead end.
    const flightArm = (table: string, kind: string, timeCol: string) =>
      `SELECT f.task_id, f.comp_pilot_id, f.${timeCol} AS recorded_at,
              '${kind}' AS kind, t.name AS task_name, t.task_date,
              cp.pilot_class, c.comp_id, c.name AS comp_name
       FROM comp_pilot cp
       JOIN ${table} f ON f.comp_pilot_id = cp.comp_pilot_id AND f.active = 1
       JOIN task t ON t.task_id = f.task_id
       JOIN comp c ON c.comp_id = cp.comp_id
       WHERE cp.pilot_id = ?1 AND c.test = 0`;
    const flights = (
      await c.env.DB.prepare(
        `${flightArm("task_track", "track", "uploaded_at")}
         UNION ALL
         ${flightArm("task_manual_flight", "manual", "set_at")}
         ORDER BY task_date DESC, recorded_at DESC
         LIMIT 500`
      )
        .bind(pilotRow.pilot_id)
        .all<FlightRow>()
    ).results;

    // Ranks: the score blobs store comp_pilot_id sqid-encoded, so encode
    // ours and let SQLite's json_each pull out only the matching entries.
    // Placeholder rows (bumped before first compute) hold '' — not JSON —
    // and must be skipped or json_each errors. Chunked so each statement
    // stays under D1's bound-parameter cap.
    const rankByFlight = new Map<string, RankRow>();
    const CHUNK = 40;
    for (let i = 0; i < flights.length; i += CHUNK) {
      const chunk = flights.slice(i, i + CHUNK);
      const taskIds = [...new Set(chunk.map((f) => f.task_id))];
      const pilotSqids = [
        ...new Set(chunk.map((f) => encodeId(alphabet, f.comp_pilot_id))),
      ];
      const ranks = await c.env.DB.prepare(
        `SELECT ts.task_id,
                json_extract(pj.value, '$.comp_pilot_id') AS comp_pilot_sqid,
                json_extract(pj.value, '$.rank') AS rank,
                json_extract(pj.value, '$.total_score') AS total_score,
                json_array_length(cls.value, '$.pilots') AS class_size
         FROM task_scores ts,
              json_each(ts.response_json, '$.classes') cls,
              json_each(cls.value, '$.pilots') pj
         WHERE ts.task_id IN (${taskIds.map(() => "?").join(", ")})
           AND ts.response_json != ''
           AND json_extract(pj.value, '$.comp_pilot_id')
                 IN (${pilotSqids.map(() => "?").join(", ")})`
      )
        .bind(...taskIds, ...pilotSqids)
        .all<RankRow>();
      for (const r of ranks.results) {
        rankByFlight.set(`${r.task_id}:${r.comp_pilot_sqid}`, r);
      }
    }

    const entries: FlightEntry[] = flights.map((f) => {
      const sqid = encodeId(alphabet, f.comp_pilot_id);
      const score = rankByFlight.get(`${f.task_id}:${sqid}`) ?? null;
      return {
        comp_id: encodeId(alphabet, f.comp_id),
        comp_name: f.comp_name,
        task_id: encodeId(alphabet, f.task_id),
        task_name: f.task_name,
        task_date: f.task_date,
        pilot_class: f.pilot_class,
        comp_pilot_id: sqid,
        kind: f.kind,
        recorded_at: f.recorded_at,
        rank: score?.rank ?? null,
        class_size: score?.class_size ?? null,
        total_score: score?.total_score ?? null,
      };
    });

    return c.json({ flights: entries });
  })

  // ── PATCH /api/comp/pilot ── Update current user's pilot profile
  .patch(
    "/api/comp/pilot",
    requireAuth,
    validated("json", updatePilotSchema),
    async (c) => {
      const user = c.var.user;
      const body = c.req.valid("json");

      const existing = await c.env.DB.prepare(
        "SELECT pilot_id FROM pilot WHERE user_id = ?"
      )
        .bind(user.id)
        .first<{ pilot_id: number }>();

      if (!existing) {
        await c.env.DB.prepare(
          "INSERT INTO pilot (user_id, name) VALUES (?, ?)"
        )
          .bind(user.id, user.name)
          .run();
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      for (const col of PROFILE_COLUMNS) {
        if (body[col as keyof typeof body] !== undefined) {
          updates.push(`${col} = ?`);
          values.push(body[col as keyof typeof body] ?? null);
        }
      }

      if (updates.length > 0) {
        values.push(user.id);
        await c.env.DB.prepare(
          `UPDATE pilot SET ${updates.join(", ")} WHERE user_id = ?`
        )
          .bind(...values)
          .run();
      }

      // Signup-linking (Iteration 8g): once the user's identity fields are
      // up to date, scan every competition — closed ones included — for
      // admin-pre-registered comp_pilot rows matching them and claim any
      // hits. This is the mechanism that turns a pre-registration into a
      // real linked registration as soon as the user fills in (e.g.) their
      // CIVL ID, and it is how a pilot claims their flights in historical
      // comps for the My Flights page.
      const pilotIdRow = await c.env.DB.prepare(
        "SELECT pilot_id FROM pilot WHERE user_id = ?"
      )
        .bind(user.id)
        .first<{ pilot_id: number }>();
      if (pilotIdRow) {
        const linked = await linkExistingRegistrations(
          c.env.DB,
          pilotIdRow.pilot_id,
          "all-comps"
        );
        for (const link of linked) {
          await audit(c.env.DB, c.var.user, link.comp_id, {
            subject_type: "pilot",
            subject_id: link.comp_pilot_id,
            subject_name: link.registered_pilot_name,
            description: `Linked pre-registered pilot "${link.registered_pilot_name}" to GlideComp account (matched by ${link.matched_by})`,
          });
        }
      }

      const pilot = await c.env.DB.prepare(
        `SELECT ${PROFILE_COLUMNS.join(", ")} FROM pilot WHERE user_id = ?`
      )
        .bind(user.id)
        .first<ProfileRow>();

      return c.json(serializeProfile(pilot, user.name));
    }
  )

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
        "SELECT comp_id, test FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ comp_id: number; test: number }>();

      if (!comp) {
        return c.json({ error: "Not found" }, 404);
      }

      // SEC-15: PII (admin-entered email, linked Better Auth email,
      // driver_contact phone) must only be returned to a comp admin.
      // Test comps already require admin to see anything; for non-test
      // comps we keep public visibility of names/IDs/classes but redact
      // the PII fields via `serializeCompPilotPublic`.
      const isAdmin = await isCompAdmin(c.env.DB, compId, user);

      if (comp.test && !isAdmin) {
        return c.json({ error: "Not found" }, 404);
      }

      const pilots = await c.env.DB.prepare(
        `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, u.email AS linked_email, u.username AS linked_username
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
            { error: "This pilot is already registered in the competition" },
            409
          );
        }
      }

      const insertValues = buildInsertValues(compId, resolved.pilot_id, body);
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
      const { pilots } = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        "SELECT pilot_classes FROM comp WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ pilot_classes: string }>();
      if (!comp) return c.json({ error: "Competition not found" }, 404);
      const compClasses = JSON.parse(comp.pilot_classes) as string[];

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

      const keepIds = new Set(
        planned.flatMap((p) => (p.kind === "update" ? [p.id] : []))
      );
      const toDelete = [...existingById.keys()].filter((id) => !keepIds.has(id));

      // Resolve linking for each row that needs one. Each resolution is an
      // independent D1 read, so they overlap rather than queueing: a 250-row
      // roster paste used to be 250 strictly serialized round trips.
      const resolvedPilotIds = await mapWithConcurrency(
        planned,
        PILOT_RESOLVE_CONCURRENCY,
        async ({ row }) =>
          (
            await resolvePilotId(c.env.DB, {
              name: row.registered_pilot_name,
              email: row.registered_pilot_email,
              civl_id: row.registered_pilot_civl_id,
              safa_id: row.registered_pilot_safa_id,
              ushpa_id: row.registered_pilot_ushpa_id,
              bhpa_id: row.registered_pilot_bhpa_id,
              dhv_id: row.registered_pilot_dhv_id,
              ffvl_id: row.registered_pilot_ffvl_id,
              fai_id: row.registered_pilot_fai_id,
            })
          ).pilot_id
      );

      // Enforce the partial unique index: no two rows in the payload may
      // resolve to the same linked pilot_id.
      const linkedSeen = new Map<number, number>(); // pilot_id → row index
      for (const [i, pilotId] of resolvedPilotIds.entries()) {
        if (pilotId === null) continue;
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

      if (statements.length > 0) {
        await c.env.DB.batch(statements);
      }

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
        `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, u.email AS linked_email, u.username AS linked_username
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

      // Build a complete field set (existing overlaid with body) so we can
      // re-run the resolver if any identity field changed.
      const merged = {
        registered_pilot_name:
          body.registered_pilot_name ?? existing.registered_pilot_name,
        registered_pilot_email:
          body.registered_pilot_email ?? existing.registered_pilot_email,
        registered_pilot_civl_id:
          body.registered_pilot_civl_id ?? existing.registered_pilot_civl_id,
        registered_pilot_safa_id:
          body.registered_pilot_safa_id ?? existing.registered_pilot_safa_id,
        registered_pilot_ushpa_id:
          body.registered_pilot_ushpa_id ?? existing.registered_pilot_ushpa_id,
        registered_pilot_bhpa_id:
          body.registered_pilot_bhpa_id ?? existing.registered_pilot_bhpa_id,
        registered_pilot_dhv_id:
          body.registered_pilot_dhv_id ?? existing.registered_pilot_dhv_id,
        registered_pilot_ffvl_id:
          body.registered_pilot_ffvl_id ?? existing.registered_pilot_ffvl_id,
        registered_pilot_fai_id:
          body.registered_pilot_fai_id ?? existing.registered_pilot_fai_id,
        registered_pilot_glider:
          body.registered_pilot_glider ?? existing.registered_pilot_glider,
        pilot_class: body.pilot_class ?? existing.pilot_class,
        team_name: body.team_name ?? existing.team_name,
        driver_contact: body.driver_contact ?? existing.driver_contact,
        first_start_order:
          body.first_start_order ?? existing.first_start_order,
      };

      // Only re-run the resolver if an identity field was touched.
      let newPilotId: number | null = existing.pilot_id;
      const identityChanged =
        body.registered_pilot_name !== undefined ||
        body.registered_pilot_email !== undefined ||
        body.registered_pilot_civl_id !== undefined ||
        body.registered_pilot_safa_id !== undefined ||
        body.registered_pilot_ushpa_id !== undefined ||
        body.registered_pilot_bhpa_id !== undefined ||
        body.registered_pilot_dhv_id !== undefined ||
        body.registered_pilot_ffvl_id !== undefined ||
        body.registered_pilot_fai_id !== undefined;

      if (identityChanged) {
        const resolved = await resolvePilotId(c.env.DB, {
          name: merged.registered_pilot_name,
          email: merged.registered_pilot_email,
          civl_id: merged.registered_pilot_civl_id,
          safa_id: merged.registered_pilot_safa_id,
          ushpa_id: merged.registered_pilot_ushpa_id,
          bhpa_id: merged.registered_pilot_bhpa_id,
          dhv_id: merged.registered_pilot_dhv_id,
          ffvl_id: merged.registered_pilot_ffvl_id,
          fai_id: merged.registered_pilot_fai_id,
        });
        newPilotId = resolved.pilot_id;

        if (newPilotId !== null && newPilotId !== existing.pilot_id) {
          const dupe = await c.env.DB.prepare(
            "SELECT comp_pilot_id FROM comp_pilot WHERE comp_id = ? AND pilot_id = ? AND comp_pilot_id != ?"
          )
            .bind(compId, newPilotId, compPilotId)
            .first();
          if (dupe) {
            return c.json(
              { error: "Another row in this competition already links to that pilot" },
              409
            );
          }
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
      ];
      const subjectName = merged.registered_pilot_name;
      for (const [key, label] of auditFields) {
        if (body[key as keyof typeof body] === undefined) continue;
        const oldVal = existing[key as keyof CompPilotRow];
        const newVal = merged[key];
        if (oldVal === newVal) continue;
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "pilot",
          subject_id: compPilotId,
          subject_name: subjectName,
          description: `${subjectName}: ${describeChange(label, oldVal, newVal)}`,
        });
      }
      if (identityChanged && newPilotId !== existing.pilot_id) {
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

      // Cascade deletes task_track rows for this comp_pilot.
      await c.env.DB.prepare(
        "DELETE FROM comp_pilot WHERE comp_pilot_id = ?"
      )
        .bind(compPilotId)
        .run();

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
