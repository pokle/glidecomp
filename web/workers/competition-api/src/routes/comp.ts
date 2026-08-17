import { Hono } from "hono";
import type { AuthedEnv } from "../env";
import { encodeId } from "../sqids";
import { sqidsMiddleware } from "../middleware/sqids";
import { requireAuth, optionalAuth, requireCompAdmin } from "../middleware/auth";
import { isCompAdmin, isSuperAdmin } from "../super-admin";
import { createCompSchema, updateCompSchema, validated } from "../validators";
import {
  boolFromDb,
  boolToDb,
  deepChanged,
  planPatch,
  type PatchFieldTable,
} from "../lib/patch-fields";
import type { z } from "zod";
import { audit, auditAll, describeChange } from "../audit";
import { bumpAndRevalidateScores, taskIdsForComp } from "../score-store";
import { speedSectionTypeWarnings, hasLineGoal, taskRouteSummary } from "../xctsk-summary";
import {
  defaultsFor,
  resolveCompGapParams,
  resolveLeadingTimeRatio,
  type GAPParameters,
} from "@glidecomp/engine";
import { timezoneForXctsk } from "@glidecomp/engine/timezone";

const MAX_COMPS_PER_ACCOUNT = 50;

type GapParamInput = Partial<Omit<GAPParameters, "nominalDistance">> & {
  nominalDistance?: number | null;
};

type CompCategory = "hg" | "pg";

/**
 * The Wing, in the words the settings form's own radio group uses
 * (`CategoryField` in the frontend's comp/fields.tsx). The column is called
 * `category`, but no screen has ever shown a reader that word or the stored
 * codes — the audit log was the one place they leaked out.
 */
const WING_LABEL: Record<CompCategory, string> = {
  hg: "Hang Gliding",
  pg: "Paragliding",
};

const wingLabel = (value: unknown): string =>
  WING_LABEL[value as CompCategory] ?? String(value);

/**
 * The GAP scoring class a Wing implies.
 *
 * The Wing is a GLOBAL competition setting that happens to have a copy inside
 * the formula: `gap_params.scoring` is derived from it and never picked
 * independently — the Settings dialog says as much ("The scoring class (HG/PG)
 * follows the Wing above") and has no control for it. `defaultsFor` is where
 * that mapping lives, so read it rather than restating it here.
 */
const scoringForWing = (category: CompCategory): GAPParameters["scoring"] =>
  defaultsFor(category).scoring;

/**
 * Force a gap_params payload's scoring class to follow the Wing.
 *
 * Applied on every write, because the read side lets the copy outrank the
 * original: `resolveCompGapParams` starts from `defaultsFor(category)` and
 * then lets a stored `scoring` overwrite it, so a gap_params that disagreed
 * with the Wing would silently win. Deriving it as it is stored means the two
 * can never disagree in the first place, and no scoring behaviour changes for
 * anything already in the database — including the per-task overrides imported
 * AirScore comps carry.
 */
function withWingScoring<T extends GapParamInput>(
  gap: T,
  category: CompCategory
): T {
  return { ...gap, scoring: scoringForWing(category) };
}

/**
 * Resolve one side of the audit diff the way the SCORER resolves it: the
 * stored partial merged over the official per-category defaults
 * (`resolveCompGapParams`), never over the raw engine baseline.
 *
 * The two are not the same set of values — `DEFAULT_GAP_PARAMETERS` keeps
 * leading, arrival and (for PG) difficulty OFF so partial-param engine
 * callers stay backwards-compatible, while a competition is scored from
 * `defaultsFor(category)`, which turns on the terms the FAI formula uses.
 * Diffing against the baseline made a comp whose gap_params was still null
 * read as "everything off", so the first settings save announced knobs the
 * organiser never touched and rescored every task to the same numbers
 * (issue #633).
 *
 * nominalDistance is left out: null there means "auto (per task)", which a
 * resolved GAPParameters cannot represent, so it is compared from the raw
 * stored values by the caller.
 */
function resolveForAudit(
  category: CompCategory,
  gap: GapParamInput | null
): GAPParameters {
  if (!gap) return resolveCompGapParams(category, null);
  const { nominalDistance: _auto, ...rest } = gap;
  void _auto;
  return resolveCompGapParams(category, rest);
}

