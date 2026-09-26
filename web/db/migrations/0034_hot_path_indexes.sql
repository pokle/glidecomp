-- Indexes for the hot read paths that were scanning whole tables
-- (docs/2026-09-26-workers-performance-review.md §3.2).
--
-- Every one of these was a `SCAN` under EXPLAIN QUERY PLAN, so its cost grew
-- with the whole database rather than with the competition being viewed:
-- each archive import made every other comp's pages slower, and D1 bills per
-- row read. Pure additions — no table is rebuilt and no row rewritten.

-- `task WHERE comp_id = ?` — comp detail, both scores routes, the comp and
-- task analysis routes, taskIdsForComp(). task_date second, so the comp
-- detail's and /scores' `ORDER BY task_date, …` walk the index in order (the
-- implicit rowid tail IS task_id, /scores' tiebreak), and the comp list's
-- `MIN/MAX(task_date) … GROUP BY comp_id` reads the index alone.
CREATE INDEX "idx_task_by_comp"
  ON task(comp_id, task_date);

-- `comp_pilot WHERE comp_id = ?` — the roster, the team map in /scores, the
-- pilot count, registration resolve. 0001's UNIQUE(comp_id, pilot_id) did not
-- survive the table's rebuild in 0002; its successor
-- idx_comp_pilot_unique_linked is PARTIAL (pilot_id IS NOT NULL), which the
-- planner cannot use for a bare comp_id lookup.
CREATE INDEX "idx_comp_pilot_by_comp"
  ON comp_pilot(comp_id);

-- `comp_pilot WHERE pilot_id IS NULL AND registered_pilot_email = ?` — the
-- pre-registration claim auth-api's pilot bootstrap runs on EVERY sign-in
-- (pilot-bootstrap.ts). Partial, to match the query: only unclaimed rows are
-- ever looked up by email.
CREATE INDEX "idx_comp_pilot_unclaimed_email"
  ON comp_pilot(registered_pilot_email) WHERE pilot_id IS NULL;

-- `comp_admin WHERE user_id = ?` — the signed-in comp list,
-- visibleCompsFilter() (search, the 404 page's lookup). The primary key is
-- (comp_id, user_id), comp_id-first, so it only serves isCompAdmin().
CREATE INDEX "idx_comp_admin_by_user"
  ON comp_admin(user_id);

-- The public comp list: `WHERE test = 0 AND creation_date >= ?
-- ORDER BY creation_date DESC`.
CREATE INDEX "idx_comp_by_test_created"
  ON comp(test, creation_date);

-- Better Auth's session and account lookups by owner (list/revoke sessions,
-- linked accounts, delete-account's Google token read). Only `token` and `id`
-- were indexed.
CREATE INDEX "idx_session_by_user"
  ON "session"("userId");

CREATE INDEX "idx_account_by_user"
  ON "account"("userId");
