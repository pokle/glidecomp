import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import { isValidTimezone } from "@glidecomp/engine/timezone";

/**
 * zValidator with a hook that turns zod failures into the API's standard
 * `{ error: string }` shape (e.g. "admin_emails.1: Invalid email"). Without
 * the hook the default 400 body nests the raw ZodError object under `error`,
 * which clients expecting a string render as nothing at all — the request
 * fails silently. All routes must use this instead of bare zValidator.
 */
export function validated<T extends z.ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T
) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const path = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      return c.json({ error: `${path}${issue?.message ?? "Invalid request"}` }, 400);
    }
  });
}

const MAX_TEXT = 128;

const pilotClassString = z.string().min(1).max(MAX_TEXT);

const pilotClassesArray = z
  .array(pilotClassString)
  .min(1)
  .max(20)
  .refine((arr) => new Set(arr).size === arr.length, {
    message: "Duplicate pilot classes",
  });

const gapParamsSchema = z
  .object({
    nominalLaunch: z.number().min(0).max(1),
    // Optional: when omitted the scorer auto-computes it per task
    // (70% of the optimized task distance), preserving the historical
    // default. Set it to pin a fixed comp-wide nominal distance.
    nominalDistance: z.number().positive().nullable().optional(),
    nominalGoal: z.number().min(0).max(1),
    nominalTime: z.number().positive(),
    minimumDistance: z.number().positive(),
    scoring: z.enum(["PG", "HG"]),
    useLeading: z.boolean(),
    useArrival: z.boolean(),
    // Leading coefficient variant (AirScore lc_formula). Optional; the
    // per-category default is 'weighted' for PG and 'classic' for HG (2024
    // spec, issue #258) when omitted.
    leadingFormula: z.enum(["classic", "weighted"]).optional(),
    // Leading-weight generation (paragliding only; issue #257). Optional; the
    // default is date-based — new PG comps default to 's7f2024' and older ones
    // to 'gap2020' (AirScore parity) — resolved in resolveCompGapParams.
    leadingWeightFormula: z.enum(["gap2020", "s7f2020", "s7f2024"]).optional(),
    // S7F 2024 §10 LeadingTimeRatio (0–0.5, spec default 0.26). Optional;
    // only used for PG under the 's7f2024' leadingWeightFormula.
    leadingTimeRatio: z.number().min(0).max(0.5).optional(),
    // Time-points exponent (FAI S7F §11.2), decoupled from the leading
    // variant (issue #258). Optional; the per-category default is '5/6'.
    // When omitted for a comp that saved a leadingFormula, the scorer keeps
    // the exponent that formula historically implied (classic → 2/3,
    // weighted → 5/6) so older saved comps keep their scores.
    timePointsExponent: z.enum(["2/3", "5/6"]).optional(),
    // Where scored distance begins. Optional; defaults to 'takeoff'
    // (FAI CIVL GAP / PWCA) when omitted. 'start' excludes the
    // take-off→SSS leg (HGFA wording / "Move Origin").
    distanceOrigin: z.enum(["takeoff", "start"]).optional(),
    // HG distance difficulty (FAI S7F §11.1.1). Optional; defaults to true.
    // No effect on paragliding.
    useDistanceDifficulty: z.boolean().optional(),
    // HG jump-the-gun (FAI S7F §12.2): seconds of early start per 1 penalty
    // point (X) and the maximum seconds early (Y) before the pilot is
    // scored for minimum distance. Optional; the scorer defaults to the
    // spec's X=2 / Y=300. PG early starts are handled without settings
    // (scored launch→SSS only).
    jumpTheGunFactor: z.number().positive().max(3600).optional(),
    jumpTheGunMaxSeconds: z.number().min(0).max(86400).optional(),
    // HG "ESS but not goal" (FAI S7F §12.1): fraction of time and arrival
    // points KEPT by a pilot who reaches ESS but lands before goal.
    // Optional; the scorer defaults to the spec's recommended 0.8. The spec
    // fixes PG at 0 — the engine ignores the value for PG comps.
    essNotGoalFactor: z.number().min(0).max(1).optional(),
    // PG score-back time in seconds (FAI S7F §5.6, §12.3.1): when a task is
    // stopped, the PG stop time is the announcement minus this. Optional;
    // the scorer defaults to the spec's 300 s (5 minutes). HG score-back is
    // one start-gate interval (or 15 min single-gate) and has no setting.
    scoreBackTime: z.number().min(0).max(3600).optional(),
  })
  .strict();

// Competition-local timezone — see migration 0011. Anything the runtime's
// Intl accepts (IANA names like "Australia/Melbourne"); null clears the
// setting so the server re-derives it from the task location.
export const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimezone, {
    message: "Must be a valid timezone name (e.g. Australia/Melbourne)",
  });