/**
 * Describe GAP scoring parameter changes as human-readable audit lines.
 *
 * Both sides are resolved against the category they were (and will be)
 * scored under — the pre-update category for the old values, the incoming one
 * for the new — so a category switch is described as the parameter moves it
 * really makes, not as a re-statement of every per-category default.
 *
 * Friendly units are used (km, min, %) rather than the stored
 * meters/seconds/fractions. A missing/null nominalDistance means the
 * scorer auto-computes it per task, so it reads as "auto (per task)".
 * When the whole object is reset to null, a single line is returned.
 *
 * An empty result is the "nothing moved" signal: `planPatch` neither logs nor
 * bumps the materialized scores for it, so a save that keeps the effective
 * parameters is silent and free.
 */
function describeGapParamChanges(
  oldGap: GapParamInput | null,
  newGap: GapParamInput | null,
  oldCategory: CompCategory,
  newCategory: CompCategory
): string[] {
  if (oldGap === null && newGap === null && oldCategory === newCategory) {
    return [];
  }
  const o = resolveForAudit(oldCategory, oldGap);
  const n = resolveForAudit(newCategory, newGap);
  const oDist = oldGap?.nominalDistance ?? null;
  const nDist = newGap?.nominalDistance ?? null;
  const km = (m: number | null) =>
    m == null ? "auto (per task)" : `${Math.round((m / 1000) * 10) / 10} km`;
  const min = (s: number) => `${Math.round(s / 60)} min`;
  // One decimal place, trimmed: the §11 HG default is 17.5%, and whole-percent
  // rounding would report it as 18% — and a 17.5% → 17.6% edit as a line
  // reading "from 18% to 18%".
  const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;

  const out: string[] = [];
  // The scoring class is the Wing's copy inside the formula. When each side
  // matches the wing it was scored under, the wing's own sentence already
  // reports this and a second line would just repeat it in GAP's vocabulary —
  // on an open-distance comp, about a formula that never scores it. A stored
  // value that does NOT follow its wing is a setting somebody picked
  // deliberately (only reachable through the API), so that still gets a line.
  const followsWing =
    o.scoring === scoringForWing(oldCategory) &&
    n.scoring === scoringForWing(newCategory);
  if (o.scoring !== n.scoring && !followsWing) {
    out.push(describeChange("scoring class", o.scoring, n.scoring));
  }
  if (oDist !== nDist) {
    out.push(`Changed nominal distance from ${km(oDist)} to ${km(nDist)}`);
  }
  if (o.nominalTime !== n.nominalTime) {
    out.push(`Changed nominal time from ${min(o.nominalTime)} to ${min(n.nominalTime)}`);
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
  // §11 Leading Time Ratio — changes every pilot's leading↔time split, so
  // it is individually audit-logged. Read through the same clamp-and-default
  // the scorer reads it through, so an out-of-range stored value is described
  // as the value that will actually be used.
  const oLtr = resolveLeadingTimeRatio(o);
  const nLtr = resolveLeadingTimeRatio(n);
  if (oLtr !== nLtr) {
    out.push(describeChange("leading-time ratio", pct(oLtr), pct(nLtr)));
  }
  if (o.distanceOrigin !== n.distanceOrigin) {
    out.push(describeChange("distance origin", o.distanceOrigin, n.distanceOrigin));
  }
  if (o.useDistanceDifficulty !== n.useDistanceDifficulty) {
    out.push(
      n.useDistanceDifficulty
        ? "Enabled HG distance difficulty"
        : "Disabled HG distance difficulty (pure linear distance points)",
    );
  }
  // Jump-the-gun settings (S7F §13.3) directly change how HG early starts
  // are penalised, so both knobs are individually audit-logged.
  if (o.jumpTheGunFactor !== n.jumpTheGunFactor) {
    out.push(
      `Changed jump-the-gun penalty rate from 1 point per ${o.jumpTheGunFactor} s early to 1 point per ${n.jumpTheGunFactor} s early`
    );
  }
  if (o.jumpTheGunMaxSeconds !== n.jumpTheGunMaxSeconds) {
    out.push(
      `Changed jump-the-gun limit from ${o.jumpTheGunMaxSeconds} s to ${n.jumpTheGunMaxSeconds} s early (beyond it, minimum distance)`
    );
  }
  // ESS-but-not-goal (S7F §13.2): the share of time and arrival points an
  // HG pilot keeps after reaching ESS but landing before goal.
  if (o.essNotGoalFactor !== n.essNotGoalFactor) {
    out.push(
      `Changed the ESS-but-not-goal factor from ${pct(o.essNotGoalFactor)} to ${pct(n.essNotGoalFactor)} of time and arrival points kept (HG, S7F §13.2)`
    );
  }

  // Clearing the whole object is one line, not a dozen — but only when the
  // clear actually moves something. Dropping a stored set that already held
  // the per-category defaults changes no score and needs no record.
  if (newGap === null) {
    return out.length === 0 ? [] : ["Reset GAP scoring parameters to defaults"];
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

/**
 * The comp row on the wire: ids encoded, SQLite's 0/1 booleans as booleans,
 * JSON columns parsed, absent columns defaulted.
 *
 * One function because GET and PATCH must answer with the same shape — they
 * used to carry two copies of this cast-by-cast, and a field added to one is
 * a field the other silently stops returning.
 */
function serializeComp(alphabet: string, row: Record<string, unknown>) {
  return {
    ...encodeComp(alphabet, row),
    test: !!(row.test as number),
    pilot_classes: JSON.parse(row.pilot_classes as string) as string[],
    default_pilot_class: row.default_pilot_class,
    gap_params: row.gap_params
      ? (JSON.parse(row.gap_params as string) as GAPParameters)
      : null,
    scoring_format: (row.scoring_format as string) ?? "gap",
    series_scoring: (row.series_scoring as string) ?? "total",
    ftv_factor: (row.ftv_factor as number | null) ?? null,
    open_igc_upload: !!(row.open_igc_upload as number),
    open_registration: !!(row.open_registration as number),
  };
}

/**
 * What each updatable comp field means: where it is stored, and what a change
 * to it does to the audit log and to the published scores.
 *
 * Built per request because two entries need the request in scope — the
 * timezone's audit sentence depends on whether the organiser asked for
 * "automatic", and the resolved value is worked out before the table is used.
 *
 * The `bumpsScores` column is the important one to be able to read down.
 * Series scoring (total ↔ FTV) and the FTV factor deliberately do NOT carry
 * it: FTV is a pure aggregation over the stored task scores, computed live in
 * GET /scores (which folds these two fields into its ETag), so they change
 * published SCORES without changing any per-task score. Bumping every task
 * would be wasted work that changes nothing.
 */
function compFieldTable(
  body: z.infer<typeof updateCompSchema>,
  resolvedTimezone: string | null | undefined,
  currentCategory: CompCategory
): PatchFieldTable<z.infer<typeof updateCompSchema>> {
  const fmtLabel = (f: string) => (f === "open_distance" ? "Open distance" : "GAP");
  const seriesLabel = (s: string) => (s === "ftv" ? "FTV" : "Sum of task scores");
  const ftvLabel = (f: number | null) =>
    f === null ? "automatic" : `${Math.round(f * 100)}%`;

  return {
    name: {
      column: "name",
      describe: (was, now) => describeChange("name", was, now),
    },
    // The Wing. It picks the per-category GAP profile every task is resolved
    // through (resolveCompGapParams), so on a comp that has never pinned its
    // own gap_params it IS the scoring formula — hence the bump. Its sentence
    // is the ONE record of the change: describeGapParamChanges suppresses the
    // scoring class that merely follows it.
    category: {
      column: "category",
      describe: (was, now) =>
        `Changed wing from ${wingLabel(was)} to ${wingLabel(now)}`,
      bumpsScores: true,
    },
    close_date: {
      column: "close_date",
      describe: (was, now) => describeChange("close date", was, now),
    },
    test: {
      column: "test",
      toDb: boolToDb,
      fromDb: boolFromDb,
      describe: (was, now) => describeChange("test flag", was, now),
    },
    pilot_classes: {
      column: "pilot_classes",
      toDb: (v) => JSON.stringify(v),
      fromDb: (v) => JSON.parse(v as string) as string[],
      changed: deepChanged,
      describe: (was, now) =>
        `Changed pilot classes from [${(was as string[]).join(", ")}] to [${(now as string[]).join(", ")}]`,
    },
    default_pilot_class: {
      column: "default_pilot_class",
      describe: (was, now) => describeChange("default pilot class", was, now),
    },
    // The scoring formula itself. describeGapParamChanges emits one line per
    // knob that moved and none at all when the object is equivalent, so an
    // untouched save neither logs nor bumps.
    gap_params: {
      column: "gap_params",
      toDb: (v) => (v ? JSON.stringify(v) : null),
      fromDb: (v) => (v ? (JSON.parse(v as string) as GAPParameters) : null),
      changed: deepChanged,
      describe: (was, now) =>
        describeGapParamChanges(
          was as GapParamInput | null,
          now as GapParamInput | null,
          currentCategory,
          body.category ?? currentCategory
        ),
      bumpsScores: true,
    },
    scoring_format: {
      column: "scoring_format",
      describe: (was, now) =>
        `Changed scoring format from ${fmtLabel(was as string)} to ${fmtLabel(now as string)}`,
      bumpsScores: true,
    },
    series_scoring: {
      column: "series_scoring",
      describe: (was, now) =>
        `Changed series scoring from ${seriesLabel(was as string)} to ${seriesLabel(now as string)}`,
    },
    ftv_factor: {
      column: "ftv_factor",
      fromDb: (v) => (v as number | null) ?? null,
      describe: (was, now) =>
        describeChange(
          "FTV discard factor",
          ftvLabel(was as number | null),
          ftvLabel(now as number | null)
        ),
    },
    // The timezone stopped being presentational with track-quality.ts: the
    // "wrong day" check builds the task's LOCAL calendar day in this zone to
    // decide whether a tracklog belongs to the task at all (FAI S7A §4.4.2),
    // so changing it can change which pilots are scored.
    //
    // The body's `null` means "back to automatic", so the value written is the
    // one already derived from the task location — see the caller.
    timezone: {
      column: "timezone",
      toDb: () => resolvedTimezone,
      changed: (was) => was !== resolvedTimezone,
      describe: (was) =>
        body.timezone === null
          ? resolvedTimezone
            ? was
              ? `Reset timezone to automatic — derived "${resolvedTimezone}" from the task location`
              : `Set timezone to "${resolvedTimezone}" (derived from the task location)`
            : "Cleared timezone (no task location to derive it from)"
          : describeChange("timezone", was, resolvedTimezone),
      bumpsScores: true,
    },
    open_igc_upload: {
      column: "open_igc_upload",
      toDb: boolToDb,
      fromDb: boolFromDb,
      describe: (_was, now) =>
        now
          ? "Enabled open IGC upload (any registered pilot can upload on behalf)"
          : "Disabled open IGC upload (admins only)",
    },
    open_registration: {
      column: "open_registration",
      toDb: boolToDb,
      fromDb: boolFromDb,
      describe: (_was, now) =>
        now
          ? "Enabled open registration (a pilot joins by uploading a track)"
          : "Disabled open registration (only an admin can add pilots)",
    },
  };
}

export const compRoutes = new Hono<AuthedEnv>()
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

      // The formula's copy of the Wing follows the Wing — see withWingScoring.
      const gapParams = body.gap_params
        ? withWingScoring(body.gap_params, body.category)
        : null;

      // New PG GAP comps default to FTV series scoring (the paragliding norm,
      // S7A §5.2.5.1); HG and open-distance comps default to sum-of-tasks. The
      // DB column default stays "total", so this only affects newly created
      // comps — existing comps' published scores never change silently.
      const seriesScoring =
        body.series_scoring ??
        (body.category === "pg" && scoringFormat === "gap" ? "ftv" : "total");
      const ftvFactor = body.ftv_factor ?? null;

      const compResult = await c.env.DB.prepare(
        `INSERT INTO comp (name, creation_date, close_date, category, test, pilot_classes, default_pilot_class, gap_params, scoring_format, series_scoring, ftv_factor, timezone)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
        .bind(
          body.name,
          now,
          closeDate,
          body.category,
          body.test ? 1 : 0,
          JSON.stringify(pilotClasses),
          defaultClass,
          gapParams ? JSON.stringify(gapParams) : null,
          scoringFormat,
          seriesScoring,
          ftvFactor,
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
          gap_params: gapParams,
          scoring_format: scoringFormat,
          series_scoring: seriesScoring,
          ftv_factor: ftvFactor,
          timezone: body.timezone ?? null,
          open_igc_upload: true,
          open_registration: true,
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
      `SELECT comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, scoring_format, timezone, open_igc_upload, open_registration
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
            `SELECT c.comp_id, c.name, c.category, c.creation_date, c.close_date, c.test, c.pilot_classes, c.default_pilot_class, c.gap_params, c.scoring_format, c.timezone, c.open_igc_upload, c.open_registration
             FROM comp c
             ORDER BY c.creation_date DESC`
          ).all()
        : await c.env.DB.prepare(
            `SELECT c.comp_id, c.name, c.category, c.creation_date, c.close_date, c.test, c.pilot_classes, c.default_pilot_class, c.gap_params, c.scoring_format, c.timezone, c.open_igc_upload, c.open_registration
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
        open_registration: !!(r.open_registration as number),
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
          open_registration: !!(r.open_registration as number),
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
        `SELECT comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, scoring_format, series_scoring, ftv_factor, timezone, open_igc_upload, open_registration, settings_reviewed
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
        ...serializeComp(alphabet, comp),
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
            // Enough geometry for the task list's compact route diagrams —
            // a trim of the stored xctsk, not the whole thing.
            route: taskRouteSummary(t.xctsk as string | null),
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

      // The pre-update row: what the audit diffs compare against, and what
      // the consistency check below reads for the fields the body omits.
      const current = await c.env.DB.prepare(
        `SELECT name, category, close_date, test, pilot_classes, default_pilot_class, gap_params, scoring_format, series_scoring, ftv_factor, timezone, open_igc_upload, open_registration
         FROM comp WHERE comp_id = ?`
      )
        .bind(compId)
        .first<Record<string, unknown>>();
      if (!current) return c.json({ error: "Competition not found" }, 404);

      // Resolve the new timezone up front: an explicit name is stored as-is,
      // while null means "back to automatic" — re-derive it from the task
      // location right away so the change is visible immediately (and stays
      // null only when the comp has no located task yet).
      let resolvedTimezone: string | null | undefined;
      if (body.timezone !== undefined) {
        resolvedTimezone = body.timezone;
        if (resolvedTimezone === null) {
          const firstTask = await c.env.DB.prepare(
            `SELECT xctsk FROM task
             WHERE comp_id = ? AND xctsk IS NOT NULL
             ORDER BY task_date ASC, creation_date ASC LIMIT 1`
          )
            .bind(compId)
            .first<{ xctsk: string }>();
          resolvedTimezone = timezoneForXctsk(firstTask?.xctsk) ?? null;
        }
      }

      // If updating pilot_classes or default_pilot_class, validate consistency
      if (body.pilot_classes || body.default_pilot_class) {
        const newClasses =
          body.pilot_classes ??
          (JSON.parse(current.pilot_classes as string) as string[]);
        const newDefault =
          body.default_pilot_class ?? (current.default_pilot_class as string);

        if (!newClasses.includes(newDefault)) {
          return c.json(
            { error: "default_pilot_class must be one of pilot_classes" },
            400
          );
        }
      }

      // Keep the formula's copy of the Wing in step with the Wing itself.
      //
      // Two cases, and the second is the one that bites: a body carrying
      // gap_params gets its scoring class derived, and a body that moves the
      // Wing while carrying NO gap_params has to rewrite the stored copy too —
      // otherwise it is left behind on the old wing, where the read side would
      // let it outrank the new one (see withWingScoring). Done here rather
      // than in the field table's toDb so the audit diff and the stored value
      // are the same object: describing a scoring change the write then
      // normalises away is exactly the class of lie issue #633 was about.
      const currentCategory: CompCategory = current.category === "pg" ? "pg" : "hg";
      const nextCategory: CompCategory = body.category ?? currentCategory;
      const patch = { ...body };
      if (patch.gap_params) {
        patch.gap_params = withWingScoring(patch.gap_params, nextCategory);
      } else if (
        patch.gap_params === undefined &&
        nextCategory !== currentCategory &&
        current.gap_params
      ) {
        patch.gap_params = withWingScoring(
          JSON.parse(current.gap_params as string) as NonNullable<
            typeof patch.gap_params
          >,
          nextCategory
        );
      }

      const plan = planPatch(
        patch,
        current,
        compFieldTable(patch, resolvedTimezone, currentCategory)
      );

      // Any successful settings save counts as "settings reviewed" for the
      // setup guide — including a Save that keeps every default — so the flag
      // is set unconditionally. Presentational only: no audit entry, no score
      // bump, and it is why the UPDATE always has something to write.
      await c.env.DB.prepare(
        `UPDATE comp SET ${["settings_reviewed = 1", ...plan.assignments].join(", ")} WHERE comp_id = ?`
      )
        .bind(...plan.values, compId)
        .run();

      // Scoring behaviour knobs apply to every task in the comp.
      if (plan.bumpsScores) {
        await bumpAndRevalidateScores(c, await taskIdsForComp(c.env.DB, compId));
      }

      const compName = body.name ?? (current.name as string);
      await auditAll(
        c.env.DB,
        c.var.user,
        compId,
        plan.audits.map((description) => ({
          subject_type: "comp" as const,
          subject_id: compId,
          subject_name: compName,
          description,
        }))
      );

      // Handle admin management via email resolution
      if (body.admin_emails) {
        await updateAdmins(c.env.DB, compId, body.admin_emails);
        await audit(c.env.DB, c.var.user, compId, {
          subject_type: "comp",
          subject_id: compId,
          subject_name: compName,
          description: `Updated admin list (${body.admin_emails.length} admin${body.admin_emails.length === 1 ? "" : "s"})`,
        });
      }

      // Return updated comp
      const updated = await c.env.DB.prepare(
        `SELECT comp_id, name, category, creation_date, close_date, test, pilot_classes, default_pilot_class, gap_params, scoring_format, series_scoring, ftv_factor, timezone, open_igc_upload, open_registration
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
        ...serializeComp(alphabet, updated),
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
