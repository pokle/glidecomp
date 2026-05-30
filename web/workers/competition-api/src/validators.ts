import { z } from "zod";

const MAX_TEXT = 128;

const pilotClassString = z.string().min(1).max(MAX_TEXT);

const pilotClassesArray = z
  .array(pilotClassString)
  .min(1)
  .max(20)
  .refine((arr) => new Set(arr).size === arr.length, {
    message: "Duplicate pilot classes",
  });

// ── Pilot status configuration ──
//
// Each comp has a list of statuses admins can assign to pilots per task
// (e.g. "safely landed", "DNF"). `on_track_upload` is the knob that hooks
// track uploads: a fresh track can leave the status alone, clear it, or
// set it. Keys are stable ASCII slugs used in URLs and audit logs; labels
// are the human-readable display form.
const statusKeyRegex = /^[a-z0-9_]+$/;
const pilotStatusEntrySchema = z
  .object({
    key: z.string().min(1).max(64).regex(statusKeyRegex, {
      message: "key must be lowercase ASCII letters, digits, or underscores",
    }),
    label: z.string().min(1).max(MAX_TEXT),
    on_track_upload: z.enum(["none", "clear", "set"]),
  })
  .strict();

export const pilotStatusesArray = z
  .array(pilotStatusEntrySchema)
  .max(20)
  .refine((arr) => new Set(arr.map((s) => s.key)).size === arr.length, {
    message: "Duplicate status keys",
  });

const gapParamsSchema = z
  .object({
    nominalLaunch: z.number().min(0).max(1),
    nominalDistance: z.number().positive(),
    nominalGoal: z.number().min(0).max(1),
    nominalTime: z.number().positive(),
    minimumDistance: z.number().positive(),
    scoring: z.enum(["PG", "HG"]),
    useLeading: z.boolean(),
    useArrival: z.boolean(),
  })
  .strict();

export const createCompSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT),
  category: z.enum(["hg", "pg"]),
  close_date: z.string().max(MAX_TEXT).nullable().optional(),
  test: z.boolean().optional(),
  pilot_classes: pilotClassesArray.optional(),
  default_pilot_class: pilotClassString.optional(),
  gap_params: gapParamsSchema.nullable().optional(),
});

export const updateCompSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT).optional(),
  category: z.enum(["hg", "pg"]).optional(),
  close_date: z.string().max(MAX_TEXT).nullable().optional(),
  test: z.boolean().optional(),
  pilot_classes: pilotClassesArray.optional(),
  default_pilot_class: pilotClassString.optional(),
  gap_params: gapParamsSchema.nullable().optional(),
  open_igc_upload: z.boolean().optional(),
  admin_emails: z.array(z.string().email().max(MAX_TEXT)).min(1).optional(),
  pilot_statuses: pilotStatusesArray.optional(),
});

// ── Pilot status (per-task) validators ──

export const upsertPilotStatusSchema = z.object({
  status_key: z.string().min(1).max(64).regex(statusKeyRegex),
  note: z.string().max(MAX_TEXT).nullable().optional(),
});

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
});
