/**
 * Whether a task is still accepting evidence, and who to write to when it is
 * not.
 *
 * A competition has `close_date`, which closes everything. A single task has
 * `submissions_closed` (migration 0028), which is what an organiser reaches for
 * at the end of the day: "task 3 is done, stop sending me files" while task 4
 * is still flying. (A competition's `test` flag hides it from everyone but its
 * own admins; that rule is `hiddenFromCaller` in `comp-visibility.ts`, since it
 * governs reads and writes alike.)
 *
 * Lives in its own module because the same rule has to hold at FOUR call sites
 * in three files — the self upload, the on-behalf upload, the anonymous
 * submit, and the manual flight. A rule copied four times is a rule that is
 * three-quarters enforced by the second time somebody edits it.
 *
 * The same goes for what the rule SAYS. The three upload routes answer every
 * refusal they share through `submissionComp`, `submissionTask` and
 * `uploadRejection` below, so a signed-in pilot is told what an anonymous one
 * is — the same sentence, the same `code`, and the same organisers to write
 * to. They used to phrase each refusal twice, and the signed-in copy lost the
 * code and the organisers on the way.
 */

import type { AuthUser } from "./env";
import { isCompAdmin, isSuperAdmin } from "./super-admin";
import { hiddenFromCaller } from "./comp-visibility";
import { encodeId } from "./sqids";
import type { TrackSubmissionRejection } from "./track-upload";

/**
 * Has the competition closed for submissions?
 *
 * A date-only `close_date` (e.g. "2026-12-31") means the END of that day, so a
 * pilot landing on the last afternoon is not turned away by a boundary nobody
 * told them about. Every submission route asks this question and each used to
 * answer it with its own copy of the same three lines — including the two in
 * igc.ts that were identical to each other.
 */
export function isCompClosed(closeDate: string | null): boolean {
  if (!closeDate) return false;
  const at = closeDate.includes("T") ? closeDate : closeDate + "T23:59:59Z";
  return new Date() > new Date(at);
}

/**
 * Enough of an address to recognise, not enough to learn.
 *
 * Used wherever a pilot is shown an address that is not provably theirs: the
 * "we emailed you" confirmation, and the registration picker, where seeing
 * `j***@example.com` is often how somebody realises which of two entries is
 * their own old address.
 */