// Competition scoring format — see migration 0009. "gap" is the default
// CIVL GAP scoring (driven by gap_params); "open_distance" scores each pilot
// by the metres of open distance flown from the take-off exit.
export const scoringFormatSchema = z.enum(["gap", "open_distance"]);

export const createCompSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT),
  category: z.enum(["hg", "pg"]),
  close_date: z.string().max(MAX_TEXT).nullable().optional(),
  test: z.boolean().optional(),
  pilot_classes: pilotClassesArray.optional(),
  default_pilot_class: pilotClassString.optional(),
  gap_params: gapParamsSchema.nullable().optional(),
  scoring_format: scoringFormatSchema.optional(),
  timezone: timezoneSchema.nullable().optional(),
});

export const updateCompSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT).optional(),
  category: z.enum(["hg", "pg"]).optional(),
  close_date: z.string().max(MAX_TEXT).nullable().optional(),
  test: z.boolean().optional(),
  pilot_classes: pilotClassesArray.optional(),
  default_pilot_class: pilotClassString.optional(),
  gap_params: gapParamsSchema.nullable().optional(),
  scoring_format: scoringFormatSchema.optional(),
  timezone: timezoneSchema.nullable().optional(),
  open_igc_upload: z.boolean().optional(),
  admin_emails: z.array(z.string().email().max(MAX_TEXT)).min(1).optional(),
});

// ── Pilot status (per-task) validators ──
//
// Admins/pilots may hand-pick only the two "did not fly" outcomes. "Present"
// is the absence of a row (a DELETE returns a pilot to it). "Landed" is NOT
// hand-picked — it is DERIVED from an active flight record (a track or a
// manual flight); see manual-flight-store.ts. Accepting `landed` here would
// let an admin claim a landing with no scored evidence, which is exactly what
// manual flights replace (issue #306).
export const upsertPilotStatusSchema = z.object({
  status_key: z.enum(["absent", "dnf"]),
  note: z.string().max(MAX_TEXT).nullable().optional(),
});

// ── Manual flight (per-task, per-pilot) validators ──
//
// A manual flight scores a track-less pilot from the last turnpoint they
// legally reached plus where they landed (FAI S7F §8.4). last_reached_tp_index
// is an index into the FULL task turnpoints[] (Start/SSS … Goal); the server
// computes the made-good distance via the engine. duration_seconds is the
// speed-section time, only meaningful when the pilot is in goal.
export const upsertManualFlightSchema = z
  .object({
    last_reached_tp_index: z.number().int().min(0).max(49),
    landing_lat: z.number().min(-90).max(90),
    landing_lon: z.number().min(-180).max(180),
    duration_seconds: z.number().int().min(0).max(86400).nullable().optional(),
  })
  .strict();

export const updatePilotStatusNoteSchema = z.object({
  note: z.string().max(MAX_TEXT).nullable(),
});

// ── Pilot profile validators ──

const idField = z.string().max(MAX_TEXT).nullable().optional();

export const updatePilotSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT).optional(),
  civl_id: idField,
  safa_id: idField,
  ushpa_id: idField,
  bhpa_id: idField,
  dhv_id: idField,
  ffvl_id: idField,
  fai_id: idField,
  phone: z.string().max(MAX_TEXT).nullable().optional(),
  glider: z.string().max(MAX_TEXT).nullable().optional(),
  emergency_contact_name: z.string().max(MAX_TEXT).nullable().optional(),
  emergency_contact_phone: z.string().max(MAX_TEXT).nullable().optional(),
});

// ── Track validators ──

export const updatePenaltySchema = z.object({
  penalty_points: z.number().min(-10000).max(10000),
  penalty_reason: z.string().max(MAX_TEXT).nullable().optional(),
});

// ── Comp pilot validators ──

const optionalText = z.string().max(MAX_TEXT).nullable().optional();

/**
 * Fields that admins can set per-row for a comp_pilot. The registered_*
 * fields carry the admin-entered identity; `pilot_class` etc. carry
 * competition-specific metadata.
 */
export const compPilotFieldsSchema = z.object({
  // Identity (admin-entered; used both for display and for link resolution)
  registered_pilot_name: z.string().min(1).max(MAX_TEXT),
  registered_pilot_email: z.string().email().max(MAX_TEXT).nullable().optional(),
  registered_pilot_civl_id: optionalText,
  registered_pilot_safa_id: optionalText,
  registered_pilot_ushpa_id: optionalText,
  registered_pilot_bhpa_id: optionalText,
  registered_pilot_dhv_id: optionalText,
  registered_pilot_ffvl_id: optionalText,
  registered_pilot_fai_id: optionalText,
  registered_pilot_glider: optionalText,
  // Competition-specific
  pilot_class: pilotClassString,
  team_name: optionalText,
  driver_contact: optionalText,
  first_start_order: z.number().int().positive().nullable().optional(),
});

/** Create a single comp_pilot (admin). */
export const createCompPilotSchema = compPilotFieldsSchema;

