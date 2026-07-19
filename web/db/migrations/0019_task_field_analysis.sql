-- Stale-first field-analysis storage in D1 (docs/2026-07-18-field-analysis-plan.md).
--
-- task_field_analysis materializes each task's behavioural field-analysis
-- report — the per-pilot metrics and their Spearman correlations against GAP
-- rank — as one row, following the same contract as task_scores (0012):
-- reads never compute, mutations mark the row stale by bumping inputs_rev,
-- and a lock+CAS-guarded background revalidation is the only writer.
--
-- Deliberately a SEPARATE table from task_scores rather than extra columns:
--   * the blob is ~20 KB gzipped for a 32-pilot task (vs a couple of KB of
--     score JSON) and would bloat the app's hottest read path;
--   * it needs its own computed_rev, because field analysis revalidates
--     LAZILY (on read) while scores revalidate eagerly on every mutation, so
--     the two legitimately sit at different revisions;
--   * it needs a second version stamp (see below).
--
-- Two version stamps, either of which makes the row stale:
--   engine_version   — SCORING_ENGINE_VERSION. Scoring changes move the GAP
--                      ranks that every correlation is measured against.
--   analysis_version — FIELD_ANALYSIS_VERSION. Metric changes move the values.
--
-- computed_rev = -1 marks a placeholder created by an inputs bump before the
-- first compute; it carries no servable blob, so the read path treats it as
-- cold and returns a "pending" response while revalidation runs.

CREATE TABLE "task_field_analysis" (
  "task_id"            INTEGER PRIMARY KEY
                       REFERENCES "task"("task_id") ON DELETE CASCADE,
  -- gzipped JSON of StoredFieldAnalysis; zero-length until the first compute.
  -- Gzipped because the report is per-pilot × per-metric and highly
  -- repetitive (~10x on real data), keeping even a 150-pilot task well
  -- inside D1's value limits.
  "report_gz"          BLOB    NOT NULL,
  "state_key"          TEXT    NOT NULL,            -- computeScoreStateKey at write time; ETag = fa:<analysis_version>:<state_key>
  "computed_at"        TEXT    NOT NULL,            -- ISO, stamped when the compute finished
  "engine_version"     INTEGER NOT NULL DEFAULT 0,  -- SCORING_ENGINE_VERSION the report was computed with
  "analysis_version"   INTEGER NOT NULL DEFAULT 0,  -- FIELD_ANALYSIS_VERSION the report was computed with
  "inputs_rev"         INTEGER NOT NULL DEFAULT 0,  -- bumped by every score-affecting mutation (shared with task_scores)
  "computed_rev"       INTEGER NOT NULL DEFAULT -1, -- inputs_rev the report was computed from
  "revalidating_until" TEXT    NOT NULL DEFAULT '', -- revalidation lock lease (ISO); '' = unlocked
  -- Observability: this is the worker's most expensive compute (every
  -- pilot's full tracklog in memory at once), and its likeliest failure is
  -- an isolate kill with no log. compute_ms and error make a struggling
  -- task visible in the UI instead of silently never producing a report.
  "compute_ms"         INTEGER NOT NULL DEFAULT 0,
  "error"              TEXT    NOT NULL DEFAULT ''
);
