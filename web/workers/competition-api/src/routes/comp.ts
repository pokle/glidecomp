import { Hono } from "hono";
import type { Env, AuthUser } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin, isSuperAdmin } from "../super-admin";
import { createCompSchema, updateCompSchema, validated } from "../validators";
import { audit, describeChange } from "../audit";
import { bumpAndRevalidateScores, taskIdsForComp } from "../score-store";
import { speedSectionTypeWarnings, hasLineGoal } from "../xctsk-summary";
import { DEFAULT_GAP_PARAMETERS, resolveTimePointsExponent, type GAPParameters } from "@glidecomp/engine";
import { timezoneForXctsk } from "@glidecomp/engine/timezone";

type Variables = {
  user: AuthUser;
  ids: { comp_id?: number; task_id?: number; comp_pilot_id?: number };
};

type HonoEnv = { Bindings: Env; Variables: Variables };

const MAX_COMPS_PER_ACCOUNT = 50;

/**
 * Describe GAP scoring parameter changes as human-readable audit lines.
 *
 * Friendly units are used (km, min, %) rather than the stored
 * meters/seconds/fractions. A missing/null nominalDistance means the
 * scorer auto-computes it per task, so it reads as "auto (per task)".
 * When the whole object is reset to null, a single line is returned.
 */
type GapParamInput = Partial<Omit<GAPParameters, "nominalDistance">> & {
  nominalDistance?: number | null;
};

