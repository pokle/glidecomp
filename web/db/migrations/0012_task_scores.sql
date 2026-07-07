-- Stale-first score storage in D1 (docs/score-caching-stale-first-plan.md).
--
-- task_scores materializes each task's scores as one row holding the exact
-- response the score endpoint serves. Reads never compute: mutations mark the
-- row stale by bumping inputs_rev (bumpScoreInputs in the competition-api),
-- and a lock+CAS-guarded background revalidation is the only writer of
-- response_json. A row is stale iff computed_rev < inputs_rev (or the blob
-- was computed by a different scoring-engine version). computed_rev = -1
-- marks a placeholder created by an inputs bump before the first compute —
-- it carries no servable blob, so the read path treats it as cold.

CREATE TABLE "task_scores" (
  "task_id"            INTEGER PRIMARY KEY
                       REFERENCES "task"("task_id") ON DELETE CASCADE,
  "response_json"      TEXT    NOT NULL,            -- served verbatim (+ stale flag); '' until first compute
  "state_key"          TEXT    NOT NULL,            -- computeScoreStateKey at write time; doubles as the ETag
  "computed_at"        TEXT    NOT NULL,            -- ISO, stamped when the compute finished
  "engine_version"     INTEGER NOT NULL DEFAULT 0,  -- SCORING_ENGINE_VERSION the blob was computed with
  "inputs_rev"         INTEGER NOT NULL DEFAULT 0,  -- bumped by every score-affecting mutation
  "computed_rev"       INTEGER NOT NULL DEFAULT -1, -- inputs_rev the blob was computed from
  "revalidating_until" TEXT    NOT NULL DEFAULT ''  -- revalidation lock lease (ISO); '' = unlocked
);

-- Per-track, field-independent analyses (replaces the pa:/od:/pd: KV
-- entries). One row per (track, variant), overwritten in place when the task
-- geometry or the upload changes; a row is only reused when both geom_hash
-- and uploaded_at match the current task/track state, so a re-upload or a
-- route edit misses exactly the rows it invalidated.
CREATE TABLE "track_analysis" (
  "task_track_id" INTEGER NOT NULL
                  REFERENCES "task_track"("task_track_id") ON DELETE CASCADE,
  "variant"       TEXT    NOT NULL,  -- 'gap' | 'od' | 'pilot-detail'
  "geom_hash"     TEXT    NOT NULL,  -- hash of task geometry + engine version
  "uploaded_at"   TEXT    NOT NULL,  -- task_track.uploaded_at the payload was computed from
  "payload_json"  TEXT    NOT NULL,
  PRIMARY KEY ("task_track_id", "variant")
);
