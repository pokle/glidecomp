-- Site search: one index over competitions, tasks (including their routes)
-- and pilots, so the competitions page can answer "elliot KANGCK" with the
-- tasks that fly through both turnpoints.
--
-- Shape: a denormalised `search_doc` row per searchable thing, and an FTS5
-- index over it. D1 ships the FTS5 module, so the ranking runs inside the
-- database we already have — no new service, no embedding pipeline.
--
-- Four text columns, because they are not equally informative:
--   title — the entity's name (the thing a person types when they know it)
--   route — a task's turnpoint codes and descriptions, and nothing else
--   body  — the rest (class, team, format, dates)
--   owner — the competition a task or pilot belongs to, and nothing else
-- The query weights them 10 : 8 : 1 : 0.5, so a task that genuinely flies
-- through KANGCK outranks one that merely mentions a matching word in its name.
--
-- `owner` is a column of its own rather than more words in `body` because it
-- answers two questions that must not be confused. It is what makes "corryong
-- harrison" findable — every word of a query has to be in ONE document, and
-- nobody thinks of a search as scoped to a level. But a search for "corryong"
-- ALONE must not then return forty pilots whose only connection to the word is
-- the competition they are in. Keeping the competition's name in its own
-- column lets the query say "every word somewhere, and at least one word
-- outside `owner`" — see routes/search.ts.
--
-- Freshness is NOT the responsibility of the route handlers. Triggers below
-- push a key onto `search_dirty` whenever an indexed column changes, and
-- ../../workers/competition-api/src/search-index.ts drains that queue after
-- mutations, off search traffic, and on a cron. This is deliberately unlike
-- audit()/bumpAndRevalidateScores(), which every handler must remember to
-- call: the search index derives from three columns of three tables, that
-- derivation is expressible in SQL, and a search that quietly stops seeing
-- new competitions is a failure nobody would notice for months.
--
-- Two things are deliberately NOT indexed:
--   * comp_waypoints — a comp's uploaded waypoint set. The task's own frozen
--     xctsk is what it actually flew (see 0015); the comp's set may have been
--     edited since, so it would answer with a route nobody flew.
--   * comp.test — visibility is joined live from `comp` at query time rather
--     than copied onto the doc, so toggling a comp hidden takes effect on the
--     next search rather than after a reindex.

-- ── The documents ──────────────────────────────────────────────────────────

CREATE TABLE "search_doc" (
  "doc_id"        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'comp:12' | 'task:34' | 'pilot:56'. A single text key so the dirty queue
  -- below is one column, and so uniqueness works: a composite unique over the
  -- nullable id columns would never collide (SQLite treats NULLs as distinct).
  "key"           TEXT NOT NULL UNIQUE,
  "kind"          TEXT NOT NULL CHECK ("kind" IN ('comp', 'task', 'pilot')),
  -- Every doc belongs to a competition — that is the top of the hierarchy the
  -- results are grouped into, and the row the visibility check joins to.
  "comp_id"       INTEGER NOT NULL REFERENCES "comp"("comp_id") ON DELETE CASCADE,
  "task_id"       INTEGER REFERENCES "task"("task_id") ON DELETE CASCADE,
  "comp_pilot_id" INTEGER REFERENCES "comp_pilot"("comp_pilot_id") ON DELETE CASCADE,
  "title"         TEXT NOT NULL,
  "route"         TEXT NOT NULL DEFAULT '',
  "body"          TEXT NOT NULL DEFAULT '',
  "owner"         TEXT NOT NULL DEFAULT '',
  -- JSON the result page needs and cannot re-derive cheaply: for a task, its
  -- turnpoint list, so the UI can say WHICH turnpoints matched without
  -- re-parsing every candidate task's xctsk.
  "extra"         TEXT,
  -- Recency tiebreaker: the task's date, or the comp's last task date.
  "sort_date"     TEXT,
  -- The version of the document builder that wrote this row. A change to what
  -- goes into title/route/body ships with a bump, and the nightly job reindexes
  -- whatever is behind — so a format change heals itself instead of needing a
  -- migration or a remembered admin action.
  "rev"           INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX "idx_search_doc_comp" ON search_doc(comp_id);
-- Drives the nightly "which docs are missing or out of date" sweep.
CREATE INDEX "idx_search_doc_kind_rev" ON search_doc(kind, rev);

CREATE VIRTUAL TABLE "search_fts" USING fts5(
  title,
  route,
  body,
  owner,
  content='search_doc',
  content_rowid='doc_id',
  -- remove_diacritics 2 folds accents, so "Épreuve" is found by "epreuve" —
  -- the same folding lib/slug.ts does for URLs.
  tokenize='unicode61 remove_diacritics 2',
  -- Prefix indexes for search-as-you-type: the last word of a query is
  -- matched as a prefix, and 2/3-character prefixes are the common case.
  prefix='2 3'
);

-- External-content FTS5 keeps only the index, not the text, so it must be
-- told about every change to the content table. These three triggers are the
-- pattern from the SQLite FTS5 documentation, verbatim in shape. They also
-- mean a cascade delete (comp removed → its docs removed) cleans the index.
CREATE TRIGGER "search_doc_ai" AFTER INSERT ON search_doc BEGIN
  INSERT INTO search_fts(rowid, title, route, body, owner)
  VALUES (new.doc_id, new.title, new.route, new.body, new.owner);
END;

CREATE TRIGGER "search_doc_ad" AFTER DELETE ON search_doc BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, route, body, owner)
  VALUES ('delete', old.doc_id, old.title, old.route, old.body, old.owner);
