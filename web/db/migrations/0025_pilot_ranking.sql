-- The CIVL/WPRS world pilot rankings, imported monthly from civlcomps.org.
--
-- ── Why this table stands alone ────────────────────────────────────────────
--
-- Everything else in this schema is competition data: someone entered it, and
-- it is about a GlideComp comp. This is neither. It is an outside fact —
-- FAI/CIVL publishes a world ranking per discipline at the start of each
-- month, and we take a copy. So the table deliberately has:
--
--   * no foreign keys. `civl_id` here is CIVL's identifier for a human, not a
--     GlideComp `pilot_id`. Most ranked pilots have never heard of GlideComp
--     and will never have a row in `pilot`. A FK would mean discarding the
--     ~99% of the ranking that doesn't match anyone, which is exactly the
--     data you need the moment a new pilot registers for a comp.
--   * no audit-log entries. The `audit()` rule in CLAUDE.md covers mutations
--     that could affect a competition's scores; nothing here can. The import
--     is a machine copying a public list, and its record is the workflow run.
--   * no score-staleness bump. Same reasoning as `task_weather` (0023): this
--     is not derived from competition data, so `bumpScoreInputs()` must NOT be
--     called for it. Editing a world ranking cannot change a task score.
--
-- ── Retention: latest only ─────────────────────────────────────────────────
--
-- One snapshot per list is kept; a new month replaces the previous one, so the
-- table stays around 20k rows forever rather than growing by that much every
-- month. `ranking_date` is still stored on every row (not just in a header
-- table) for two reasons: it is what the importer reads back to decide
-- "do I already have this month?", and it means turning history on later is a
-- change to the DELETE step alone, not a migration.
--
-- The importer writes the new month BEFORE deleting the old one. The two run
-- as separate `wrangler d1 execute` invocations, so delete-then-insert would
-- leave the table empty for a list if the second one failed. This ordering
-- means the table transiently holds two months and always holds a complete
-- set.
--
-- ── Column notes ───────────────────────────────────────────────────────────
--
-- `ranking_slug` is the civlcomps.org URL segment ('hang-gliding-class-1-xc').
-- It is the stable identity of a list; `ranking_name` ('HG Class 1') is the
-- sheet's own label and is display text.
--
-- `civl_ranking_id` is CIVL's id for the (list, month) pair — 1914 is Jul 2026
-- for HG Class 1, while Jul 2026 for PG XC is 1913. Stored for provenance:
-- it is what you need to re-fetch or diff an exact snapshot against the site.
--
-- `civl_id` is TEXT, not INTEGER, to match `pilot.civl_id` and
-- `comp_pilot.registered_pilot_civl_id` — the two columns any future matcher
-- will join against. A type mismatch there would silently never match.
--
-- `points` is the WPRS score. It is stored because rank ties are pervasive
-- rather than exceptional (344 of the 747 rows in the Jul 2026 HG Class 1 list
-- share a rank with someone; the tail is a long run of rank 695 at 0.1
-- points), so rank alone cannot order the list.
CREATE TABLE "pilot_ranking" (
  "pilot_ranking_id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "ranking_slug"     TEXT    NOT NULL,  -- civlcomps.org URL segment; the list's identity
  "civl_ranking_id"  INTEGER NOT NULL,  -- CIVL's id for this (list, month)
  "ranking_date"     TEXT    NOT NULL,  -- ISO 'YYYY-MM-01', from the sheet metadata
  "ranking_name"     TEXT    NOT NULL,  -- 'HG Class 1'
  "region"           TEXT    NOT NULL,  -- 'World'
  "selection"        TEXT    NOT NULL,  -- 'Overall'
  "rank"             INTEGER NOT NULL,
  "civl_id"          TEXT    NOT NULL,
  "pilot_name"       TEXT    NOT NULL,
  "gender"           TEXT    NOT NULL DEFAULT '',
  "nation"           TEXT    NOT NULL DEFAULT '',
  "points"           REAL    NOT NULL DEFAULT 0,
  "fetched_at"       TEXT    NOT NULL   -- ISO timestamp of the import run
);

-- A pilot appears at most once in a given list+month. Also the guard that makes
-- a re-import idempotent rather than doubling the table.
CREATE UNIQUE INDEX "idx_pilot_ranking_unique"
  ON pilot_ranking(ranking_slug, ranking_date, civl_id);

-- "What is this pilot ranked, in every discipline?" — the lookup a future
-- launch-order or pilot-profile feature makes.
CREATE INDEX "idx_pilot_ranking_civl_id" ON pilot_ranking(civl_id);
