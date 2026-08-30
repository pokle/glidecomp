-- Rename task_field_analysis → task_analysis.
--
-- "Field analysis" named two different things at once: the whole-competition
-- report at /comp/:id/analysis and the one-task report at
-- /comp/:id/task/:id/analysis. The two are now named apart — COMP analysis and
-- TASK analysis — everywhere a reader or a maintainer meets them.
--
-- Only the task report is stored; the comp report is a pure aggregation over
-- these rows and materializes nothing. So this table is the TASK analysis, and
-- the old name's "field" said nothing the table name did not already say.
--
-- A pure rename: every column, index and foreign key travels with it, so no
-- row is rewritten and no cached report is thrown away. SQLite rewrites the
-- REFERENCES clause in dependent tables itself (legacy_alter_table is off by
-- default in D1), and nothing references this table anyway.

ALTER TABLE "task_field_analysis" RENAME TO "task_analysis";
