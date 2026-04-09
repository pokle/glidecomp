import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Env, AuthUser } from "../env";
import { encodeId, decodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import {
  updatePilotSchema,
  updateCompPilotSchema,
  createCompPilotSchema,
  bulkPilotsSchema,
} from "../validators";
import { resolvePilotId } from "../pilot-resolver";
import { audit, describeChange } from "../audit";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

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
] as const;

type ProfileRow = {
  [K in (typeof PROFILE_COLUMNS)[number]]: string | null;
};

const MAX_PILOTS_PER_COMP = 250;

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
  row: CompPilotRow & { linked_email?: string | null }
) {
  return {
    comp_pilot_id: encodeId(alphabet, row.comp_pilot_id),
    linked: row.pilot_id !== null,
    linked_email: row.linked_email ?? null,
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
): Promise<(CompPilotRow & { linked_email: string | null }) | null> {
  return db
    .prepare(
      `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, u.email AS linked_email
       FROM comp_pilot cp
       LEFT JOIN pilot p ON cp.pilot_id = p.pilot_id
       LEFT JOIN "user" u ON p.user_id = u.id
       WHERE cp.comp_pilot_id = ?`
    )
    .bind(compPilotId)
    .first<CompPilotRow & { linked_email: string | null }>();
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
  };
}

