/**
 * Removing a competition's track FILES when its rows go.
 *
 * Deleting a competition, a task or a pilot cascade-deletes their `task_track`
 * rows in D1, but the IGC files those rows point at live in R2, which knows
 * nothing about the cascade. They used to stay there forever — invisible,
 * unscored, and still somebody's GPS trace, which the privacy policy promises
 * goes when the organiser deletes it.
 *
 * So each such route asks for the keys BEFORE its delete (the cascade removes
 * the rows that name them) and hands them here AFTER the delete commits. Keys
 * come from `igc_filename` rather than a `c/{comp}/` prefix listing, so a
 * track stored under any other layout goes too.
 */

/** R2's delete() takes at most 1000 keys per call. */
const R2_DELETE_BATCH = 1000;

/** The R2 keys of every track matching `where` (a clause over `task_track`). */
export async function trackFileKeys(
  db: D1Database,
  where: string,
  ...binds: unknown[]
): Promise<string[]> {
  const rows = await db
    .prepare(
      `SELECT igc_filename FROM task_track WHERE igc_filename IS NOT NULL AND (${where})`
    )
    .bind(...binds)
    .all<{ igc_filename: string }>();
  return rows.results.map((r) => r.igc_filename).filter((k) => k.length > 0);
}

/** D1 binds at most 100 parameters per statement; stay well inside it. */
const D1_BIND_CHUNK = 90;

/** The R2 keys of every track flown by any of these roster entries. */
export async function trackFileKeysForPilots(
  db: D1Database,
  compPilotIds: number[]
): Promise<string[]> {
  const keys: string[] = [];
  for (let i = 0; i < compPilotIds.length; i += D1_BIND_CHUNK) {
    const chunk = compPilotIds.slice(i, i + D1_BIND_CHUNK);
    keys.push(
      ...(await trackFileKeys(
        db,
        `comp_pilot_id IN (${chunk.map(() => "?").join(",")})`,
        ...chunk
      ))
    );
  }
  return keys;
}

/**
 * Delete the files. Never throws: the rows are already gone, and a storage
 * hiccup must not turn a completed delete into an error the organiser sees —
 * it is logged instead, and the file is merely orphaned, as every file was
 * before this existed.
 */
export async function deleteTrackFiles(r2: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
    try {
      await r2.delete(keys.slice(i, i + R2_DELETE_BATCH));
    } catch (err) {
      console.error("track file delete failed", err);
    }
  }
}