export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}***@${domain}`;
}

/**
 * The submit form's field names, sent as `field` on a refusal that one step of
 * the form can fix, so the kit form (`rac/form.tsx`) shows the message under
 * that step's field and focuses it.
 *
 * Shared by the three upload routes (self, on-behalf, anonymous). A refusal no
 * field can fix — a sign-in, a closed comp, a duplicated roster row, a spent
 * budget — carries no `field`, and is shown beside Submit instead.
 * `docs/track-submission.md`, "Errors are repairable".
 */
export const SUBMIT_FIELD = {
  /** Which task did you fly? Also a comp that cannot be found. */
  task: "task",
  /** The identifier an anonymous pilot typed. */
  identifier: "identifier",
  /** The registration a signed-in pilot claimed. */
  registration: "registration",
  /** The IGC file. */
  file: "file",
} as const;

export interface Organiser {
  name: string;
  email: string;
}

/**
 * The organisers of a competition, with their addresses.
 *
 * Not a new exposure: `GET /api/comp/:comp_id` already returns `admins` with
 * emails to anonymous callers, and the public comp page renders them with a
 * `mailto:` link. It is included only on genuine failures, so this does not
 * become a harvesting endpoint.
 */
export async function organisersOf(
  db: D1Database,
  compId: number
): Promise<Organiser[]> {
  const rows = await db
    .prepare(
      `SELECT u.email, u.name FROM comp_admin ca
       JOIN "user" u ON ca.user_id = u.id
       WHERE ca.comp_id = ?`
    )
    .bind(compId)
    .all<{ email: string; name: string }>();
  // Site super admins may hold a row so they can operate the tools, but they
  // are not the competition's organisers — keep them out of pilot-facing
  // "contact the organiser" copy.
  return rows.results.filter((r) => !isSuperAdmin({ email: r.email }));
}

/** True when the organiser has closed this task for submissions. */
export async function taskSubmissionsClosed(
  db: D1Database,
  taskId: number
): Promise<boolean> {
  const row = await db
    .prepare("SELECT submissions_closed FROM task WHERE task_id = ?")
    .bind(taskId)
    .first<{ submissions_closed: number }>();
  return !!row?.submissions_closed;
}

/**
 * Whether this caller is stopped by a closed task.
 *
 * **Comp admins are not.** The stop exists to tell pilots to stop sending
 * files, not to lock the scorekeeper out of their own task — and the very next
 * thing that happens after closing is "Dave's card was corrupt, here is his
 * file". A flag that forces the organiser to reopen, upload and re-close would
 * simply stop being used. Their upload is audit-logged like every other, so a
 * post-close upload is visible rather than secret.
 *
 * The anonymous route has no admin concept and calls `taskSubmissionsClosed`
 * directly: it is a hard stop there.
 */
export async function submissionsBlockedFor(
  db: D1Database,
  compId: number,
  taskId: number,
  user: Pick<AuthUser, "id" | "email"> | null | undefined
): Promise<boolean> {
  if (!(await taskSubmissionsClosed(db, taskId))) return false;
  return !(await isCompAdmin(db, compId, user));
}

/**
 * The body every closed-task refusal answers with.
 *
 * Looks up its own names so a call site needs nothing but the two ids. It runs
 * only on the refusal path, so the extra query costs nothing anyone waits for.
 *
 * `code` is what the submit form branches on; `organisers` is who the pilot can
 * ask to reopen it, which is the only repair available to them.
 */
export async function submissionsClosedBody(
  db: D1Database,
  compId: number,
  taskId: number
): Promise<{
  error: string;
  code: "submissions_closed";
  comp: { name: string };
  task: { name: string };
  organisers: Organiser[];
}> {
  const names = await db
    .prepare(
      `SELECT c.name AS comp_name, t.name AS task_name
       FROM task t JOIN comp c ON c.comp_id = t.comp_id
       WHERE t.task_id = ?`
    )
    .bind(taskId)
    .first<{ comp_name: string; task_name: string }>();
  const taskName = names?.task_name ?? "This task";
  return {
    error: `"${taskName}" is closed for track submissions. The organisers can reopen it.`,
    code: "submissions_closed",
    comp: { name: names?.comp_name ?? "" },
    task: { name: taskName },
    organisers: await organisersOf(db, compId),
  };
}

// ── The refusals the three upload routes share ──────────────────────────────

/** A value of {@link SUBMIT_FIELD}. */
export type SubmitField = (typeof SUBMIT_FIELD)[keyof typeof SUBMIT_FIELD];

/**
 * What an upload refusal answers with. `error` is the sentence a person reads,
 * `code` what the submit form branches on, `field` the step that can fix it;
 * the rest is what the form needs to offer the fix (who to write to, which
 * comp, when it closed). docs/track-submission.md, "Errors are repairable".
 */
export type SubmitRefusalBody = {
  error: string;
  code: string;
  field?: SubmitField;
  comp?: { comp_id?: string; name: string };
  task?: { name: string };
  close_date?: string | null;
  organisers?: Organiser[];
  reason?: string;
};

/** A refusal, with the status every route answers it with. */
export type GateRefusal = {
  status: 400 | 403 | 404;
  body: SubmitRefusalBody;
};

/** The comp's id and name, as a refusal names them. */
function compRef(alphabet: string, comp: SubmissionComp): { comp_id: string; name: string } {
  return { comp_id: encodeId(alphabet, comp.comp_id), name: comp.name };
}

/**
 * A comp that does not exist — or a hidden `test` comp the caller may not
 * see, which answers EXACTLY the same, so no upload route is how somebody
 * discovers that one exists. Names the task field: picking another task is
 * the repair.
 */
export function compNotFoundRefusal(): GateRefusal {
  return {
    status: 404,
    body: {
      error: "We could not find that competition.",
      code: "comp_not_found",
      field: SUBMIT_FIELD.task,
    },
  };
}

/**
 * A comp past its close date (`isCompClosed`). No field: nothing on the form
 * fixes it, so it is shown beside Submit, with the organisers.
 */
export async function compClosedRefusal(
  db: D1Database,
  alphabet: string,
  comp: SubmissionComp
): Promise<GateRefusal> {
  return {
    status: 400,
    body: {
      error: `${comp.name} has closed for track submissions.`,
      code: "comp_closed",
      comp: compRef(alphabet, comp),
      close_date: comp.close_date,
      organisers: await organisersOf(db, comp.comp_id),
    },
  };
}

/** A task that is not this comp's. Picking another task is the repair. */
export function taskNotFoundRefusal(alphabet: string, comp: SubmissionComp): GateRefusal {
  return {
    status: 404,
    body: {
      error: `That task is not part of ${comp.name}.`,
      code: "task_not_found",
      field: SUBMIT_FIELD.task,
      comp: compRef(alphabet, comp),
    },
  };
}

/**
 * A task the organiser has closed for the day. Names the task field: the
 * pilot may well have meant yesterday's task, which is probably still open.
 */
export async function taskClosedRefusal(
  db: D1Database,
  compId: number,
  taskId: number
): Promise<GateRefusal> {
  return {
    status: 403,
    body: { ...(await submissionsClosedBody(db, compId, taskId)), field: SUBMIT_FIELD.task },
  };
}

/**
 * The pipeline refused the file (`ingestTrackSubmission`). A bad file names
 * the file field; a full task is the organiser's to fix, so it names no field
 * and says who they are. The organisers are looked up only on that path.
 */
export async function uploadRejection(
  db: D1Database,
  compId: number,
  rejection: TrackSubmissionRejection
): Promise<GateRefusal> {
  return {
    status: 400,
    body:
      rejection.kind === "invalid_file"
        ? {
            error: rejection.message,
            code: "invalid_file",
            field: SUBMIT_FIELD.file,
            reason: rejection.reason,
          }
        : {
            error: rejection.message,
            code: "task_pilot_limit",
            organisers: await organisersOf(db, compId),
          },
  };
}

// ── Resolving what a submission is for ──────────────────────────────────────

/**
 * The comp row every upload route reads: enough for the gate itself, for the
 * pipeline (`name`), and for each route's own rule — the self route's
 * registration (`default_pilot_class`, `open_registration`), and the
 * on-behalf and anonymous routes' `open_igc_upload`.
 */
export interface SubmissionComp {
  comp_id: number;
  name: string;
  close_date: string | null;
  test: number;
  default_pilot_class: string;
  open_registration: number;
  open_igc_upload: number;
}

export interface SubmissionTask {
  task_id: number;
  name: string;
  submissions_closed: number;
}

/**
 * The comp a submission is for, or why it cannot take one. In this order,
 * cheapest rejection first, and all of it before the body is read:
 *
 *   1. it exists;
 *   2. it is not a hidden `test` comp this caller may not see
 *      (`hiddenFromCaller` — null for the anonymous route, which no admin
 *      bypass can reach). Missing and hidden answer the same;
 *   3. the route's own rule about the comp, if it has one (`admit`): the
 *      anonymous route's "this comp wants a sign-in". It runs before the
 *      close date, so a closed comp that also wants a sign-in still asks for
 *      the sign-in;
 *   4. it has not closed (`isCompClosed`).
 *
 * The task is `submissionTask`'s, and anything a route checks between the two
 * — the on-behalf route's authorisation — sits between the two calls.
 */
export async function submissionComp(
  db: D1Database,
  alphabet: string,
  compId: number,
  caller: Pick<AuthUser, "id" | "email"> | null,
  admit?: (comp: SubmissionComp) => Promise<GateRefusal | null>
): Promise<{ comp: SubmissionComp } | { refusal: GateRefusal }> {
  const comp = await db
    .prepare(
      `SELECT comp_id, name, close_date, test, default_pilot_class,
              open_registration, open_igc_upload
       FROM comp WHERE comp_id = ?`
    )
    .bind(compId)
    .first<SubmissionComp>();
  if (!comp) return { refusal: compNotFoundRefusal() };
  // Being signed in is not a claim to somebody's rehearsal.
  if (await hiddenFromCaller(db, compId, comp.test, caller)) {
    return { refusal: compNotFoundRefusal() };
  }
  const refused = admit ? await admit(comp) : null;
  if (refused) return { refusal: refused };
  if (isCompClosed(comp.close_date)) {
    return { refusal: await compClosedRefusal(db, alphabet, comp) };
  }
  return { comp };
}

/**
 * The task a submission is for, or why it cannot take one: it must belong to
 * the comp, and it must not be closed for the day.
 *
 * `isOrganiser` is asked only when the task IS closed, because organisers
 * pass a closed task (see `submissionsBlockedFor` for why). The self route
 * looks it up then; the on-behalf route has already resolved it; the
 * anonymous route answers false — a hard stop, since an anonymous caller is
 * exactly who the organiser meant to stop.
 */
export async function submissionTask(
  db: D1Database,
  alphabet: string,
  comp: SubmissionComp,
  taskId: number,
  isOrganiser: () => Promise<boolean>
): Promise<{ task: SubmissionTask } | { refusal: GateRefusal }> {
  const task = await db
    .prepare(
      "SELECT task_id, name, submissions_closed FROM task WHERE task_id = ? AND comp_id = ?"
    )
    .bind(taskId, comp.comp_id)
    .first<SubmissionTask>();
  if (!task) return { refusal: taskNotFoundRefusal(alphabet, comp) };
  if (task.submissions_closed && !(await isOrganiser())) {
    return { refusal: await taskClosedRefusal(db, comp.comp_id, taskId) };
  }
  return { task };
}