function describeGapParamChanges(
  oldGap: GapParamInput | null,
  newGap: GapParamInput | null
): string[] {
  if (newGap === null) {
    return oldGap === null ? [] : ["Reset GAP scoring parameters to defaults"];
  }
  // Merge over engine defaults so an unset old value reads as its default.
  const o = { ...DEFAULT_GAP_PARAMETERS, ...(oldGap ?? {}) };
  const n = { ...DEFAULT_GAP_PARAMETERS, ...newGap };
  const oDist = oldGap?.nominalDistance ?? null;
  const nDist = newGap.nominalDistance ?? null;
  const km = (m: number | null) =>
    m == null ? "auto (per task)" : `${Math.round((m / 1000) * 10) / 10} km`;
  const min = (s: number) => `${Math.round(s / 60)} min`;
  const pct = (f: number) => `${Math.round(f * 100)}%`;

  const out: string[] = [];
  if (o.scoring !== n.scoring) {
    out.push(describeChange("scoring class", o.scoring, n.scoring));
  }
  if (oDist !== nDist) {
    out.push(`Changed nominal distance from ${km(oDist)} to ${km(nDist)}`);
  }
  if (o.nominalTime !== n.nominalTime) {
    out.push(`Changed nominal time from ${min(o.nominalTime)} to ${min(n.nominalTime)}`);
  }
  if (o.nominalGoal !== n.nominalGoal) {
    out.push(`Changed nominal goal from ${pct(o.nominalGoal)} to ${pct(n.nominalGoal)}`);
  }
  if (o.nominalLaunch !== n.nominalLaunch) {
    out.push(`Changed nominal launch from ${pct(o.nominalLaunch)} to ${pct(n.nominalLaunch)}`);
  }
  if (o.minimumDistance !== n.minimumDistance) {
    out.push(`Changed minimum distance from ${km(o.minimumDistance)} to ${km(n.minimumDistance)}`);
  }
  if (o.useLeading !== n.useLeading) {
    out.push(
      n.useLeading
        ? "Enabled leading (departure) points"
        : "Disabled leading (departure) points"
    );
  }
  if (o.useArrival !== n.useArrival) {
    out.push(n.useArrival ? "Enabled arrival points" : "Disabled arrival points");
  }
  const oFormula = o.leadingFormula ?? "weighted";
  const nFormula = n.leadingFormula ?? "weighted";
  if (oFormula !== nFormula) {
    out.push(describeChange("leading coefficient formula", oFormula, nFormula));
  }
  // Leading-weight generation (PG only; issue #257) — changes every PG
  // pilot's leading↔time split, so both the generation and its ratio are
  // individually audit-logged.
  const oLwf = o.leadingWeightFormula ?? "gap2020";
  const nLwf = n.leadingWeightFormula ?? "gap2020";
  if (oLwf !== nLwf) {
    out.push(describeChange("PG leading-weight formula", oLwf, nLwf));
  }
  const oLtr = o.leadingTimeRatio ?? 0.26;
  const nLtr = n.leadingTimeRatio ?? 0.26;
  if (oLtr !== nLtr) {
    out.push(describeChange("PG leading-time ratio", pct(oLtr), pct(nLtr)));
  }
  // Time-points exponent (S7F §11.2), decoupled from the leading formula
  // (issue #258). Report the effective exponent so a change from the
  // formula-implied default to an explicit override is still logged.
  const oExp = resolveTimePointsExponent(o);
  const nExp = resolveTimePointsExponent(n);
  if (oExp !== nExp) {
    out.push(describeChange("time points exponent", oExp, nExp));
  }
  const oOrigin = o.distanceOrigin ?? "takeoff";
  const nOrigin = n.distanceOrigin ?? "takeoff";
  if (oOrigin !== nOrigin) {
    out.push(describeChange("distance origin", oOrigin, nOrigin));
  }
  const oDiff = o.useDistanceDifficulty ?? true;
  const nDiff = n.useDistanceDifficulty ?? true;
  if (oDiff !== nDiff) {
    out.push(
      nDiff
        ? "Enabled HG distance difficulty"
        : "Disabled HG distance difficulty (pure linear distance points)",
    );
  }
  // Jump-the-gun settings (S7F §12.2) directly change how HG early starts
  // are penalised, so both knobs are individually audit-logged.
  const oJtgX = o.jumpTheGunFactor ?? 2;
  const nJtgX = n.jumpTheGunFactor ?? 2;
  if (oJtgX !== nJtgX) {
    out.push(
      `Changed jump-the-gun penalty rate from 1 point per ${oJtgX} s early to 1 point per ${nJtgX} s early`
    );
  }
  const oJtgY = o.jumpTheGunMaxSeconds ?? 300;
  const nJtgY = n.jumpTheGunMaxSeconds ?? 300;
  if (oJtgY !== nJtgY) {
    out.push(
      `Changed jump-the-gun limit from ${oJtgY} s to ${nJtgY} s early (beyond it, minimum distance)`
    );
  }
  // ESS-but-not-goal (S7F §12.1): the share of time and arrival points an
  // HG pilot keeps after reaching ESS but landing before goal.
  const oEng = o.essNotGoalFactor ?? 0.8;
  const nEng = n.essNotGoalFactor ?? 0.8;
  if (oEng !== nEng) {
    out.push(
      `Changed the ESS-but-not-goal factor from ${pct(oEng)} to ${pct(nEng)} of time and arrival points kept (HG, S7F §12.1)`
    );
  }
  // PG score-back time (S7F §5.6, §12.3.1): shifts the stop time of every
  // stopped task, so it is individually audit-logged.
  const oSb = o.scoreBackTime ?? 300;
  const nSb = n.scoreBackTime ?? 300;
  if (oSb !== nSb) {
    out.push(
      `Changed the PG score-back time from ${min(oSb)} to ${min(nSb)} (stopped tasks, S7F §12.3.1)`
    );
  }
  return out;
}

// Helper to encode comp row IDs for response
function encodeComp(alphabet: string, row: Record<string, unknown>) {
  return {
    ...row,
    comp_id: encodeId(alphabet, row.comp_id as number),
  };
}