END;

CREATE TRIGGER "search_doc_au" AFTER UPDATE ON search_doc BEGIN
  INSERT INTO search_fts(search_fts, rowid, title, route, body, owner)
  VALUES ('delete', old.doc_id, old.title, old.route, old.body, old.owner);
  INSERT INTO search_fts(rowid, title, route, body, owner)
  VALUES (new.doc_id, new.title, new.route, new.body, new.owner);
END;

-- ── The dirty queue ────────────────────────────────────────────────────────
-- Keys whose document needs rebuilding. Idempotent by construction (the key
-- is the primary key), so a bulk import of 250 pilots leaves 250 keys, not
-- 250 rebuilds of the same document.

CREATE TABLE "search_dirty" (
  "key"    TEXT PRIMARY KEY,
  -- How many times this key has been marked. The drain deletes the key only
  -- if the count still matches what it read, so a write that lands DURING a
  -- rebuild is not swallowed by the delete that follows it — the key survives
  -- and is rebuilt on the next pass. Without this the losing write is stale
  -- until something touches the row again, which for a renamed competition
  -- could be never.
  "marked" INTEGER NOT NULL DEFAULT 1
);

-- The triggers stay deliberately trivial — one upsert each. They run inside
-- the writing transaction, so anything cleverer here would be a way to break
-- competition writes. All the real work (parsing xctsk, composing the text)
-- happens later, in the drain.
--
-- UPDATE triggers name their columns: a task's flight data, a comp's gap_params
-- and a pilot's start order all change often and change nothing searchable.

CREATE TRIGGER "comp_search_ai" AFTER INSERT ON comp BEGIN
  INSERT INTO search_dirty(key) VALUES ('comp:' || new.comp_id)
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
END;

CREATE TRIGGER "comp_search_au"
AFTER UPDATE OF name, category, pilot_classes, scoring_format ON comp BEGIN
  INSERT INTO search_dirty(key) VALUES ('comp:' || new.comp_id)
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
END;

-- A competition's name is copied into its tasks' and pilots' documents, so
-- "corryong harrison" finds a pilot without the query having to span two
-- documents. That copy is why a rename re-dirties the whole competition.
CREATE TRIGGER "comp_search_rename" AFTER UPDATE OF name ON comp BEGIN
  INSERT INTO search_dirty(key) SELECT key FROM search_doc WHERE comp_id = new.comp_id
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
END;

CREATE TRIGGER "task_search_ai" AFTER INSERT ON task BEGIN
  INSERT INTO search_dirty(key) VALUES ('task:' || new.task_id)
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
  -- A new task can move the comp's date range, which is the comp doc's
  -- recency signal.
  INSERT INTO search_dirty(key) VALUES ('comp:' || new.comp_id)
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
END;

CREATE TRIGGER "task_search_au"
AFTER UPDATE OF name, task_date, xctsk ON task BEGIN
  INSERT INTO search_dirty(key) VALUES ('task:' || new.task_id)
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
  INSERT INTO search_dirty(key) VALUES ('comp:' || new.comp_id)
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
END;

CREATE TRIGGER "comp_pilot_search_ai" AFTER INSERT ON comp_pilot BEGIN
  INSERT INTO search_dirty(key) VALUES ('pilot:' || new.comp_pilot_id)
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
END;

CREATE TRIGGER "comp_pilot_search_au"
AFTER UPDATE OF registered_pilot_name, registered_pilot_civl_id, pilot_class,
                team_name, pilot_id ON comp_pilot BEGIN
  INSERT INTO search_dirty(key) VALUES ('pilot:' || new.comp_pilot_id)
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
END;

-- A pilot document carries the name on the roster AND the name on the linked
-- account, because organisers enter "H. Rowntree" and people search for
-- "Harrison". The account name lives one table away, so its rename has to
-- reach across.
CREATE TRIGGER "pilot_search_au" AFTER UPDATE OF name ON pilot BEGIN
  INSERT INTO search_dirty(key)
    SELECT 'pilot:' || comp_pilot_id FROM comp_pilot WHERE pilot_id = new.pilot_id
    ON CONFLICT(key) DO UPDATE SET marked = marked + 1;
END;

-- ── First fill ─────────────────────────────────────────────────────────────
-- Everything that exists today is dirty. The migration itself builds no
-- documents: composing them means parsing each task's xctsk, which is the
-- Worker's job, not SQL's. The queue drains on the next mutations, the next
-- searches, and the hourly cron.

INSERT OR IGNORE INTO search_dirty(key) SELECT 'comp:'  || comp_id       FROM comp;
INSERT OR IGNORE INTO search_dirty(key) SELECT 'task:'  || task_id       FROM task;
INSERT OR IGNORE INTO search_dirty(key) SELECT 'pilot:' || comp_pilot_id FROM comp_pilot;