export const pilotRoutes = new Hono<HonoEnv>()
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

  // ── PATCH /api/comp/pilot ── Update current user's pilot profile
  .patch(
    "/api/comp/pilot",
    requireAuth,
    zValidator("json", updatePilotSchema),
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

      if (comp.test) {
        if (!user) {
          return c.json({ error: "Not found" }, 404);
        }
        const isAdmin = await c.env.DB.prepare(
          "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
        )
          .bind(compId, user.id)
          .first();
        if (!isAdmin) {
          return c.json({ error: "Not found" }, 404);
        }
      }

      const pilots = await c.env.DB.prepare(
        `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, u.email AS linked_email
         FROM comp_pilot cp
         LEFT JOIN pilot p ON cp.pilot_id = p.pilot_id
         LEFT JOIN "user" u ON p.user_id = u.id
         WHERE cp.comp_id = ?
         ORDER BY cp.registered_pilot_name COLLATE NOCASE ASC`
      )
        .bind(compId)
        .all<CompPilotRow & { linked_email: string | null }>();

      return c.json({
        pilots: pilots.results.map((p) => serializeCompPilot(alphabet, p)),
      });
    }
  )

  // ── POST /api/comp/:comp_id/pilot ── Admin: create a single pilot
  .post(
    "/api/comp/:comp_id/pilot",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    zValidator("json", createCompPilotSchema),
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
    zValidator("json", bulkPilotsSchema),
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

      // Validate every row up front. Return all errors at once so the admin
      // can fix them in one pass.
      const errors: { index: number; error: string }[] = [];
      const idsSeen = new Set<number>();
      for (let i = 0; i < pilots.length; i++) {
        const row = pilots[i];
        if (!compClasses.includes(row.pilot_class)) {
          errors.push({
            index: i,
            error: `Invalid pilot class "${row.pilot_class}". Must be one of: ${compClasses.join(", ")}`,
          });
          continue;
        }
        if (row.comp_pilot_id) {
          const decoded = decodeId(alphabet, row.comp_pilot_id);
          if (decoded === null) {
            errors.push({ index: i, error: "Invalid comp_pilot_id" });
            continue;
          }
          if (idsSeen.has(decoded)) {
            errors.push({
              index: i,
              error: "Duplicate comp_pilot_id in payload",
            });
            continue;
          }
          idsSeen.add(decoded);
        }
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

      const existingById = new Map<number, CompPilotRow>();
      for (const row of existingRows.results) {
        existingById.set(row.comp_pilot_id, row);
      }

      // Validate all referenced comp_pilot_ids exist
      for (let i = 0; i < pilots.length; i++) {
        const row = pilots[i];
        if (row.comp_pilot_id) {
          const decoded = decodeId(alphabet, row.comp_pilot_id)!;
          if (!existingById.has(decoded)) {
            errors.push({
              index: i,
              error: "comp_pilot_id does not exist in this competition",
            });
          }
        }
      }
      if (errors.length > 0) {
        return c.json({ errors }, 400);
      }

      // Compute: keep IDs (updates), new inserts, and deletions.
      const keepIds = new Set<number>();
      for (const row of pilots) {
        if (row.comp_pilot_id) {
          keepIds.add(decodeId(alphabet, row.comp_pilot_id)!);
        }
      }

      const toDelete: number[] = [];
      for (const id of existingById.keys()) {
        if (!keepIds.has(id)) toDelete.push(id);
      }

      // Resolve linking for each row that needs one (new rows, or existing
      // rows whose identity fields may have changed).
      const resolvedPilotIds: (number | null)[] = [];
      for (const row of pilots) {
        const resolved = await resolvePilotId(c.env.DB, {
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
        resolvedPilotIds.push(resolved.pilot_id);
      }

      // Enforce partial unique index: no two rows in the payload may resolve
      // to the same linked pilot_id. Also: don't clobber a linked row that
      // exists in this comp but whose comp_pilot_id is absent from the
      // payload (handled by the delete step, but guard against conflicts).
      const linkedSeen = new Map<number, number>(); // pilot_id → row index
      for (let i = 0; i < pilots.length; i++) {
        const pid = resolvedPilotIds[i];
        if (pid === null) continue;
        if (linkedSeen.has(pid)) {
          errors.push({
            index: i,
            error: `Two rows resolved to the same pilot (also row ${linkedSeen.get(pid)})`,
          });
        } else {
          linkedSeen.set(pid, i);
        }
      }
      if (errors.length > 0) {
        return c.json({ errors }, 400);
      }

      // Enforce cap on post-write size
      const finalSize = existingById.size - toDelete.length +
        pilots.filter((p) => !p.comp_pilot_id).length;
      if (finalSize > MAX_PILOTS_PER_COMP) {
        return c.json(
          { error: `Maximum ${MAX_PILOTS_PER_COMP} pilots per competition` },
          400
        );
      }

      // Build the batch. All statements execute atomically in D1.batch().
      const statements: D1PreparedStatement[] = [];

      for (const id of toDelete) {
        statements.push(
          c.env.DB.prepare(
            "DELETE FROM comp_pilot WHERE comp_pilot_id = ? AND comp_id = ?"
          ).bind(id, compId)
        );
      }

      for (let i = 0; i < pilots.length; i++) {
        const row = pilots[i];
        const pilotId = resolvedPilotIds[i];
        if (row.comp_pilot_id) {
          const decoded = decodeId(alphabet, row.comp_pilot_id)!;
          statements.push(
            c.env.DB.prepare(UPDATE_COMP_PILOT_SQL).bind(
              ...buildUpdateValues(pilotId, row, decoded, compId)
            )
          );
        } else {
          statements.push(
            c.env.DB.prepare(INSERT_COMP_PILOT_SQL).bind(
              ...buildInsertValues(compId, pilotId, row)
            )
          );
        }
      }

      if (statements.length > 0) {
        await c.env.DB.batch(statements);
      }

      // Audit: one per change up to 5 total, otherwise a single rollup.
      const inserts = pilots.filter((p) => !p.comp_pilot_id).length;
      const updates = pilots.length - inserts;
      const totalChanges = inserts + updates + toDelete.length;
      if (totalChanges === 0) {
        // idempotent replay — nothing to audit
      } else if (totalChanges <= 5) {
        for (let i = 0; i < pilots.length; i++) {
          const row = pilots[i];
          if (row.comp_pilot_id) {
            const decoded = decodeId(alphabet, row.comp_pilot_id)!;
            await audit(c.env.DB, c.var.user, compId, {
              subject_type: "pilot",
              subject_id: decoded,
              subject_name: row.registered_pilot_name,
              description: `Updated pilot "${row.registered_pilot_name}"`,
            });
          } else {
            await audit(c.env.DB, c.var.user, compId, {
              subject_type: "pilot",
              subject_id: null,
              subject_name: row.registered_pilot_name,
              description: `Registered pilot "${row.registered_pilot_name}" (class: ${row.pilot_class})`,
            });
          }
        }
        for (const id of toDelete) {
          const old = existingById.get(id)!;
          await audit(c.env.DB, c.var.user, compId, {
            subject_type: "pilot",
            subject_id: id,
            subject_name: old.registered_pilot_name,
            description: `Removed pilot "${old.registered_pilot_name}"`,
          });
        }
      } else {
        const parts: string[] = [];
        if (inserts > 0) parts.push(`${inserts} added`);
        if (updates > 0) parts.push(`${updates} updated`);
        if (toDelete.length > 0) parts.push(`${toDelete.length} removed`);
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "pilot",
          subject_id: null,
          subject_name: null,
          description: `Bulk pilot update: ${parts.join(", ")}`,
        });
      }

      // Return the new state of all pilots in the comp.
      const after = await c.env.DB.prepare(
        `SELECT ${COMP_PILOT_COLUMNS.join(", ")}, u.email AS linked_email
         FROM comp_pilot cp
         LEFT JOIN pilot p ON cp.pilot_id = p.pilot_id
         LEFT JOIN "user" u ON p.user_id = u.id
         WHERE cp.comp_id = ?
         ORDER BY cp.registered_pilot_name COLLATE NOCASE ASC`
      )
        .bind(compId)
        .all<CompPilotRow & { linked_email: string | null }>();

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
    zValidator("json", updateCompPilotSchema),
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

      // Cascade deletes task_track rows for this comp_pilot.
      await c.env.DB.prepare(
        "DELETE FROM comp_pilot WHERE comp_pilot_id = ?"
      )
        .bind(compPilotId)
        .run();

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "pilot",
        subject_id: compPilotId,
        subject_name: existing.registered_pilot_name,
        description: `Removed pilot "${existing.registered_pilot_name}"`,
      });

      return c.json({ success: true });
    }
  );
