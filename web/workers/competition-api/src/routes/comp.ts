import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { createCompSchema, updateCompSchema } from "../validators";
import { audit, describeChange } from "../audit";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

const MAX_COMPS_PER_ACCOUNT = 50;

export interface PilotStatusConfig {
  key: string;
  label: string;
  on_track_upload: "none" | "clear" | "set";
}

/** Default statuses new comps get: covers the two canonical ones. */
export const DEFAULT_PILOT_STATUSES: PilotStatusConfig[] = [
  { key: "safely_landed", label: "Safely landed", on_track_upload: "none" },
  { key: "dnf", label: "DNF", on_track_upload: "clear" },
];

// Helper to encode comp row IDs for response
function encodeComp(alphabet: string, row: Record<string, unknown>) {
  return {
    ...row,
    comp_id: encodeId(alphabet, row.comp_id as number),
  };
}

/**
 * Parse the `comp.pilot_statuses` JSON column. Returns an empty array if
 * the value is null/undefined or malformed — callers never need to guard
 * against bad data coming from the DB.
 */
export function parsePilotStatuses(raw: unknown): PilotStatusConfig[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as PilotStatusConfig[];
  } catch {
    return [];
  }
}

export const compRoutes = new Hono<HonoEnv>()
  // ── POST /api/comp ── Create competition
  .post(
    "/api/comp",
    requireAuth,
    zValidator("json", createCompSchema),
    async (c) => {
      const user = c.var.user;
      const body = c.req.valid("json");

      const pilotClasses = body.pilot_classes ?? ["open"];
      const defaultClass = body.default_pilot_class ?? pilotClasses[0];

      // Validate default_pilot_class is in pilot_classes
      if (!pilotClasses.includes(defaultClass)) {
        return c.json(
          { error: "default_pilot_class must be one of pilot_classes" },
          400
        );
      }

      // Enforce per-account comp limit
      const countRow = await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM comp_admin WHERE user_id = ?"
      )
        .bind(user.id)
        .first<{ cnt: number }>();

      if (countRow && countRow.cnt >= MAX_COMPS_PER_ACCOUNT) {
        return c.json(
          { error: `Maximum ${MAX_COMPS_PER_ACCOUNT} competitions per account` },
          400
        );
      }

      const now = new Date().toISOString();

      const compResult = await c.env.DB.prepare(
        `INSERT INTO comp (name, creation_date, close_date, category, test, pilot_classes, default_pilot_class, gap_params, pilot_statuses)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.name,
          now,
          body.close_date ?? null,
          body.category,
          body.test ? 1 : 0,
          JSON.stringify(pilotClasses),
          defaultClass,
          body.gap_params ? JSON.stringify(body.gap_params) : null,
          JSON.stringify(DEFAULT_PILOT_STATUSES)
        )
        .run();

      const compId = compResult.meta.last_row_id;

      // Add creator as first admin
      await c.env.DB.prepare(
        "INSERT INTO comp_admin (comp_id, user_id) VALUES (?, ?)"
      )
        .bind(compId, user.id)
        .run();

      await audit(c.env.DB, c.var.user, compId, {
        subject_type: "comp",
        subject_id: compId,
        subject_name: body.name,
        description: `Created competition "${body.name}"`,
      });

      return c.json(
        {
          comp_id: encodeId(c.env.SQIDS_ALPHABET, compId),
          name: body.name,
          category: body.category,
          creation_date: now,
          close_date: body.close_date ?? null,
          test: body.test ?? false,
          pilot_classes: pilotClasses,
          default_pilot_class: defaultClass,
          gap_params: body.gap_params ?? null,
          open_igc_upload: true,
          pilot_statuses: DEFAULT_PILOT_STATUSES,
        },
        201
      );
    }
  )

  // ── GET /api/comp ── List competitions
  .get("/api/comp", optionalAuth, async (c) => {
    const user = c.var.user;
    const alphabet = c.env.SQIDS_ALPHABET;

    // Public comps: non-test, created within last 24 months
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 24);
    const cutoffStr = cutoff.toISOString();

    const publicComps = await c.env.DB.prepare(
      `SELECT comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, open_igc_upload, pilot_statuses
       FROM comp
       WHERE test = 0 AND creation_date >= ?
       ORDER BY creation_date DESC`
    )
      .bind(cutoffStr)
      .all();

    let adminComps: { results: Record<string, unknown>[] } = { results: [] };

    if (user) {
      adminComps = await c.env.DB.prepare(
        `SELECT c.comp_id, c.name, c.category, c.creation_date, c.close_date, c.test, c.pilot_classes, c.default_pilot_class, c.gap_params, c.open_igc_upload
         FROM comp c
         JOIN comp_admin ca ON c.comp_id = ca.comp_id
         WHERE ca.user_id = ?
         ORDER BY c.creation_date DESC`
      )
        .bind(user.id)
        .all();
    }

    // Merge: admin comps first, then public (deduped)
    const adminIds = new Set(
      adminComps.results.map((r) => r.comp_id as number)
    );
    const merged = [
      ...adminComps.results.map((r) => ({
        ...encodeComp(alphabet, r),
        is_admin: true,
        pilot_classes: JSON.parse(r.pilot_classes as string),
        gap_params: r.gap_params ? JSON.parse(r.gap_params as string) : null,
        test: !!(r.test as number),
        open_igc_upload: !!(r.open_igc_upload as number),
        pilot_statuses: parsePilotStatuses(r.pilot_statuses),
      })),
      ...publicComps.results
        .filter((r) => !adminIds.has(r.comp_id as number))
        .map((r) => ({
          ...encodeComp(alphabet, r),
          is_admin: false,
          pilot_classes: JSON.parse(r.pilot_classes as string),
          gap_params: r.gap_params ? JSON.parse(r.gap_params as string) : null,
          test: !!(r.test as number),
          open_igc_upload: !!(r.open_igc_upload as number),
          pilot_statuses: parsePilotStatuses(r.pilot_statuses),
        })),
    ];

    return c.json({ comps: merged });
  })

  // ── GET /api/comp/:comp_id ── Get comp details
  .get(
    "/api/comp/:comp_id",
    optionalAuth,
    sqidsMiddleware,
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const user = c.var.user;
      const alphabet = c.env.SQIDS_ALPHABET;

      const comp = await c.env.DB.prepare(
        `SELECT comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, open_igc_upload, pilot_statuses
         FROM comp WHERE comp_id = ?`
      )
        .bind(compId)
        .first<Record<string, unknown>>();

      if (!comp) {
        return c.json({ error: "Competition not found" }, 404);
      }

      // Test comps require admin access
      if (comp.test) {
        if (!user) {
          return c.json({ error: "Competition not found" }, 404);
        }
        const isAdmin = await c.env.DB.prepare(
          "SELECT 1 FROM comp_admin WHERE comp_id = ? AND user_id = ?"
        )
          .bind(compId, user.id)
          .first();
        if (!isAdmin) {
          return c.json({ error: "Competition not found" }, 404);
        }
      }

      // Get admin list (emails)
      const admins = await c.env.DB.prepare(
        `SELECT u.email, u.name FROM comp_admin ca
         JOIN "user" u ON ca.user_id = u.id
         WHERE ca.comp_id = ?`
      )
        .bind(compId)
        .all<{ email: string; name: string }>();

      // Get tasks summary
      const tasks = await c.env.DB.prepare(
        `SELECT t.task_id, t.name, t.task_date, t.creation_date,
                (t.xctsk IS NOT NULL) as has_xctsk
         FROM task t WHERE t.comp_id = ?
         ORDER BY t.task_date ASC, t.creation_date ASC`
      )
        .bind(compId)
        .all<Record<string, unknown>>();

      // Get task classes for each task
      const taskIds = tasks.results.map((t) => t.task_id as number);
      let taskClasses: Record<number, string[]> = {};
      if (taskIds.length > 0) {
        const placeholders = taskIds.map(() => "?").join(",");
        const tc = await c.env.DB.prepare(
          `SELECT task_id, pilot_class FROM task_class WHERE task_id IN (${placeholders})`
        )
          .bind(...taskIds)
          .all<{ task_id: number; pilot_class: string }>();
        for (const row of tc.results) {
          if (!taskClasses[row.task_id]) taskClasses[row.task_id] = [];
          taskClasses[row.task_id].push(row.pilot_class);
        }
      }

      // Get pilot count
      const pilotCount = await c.env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM comp_pilot WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ cnt: number }>();

      // Compute class coverage warnings
      const pilotClasses = JSON.parse(comp.pilot_classes as string) as string[];
      const classCoverageWarnings = computeClassCoverageWarnings(
        tasks.results as Array<{ task_id: number; task_date: string }>,
        taskClasses,
        pilotClasses
      );

      return c.json({
        ...encodeComp(alphabet, comp),
        test: !!(comp.test as number),
        pilot_classes: pilotClasses,
        default_pilot_class: comp.default_pilot_class,
        gap_params: comp.gap_params
          ? JSON.parse(comp.gap_params as string)
          : null,
        open_igc_upload: !!(comp.open_igc_upload as number),
        pilot_statuses: parsePilotStatuses(comp.pilot_statuses),
        admins: admins.results,
        tasks: tasks.results.map((t) => ({
          task_id: encodeId(alphabet, t.task_id as number),
          name: t.name,
          task_date: t.task_date,
          creation_date: t.creation_date,
          has_xctsk: !!(t.has_xctsk as number),
          pilot_classes: taskClasses[t.task_id as number] ?? [],
        })),
        pilot_count: pilotCount?.cnt ?? 0,
        class_coverage_warnings: classCoverageWarnings,
      });
    }
  )

  // ── PATCH /api/comp/:comp_id ── Update competition
  .patch(
    "/api/comp/:comp_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    zValidator("json", updateCompSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      // Fetch current state so we can compute audit diffs and validate consistency
      const current = await c.env.DB.prepare(
        `SELECT name, category, close_date, test, pilot_classes, default_pilot_class, gap_params, open_igc_upload, pilot_statuses
         FROM comp WHERE comp_id = ?`
      )
        .bind(compId)
        .first<{
          name: string;
          category: string;
          close_date: string | null;
          test: number;
          pilot_classes: string;
          default_pilot_class: string;
          gap_params: string | null;
          open_igc_upload: number;
          pilot_statuses: string;
        }>();
      if (!current) return c.json({ error: "Competition not found" }, 404);

      // If updating pilot_classes or default_pilot_class, validate consistency
      if (body.pilot_classes || body.default_pilot_class) {
        const newClasses =
          body.pilot_classes ??
          (JSON.parse(current.pilot_classes) as string[]);
        const newDefault =
          body.default_pilot_class ?? current.default_pilot_class;

        if (!newClasses.includes(newDefault)) {
          return c.json(
            { error: "default_pilot_class must be one of pilot_classes" },
            400
          );
        }
      }

      // Build dynamic UPDATE
      const updates: string[] = [];
      const values: unknown[] = [];

      if (body.name !== undefined) {
        updates.push("name = ?");
        values.push(body.name);
      }
      if (body.category !== undefined) {
        updates.push("category = ?");
        values.push(body.category);
      }
      if (body.close_date !== undefined) {
        updates.push("close_date = ?");
        values.push(body.close_date);
      }
      if (body.test !== undefined) {
        updates.push("test = ?");
        values.push(body.test ? 1 : 0);
      }
      if (body.pilot_classes !== undefined) {
        updates.push("pilot_classes = ?");
        values.push(JSON.stringify(body.pilot_classes));
      }
      if (body.default_pilot_class !== undefined) {
        updates.push("default_pilot_class = ?");
        values.push(body.default_pilot_class);
      }
      if (body.gap_params !== undefined) {
        updates.push("gap_params = ?");
        values.push(
          body.gap_params ? JSON.stringify(body.gap_params) : null
        );
      }
      if (body.open_igc_upload !== undefined) {
        updates.push("open_igc_upload = ?");
        values.push(body.open_igc_upload ? 1 : 0);
      }
      if (body.pilot_statuses !== undefined) {
        updates.push("pilot_statuses = ?");
        values.push(JSON.stringify(body.pilot_statuses));
      }

      if (updates.length > 0) {
        values.push(compId);
        await c.env.DB.prepare(
          `UPDATE comp SET ${updates.join(", ")} WHERE comp_id = ?`
        )
          .bind(...values)
          .run();
      }

      // Emit one audit entry per changed field
      const auditChanges: string[] = [];
      if (body.name !== undefined && body.name !== current.name) {
        auditChanges.push(describeChange("name", current.name, body.name));
      }
      if (body.category !== undefined && body.category !== current.category) {
        auditChanges.push(describeChange("category", current.category, body.category));
      }
      if (
        body.close_date !== undefined &&
        body.close_date !== current.close_date
      ) {
        auditChanges.push(
          describeChange("close date", current.close_date, body.close_date)
        );
      }
      if (body.test !== undefined && (body.test ? 1 : 0) !== current.test) {
        auditChanges.push(
          describeChange("test flag", !!current.test, body.test)
        );
      }
      if (body.pilot_classes !== undefined) {
        const oldClasses = JSON.parse(current.pilot_classes) as string[];
        if (JSON.stringify(oldClasses) !== JSON.stringify(body.pilot_classes)) {
          auditChanges.push(
            `Changed pilot classes from [${oldClasses.join(", ")}] to [${body.pilot_classes.join(", ")}]`
          );
        }
      }
      if (
        body.default_pilot_class !== undefined &&
        body.default_pilot_class !== current.default_pilot_class
      ) {
        auditChanges.push(
          describeChange(
            "default pilot class",
            current.default_pilot_class,
            body.default_pilot_class
          )
        );
      }
      if (body.gap_params !== undefined) {
        auditChanges.push("Updated GAP scoring parameters");
      }
      if (
        body.open_igc_upload !== undefined &&
        (body.open_igc_upload ? 1 : 0) !== current.open_igc_upload
      ) {
        auditChanges.push(
          body.open_igc_upload
            ? "Enabled open IGC upload (any registered pilot can upload on behalf)"
            : "Disabled open IGC upload (admins only)"
        );
      }
      if (body.pilot_statuses !== undefined) {
        const oldStatuses = parsePilotStatuses(current.pilot_statuses);
        const newStatuses = body.pilot_statuses;
        const oldByKey = new Map(oldStatuses.map((s) => [s.key, s] as const));
        const newByKey = new Map(newStatuses.map((s) => [s.key, s] as const));
        for (const [key, s] of newByKey) {
          const prev = oldByKey.get(key);
          if (!prev) {
            auditChanges.push(
              `Added pilot status "${s.label}" (key=${key}, on track upload: ${s.on_track_upload})`
            );
          } else if (
            prev.label !== s.label ||
            prev.on_track_upload !== s.on_track_upload
          ) {
            auditChanges.push(
              `Updated pilot status "${s.label}" (key=${key}, on track upload: ${s.on_track_upload})`
            );
          }
        }
        for (const [key, s] of oldByKey) {
          if (!newByKey.has(key)) {
            auditChanges.push(
              `Removed pilot status "${s.label}" (key=${key})`
            );
          }
        }
      }

      for (const description of auditChanges) {
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "comp",
          subject_id: compId,
          subject_name: body.name ?? current.name,
          description,
        });
      }

      // Handle admin management via email resolution
      if (body.admin_emails) {
        await updateAdmins(c.env.DB, compId, body.admin_emails);
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "comp",
          subject_id: compId,
          subject_name: body.name ?? current.name,
          description: `Updated admin list (${body.admin_emails.length} admin${body.admin_emails.length === 1 ? "" : "s"})`,
        });
      }

      // Return updated comp
      const updated = await c.env.DB.prepare(
        `SELECT comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, open_igc_upload, pilot_statuses
         FROM comp WHERE comp_id = ?`
      )
        .bind(compId)
        .first<Record<string, unknown>>();

      if (!updated) return c.json({ error: "Competition not found" }, 404);

      const admins = await c.env.DB.prepare(
        `SELECT u.email, u.name FROM comp_admin ca
         JOIN "user" u ON ca.user_id = u.id
         WHERE ca.comp_id = ?`
      )
        .bind(compId)
        .all<{ email: string; name: string }>();

      return c.json({
        ...encodeComp(alphabet, updated),
        test: !!(updated.test as number),
        pilot_classes: JSON.parse(updated.pilot_classes as string),
        default_pilot_class: updated.default_pilot_class,
        gap_params: updated.gap_params
          ? JSON.parse(updated.gap_params as string)
          : null,
        open_igc_upload: !!(updated.open_igc_upload as number),
        pilot_statuses: parsePilotStatuses(updated.pilot_statuses),
        admins: admins.results,
      });
    }
  )

  // ── DELETE /api/comp/:comp_id ── Delete competition
  .delete(
    "/api/comp/:comp_id",
    requireAuth,
    sqidsMiddleware,
    requireCompAdmin,
    async (c) => {
      const compId = c.var.ids.comp_id!;

      // Note: no audit write here — the audit_log rows cascade-delete with
      // the comp, so the entry would be wiped immediately. Deletion is
      // tracked by the comp's absence in listings; if needed later we could
      // move audit_log to its own retention table.

      // D1 cascade deletes handle child rows
      await c.env.DB.prepare("DELETE FROM comp WHERE comp_id = ?")
        .bind(compId)
        .run();

      // TODO (Iteration 9): Enqueue R2 cleanup via Cloudflare Queue

      return c.json({ success: true });
    }
  );

// ── Admin management helper ──

async function updateAdmins(
  db: D1Database,
  compId: number,
  emails: string[]
): Promise<void> {
  // Resolve emails to user IDs
  const placeholders = emails.map(() => "?").join(",");
  const users = await db
    .prepare(
      `SELECT id, email FROM "user" WHERE email IN (${placeholders})`
    )
    .bind(...emails)
    .all<{ id: string; email: string }>();

  const resolvedIds = users.results.map((u) => u.id);

  if (resolvedIds.length === 0) {
    throw new Error("At least one admin must be a registered user");
  }

  // Replace all admins in a batch
  await db
    .prepare("DELETE FROM comp_admin WHERE comp_id = ?")
    .bind(compId)
    .run();

  const batch = resolvedIds.map((userId) =>
    db
      .prepare("INSERT INTO comp_admin (comp_id, user_id) VALUES (?, ?)")
      .bind(compId, userId)
  );
  await db.batch(batch);
}

// ── Class coverage warnings ──

function computeClassCoverageWarnings(
  tasks: Array<{ task_id: number; task_date: string }>,
  taskClasses: Record<number, string[]>,
  compPilotClasses: string[]
): Array<{ date: string; missing_classes?: string[]; inconsistent_groupings?: boolean }> {
  if (tasks.length === 0) return [];

  // Group tasks by date
  const byDate = new Map<string, number[]>();
  for (const t of tasks) {
    const ids = byDate.get(t.task_date) ?? [];
    ids.push(t.task_id);
    byDate.set(t.task_date, ids);
  }

  // Determine the canonical grouping from the first date
  const dates = [...byDate.keys()].sort();
  const firstDayTaskIds = byDate.get(dates[0])!;
  const canonicalGroupings = firstDayTaskIds
    .map((tid) => [...(taskClasses[tid] ?? [])].sort().join(","))
    .sort();

  const warnings: Array<{
    date: string;
    missing_classes?: string[];
    inconsistent_groupings?: boolean;
  }> = [];

  for (const date of dates) {
    const dayTaskIds = byDate.get(date)!;

    // Check missing classes
    const coveredClasses = new Set<string>();
    for (const tid of dayTaskIds) {
      for (const cls of taskClasses[tid] ?? []) {
        coveredClasses.add(cls);
      }
    }
    const missing = compPilotClasses.filter((c) => !coveredClasses.has(c));

    // Check grouping consistency
    const dayGroupings = dayTaskIds
      .map((tid) => [...(taskClasses[tid] ?? [])].sort().join(","))
      .sort();
    const inconsistent =
      JSON.stringify(dayGroupings) !== JSON.stringify(canonicalGroupings);

    if (missing.length > 0 || inconsistent) {
      warnings.push({
        date,
        ...(missing.length > 0 ? { missing_classes: missing } : {}),
        ...(inconsistent ? { inconsistent_groupings: true } : {}),
      });
    }
  }

  return warnings;
}
