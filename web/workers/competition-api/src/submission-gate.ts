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
 */

import type { AuthUser } from "./env";
import { isCompAdmin } from "./super-admin";

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
  return rows.results;
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