/** Sparse update for a single comp_pilot — every field optional. */
export const updateCompPilotSchema = compPilotFieldsSchema.partial();

/**
 * Bulk upsert payload. Each row may include `comp_pilot_id` (encoded sqid)
 * to identify an existing row for update; omit it for a new row.
 * Rows not included in the payload are deleted by the server.
 *
 * Max 250 rows per request (matches the 250 pilots-per-comp cap).
 */
export const bulkPilotsSchema = z.object({
  pilots: z
    .array(
      compPilotFieldsSchema.extend({
        comp_pilot_id: z.string().max(MAX_TEXT).optional(),
      })
    )
    .max(250),
});

// ── Task validators ──

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

// ── XCTask (xctsk) — strict schema, SEC-12 ──
//
// Mirrors the engine's XCTask interface (web/engine/src/xctsk-parser.ts).
// Real-world samples in web/frontend/public/data/tasks/ are 1.1–2.0 KB;
// the limits here are 16–100× generous so any plausible task fits while
// pathological / DoS payloads are rejected. Unknown keys are stripped
// (Zod default) so spec extensions don't crash but also don't bloat D1.
//
// Last-line defence: a refine on the top-level checks the stringified
// JSON length against MAX_XCTSK_BYTES, catching anything that slips
// through individual field limits (e.g. 50 turnpoints × 64-char names
// would fit; 50 turnpoints × 64-char names + 100 timeGates is still
// well under 32 KB, but the refine guarantees it).
const MAX_XCTSK_BYTES = 32 * 1024;
const MAX_XCTSK_TURNPOINTS = 50;
const MAX_XCTSK_TIMEGATES = 100;
const XCTSK_NAME = z.string().min(1).max(64);
const XCTSK_DESCRIPTION = z.string().max(64).optional();
// XCTrack uses HH:MM:SSZ for gate / deadline times.
const XCTSK_TIME = z.string().min(1).max(16);

const xctskWaypointSchema = z
  .object({
    name: XCTSK_NAME,
    description: XCTSK_DESCRIPTION,
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    altSmoothed: z.number().min(-1000).max(30000).optional(),
  })
  .strict();

const xctskTurnpointSchema = z
  .object({
    type: z.enum(["TAKEOFF", "SSS", "ESS"]).optional(),
    radius: z.number().int().min(1).max(50000),
    waypoint: xctskWaypointSchema,
  })
  .strict();

const xctskSSSSchema = z
  .object({
    type: z.enum(["RACE", "ELAPSED-TIME"]),
    direction: z.enum(["ENTER", "EXIT"]),
    timeGates: z.array(XCTSK_TIME).max(MAX_XCTSK_TIMEGATES).optional(),
  })
  .strict();

const xctskGoalSchema = z
  .object({
    type: z.enum(["CYLINDER", "LINE"]),
    deadline: XCTSK_TIME.optional(),
    finishAltitude: z.number().min(-1000).max(30000).optional(),
  })
  .strict();

const xctskTakeoffSchema = z
  .object({
    timeOpen: XCTSK_TIME.optional(),
    timeClose: XCTSK_TIME.optional(),
  })
  .strict();

export const xctskSchema = z
  .object({
    taskType: z.string().min(1).max(32),
    version: z.number().int().min(0).max(99).optional(),
    earthModel: z.enum(["WGS84", "FAI_SPHERE"]).optional(),
    turnpoints: z
      .array(xctskTurnpointSchema)
      .min(1)
      .max(MAX_XCTSK_TURNPOINTS),
    takeoff: xctskTakeoffSchema.optional(),
    sss: xctskSSSSchema.optional(),
    goal: xctskGoalSchema.optional(),
    cylinderTolerance: z.number().min(0).max(0.1).optional(),
  })
  .strict()
  .refine(
    (v) => JSON.stringify(v).length <= MAX_XCTSK_BYTES,
    {
      message: `xctsk JSON too large (max ${MAX_XCTSK_BYTES} bytes)`,
    }
  );

export const createTaskSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT),
  task_date: z.string().regex(isoDateRegex, "Must be ISO date (YYYY-MM-DD)"),
  pilot_classes: pilotClassesArray,
  xctsk: xctskSchema.nullable().optional(),
});

export const updateTaskSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT).optional(),
  task_date: z
    .string()
    .regex(isoDateRegex, "Must be ISO date (YYYY-MM-DD)")
    .optional(),
  pilot_classes: pilotClassesArray.optional(),
  xctsk: xctskSchema.nullable().optional(),
  // Stopped tasks (issue #264, S7F §12.3): the task stop announcement time
  // as an ISO 8601 UTC datetime. Setting it scores the task as stopped;
  // null clears the stop (task scored as run to completion).
  stop_announcement_time: z
    .string()
    .refine((v) => !Number.isNaN(Date.parse(v)), "Must be an ISO 8601 datetime")
    .nullable()
    .optional(),
});
