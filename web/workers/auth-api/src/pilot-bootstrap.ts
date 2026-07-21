/**
 * Sign-in pilot bootstrap.
 *
 * Lazily ensure every signed-in account has a `pilot` row, then claim any
 * unlinked comp_pilot pre-registrations carrying the account's email.
 * Runs from the Better Auth session-create hook (see auth.ts), i.e. on
 * every sign-in — OAuth, email OTP, and dev-login alike.
 *
 * Why: `pilot` rows used to be created only on profile save or IGC upload,
 * so an account that had done neither was invisible to the competition
 * API's `resolvePilotId` — an admin adding that pilot's email to a comp
 * roster linked nothing, silently. Creating the row at sign-in makes every
 * account resolvable from its first session, and the email claim pass
 * links pre-registrations made BEFORE the account ever existed.
 *
 * Email is the only identity available here (national-body IDs live on the
 * pilot profile, which is empty at bootstrap) — ID-based matching stays
 * with competition-api's pilot-linker, which runs on profile saves. The
 * claim mirrors pilot-linker semantics: per-row conditional UPDATE, and a
 * failure (e.g. the partial unique index on (comp_id, pilot_id) firing
 * because this pilot already holds another row in that comp) skips that
 * row only.
 *
 * Best-effort throughout: a bootstrap failure must never fail the sign-in.
 */

export async function bootstrapPilotForUser(
  db: D1Database,
  userId: string
): Promise<void> {
  try {
    // 1) Ensure the pilot row (INSERT OR IGNORE — user_id is UNIQUE).
    await db
      .prepare(
        `INSERT OR IGNORE INTO pilot (user_id, name)
         SELECT id, name FROM "user" WHERE id = ?`
      )
      .bind(userId)
      .run();

    const pilot = await db
      .prepare(
        `SELECT p.pilot_id, u.email, u.name
         FROM pilot p JOIN "user" u ON u.id = p.user_id
         WHERE p.user_id = ?`
      )
      .bind(userId)
      .first<{ pilot_id: number; email: string | null; name: string }>();
    if (!pilot?.email) return;

    // 2) Claim unlinked pre-registrations carrying this account's email —
    //    every comp, closed ones included (same rationale as pilot-linker:
    //    a link is a statement about identity, not a competition mutation).
    const candidates = await db
      .prepare(
        `SELECT comp_pilot_id, comp_id, registered_pilot_name
         FROM comp_pilot
         WHERE pilot_id IS NULL AND registered_pilot_email = ?`
      )
      .bind(pilot.email)
      .all<{
        comp_pilot_id: number;
        comp_id: number;
        registered_pilot_name: string;
      }>();

    for (const row of candidates.results) {
      try {
        const res = await db
          .prepare(
            `UPDATE comp_pilot SET pilot_id = ?
             WHERE comp_pilot_id = ? AND pilot_id IS NULL`
          )
          .bind(pilot.pilot_id, row.comp_pilot_id)
          .run();
        if (res.meta.changes === 0) continue; // raced — someone else claimed it
      } catch (err) {
        console.error("[auth-api] pilot bootstrap claim failed", { err, row });
        continue;
      }
      // Same transparency record the profile-save linker writes
      // (competition-api's audit(); format kept in lockstep by
      // pilot-bootstrap.test.ts).
      try {
        await db
          .prepare(
            `INSERT INTO audit_log (
               comp_id, timestamp, actor_user_id, actor_name,
               subject_type, subject_id, subject_name, description
             ) VALUES (?, ?, ?, ?, 'pilot', ?, ?, ?)`
          )
          .bind(
            row.comp_id,
            new Date().toISOString(),
            userId,
            pilot.name,
            row.comp_pilot_id,
            row.registered_pilot_name,
            `Linked pre-registered pilot "${row.registered_pilot_name}" to GlideComp account (matched by email at sign-in)`
          )
          .run();
      } catch (err) {
        console.error("[auth-api] pilot bootstrap audit failed", { err, row });
      }
    }
  } catch (err) {
    console.error("[auth-api] pilot bootstrap failed", { err, userId });
  }
}
