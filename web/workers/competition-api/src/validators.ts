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
  admin_emails: z.array(z.string().email().max(MAX_TEXT)).min(1).optional(),
});

// ── Pilot profile validators ──

export const updatePilotSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT).optional(),
  civl_id: z.string().max(MAX_TEXT).nullable().optional(),
  sporting_body_ids: z.record(z.string().max(MAX_TEXT)).nullable().optional(),
  phone: z.string().max(MAX_TEXT).nullable().optional(),
  glider: z.string().max(MAX_TEXT).nullable().optional(),
});

// ── Track validators ──

export const updatePenaltySchema = z.object({
  penalty_points: z.number().min(-10000).max(10000),
  penalty_reason: z.string().max(MAX_TEXT).nullable().optional(),
});

// ── Comp pilot validators ──

export const updateCompPilotSchema = z.object({
  pilot_class: pilotClassString.optional(),
  team_name: z.string().max(MAX_TEXT).nullable().optional(),
  driver_contact: z.string().max(MAX_TEXT).nullable().optional(),
  first_start_order: z.number().int().positive().nullable().optional(),
});

// ── Task validators ──

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;

export const createTaskSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT),
  task_date: z.string().regex(isoDateRegex, "Must be ISO date (YYYY-MM-DD)"),
  pilot_classes: pilotClassesArray,
  xctsk: z.record(z.unknown()).nullable().optional(),
});

export const updateTaskSchema = z.object({
  name: z.string().min(1).max(MAX_TEXT).optional(),
  task_date: z
    .string()
    .regex(isoDateRegex, "Must be ISO date (YYYY-MM-DD)")
    .optional(),
  pilot_classes: pilotClassesArray.optional(),
  xctsk: z.record(z.unknown()).nullable().optional(),
});