export const compRoutes = new Hono<HonoEnv>()
  // ── POST /api/comp ── Create competition
  .post(
    "/api/comp",
    requireAuth,
    validated("json", createCompSchema),
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

      // Default close_date to one month out so a forgotten close date
      // doesn't silently leave the comp open-ended forever.
      const defaultCloseDate = new Date(now);
      defaultCloseDate.setUTCMonth(defaultCloseDate.getUTCMonth() + 1);
      const closeDate =
        body.close_date ?? defaultCloseDate.toISOString().split("T")[0];

      const scoringFormat = body.scoring_format ?? "gap";

      const compResult = await c.env.DB.prepare(
        `INSERT INTO comp (name, creation_date, close_date, category, test, pilot_classes, default_pilot_class, gap_params, scoring_format, timezone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.name,
          now,
          closeDate,
          body.category,
          body.test ? 1 : 0,
          JSON.stringify(pilotClasses),
          defaultClass,
          body.gap_params ? JSON.stringify(body.gap_params) : null,
          scoringFormat,
          body.timezone ?? null
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
        description: body.close_date
          ? `Created competition "${body.name}"`
          : `Created competition "${body.name}" (close date defaulted to ${closeDate})`,
      });

      return c.json(
        {
          comp_id: encodeId(c.env.SQIDS_ALPHABET, compId),
          name: body.name,
          category: body.category,
          creation_date: now,
          close_date: closeDate,
          test: body.test ?? false,
          pilot_classes: pilotClasses,
          default_pilot_class: defaultClass,
          gap_params: body.gap_params ?? null,
          scoring_format: scoringFormat,
          timezone: body.timezone ?? null,
          open_igc_upload: true,
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
      `SELECT comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, scoring_format, timezone, open_igc_upload
       FROM comp
       WHERE test = 0 AND creation_date >= ?
       ORDER BY creation_date DESC`
    )
      .bind(cutoffStr)
      .all();

    let adminComps: { results: Record<string, unknown>[] } = { results: [] };

    if (user) {
      // A super admin administers every competition, so surface all comps —
      // including test comps created by any comp admin, which the public query
      // hard-filters out. A regular admin sees only comps they hold a
      // `comp_admin` row for.
      adminComps = isSuperAdmin(user)
        ? await c.env.DB.prepare(
            `SELECT c.comp_id, c.name, c.category, c.creation_date, c.close_date, c.test, c.pilot_classes, c.default_pilot_class, c.gap_params, c.scoring_format, c.timezone, c.open_igc_upload
             FROM comp c
             ORDER BY c.creation_date DESC`
          ).all()
        : await c.env.DB.prepare(
            `SELECT c.comp_id, c.name, c.category, c.creation_date, c.close_date, c.test, c.pilot_classes, c.default_pilot_class, c.gap_params, c.scoring_format, c.timezone, c.open_igc_upload
             FROM comp c
             JOIN comp_admin ca ON c.comp_id = ca.comp_id
             WHERE ca.user_id = ?
             ORDER BY c.creation_date DESC`
          )
            .bind(user.id)
            .all();
    }

    // Task date range per comp — the list shows when a comp *runs* (first
    // task to last task), not when its row was created.
    const taskDates = await c.env.DB.prepare(
      `SELECT comp_id, MIN(task_date) AS first_task_date, MAX(task_date) AS last_task_date
       FROM task GROUP BY comp_id`
    ).all();
    const datesByComp = new Map(
      taskDates.results.map((r) => [
        r.comp_id as number,
        {
          first_task_date: r.first_task_date as string,
          last_task_date: r.last_task_date as string,
        },
      ])
    );

    // Merge admin + public (deduped); ordering is applied after the merge.
    // A super admin administers every comp, so mark the public ones as
    // admin too.
    const superAdmin = isSuperAdmin(user);
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
        first_task_date: datesByComp.get(r.comp_id as number)?.first_task_date ?? null,
        last_task_date: datesByComp.get(r.comp_id as number)?.last_task_date ?? null,
      })),
      ...publicComps.results
        .filter((r) => !adminIds.has(r.comp_id as number))
        .map((r) => ({
          ...encodeComp(alphabet, r),
          is_admin: superAdmin,
          pilot_classes: JSON.parse(r.pilot_classes as string),
          gap_params: r.gap_params ? JSON.parse(r.gap_params as string) : null,
          test: !!(r.test as number),
          open_igc_upload: !!(r.open_igc_upload as number),
          first_task_date: datesByComp.get(r.comp_id as number)?.first_task_date ?? null,
          last_task_date: datesByComp.get(r.comp_id as number)?.last_task_date ?? null,
        })),
    ];

    // Most recent event first: the list displays each comp's task date range,
    // so sort by when the comp *ran* (last task date), not when its row was
    // inserted. Comps with no tasks yet fall back to creation_date. Task
    // dates (YYYY-MM-DD) and creation_date (ISO timestamp) both compare
    // lexicographically, so one string compare orders the mix correctly.
    merged.sort((a, b) => {
      const aKey =
        a.last_task_date ?? ((a as Record<string, unknown>).creation_date as string);
      const bKey =
        b.last_task_date ?? ((b as Record<string, unknown>).creation_date as string);
      return bKey.localeCompare(aKey);
    });

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
        `SELECT comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, scoring_format, timezone, open_igc_upload, settings_reviewed
         FROM comp WHERE comp_id = ?`
      )
        .bind(compId)
        .first<Record<string, unknown>>();

      if (!comp) {
        return c.json({ error: "Competition not found" }, 404);
      }

      const isAdmin = await isCompAdmin(c.env.DB, compId, user);

      // Test comps require admin access
      if (comp.test && !isAdmin) {
        return c.json({ error: "Competition not found" }, 404);
      }

      // Get admin list (emails)
      const admins = await c.env.DB.prepare(
        `SELECT u.email, u.name FROM comp_admin ca
         JOIN "user" u ON ca.user_id = u.id
         WHERE ca.comp_id = ?`
      )
        .bind(compId)
        .all<{ email: string; name: string }>();

      // A super admin administers every comp without a comp_admin row. Surface
      // that to *their own* response (not other viewers) so the admin UI, which
      // keys off the caller's email appearing in `admins`, activates for them.
      const adminList = admins.results;
      if (
        isSuperAdmin(user) &&
        user &&
        !adminList.some((a) => a.email === user.email)
      ) {
        adminList.push({ email: user.email, name: user.name });
      }

      // Get tasks summary (xctsk is fetched only to derive the speed-section
      // warnings below; it is not echoed back in the response)
      const tasks = await c.env.DB.prepare(
        `SELECT t.task_id, t.name, t.task_date, t.creation_date,
                (t.xctsk IS NOT NULL) as has_xctsk, t.xctsk
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

      // Waypoint count (setup-guide signal + nav count) — the set is one JSON
      // array per comp, so its length is the count. Absent row → 0.
      const waypointCount = await c.env.DB.prepare(
        "SELECT json_array_length(waypoints) AS n FROM comp_waypoints WHERE comp_id = ?"
      )
        .bind(compId)
        .first<{ n: number }>();

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
        scoring_format: (comp.scoring_format as string) ?? "gap",
        open_igc_upload: !!(comp.open_igc_upload as number),
        admins: adminList,
        is_admin: isAdmin,
        tasks: tasks.results.map((t) => {
          // Task-definition warnings only apply to GAP race tasks —
          // open-distance tasks are a single TAKEOFF with no speed section
          // or goal.
          const isGap = ((comp.scoring_format as string) ?? "gap") === "gap";
          const speedSection = isGap
            ? speedSectionTypeWarnings(t.xctsk as string | null)
            : { missing_sss: false, missing_ess: false };
          return {
            task_id: encodeId(alphabet, t.task_id as number),
            name: t.name,
            task_date: t.task_date,
            creation_date: t.creation_date,
            has_xctsk: !!(t.has_xctsk as number),
            pilot_classes: taskClasses[t.task_id as number] ?? [],
            missing_sss: speedSection.missing_sss,
            missing_ess: speedSection.missing_ess,
            line_goal: isGap && hasLineGoal(t.xctsk as string | null),
          };
        }),
        pilot_count: pilotCount?.cnt ?? 0,
        waypoint_count: waypointCount?.n ?? 0,
        settings_reviewed: !!(comp.settings_reviewed as number),
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
    validated("json", updateCompSchema),
    async (c) => {
      const compId = c.var.ids.comp_id!;
      const body = c.req.valid("json");
      const alphabet = c.env.SQIDS_ALPHABET;

      // Fetch current state so we can compute audit diffs and validate consistency
      const current = await c.env.DB.prepare(
        `SELECT name, category, close_date, test, pilot_classes, default_pilot_class, gap_params, scoring_format, timezone, open_igc_upload
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
          scoring_format: string;
          timezone: string | null;
          open_igc_upload: number;
        }>();
      if (!current) return c.json({ error: "Competition not found" }, 404);

      // Resolve the new timezone up front: an explicit name is stored as-is,
      // while null means "back to automatic" — re-derive it from the task
      // location right away so the change is visible immediately (and stays
      // null only when the comp has no located task yet).
      let newTimezone: string | null | undefined;
      if (body.timezone !== undefined) {
        newTimezone = body.timezone;
        if (newTimezone === null) {
          const firstTask = await c.env.DB.prepare(
            `SELECT xctsk FROM task
             WHERE comp_id = ? AND xctsk IS NOT NULL
             ORDER BY task_date ASC, creation_date ASC LIMIT 1`
          )
            .bind(compId)
            .first<{ xctsk: string }>();
          newTimezone = timezoneForXctsk(firstTask?.xctsk) ?? null;
        }
      }

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

      // Build dynamic UPDATE. Any successful settings save counts as
      // "settings reviewed" for the setup guide — including a Save that keeps
      // every default — so the flag is set unconditionally. Presentational
      // only: no audit entry, no score bump.
      const updates: string[] = ["settings_reviewed = 1"];
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
      if (body.scoring_format !== undefined) {
        updates.push("scoring_format = ?");
        values.push(body.scoring_format);
      }
      if (newTimezone !== undefined) {
        updates.push("timezone = ?");
        values.push(newTimezone);
      }
      if (body.open_igc_upload !== undefined) {
        updates.push("open_igc_upload = ?");
        values.push(body.open_igc_upload ? 1 : 0);
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
      // Scoring behaviour knobs apply to every task in the comp — a change
      // marks all their materialized scores stale below.
      let scoringInputsChanged = false;
      if (body.gap_params !== undefined) {
        const oldGap = current.gap_params
          ? (JSON.parse(current.gap_params) as GAPParameters)
          : null;
        for (const line of describeGapParamChanges(
          oldGap,
          body.gap_params ?? null
        )) {
          auditChanges.push(line);
          scoringInputsChanged = true;
        }
      }
      if (
        body.scoring_format !== undefined &&
        body.scoring_format !== current.scoring_format
      ) {
        // Changing the scoring format re-scores every task in the comp.
        const fmtLabel = (f: string) =>
          f === "open_distance" ? "Open distance" : "GAP";
        auditChanges.push(
          `Changed scoring format from ${fmtLabel(current.scoring_format)} to ${fmtLabel(body.scoring_format)}`
        );
        scoringInputsChanged = true;
      }
      // Timezone is presentational only (scoring runs on UTC), but the
      // change is audit-logged like every other settings knob.
      if (newTimezone !== undefined && newTimezone !== current.timezone) {
        if (body.timezone === null) {
          auditChanges.push(
            newTimezone
              ? current.timezone
                ? `Reset timezone to automatic — derived "${newTimezone}" from the task location`
                : `Set timezone to "${newTimezone}" (derived from the task location)`
              : "Cleared timezone (no task location to derive it from)"
          );
        } else {
          auditChanges.push(
            describeChange("timezone", current.timezone, newTimezone)
          );
        }
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
      if (scoringInputsChanged) {
        await bumpAndRevalidateScores(
          c,
          await taskIdsForComp(c.env.DB, compId)
        );
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
        `SELECT comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, scoring_format, timezone, open_igc_upload
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
        scoring_format: (updated.scoring_format as string) ?? "gap",
        open_igc_upload: !!(updated.open_igc_upload as number),
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
