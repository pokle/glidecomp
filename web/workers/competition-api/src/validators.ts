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

/** Character cap on a task's weather notes. Room for a few paragraphs of
 * debrief prose without letting the field become a document store. */
export const MAX_WEATHER_NOTES = 4000;

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
    // Optional: when omitted the scorer auto-computes it per task
    // (70% of the optimized task distance), preserving the historical
    // default. Set it to pin a fixed comp-wide nominal distance.
    nominalDistance: z.number().positive().nullable().optional(),
    nominalTime: z.number().positive(),
    minimumDistance: z.number().positive(),
    scoring: z.enum(["PG", "HG"]),
    useLeading: z.boolean(),
    useArrival: z.boolean(),
    // S7F 2026 §11 LeadingTimeRatio (0–0.26). Optional; the scorer defaults
    // per discipline (26% PG, 17.5% HG).
    leadingTimeRatio: z.number().min(0).max(0.26).optional(),
    // Where scored distance begins. Optional; defaults to 'takeoff'
    // (FAI CIVL GAP / PWCA) when omitted. 'start' excludes the
    // take-off→SSS leg (HGFA wording / "Move Origin").
    distanceOrigin: z.enum(["takeoff", "start"]).optional(),
    // HG distance difficulty (S7F 2026 §12.1.1). Optional; defaults to true.
    // No effect on paragliding.
    useDistanceDifficulty: z.boolean().optional(),
    // HG jump-the-gun (S7F 2026 §13.3): seconds of early start per 1 penalty
    // point (X) and the maximum seconds early (Y) before the pilot is
    // scored for minimum distance. Optional; the scorer defaults to the
    // spec's X=2 / Y=300. PG early starts are handled without settings
    // (scored launch→SSS only).
    jumpTheGunFactor: z.number().positive().max(3600).optional(),
    jumpTheGunMaxSeconds: z.number().min(0).max(86400).optional(),
    // HG "ESS but not goal" (S7F 2026 §13.2): fraction of time and arrival
    // points KEPT by a pilot who reaches ESS but lands before goal.
    // Optional; the scorer defaults to the spec's recommended 0.8. The spec
    // fixes PG at 0 — the engine ignores the value for PG comps.
    essNotGoalFactor: z.number().min(0).max(1).optional(),
    // ---- Legacy keys from pre-2026 editions ----
    // Accepted so older clients and re-submitted stored payloads don't
    // hard-fail, then STRIPPED: the 2026 edition fixes these values
    // (nominal launch 96%, nominal goal 30%, score-back HG 15 min / PG
    // 5 min) and pins the formula variants per discipline, so nothing may
    // depend on them. resolveCompGapParams ignores them in old stored rows
    // the same way.
    nominalLaunch: z.unknown().optional(),
    nominalGoal: z.unknown().optional(),
    scoreBackTime: z.unknown().optional(),
    leadingFormula: z.unknown().optional(),
    leadingWeightFormula: z.unknown().optional(),
    timePointsExponent: z.unknown().optional(),
  })
  .strict()
  .transform(({
    nominalLaunch: _nl,
    nominalGoal: _ng,
    scoreBackTime: _sb,
    leadingFormula: _lf,
    leadingWeightFormula: _lwf,
    timePointsExponent: _tpe,
    ...kept
  }) => kept);

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

// Competition series-scoring method — see migration 0022. "total" sums all
// task scores; "ftv" (Fixed Total Validity, S7F §15) counts only each pilot's
// best tasks up to a fixed validity. ftv_factor is the discard fraction
// (0 < f < 1); null auto-derives it from the task count (0.2 for ≤6, 0.25 ≥7).
export const seriesScoringSchema = z.enum(["total", "ftv"]);
export const ftvFactorSchema = z.number().gt(0).lt(1);

export const createCompSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT),
  category: z.enum(["hg", "pg"]),
  close_date: z.string().max(MAX_TEXT).nullable().optional(),
  test: z.boolean().optional(),
  pilot_classes: pilotClassesArray.optional(),
  default_pilot_class: pilotClassString.optional(),
  gap_params: gapParamsSchema.nullable().optional(),
  scoring_format: scoringFormatSchema.optional(),
  series_scoring: seriesScoringSchema.optional(),
  ftv_factor: ftvFactorSchema.nullable().optional(),
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
  series_scoring: seriesScoringSchema.optional(),
  ftv_factor: ftvFactorSchema.nullable().optional(),
  timezone: timezoneSchema.nullable().optional(),
  open_igc_upload: z.boolean().optional(),
  open_registration: z.boolean().optional(),
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

/**
 * The scorekeeper's ruling on a tracklog that failed an automatic
 * data-quality check. FAI S7A §4.4.6 makes rejecting a track log the
 * organiser's judgement, so the automatic verdict must be overrulable:
 * `true` scores and analyses the track normally, findings and all.
 */
export const trackQualityOverrideSchema = z.object({
  quality_override: z.boolean(),
});

// ── Comp pilot validators ──

/** Shared by the comp-pilot ranking date and the task validators below. */
const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

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
  // The pilot's WPRS score, copied onto the roster (never looked up live —
  // see migrations 0029/0030) and overridable by the organiser. The two source
  // fields say which CIVL list and which monthly snapshot it came from; both
  // null means a hand-entered number.
  //
  // REAL and not an integer: CIVL publishes one decimal, and near the top of a
  // list that decimal is the whole difference between two pilots. The ceiling
  // is far above the best score ever published (431.2 in August 2026) and only
  // exists so the column cannot be used as free numeric storage.
  wprs_points: z.number().positive().max(10000).nullable().optional(),
  civl_ranking_slug: z
    .string()
    .max(MAX_TEXT)
    // A civlcomps.org URL segment ('hang-gliding-class-1-xc'). Constrained
    // because it is rendered as the source of a published number; free text
    // here would let a roster import label a rank with anything at all.
    .regex(/^[a-z0-9-]+$/, "must be a CIVL ranking list slug")
    .nullable()
    .optional(),
  civl_ranking_date: z
    .string()
    .regex(isoDateRegex, "must be an ISO date (YYYY-MM-DD)")
    .nullable()
    .optional(),
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

/**
 * The roster to look up against the CIVL ranking lists — the grid's CURRENT
 * contents, which is why it is a body rather than the stored roster. Only the
 * two fields the matching uses are accepted; the same 250-row cap applies, and
 * it bounds the bound-parameter count of the lookup's single query.
 */
export const civlRankingLookupSchema = z.object({
  pilots: z
    .array(
      z.object({
        name: z.string().max(MAX_TEXT),
        civl_id: optionalText,
      })
    )
    .max(250),
});

// ── Task validators ──

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
  // The organizer's free-text account of the day's conditions — "overdeveloped
  // by 2pm, glass off at 3". Longer than MAX_TEXT because this is prose, not a
  // label; not a scoring input, so no format is imposed beyond a length cap.
  weather_notes: z.string().max(MAX_WEATHER_NOTES).optional(),
  // "This task is done — stop sending me files." Blocks tracks and manual
  // flights for THIS task only; organisers still upload, so a recovered SD
  // card does not need the switch flipped twice. Not a scoring input: whether
  // FURTHER evidence may arrive changes no score that exists.
  submissions_closed: z.boolean().optional(),
});
